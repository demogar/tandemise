# P3: Outside contributions, and evals

Status: design, revised 2026-09-27. Parent: [collaboration roadmap](2026-09-13-collaboration-roadmap.md).
Base: `main` at 0.6.0 (after P5–P16). The first draft (2026-09-16) predated
P5–P16; this revision corrects it against the current code and adds **Part B:
evals**.

P3 ships as **two pull requests**, one concern each:

- **P3a — outside contributions** (Part A). No migration.
- **P3b — evals** (Part B). Migration 020.

P3b builds on P3a only for the `Evidence` snapshot helpers. Either can be
reviewed alone.

---

# Part A — outside contributions

## Problem

Tandemise starts every mission from text and does all the work in its own
runtimes. Real work does not:

- **You cannot bring your own work in.** A spec you wrote, a Figma export, a
  prototype, a branch you started: none of it can seed a mission, so the
  planner re-derives what you already have. `createMissionRequest` takes no
  file and no link.
- **You cannot take work out and hand it back.** If the real work happens in
  Figma, your editor or a pull request, nothing parks the task there and
  accepts the result back. `AWAITING_EXTERNAL` today means only "a `wait` step
  is polling a command".
- **Nothing is pinned.** When outside work moves on, Tandemise has no snapshot
  of the version downstream work actually used.

The hooks are reserved and unused: `feedback.attachments` ("Reserved for P3"),
`ExternalRef.kind: 'file'`, `handoff.links[].kind: 'workspace'`,
`preexistingArtifacts` in plan validation, and the `recordedBy`/`authorId`
split on every artifact.

## Goal

A person can hand work *in* (an upload) and hand it *back* (an external
hand-back). Each lands as a typed artifact with an author and a pinned
snapshot, so downstream work consumes exactly what was handed in, with no
copy-paste between tools.

## Not in P3a

- Accounts, invites and multi-seat teams (P4). The solo-owner path is the one
  proven; team hand-backs reuse `onBehalfOf` and are covered offline only.
- A feed of comments from external tools (PR review comments, Figma comments).
- Downstream agents reading arbitrary binaries: an upload is always reduced to
  a typed artifact before a downstream task reads it.
- Snapshot resolvers other than a GitHub pull request. A Figma, doc or other
  link needs an attached export.
- Counting intake runs against limits. Like planning and refinement, intake
  has no `Run` row (`KNOWN_LIMITATIONS.md` gains one line).

## A1. One shape for everything handed across

```ts
type OutsideContribution =
  | { kind: 'file'; filename: string; mediaType: string; dataBase64: string }
  | { kind: 'link'; url: string; label?: string; export?: { filename; mediaType; dataBase64 } };
```

Wherever it arrives, a contribution goes through the same two steps:

1. **Pinned first.** It is written as an `Evidence` artifact:
   content-addressed (sha256, so two identical uploads are one blob),
   `recordedBy` = the person who handed it in, `authorId` = whoever the work is
   attributed to (the person, or `onBehalfOf`). It carries at least one
   `ExternalRef`: `kind: 'file'` for a file, `kind: 'url'` for a link, plus
   `github.pr` and `git.commit` when a link is resolved (A4). This is the
   snapshot, and it never changes.
2. **Typed second.** Intake turns the `Evidence` into the typed artifact the
   mission consumes, with a handoff. The `Evidence` stays the source of truth.

**Size.** A file is at most 24 MB decoded. The router's global 8 MiB body cap
stays; the three routes that accept contributions declare a 32 MiB cap of
their own. The desktop client uses a 120 s timeout on those calls only.

## A2. Uploads and intake

### Where uploads are accepted

- **Mission creation**: `createMissionRequest.uploads`, in all three submit
  modes (plan now, create and refine, add to backlog).
- **Feedback**: the P2 composer. `feedback.attachments` stores
  `{ kind: 'artifact', artifactId }` for a file and `{ kind: 'link', url }` for
  a link; bytes never go into the feedback row.
- **Hand-back** (A4).

At creation, uploads are **pinned immediately** as `Evidence` with
`taskId: null`. Intake does not run at creation, because a mission may sit in
DRAFT, in the backlog or behind a routine for days.

### When intake runs

Intake runs **once per mission**, at the first of:

- the first refinement (P6), or
- the start of planning (inside `#planWithin`, before the authored-workflow
  shortcut).

It is idempotent: an upload that already has an intake artifact is not
converted again. A later upload (feedback) is converted by the round that
receives it (A3), not by mission intake.

