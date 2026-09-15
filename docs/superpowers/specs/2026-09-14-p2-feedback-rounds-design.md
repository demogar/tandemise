# P2: Feedback and rounds

Status: design, 2026-09-14 (grounded against the code on feat/p1-handoff-feed; corrections in §10). Parent: [collaboration roadmap](2026-09-13-collaboration-roadmap.md). Builds on P0 (people, staffing, reviews) and P1 (handoff contract, feed).

## Problem

You can't iterate on a task. The engine has pieces that nobody can reach, or that behave badly:

- **Reject-with-note** clones the task as `<key>_revision_N` and marks the original SKIPPED. The plan fills with duplicates.
- **Retry-with-note** exists in the API (`POST /v1/tasks/:id/retry {note}`), but the app has no note field. The note reaches the agent framed as a gate failure ("Your previous attempt did not satisfy this task's completion gate…"). A SUCCEEDED task can already be retried back to READY, with that same framing and without touching finished dependents.
- **A retry doesn't see its own previous output**, so it rewrites instead of editing.
- **You can't send a note to a running task.** The only single-task stop is Skip.
- **Nothing records which artifacts a run consumed.** The context compiler computes `includedArtifactIds` and the executor discards it.
- **A finished session is never continued** with new instructions.

## Goal

From any card (feed, Inbox, reader), a person gives feedback on a task's output at any time: while it waits, after it finished, or while it runs. The same task comes back as the next **round**:
- it continues its session when it can, or otherwise starts from its last output plus every piece of feedback so far;
- its handoff says what changed and which feedback each change answers;
- the person decides what happens to work that already used the old version.

AI reviewers take part in the same loop: their blocking findings become feedback items.

## Not in P2

- Uploads, hand-backs from external tools, and snapshots → P3. The feedback shape reserves `attachments` for them.
- Accounts and notifications → P4.

## 1. Concepts

### Round

A task has rounds 1..n.
- Round 1 is the task's first passed attempt.
- Each later round starts because of feedback.
- Attempts (retries after gate failures) happen *inside* a round and do not start a new one.

Stored fields:
- `mission_tasks.round` (current round number);
- `artifacts.round` (the round that produced the artifact);
- `runs.round`.

The artifact `supersedes` chain already links versions. "v2" in P1 equals round 2 whenever each round produced one artifact per type.

### Feedback item

| Field | Notes |
|---|---|
| `id` | `fb_…` |
| `taskId` | required |
| `artifactId` | optional: feedback about one output |
| `authorId` | actor: a person member, or an agent member (AI reviewer findings) |
| `recordedBy` | the P0 on-behalf-of rule |
| `text` | 1–4000 chars |
| `attachments` | `[]`, reserved for P3 |
| `status` | `open` · `queued` (waiting for a running pass to end) · `in_round` (being addressed by round N) · `addressed` (round N delivered and cited it) · `dismissed` |
| `round` | the round that addresses it, when known |
| `createdAt` | |

A new `feedback` table. Timeline events: `feedback.given`, `feedback.addressed {round}`, `feedback.dismissed`.

## 2. Giving feedback

Entry points:
- a **"Request changes"** button on every feed card (P1 `HandoffCard`) whose task has run;
- the reader header;
- the Inbox approval card, replacing today's reject-with-note;
- the task drawer.

The composer is a single textarea ("What should change?") with:
- a "Recording for" selector (P0 rule), shown only when the workspace has other people;
- optional "About": the whole task, or one specific output.

What happens depends on the task's state:

| Task state | Effect |
|---|---|
| AWAITING_APPROVAL (blocking review card open) | The review card is decided "Request changes" with this feedback. The task starts its next round. No SKIPPED clone. |
| SUCCEEDED | The **downstream impact** step (§3) runs first. The task then reopens as the next round. |
| RUNNING / AWAITING_INPUT | The item is `queued`. It is delivered when the current pass ends (§4). |
| AWAITING_HUMAN (person-staffed) | The item is attached. The person sees it on their card and addresses it when they complete. |
| PENDING / READY (not run yet) | The item is attached and included in round 1's prompt. |
| FAILED / BLOCKED / CANCELLED | The next attempt becomes a new round carrying this feedback (a retry with a note, correctly framed). |

**Several items** given before a round starts all go into that round.

**Revision clones:** `remediation.planRevision` is no longer used for owner feedback. Existing `_revision_N` tasks in old missions still display. AI **fix tasks** (a different role fixing review/QA findings) stay as they are.

## 3. Downstream impact ("ask me each time")

