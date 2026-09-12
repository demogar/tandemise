import type { ArtifactType } from '@tandemise/domain';
import { hasSchema, type SchemaBackedArtifactType } from './schemas.js';

/**
 * The exact skeleton a role must fill in.
 *
 * These strings are pasted verbatim into role prompts by the context compiler,
 * so ambiguity here becomes a malformed artifact later. Two rules keep them
 * unambiguous:
 *
 *  1. Every placeholder is `<angle-bracketed>` and every choice is written as
 *     `a | b | c`. The instruction block above the template says to remove the
 *     brackets and pick exactly one alternative.
 *  2. The front matter shown is exactly the front matter the schema validates -
 *     no illustrative extras, no omitted required keys. A template that drifts
 *     from its schema is worse than no template.
 */
const HOW_TO_FILL = [
  'Rules for filling this in:',
  '  - Keep the `---` fences and the key names exactly as shown.',
  '  - Replace every `<...>` placeholder with real content and delete the angle brackets.',
  '  - Where a value is written as `a | b | c`, keep exactly one of the alternatives.',
  '  - Repeat or delete list items as needed; keep the two-space indentation.',
  '  - Front matter is machine-read and must stay short. Put the reasoning in the prose below.',
  '  - Do not add a second `---` fence anywhere in the prose.',
].join('\n');