Intake is a single best-effort pass on the planner's runtime ladder, with a
fixed objective: *"Turn the uploaded input into `<type>`, preserving its
content. The Evidence is the source of truth."* The target type is chosen from
the media type and filename:

| Upload | Produces |
|---|---|
| Markdown / text / PDF (and anything else) | `ProductSpec` when it contains acceptance criteria, else `ProblemBrief` |
| Image, Figma/design export | `DesignBrief` |
| A GitHub PR link, a patch/diff file | `ImplementationPlan` describing the existing change |

If intake fails or the runtime cannot read the upload, the `Evidence` remains
and planning proceeds without a skip: the worst case is today's behaviour.

### Done-when (P5) still holds

An intake-made `ProductSpec` goes through the same `checkSpecCriteria` /
`replaceSpecCriteria` path as one written by a product step. If that check
fails (an uncovered user criterion, an unknown `covers` key), the spec is
passed as context but **does not cover** the product stage; the planner must
plan it. Refinement reads intake artifacts as context, so it can propose
Done-when criteria from an uploaded spec.

**An upload does not count as a criterion for readiness.** "Plan now" with
uploads but no Done-when lines still creates a DRAFT, exactly as today without
uploads. The New Mission button logic is unchanged.

### The planner may skip, and must say so

`#planWith` now passes `preexistingArtifacts` (the intake artifacts whose
criteria check passed). The planner prompt gains one instruction: when a
preexisting artifact of a stage's output type exists, omit the stage and name
it under `skipped: [{ stage, outputType, artifactId, reason }]`.

A skip has **one record: a `SKIPPED` placeholder task.** There is no stored
plan JSON (the plan is rebuilt from task rows), so materialization creates a
task that:

- carries the covered stage's `expectedOutputs`,
- has `statusReason: "Covered by your upload: <filename>"`,
- is listed in the dependents' `dependsOn`, so `validateTaskGraph` finds a
  producer and dependents satisfy immediately (`SKIPPED` counts as done).

Dependents read the intake artifact through the existing
`artifacts.latest(missionId, type)` fallback in `#loadDependencies`.
`TaskView.coveredBy` is computed on read (`{ artifactId, filename }` for a
`SKIPPED` task whose output type has an intake artifact). The Plan tab shows a
muted row "Spec · covered by your upload"; the feed already hides skipped
tasks that never ran.

**A project's own workflow does not skip.** `#authoredWorkflow` bypasses the
planner, so no `skipped` is produced. The intake artifacts are still available
to its steps through the same fallback.

## A3. Feedback with attachments

A file in the P2 composer is pinned as `Evidence`, referenced from
`feedback.attachments`, and listed among the inputs of the round that picks the
feedback up (`run_inputs`), so the agent reads it. A link is passed through as
text. No intake runs for feedback: the receiving agent is the converter.

## A4. External hand-back

### Parking: "Continue elsewhere"

An **agent** task whose expected outputs include a linkable type (`DesignBrief`,
`ChangeSet`, `ImplementationPlan`, `ProductSpec`) gets **Continue elsewhere**,
available while the task is `READY`, `RUNNING` or `SUCCEEDED` and no downstream
task has consumed its output. `MissionService.parkTask(taskId, { tool })`:

1. checks staffing (`#assertMayTake`);
2. **writes `AWAITING_EXTERNAL` first**, with `statusReason: "Continued in <tool>"`;
3. then aborts a live run (`scheduler.cancelTask`). Because the status is
   already written, the executor's "overtaken" path keeps it instead of
   settling `CANCELLED`;
4. records `task.parked_external { tool }` (new in the `event.ts` union and list).

`TaskView.parkedExternal = { tool, since }`. The scheduler's wait re-adoption
keys on `executor === 'wait'`, so a parked agent task is never re-adopted;
`PARKED_TASK_STATUSES` already keeps it out of the concurrency ceiling. A
regression check pins both.

**`wait` tasks cannot be parked or handed back**; they keep their own
completion path.

### Seeing a parked task (P9, P10, P16)

- **Liveness rule T8 splits.** A `wait` step in `AWAITING_EXTERNAL` stays
  *moving*; a parked hand-back is *waiting on a person*, so its mission is
  "waiting" (L17), not "moving" (L15).
- **Desk** `#needsAPerson` and "waits on a person" rows count parked
  hand-backs; the **Inbox** lists them as "Waiting for your work in <tool>".