When feedback reopens a SUCCEEDED task, Tandemise computes its **dependents that consumed its output**: tasks whose latest run recorded (in `run_inputs`, §7) an artifact of this task, transitively. Runs from before migration 010 have no record; for them the fallback is a dependent whose `inputArtifacts` include one of this task's output types and whose run started after that artifact was created.

A dialog then shows:
- "Build (done), Review (running) used Design v2";
- options "Redo them after the new version" (the default when any of them is still running) and "Keep their work";
- a per-task checkbox.

**Redo:**
- running dependents are cancelled;
- finished or waiting dependents are reset to PENDING, with a timeline reason "Redone after <task> round N";
- their review cards are withdrawn;
- they resolve staffing again when they become READY (P0 rules).

**Keep:** dependents stay. When the new round lands, each gets a `needsAttention` flag: "Built against Design v2; v3 is out".

With no dependents, the dialog is skipped.

## 4. Notes to a running task (wake rules)

A queued item is delivered when the current pass ends, before the task settles. The executor:
1. harvests the pass;
2. if queued items exist, continues the same session (`session_resume`) with the feedback prompt, as another pass in the **same round**;
3. otherwise, when resume isn't available, runs a fresh attempt with the draft plus the feedback.

This pass doesn't count against `maxAttempts`. It uses the P1 tighten-pass slot hand-over and restart rules.

Only `end_of_pass` delivery is in P2. An `interrupt` wake setting (stop at a safe point and resume with the note, Buzz-style) is parked: see §10.

## 5. Running a round

The prompt for round N+1 contains:
- **Your previous output**: the latest live artifact bodies for this task (capped as in P1).
- **Feedback to address**, numbered, e.g. `fb_… (Maria Lopez): …`. It includes all open and in-round items, plus earlier rounds' items marked as addressed, for context.
- **Instruction:** edit, don't rewrite. Keep what wasn't asked to change. Fill `handoff.changed` with one entry per change, and cite the `feedback` id it answers. Every open item must be either addressed in `changed` or explicitly declined in a `changed` entry: `what: "Declined: <reason>"`.

This is framed as an owner's request, not a gate failure (the P0 lesson).

**Session:** continue the last run's session when the runtime declares `session_resume` (today: Claude Code) and that run has an `externalSessionId`, whatever the run's status. This is new: today only RESUMABLE (interrupted) runs resume, and the P1 tighten pass continues a session only before the task settles. The round passes `continueSession` the way the tighten pass does. Otherwise start a fresh run with the prompt above; the previous output is inlined in both cases, so a continued session that lost context still has it.

**Validation** (the P1 handoff contract, tightened for rounds ≥ 2):
- `changed` has at least one entry;
- every `feedback` id cited exists and belongs to the task;
- every open item is cited.

A violation is a malformed artifact, which triggers a retry with the specific missing ids.

**Reviews:** the P0 review pipeline runs again for the new round, since reviews apply per round.

**AI review findings.** Today a `ReviewReport` task's blocking findings (`Evaluation`/`Finding`, gate `review.blocking_findings`) make `RemediationPlanner.plan()` add `fix_<key>_N` and `<key>_recheck_N` tasks. In P2, when the reviewed task is a task of this mission, its blocking findings instead become feedback items on the reviewed task, authored by the reviewer's agent member (or the runtime when unstaffed). The reviewed task starts its next round automatically, and the review task is redone after it (§3 Redo, without asking: the reviewer asked for it). Capped at `MAX_REMEDIATION_CYCLES` (3) AI-started rounds; then the task escalates to the responsible person with an intervention card, as today. `QAReport` defects keep today's fix-task flow (parked, §10).

**Addressed items:** when a round lands, the items it cited become `addressed` with `round: N`.

## 6. What a person sees