const TEMPLATES: Readonly<Record<SchemaBackedArtifactType, string>> = {
  ProblemBrief: `---
type: ProblemBrief
schemaVersion: 1
title: <one line naming the problem>
successMetric: <the single measurable signal that this problem is solved>
evidence:
  - <artifact id, URL, file path, or analytics query backing a claim below>
---

## Problem
<What is wrong, stated from the user's point of view.>

## Who is affected
<Which users, in which context, how often.>

## Evidence
<What you actually observed. Cite each item listed in \`evidence\` above.>

## Constraints
<Deadlines, platforms, compliance, existing commitments.>

## Out of scope
<What this brief deliberately does not cover.>
`,

  ProductSpec: `---
type: ProductSpec
schemaVersion: 1
title: <one line naming the scope of this spec>
acceptanceCriteria:
  - id: AC1
    statement: <an observable, testable statement — QA will map a test to this id>
nonGoals:
  - <something a reader might reasonably expect that is explicitly excluded>
---

## Scope
<What is being built.>

## Requirements
<Numbered requirements. Each one must be traceable to an acceptance criterion id.>

## Edge cases
<Empty states, failures, permissions, offline, long text, concurrency.>

## Open questions
<Anything a human must decide. Say what you assumed in the meantime.>
`,

  DesignBrief: `---
type: DesignBrief
schemaVersion: 1
title: <one line naming the surface being designed>
flows:
  - <named user flow, e.g. "First-run onboarding">
accessibility:
  - <a concrete requirement, e.g. "All controls reachable by keyboard in DOM order">
openQuestions:
  - <a choice that needs a human, or delete this key's items if there are none>
---

## Flows and states
<Each flow, step by step, with its empty / loading / error / success states.>

## Design references
<Links to Figma frames, existing screens, or prototypes. Give frame names, not just URLs.>

## Interaction behaviour
<Focus order, validation timing, motion, responsive behaviour.>

## Accessibility
<Expand each requirement listed above.>
`,

  ArchitecturePlan: `---
type: ArchitecturePlan
schemaVersion: 1
title: <one line naming the technical approach>
components:
  - <module, package, or service this change touches>
risks:
  - severity: high | medium | low
    description: <what could go wrong and why>
migration: <one line: how existing data/users move over, or "none">
---

## Approach
<The chosen design, and why it beats the alternatives you considered.>

## Data and API changes
<Schema changes, new endpoints, contract changes, backwards compatibility.>

## Test strategy
<What is proven by unit tests, by integration tests, and by manual QA.>

## Risks
<Expand each risk listed above, with its mitigation.>
`,

  ImplementationPlan: `---
type: ImplementationPlan
schemaVersion: 1
title: <one line naming the implementation>
steps:
  - id: S1
    summary: <one line describing this change>
    files:
      - <path/to/file.ts>
    dependsOn: []
---

## Ordered changes
<Expand each step: what changes, what it must not break, how you will verify it.>

## Task split
<Which steps can run in parallel, and which must be sequential.>

## Verification
<The exact commands that must pass when the plan is complete.>
`,

  ChangeSet: `---
type: ChangeSet
schemaVersion: 1
title: <one line describing what changed>
branch: <branch name>
commits:
  - <commit sha>
filesChanged: <integer>
testsRun:
  - <the exact command, e.g. "npm test">
knownLimitations:
  - <something a reviewer must know, or delete this key's items if there are none>
---

## Summary of the diff
<What changed, grouped by area. Not a file listing — an explanation.>

## Tests
<What each command above proved. Paste the relevant output, not the whole log.>

## Known limitations
<Expand each limitation listed above.>
`,

  ReviewReport: `---
type: ReviewReport
schemaVersion: 1
title: <one line naming what was reviewed>
verdict: pass | needs_changes | fail
reviewedRef: <commit sha, branch, or ChangeSet artifact id>
findings:
  - severity: blocking | major | minor | nit
    title: <one line naming the problem>
    location: <path/to/file.ts:42, or leave empty>
---

## Assessment
<Does the change do what the spec asked, in the way the architecture plan said?>

## Findings
<One section per finding above, in the same order: what is wrong, why it matters,
and what a correct fix looks like.>

## Checked and found correct
<What you verified and found acceptable. This is what makes the verdict credible.>
`,

  QAPlan: `---
type: QAPlan
schemaVersion: 1
title: <one line naming what is under test>
cases:
  - id: TC1
    criterion: <the acceptance criterion id this case proves, e.g. AC1>
    method: manual | automated | browser | accessibility | performance
---

## Test matrix
<Each case: preconditions, steps, expected result, and the risk it covers.>

## Coverage
<Which acceptance criteria each case maps to. Every criterion needs at least one case.>

## Not covered
<What this plan does not test, and why that is acceptable.>
`,

  QAReport: `---
type: QAReport
schemaVersion: 1
title: <one line naming the test run>
results:
  - criterion: <the acceptance criterion id, e.g. AC1>
    outcome: PASS | FAIL | SKIP
    evidence: <artifact id of a screenshot/log, or a one-line observation>
blockingDefects: <integer>
---

## Results
<One section per criterion: what you did, what happened, what you expected.>

## Defects
<Each defect: severity, reproduction steps, actual vs expected, evidence artifact id.>

## Environment
<Build/commit under test, browser or device, data used.>
`,

  ReleaseCandidate: `---
type: ReleaseCandidate
schemaVersion: 1
title: <one line naming the release>
ref: <tag or commit sha being released>
checks:
  - name: <check name, e.g. tests>
    outcome: PASS | FAIL | SKIP
unresolvedRisks:
  - <a risk being accepted, or delete this key's items if there are none>
rollback: <the exact action that undoes this release>
---

## Contents
<What is in this release, referencing the ChangeSet artifacts it integrates.>

## Verification
<Each check above, and what it proves.>

## Rollback
<Expand the rollback line: exact commands, expected duration, who to tell.>
`,

  DecisionRecord: `---
type: DecisionRecord
schemaVersion: 1
title: <one line naming the decision>
status: proposed | accepted | rejected | superseded
decision: <the decision itself, in one sentence>
owner: <who is accountable for it>
supersedes: <decision id this replaces, or leave empty>
---

## Context
<What forced a decision. What was true at the time.>

## Alternatives considered
<Each alternative and the specific reason it was not chosen.>

## Rationale
<Why the chosen option wins given the context above.>

## Consequences
<What this makes easy, what it makes hard, and what it commits us to.>
`,
};

/**
 * The copy-pasteable skeleton for one artifact type, preceded by the filling
 * rules. Types without a front-matter contract (Evidence, MissionPlan,
 * FinanceReport) have no template.
 */
export function renderArtifactTemplate(type: ArtifactType): string | undefined {
  if (!hasSchema(type)) return undefined;
  return `${HOW_TO_FILL}\n\n${TEMPLATES[type]}`;
}

/** The skeleton alone, without the instruction preamble. */
export function artifactSkeleton(type: SchemaBackedArtifactType): string {
  return TEMPLATES[type];
}

export { HOW_TO_FILL as ARTIFACT_TEMPLATE_RULES };