- **Notifications (P16):** none at park time (it is the person's own act).

### Handing back

A parked card shows **Hand back**: a note, one contribution (file or link),
and, when downstream tasks consumed an earlier version, the P2 choice
`downstream: 'redo' | 'keep'`. `MissionService.handBack(taskId, request)`:

1. Allowed only on an agent task in `AWAITING_EXTERNAL` with `parkedExternal`.
   Staffing is checked (`#assertMayTake`, `#claimFields`).
2. The contribution is pinned (A1). A link goes through the resolver registry:
   the one resolver is `PullRequestSnapshotPort` (integration-github,
   `gh pr view --json headRefOid,headRefName,title,body` + `gh pr diff`). The
   fetched diff and body become the `Evidence`, with `github.pr` and
   `git.commit` refs. **A link no resolver can read needs `export`**; a bare
   unreadable link is refused: "Nothing here can read that link. Attach an
   export of it."
3. The task's `expectedOutputs` are written as a **human-authored round**:
   `round` bumped explicitly (`completeTask` does not), `supersedes` the
   previous live output, `authorId`/`recordedBy` from the person (or
   `onBehalfOf`), handoff from the note via `deriveHandoff`, and `links`
   carrying the contribution's URL or a `workspace` link. For a `ChangeSet`
   hand-back from a PR, the ChangeSet's `git.branch`/`git.commit` refs are the
   resolver's, so downstream review and QA read that commit.
4. `rounds.onPersonCompleted`, then the reviews pipeline, then
   `scheduler.wake`, as `completeTask` does.
5. For each downstream consumer of the superseded version, `downstream`
   applies the P2 rule: `redo` re-queues the consumer as a new round; `keep`
   flags it with a stale input.

A hand-back does not resume the parked runtime session. The work moved to
another tool; what comes back is a fresh human-authored round.

## A5. Workspace links become real

- The handoff link schema gains `path`, allowed **only** for
  `kind: 'workspace'`; every other kind keeps `url` http(s)-only. `HandoffLink`
  becomes a named type.
- The service layer validates a workspace `path` against the project's
  repository roots and the artifact root (no `..`, no path outside them, no
  symlink that resolves outside).
- New route `GET /v1/artifacts/:id/path` returns
  `ArtifactStorePort.resolvePath(...)`; `POST /v1/workspace-links/resolve`
  resolves a workspace link. The desktop renders a workspace link as
  **Open workspace ↗**, resolved through the daemon and revealed with
  `revealInFinder`. This also fixes the existing bug where `ArtifactReader`
  passed a relative `contentRef` to `revealInFinder`.

## A6. Attribution

- Every contribution stores who did it (`authorId`) and who recorded it
  (`recordedBy`). For the solo owner both are you.
- An outside person without a seat is recorded through `onBehalfOf`; no
  account is needed.
- Intake output is authored by the runtime, responsible to the owner,
  `recordedBy: SYSTEM`, like any agent output.

## A7. API and storage

- `createMissionRequest.uploads`; `giveFeedbackRequest.attachments`;
  new `parkTaskRequest { tool }`; new
  `handBackRequest { note, contribution, downstream?, onBehalfOf? }`.
- `TaskView` gains `parkedExternal` and `coveredBy`. `MissionDetail` gains
  `uploads` (pinned Evidence and its intake artifact, if any).
- **No migration.** Everything fits `feedback.attachments` (010),
  `artifacts`/`artifact_links`, `mission_tasks.status_reason` and the `handoff`
  JSON. The offline check asserts `SCHEMA_VERSION` is unchanged by P3a (019).

## A8. Testing (P3a)

### Offline (`scratch/p3-contributions-check.mjs`, in `OFFLINE_CHECKS`)

- upload → Evidence (deduplicated) → intake → typed artifact over the fake
  runtime; intake runs once, at refinement or planning, whichever is first;
- an intake `ProductSpec` whose criteria check passes produces a `SKIPPED`
  placeholder and a graph that validates; one whose check fails produces no
  skip; an authored workflow never skips;
- `ExternalRef` for file, link, and a resolved PR (stub resolver); a bare
  unreadable link is refused;
- park while running keeps `AWAITING_EXTERNAL`, is not re-adopted and is not
  counted by the ceiling; hand-back bumps the round, sets `supersedes`,
  addresses notes, and applies redo/keep downstream;
- liveness T8 split; Desk and Inbox count a parked hand-back;
- workspace-link path validation (in-repo ok; `../`, out-of-repo and escaping
  symlinks refused);
- `SCHEMA_VERSION` unchanged.

### Real app (`scratch/acceptance/p3/`, CDP 9337, `/tmp/tdm-p3`)

| # | Scenario | Must observe in the window |
|---|---|---|
| D1 | Mission created with an uploaded spec (plan now, with Done-when) | Intake runs before planning; the Plan tab shows "Spec · covered by your upload" and no product task |
| D2 | Continue elsewhere on a design task | The card shows "Waiting for your work in Figma"; the timeline shows `task.parked_external`; the Desk counts it |
| D3 | Hand back a GitHub PR link | A human-authored round lands; the Evidence carries `github.pr` + `git.commit` refs; downstream consumes that commit |
| D4 | Hand back an unreadable link | A bare link is refused with "attach an export"; with an export, the export becomes the Evidence |
| D5 | Hand-back supersedes a consumed version | The dialog offers redo / keep; redo re-queues the consumer |
| D6 | Workspace link | Renders "Open workspace ↗" and resolves to the local path |
| D7 | Attribution | The hand-back card shows "by You · responsible You"; the reader shows recorded-by |
| D8 | Feedback with a file | The file appears as an input of the next round |

---

# Part B — evals

## Problem

Since P12 and P13, a person changes how agents behave all the time: a role's
model, a pinned skill, a skill update, a setup imported from a folder (P15).
Every change goes live for the next real mission, with **no way to know whether
it made things better or worse**. The facts to judge it are already measured
(gates, the Done-when trace, attempts, handoff budgets, tokens, cost, time),
but they are not kept per run (a gate's outcome is thrown away after the
check), and nothing replays the same work under two setups.

The idea comes from eval frameworks such as Mastra's scorers, datasets and
experiments, adapted to Tandemise's principle that the product **measures**, it
does not interpret.

## Goal

1. **Every run is scored.** When a step's run settles, Tandemise stores its
   gate outcome, the facts the gate read, and the measured numbers. The Evals
   screen shows, per role and model, how real work went: first-attempt pass
   rate, mean attempts, criteria failed, cost. No extra spend.
2. **A finished step becomes an eval case.** "Save as eval case" pins
   everything that step saw: the repository at its base commit, the exact input
   artifacts, the role, the step, the mission context and the Done-when
   criteria.
3. **A suite runs against a candidate before it goes live.** An eval run is
   *suite × {current setup, candidate} × N repeats*. A candidate is a different
   model for a role, a different skill pin, or a setup folder. The result is a
   scorecard of measured facts, side by side, with the difference. Nothing about
   the candidate is saved to the project unless the person applies it
   separately.

## Not in P3b

- LLM-judge scorers and sampling rates. Every score is a measured fact. A judge
  may come later, clearly labelled.
- A headless/CI runner (`tandemise eval` on the command line).
- Comparing runtimes (Claude vs Codex) or candidates that change workflows or
  gates.
- Automatically applying the winner. Applying stays the existing role, skill or
  setup action.
- Eval cases from planning or refinement (they have no `Run` row).
- Sharing cases across projects.

## B1. Run scores (every real run)

New table `run_scores`, one row per settled run of a step with a gate, written
by the executor right after `#assess`:

| Column | Source |
|---|---|
| `run_id` (PK), `task_id`, `mission_id`, `workspace_id`, `role_id` | the run |
| `model`, `skills` (JSON) | `runs.model`, `runs.skills` |
| `attempt`, `round`, `purpose` | `runs` |
| `gate_passed`, `gate_detail` | `GateService.evaluate` |
| `facts` (JSON) | the fact map `GateService.factsFor` produced |
| `criteria_verified/failed/unverified` | `traceCriteria` when a QA reading exists |
| `over_budget` | count of this run's output artifacts with `over_budget` |
| `input_tokens`, `output_tokens`, `cost_usd`, `wall_time_ms` | the run's usage |
| `scored_at` | |

Rows are append-only and never read by the engine (scores are a record, never
an input). Existing runs are not backfilled.

**"From your runs"** on the Evals screen groups rows by role × model over a
chosen window (7/30/90 days): runs, first-attempt gate pass rate, mean attempts
to pass, criteria failed, median cost, median time. Eval-trial runs are
excluded.

## B2. Eval cases and suites

**Save as eval case** appears on a step that `SUCCEEDED` and has a run (feed
card menu and task view). `EvalService.saveCase(taskId, { suiteId | newSuiteName, name })`
snapshots:

- **repository** and **base commit SHA**, resolved at save time from the branch
  the step started from (upstream ChangeSet's `git.commit`, else the mission
  base branch resolved with `git rev-parse`). If it cannot be resolved (the
  branch was deleted), saving is refused with the reason;
- **input artifacts** from `run_inputs.listByRun(firstRun)` of the passing
  round, stored as `{ type, contentHash, handoff, title }`. The content is
  addressed by hash in the artifact store, so a case survives deleting its
  mission; ids are kept only as provenance;
- **the step**: role, objective, expected outputs, input types, completion
  gate, retry policy, model policy (without the model);
- **mission context**: goal, constraints, knowledge, accepted decisions and
  answered questions (what `#compilePrompt` reads);
- **criteria**: the live `mission_criteria` rows (key, text, covers);
- **provenance**: source mission, task and run, the reference output artifact
  hashes, who saved it and when.

Suites are named lists of cases per project. A case belongs to one suite.
Cases are immutable; deleting one and saving again is how a case changes.

## B3. Eval runs

`EvalService.startRun(suiteId, { candidate, repeats, spendCapUsd })`:

- `repeats` 1–10 (default 3); `spendCapUsd` required (default $5);
- `candidate` is one of:
  - `{ kind: 'models', roles: { [roleId]: model } }`
  - `{ kind: 'skills', roles: { [roleId]: SkillPinRef[] } }` (resolved to hashes
    at start; they must exist in the store)
  - `{ kind: 'setup', folder }` (read with `readSetup`; each role's model,
    escalation, economy model, instructions, capabilities and skills apply)
- the **baseline** variant is the project's current setup, captured at start.
  Both variants are frozen as JSON on the `eval_runs` row, so later role edits
  do not change a run in flight.

### Trials

Each case × variant × repeat is one **trial**, run in its own hidden mission:

- the mission row carries `eval_trial_id` (new column);
- one `SUCCEEDED` stub task per input type owns the seeded input artifacts
  (re-written from their hashes), so `#loadDependencies` loads every one;
- one task for the step, with `isolation: 'worktree'` forced and
  `mission.baseBranch` set to the pinned SHA;
- the variant applies through task fields and one new seam:
  - **model**: `task.modelPolicy.model` with `pinned: true`. `resolveModel`
    gains the rule that a pinned step model beats economy mode (R3), so limit
    pressure cannot mask the candidate. Escalation on retry still applies from
    the variant's ladder.
  - **skills**: `task.skills` set to the variant's resolved pins.
  - **role instructions/capabilities** (setup candidates): a new
    `TaskExecutorDeps.roleFor(task, workspaceId)` seam returns a `RoleTemplate`
    built from the variant's `RoleSetup` for trial missions, and the database
    role otherwise.

An `EvalRunner` runs trials **one at a time**, calling `TaskExecutor.execute`
directly; the scheduler never dispatches trial missions. A `READY` result with
`retryAfterMs` is re-run by the runner within the task's retry policy.

A trial never escalates to a person: remediation and rounds are not triggered
(`#settled` is scheduler-only), branch integration does not run, and where the
executor would create an intervention approval or a missing-skill card, a trial
mission instead ends the trial as **blocked** with the reason.

After a trial settles, the runner stores the trial's score (same shape as
`run_scores`, from its last run), removes the trial's worktree and branch, and
leaves the hidden mission's rows in place for inspection.