- **Feed card:**
  - a round badge, e.g. "Round 3";
  - under the headline, "What changed", listing `handoff.changed` (≤ 3 items, each with the feedback author's name);
  - open feedback count ("2 notes pending");
  - "Request changes".
- **Reader:** a version switcher (v1…vN), and "Changes in vN" with each change linked to its feedback text.
- **Task drawer:** the feedback thread, which is a flat list of items per round with their status. It is not chat.
- **Inbox:** "Request changes" replaces "Reject" on output review cards. "Reject without changes" stays as a secondary action that blocks the task.
- **Timeline:** `feedback.given` / `feedback.addressed`, plus round boundaries.

## 7. Data changes (migration 010)

- New table `feedback(id, task_id, artifact_id, author_id, recorded_by, text, attachments json, status, round, created_at, updated_at)`.
- `mission_tasks.round INTEGER NOT NULL DEFAULT 1`
- `artifacts.round INTEGER`
- `runs.round INTEGER`
- `runs.purpose TEXT` (`round` | `tighten` | `feedback` | `retry`)
- New table `run_inputs(run_id, artifact_id, PRIMARY KEY(run_id, artifact_id))`, written from the compiler's `includedArtifactIds` when a run starts.
- `POST /v1/tasks/:id/retry {note}` becomes feedback: the note is stored as a feedback item and the retry is a round framed as a request (C12). A retry without a note keeps today's behaviour.

## 8. API

- `POST /v1/tasks/:id/feedback {text, artifactId?, onBehalfOf?}` → `{feedback, impact?: DownstreamImpactView}`. When the task is SUCCEEDED and has dependents, the round does not start until confirmed.
- `POST /v1/tasks/:id/rounds {feedbackIds, downstream: 'redo' | 'keep', redoTaskIds?}`: confirms and starts the round.
- `GET /v1/tasks/:id/feedback`
- `POST /v1/feedback/:id/dismiss {onBehalfOf?}`
- `decide` gains option `request_changes` with note → feedback + round.
- Views:
  - `FeedCard` + `round`, `openFeedback`, `changed` (resolved authors);
  - `TaskView` + `round`, `feedback`.

## 9. Acceptance (real app)

| # | Scenario | Must observe |
|---|---|---|
| C1 | Tweak a finished doc | Feed card → Request changes "Shorter intro" → no dependents → Round 2 runs and continues the session → card shows Round 2 with "What changed" citing the note |
| C2 | Tweak with dependents | Request changes on design after build finished → dialog lists Build → Redo → build resets and reruns against v2; Keep → build flagged "built against v2" |
| C3 | Review → request changes | Inbox review card → Request changes → same task, round 2, no `_revision_` task in the plan |
| C4 | Note while running | During a 20 s scripted run, give feedback → it's queued, then delivered at pass end → one extra pass, same round, attempts unchanged |
| C5 | Several notes | Two notes before the round starts → the round cites both in `changed` |
| C6 | Missing citation | Scripted agent omits one feedback id → retry names the missing id → next pass succeeds |
| C7 | AI reviewer feedback | A review task whose gate reads `review.blocking_findings`, run by an agent, finds problems → feedback items authored by the review agent → round 2 starts automatically → review passes |
| C8 | Your own step | Feedback on your own docs step while it waits for you → your card shows the note → completing it records the round |
| C9 | Decline | Agent declines a note with a reason → card shows "Declined: …" linked to the note |
| C10 | Real Claude | A doc round on Claude Code continues the same session (same session id), and the tweak is visible in the diff between versions in the reader |
| C11 | Beyond docs | Request changes on a ChangeSet (code task) → the round edits the branch → review reruns |
| C12 | Retry from blocked | Blocked task → "Retry with a note" → the note reaches the agent as a request, not a gate failure |

## 10. Rulings from grounding against the code

- **Dependents are known from records, not guessed.** `run_inputs` is added because nothing records consumption today. Cost if wrong: one small table.
- **Redo can reset finished dependents.** Today's `#holdDependents` deliberately leaves SUCCEEDED dependents alone ("redoing it is the person's call"). The dialog *is* the person's call, so Redo resets them; Keep leaves them and flags them.
- **Continuing a settled session is new engine work**, generalising the tighten pass's `continueSession`. Codex implements resume but does not declare `session_resume`; it gets fresh rounds.
- **Task transitions stay per call site.** There is no task state machine to extend; P2 adds guards where it reopens tasks rather than introducing one. Cost if wrong: later refactor.
- **AI review findings become rounds; QA defects keep fix tasks.** A review asks the author to change their work (a round). A failing QA case may need a different role, so it stays a fix task for now.
- **`interrupt` wake is parked.** Notes wait for the current pass to end. Cost: a note to a long pass waits minutes.
- **`check` cards:** "Needs changes" on a check (today only a `needsAttention` flag) becomes feedback that starts a round, like "Request changes" on a blocking review.
- **Focus on you plus agents (2026-09-14).** Acceptance is proven for a solo owner; C8 is your own step, not a teammate's. Team paths (onBehalfOf, other people's steps) stay implemented as the P0 rules require and are covered by offline checks only.
- **Workflow steps that declare no `inputs:` record no run inputs, so a round upstream of them finds no consumers; planner-made plans infer inputs from direct dependencies (required: false).**
