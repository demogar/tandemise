# P2 acceptance: proven in the real app

**Final build `f417490`: P2 12/12 scenarios (151 checks) in one uninterrupted run, C10 on real Claude Code. On the same build, P1 15/15 ([p1/REPORT.md](p1/REPORT.md)) and P0 20/20 ([p0/REPORT.md](p0/REPORT.md)).** Full P2 log: [REPORT.md](REPORT.md).

Focus (user decision, 2026-09-14): **you plus agents**. Every P2 scenario runs in a solo workspace and asserts that no "Recording for" control appears. Team paths stay implemented and are covered by offline checks.

## How it was run

Same harness as P0 and P1: fresh `TANDEMISE_HOME` and project, the daemon from this branch, Electron over CDP. `node scratch/acceptance/p0/run-all.mjs --p2` runs C1–C12 (`--skip-claude` skips C10). Every action a person takes happens in the window: Request changes, the impact dialog, Inbox decisions, Retry with a note, the reader's version switcher. The API is used only to read state as proof. The scripted agent replaces the model except in C10. C1 proves session continuation on the built-in fake runtime (a `session.resumed` checkpoint); C10 proves it on Claude Code.

## Scenarios

| # | What you do | Proven |
|---|---|---|
| C1 | Request changes on a finished doc | Round 2 continues the session; the card shows "Round 2" and "What changed" citing your note |
| C2 | Request changes on design after build and review used it | The dialog names who used which version. Redo: build and review rerun on the new version. Keep: build is flagged "Built on an older version of design" |
| C3 | Request changes from the Inbox review card | Same task, round 2, no `_revision_` task; options Approve · Request changes · Reject without changes |
| C4 | Leave a note while the task runs | "Queued: delivered when the current pass ends"; one extra pass in the same round; attempts unchanged |
| C5 | Leave two notes before the round runs | Both join round 2 ("Joins this round") and both are cited |
| C6 | The agent forgets to cite a note | "Round 2 left 1 note unanswered; trying again." Next attempt cites it |
| C7 | An AI reviewer finds a blocking problem | Its finding becomes a note on build, round 2 starts by itself, the review reruns and passes |
| C8 | Leave a note on your own step | "For this step" on your card and drawer; completing the step addresses it |
| C9 | The agent declines a note | "Declined: …" on the card and in the reader, linked to your note |
| C10 | Request changes on a doc written by real Claude Code | Same session continued; the reader shows v1/v2, "Changes in v2" linked to your note, and Compare |
| C11 | Request changes on code | The round edits the same branch; the review reruns |
| C12 | Retry a blocked task with a note | The note reaches the agent as a request, never as "did not satisfy this task's completion gate" |

## Found by reviews and the real app, and fixed

- A Redo could be overwritten by a pass that was already settling; output from an overtaken pass stayed "live".
- A note delivered to a running task could exceed the concurrency limit; a runtime failure during delivery burned an attempt.
- After a delivery pass the gate read the old checks; a crash during a round's tighten never marked notes addressed.
- Your own step and a start-card task downstream were not held when their upstream started a round.
- "Reject without changes" with a note started a round; a review with no recorded inputs was never redone.
- Long drawers and dialogs could not scroll (pre-existing).
- Readability: raw ids and "Missing expected artifacts" on a missed citation; your own name instead of "You"; a kept task labelled "Changes requested after the fact"; identical output chips per version; "1 tasks"; ids on Plan cards.

## Parked

- Timeline lines still print long local paths ("wrote ProductSpec to /private/var/…"), pre-P2.
- A claimed pool person step loses its claim when held (team-only).
- Same-type supersede makes a downstream retry's recorded inputs point at its own draft (P1 lineage).
- Narrow crash windows: RESUMABLE→INTERRUPTED on a signed-out delivery run; notes marked addressed just before the task settles.
- Notes queued during a tighten pass or review routing wait for a manual "Start round".
- Workflow steps with no `inputs:` record no run inputs, so rounds upstream of them find no consumers (planner-made plans infer inputs).