A run stops starting new trials when its measured spend reaches
`spendCapUsd` (`stopped_at_cap`). It can be cancelled (aborts the live trial).

### Hidden from the rest of the product

A mission with `eval_trial_id` is excluded from: backlog, backlog pull and WIP
count (P7); mission lists, Desk and projection (P10); liveness (P9); issue
sweep (P14); notifications and approvals (P16); mission and monthly limit
admission (P8).

**Spend is not hidden.** Eval spend is recorded as usage and counts toward the
project's monthly spend total; the Limits screen shows it as its own line
("of which evals"). The run's own `spendCapUsd` is its guard.

## B4. The scorecard

`scoreEvalRun(run, trials)` is a pure function in `@tandemise/evaluation`.
Per variant (baseline, candidate) and the difference:

| Metric | Definition |
|---|---|
| Trials | completed / blocked / failed |
| Gate pass rate | trials whose final gate passed ÷ completed trials |
| First-attempt pass rate | passed on attempt 1 ÷ completed trials |
| Criteria | verified / failed / unverified totals (cases whose step reads QA) |
| Mean attempts | across trials |
| Over-budget outputs | count |
| Tokens, cost, time | mean and total |

And per case, the same metrics, so a regression points at the case that caused
it. With N < 3 the scorecard adds "few repeats, differences may be noise". No
statistics beyond counts, rates and means are claimed.

