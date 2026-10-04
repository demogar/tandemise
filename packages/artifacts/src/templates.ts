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
  '  - Put `stop` only when what you found means the steps after yours should not run as planned (the request turned out moot, out of scope, or blocked). It is rare: the next steps wait for a person until they answer it.',
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
  `  stop: <only when the steps after yours should not run as planned: why, in one sentence, at most ${HANDOFF_LIMITS.stop} characters; otherwise delete this line>`,
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

  Refinement: `---
type: Refinement
schemaVersion: 1
title: <one line naming the request you refined, at most ${HANDOFF_LIMITS.title} characters>
proposedCriteria:
  - key: P1
    statement: <one observable outcome the person could check themselves, at most 400 characters; up to 8, or delete this key's items>
questions:
  - key: Q1
    text: <one question whose answer changes the plan or the criteria, at most 300 characters; up to 5, or delete this key's items>
    why: <what changes depending on the answer, at most 300 characters>
    options:
      - <a likely answer the person can pick with one click; two to four, or delete this key's items>
---

## What I understood
<The request restated in two or three sentences, in the person's own terms: who it is for and what changes for them.>

## Why these criteria
<For each proposed criterion, by key: which part of the request it proves and how someone would check it.>

## What I assumed
<Every decision you made yourself instead of asking, and why it is safe. The person can overrule any of them.>

## Out of scope
<What a reader might expect from this request that it does not include.>
`,

  StatusReport: `---
type: StatusReport
schemaVersion: 1
title: Status report: <the project's name, at most ${HANDOFF_LIMITS.title} characters>
asOf: <the instant the facts were read, ISO 8601>
handoff:
  headline: <needs you · working on · criteria verified · stalled, as counts>
---

# Status report: <the project's name>

## At a glance
<Needs you, Working on (of the limit, and queued), Criteria verified, This month against the monthly limit, Stalled: one line each, as numbers.>

## Missions
<Each mission not in draft and not finished, in backlog order: status, whether it moves, is stalled (and the one action) or waits on you, criteria verified of total with the keys that are not, its limit, what waits on a person, its last gate failure verbatim.>

## Backlog
<Queued drafts in pull order, then drafts not queued: priority and readiness.>

## How this report was made
<Rendered by Tandemise from stored facts; no model wrote it.>
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

/**
 * How to do the job a type exists for, where filling in the skeleton is not
 * enough. Only Refinement has one: it is the product owner's first job -
 * turning a rough request into one that is ready to plan - and the difference
 * between a good pass and a bad one is almost entirely what it chooses to ask
 * and propose, which no schema can check.
 */
const TYPE_GUIDANCE: Partial<Record<SchemaBackedArtifactType, string>> = {
  Refinement: [
    'How to refine a request (you are acting as the person\'s product owner):',
    '  - Your job is to make this request ready to plan, not to plan or build it. Read the request, the Done-when lines',
    '    and the repository first: anything they already answer is not a question.',
    '  - Propose the criteria that together mean "done" for this person. Each is one observable outcome someone could',
    '    check without reading code ("On a phone, /settings shows every section without scrolling sideways"), never an',
    '    activity ("Refactor the settings page") and never an implementation ("Use CSS grid").',
    '  - Cover the whole request: every part of what they asked for is proven by at least one criterion. Add the',
    '    unhappy path (empty, error, offline, permissions) only where the request implies the person cares about it.',
    '  - Do not repeat a Done-when line the person already has; propose only what is missing. Fewer, sharper criteria',
    '    beat many vague ones: three to five is typical, eight is the limit.',
    '  - Ask a question only when its answer changes the plan or the criteria: a different scope, a different user, a',
    '    different page, a different meaning of done. If a safe default exists, take it, write it under',
    '    "What I assumed", and do not ask.',
    '  - Do not ask what the repository answers (the framework, where a file lives), what only matters while building',
    '    (names, colours, library choices), or anything you could look up yourself.',
    '  - One decision per question, answerable in a few words. Offer two to four options when the likely answers are',
    '    known, and say in `why` what changes depending on the answer.',
    '  - No questions at all is a good outcome for a clear request. Five is the limit.',
    '  - The handoff headline says what you propose ("Four criteria and one question about which pages"); `needs`',
    '    says what the person must do ("Decide 4 criteria and answer 1 question").',
  ].join('\n'),
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
  const guidance = TYPE_GUIDANCE[type];
  return `${HOW_TO_FILL}\n${budgetRule}\n\n${guidance === undefined ? '' : `${guidance}\n\n`}${artifactSkeleton(type)}`;
}

/** The skeleton alone, without the instruction preamble. */
export function artifactSkeleton(type: SchemaBackedArtifactType): string {
  return withHandoff(TEMPLATES[type]);
}

export { HOW_TO_FILL as ARTIFACT_TEMPLATE_RULES };
