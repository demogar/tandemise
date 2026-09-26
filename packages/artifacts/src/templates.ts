import type { ArtifactType } from '@tandemise/domain';
import { WORD_BUDGETS } from './budget.js';
import { HANDOFF_LIMITS } from './handoff.js';
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
  '  - The handoff is what a busy owner reads first, often the only thing they read. Write the headline as the outcome, not the activity.',
  '  - Put `needs` only when a person must act, and say what they must do.',
  '  - Put a link for every real thing that lives elsewhere (preview, pull request, design file).',
].join('\n');

/**
 * The handoff skeleton, inserted right after `title` in every template. Each
 * placeholder states its limit, because the limit is what gets an artifact
 * refused, and an author who cannot see it finds out only on the retry.
 *
 * `changed.feedback` is not shown: it names a feedback item, which only exists
 * once rounds of feedback do (P2), and an invented id would be worse than none.
 */
const HANDOFF_BLOCK = [
  'handoff:',
  `  headline: <the outcome in one sentence, at most ${HANDOFF_LIMITS.headline} characters>`,
  '  points:',
  `    - <a point the owner should know, at most ${HANDOFF_LIMITS.point} characters; up to ${HANDOFF_LIMITS.points} points, or delete this key's items>`,
  `  needs: <what a person must do, at most ${HANDOFF_LIMITS.needs} characters, or leave empty when nobody must act>`,
  '  changed:',
  `    - what: <what changed since the last round, at most ${HANDOFF_LIMITS.changedWhat} characters; up to ${HANDOFF_LIMITS.changed}, or delete this key's items in the first round>`,
  '  links:',
  `    - label: <what the link opens, at most ${HANDOFF_LIMITS.linkLabel} characters, e.g. Open preview>`,
  `      url: <an http:// or https:// URL; up to ${HANDOFF_LIMITS.links} links, or delete this key's items>`,
  '      kind: workspace | preview | pr | doc | other',
].join('\n');

const TEMPLATES: Readonly<Record<SchemaBackedArtifactType, string>> = {
  ProblemBrief: `---
type: ProblemBrief
schemaVersion: 1
title: <one line naming the problem, at most ${HANDOFF_LIMITS.title} characters>
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
title: <one line naming the scope of this spec, at most ${HANDOFF_LIMITS.title} characters>
acceptanceCriteria:
  - id: AC1
    statement: <an observable, testable statement — QA will map a test to this id>
    covers:
      - <each Done-when id this criterion proves, e.g. U1; every U id must be covered by at least one criterion>
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
title: <one line naming the surface being designed, at most ${HANDOFF_LIMITS.title} characters>
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
title: <one line naming the technical approach, at most ${HANDOFF_LIMITS.title} characters>
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
title: <one line naming the implementation, at most ${HANDOFF_LIMITS.title} characters>
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
title: <one line describing what changed, at most ${HANDOFF_LIMITS.title} characters>
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
title: <one line naming what was reviewed, at most ${HANDOFF_LIMITS.title} characters>
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
title: <one line naming what is under test, at most ${HANDOFF_LIMITS.title} characters>
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
title: <one line naming the test run, at most ${HANDOFF_LIMITS.title} characters>
results:
  - criterionId: <the criterion id from the Done-when ledger, e.g. AC1; one result per id>
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
title: <one line naming the release, at most ${HANDOFF_LIMITS.title} characters>
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
title: <one line naming the decision, at most ${HANDOFF_LIMITS.title} characters>
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
  FinanceReport: `---
type: FinanceReport
schemaVersion: 1
title: <one line naming what was costed or forecast, at most ${HANDOFF_LIMITS.title} characters>
---

## Summary
<The figures that matter, and what they mean for the decision at hand.>

## Figures
<The numbers, as a table where that is clearer. Say where each one comes from.>

## Assumptions
<Every assumption behind the figures, so a reader can challenge it.>
`,

  Evidence: `---
type: Evidence
schemaVersion: 1
title: <one line naming what this evidence shows, at most ${HANDOFF_LIMITS.title} characters>
---

## What this shows
<The observation, stated plainly.>

## How it was captured
<Command, browser, device, data and commit, so it can be reproduced.>

## Raw output
<The relevant excerpt of the log or test output, not the whole log.>
`,

  MissionPlan: `---
type: MissionPlan
schemaVersion: 1
title: <one line naming the plan, at most ${HANDOFF_LIMITS.title} characters>
---

## Approach
<How the mission will be carried out, and why this order.>

## Steps
<Each step: who does it, what it produces, what it depends on.>

## Risks
<What could derail the plan, and what happens then.>
`,
};

/** Adds the handoff, which every type shares, right after the skeleton's title. */
function withHandoff(skeleton: string): string {
  const lines = skeleton.split('\n');
  const titleAt = lines.findIndex((line) => line.startsWith('title:'));
  lines.splice(titleAt + 1, 0, HANDOFF_BLOCK);
  return lines.join('\n');
}

/**
 * The copy-pasteable skeleton for one artifact type, preceded by the filling
 * rules. Every type has one, since every type carries a handoff; `undefined`
 * is kept in the signature for a string that is not an artifact type.
 *
 * The word budget is a rule, not part of the skeleton: agents copy the
 * skeleton into their document, and a budget sentence between or after the
 * fences would end up in the artifact itself.
 */
export function renderArtifactTemplate(type: ArtifactType): string | undefined {
  if (!hasSchema(type)) return undefined;
  const budget = WORD_BUDGETS[type];
  const budgetRule = `  - Main body: at most ${budget} words for ${type}. Put supporting detail under "## Appendix" (up to ${budget * 2} words).`;
  return `${HOW_TO_FILL}\n${budgetRule}\n\n${artifactSkeleton(type)}`;
}

/** The skeleton alone, without the instruction preamble. */
export function artifactSkeleton(type: SchemaBackedArtifactType): string {
  return withHandoff(TEMPLATES[type]);
}

export { HOW_TO_FILL as ARTIFACT_TEMPLATE_RULES };