## B5. Where it shows up

- **Evals screen** (Project → Evals) with three tabs:
  - **Suites**: cases, with source mission links and delete.
  - **Runs**: start a run (suite, candidate form, repeats); progress; cancel;
    a finished run's scorecard.
  - **From your runs**: B1.
- **Save as eval case** on succeeded steps (B2).
- **Try on evals**: in the setup import preview (P15), which starts a `setup`
  candidate for the chosen folder; and on the Skills screen next to an update,
  which starts a `skills` candidate with the new version. Both open the Runs
  tab prefilled.

## B6. API and storage

**Migration 020 (`evals`)**, additive:

- `run_scores` (B1);
- `eval_suites` (id, workspace, name, timestamps);
- `eval_cases` (id, suite, name, repository, base_sha, snapshot JSON,
  provenance JSON, created_by, created_at);
- `eval_runs` (id, suite, status `queued|running|completed|cancelled|stopped_at_cap|failed`,
  repeats, spend_cap_usd, variants JSON, scorecard JSON, started_by, timestamps);
- `eval_trials` (id, run, case, variant `baseline|candidate`, repeat, mission,
  status `queued|running|passed|failed|blocked|cancelled`, reason, score JSON,
  timestamps);
- `missions.eval_trial_id` (nullable, indexed).

Routes under `/v1/workspaces/:id/evals/…`: suites (list, create, delete), cases
(save, delete), runs (start, get, cancel), `run-scores` summary. A task route
`POST /v1/tasks/:id/eval-case` saves a case.

## B7. Testing (P3b)

### Offline (`scratch/p3-evals-check.mjs`)

- a settled run writes one `run_scores` row with its facts; a trial's run is
  excluded from "From your runs";
- save case: snapshot contains base SHA, input hashes, step and criteria; an
  unresolvable base is refused; a case survives deleting its source mission;
- a trial seeds every input under stub tasks, forces a worktree at the pinned
  SHA, uses the variant's model even under limit pressure, and the variant's
  skill hash;
- a trial is invisible to backlog, Desk, liveness, notifications and limit
  admission; its worktree and branch are gone afterwards;
- a gate that exhausts attempts ends the trial `failed`; a missing skill ends it
  `blocked`; neither creates an approval;
- the spend cap stops the run;
- scorecard math on fixed trial rows (pure);
- deterministic difference: the scripted agent writes a passing output for
  model `good` and a failing one for model `bad`; the scorecard shows it.

### Real app (`scratch/acceptance/p3-evals/`, CDP 9338)

| # | Scenario | Must observe in the window |
|---|---|---|
| E1 | Save as eval case on a succeeded build step | The case appears in the suite with its base commit and inputs |
| E2 | Run a suite, baseline vs a model candidate, 3 repeats | Progress, then a scorecard with both variants and the difference; no trial appears in Missions, Desk or Inbox |
| E3 | Candidate from a setup folder via "Try on evals" in the import preview | The run is prefilled with the setup candidate; the setup is **not** applied |
| E4 | Spend cap | The run shows "Stopped at your $ cap" |
| E5 | From your runs | Role × model rows with first-attempt pass rate and cost from real missions |
| E6 | Cleanup | No `tandemise/*eval*` worktrees or branches remain after the run |

## Rulings

1. **Two pull requests.** P3a has no migration; P3b adds migration 020.
2. **Intake is lazy**: pin at creation, convert at the first refinement or
   planning. Uploads never count toward readiness.
3. **A skip is a `SKIPPED` placeholder task**, not stored plan JSON; `coveredBy`
   is computed on read.
4. **An intake `ProductSpec` covers a stage only if its criteria check
   passes**, the same rule as a product step.
5. **Hand-back is an agent-task path.** It bumps the round explicitly and takes
   the P2 redo/keep choice; `wait` tasks are excluded.
6. **Park writes the status before aborting the run.**
7. **The first and only snapshot resolver is a GitHub PR, via `gh`**, behind a
   domain port. Everything else needs an export.
8. **Scores are measured facts, never judged**, and never read back by the
   engine.
9. **A trial is a hidden mission executed directly by `EvalRunner`.** The
   scheduler never sees it, and nothing in it can reach a person.
10. **A pinned step model beats economy mode**; this is the only change to
    `resolveModel`, and only eval trials set `pinned`.
11. **Eval spend is real spend**: it counts toward the monthly total, shown
    separately, and each run has its own required cap.
