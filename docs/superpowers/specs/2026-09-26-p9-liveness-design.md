# P9: Nothing waits silently

Status: design, 2026-09-26. Builds on P8 (limits, `LimitService`), P7 (the backlog) and P6 (refinement). Stacked on P8.

## Problem

A person running their own agents finds out a mission is stuck by opening it and noticing nothing has changed.

- **A mission can stop moving with nothing in the Inbox.** A step blocked because no runtime is routed to its role, a step a person chose to "Leave blocked", a rejected plan, a start card someone declined, a step cancelled mid-run: each leaves the mission unable to move and nothing addressed to anyone. The Inbox shows cards and human steps only; Home shows a BLOCKED badge only for missions whose status happens to read BLOCKED, and the scheduler only sets that when no worker is busy anywhere in the daemon, so a stuck mission can keep reading "Executing".
- **An agent can go quiet and nobody is told.** A run that stops writing output keeps its worker slot until its wall-time budget (25 to 30 minutes by default) runs out. The only sign is a spinner that never changes.
- **When something is in the Inbox it is not always the thing the mission waits on.** A mission could show a blocked card on Home and a card in the Inbox for the same cause, or neither.

## Goal

Whenever work cannot move, the person gets **exactly one** Inbox item that says what it needs and offers the one action that moves it. When an agent goes quiet, the person is told before its wall-time budget is gone, and chooses to stop and retry it or keep waiting.

- A **liveness invariant**, decided by the daemon from rows: every mission is, at any moment, *moving*, *waiting on the person with an Inbox item*, *parked by the person's own choice*, *finished*, or *stalled*. A stalled mission gets one derived **Stalled** row in the Inbox, with its reason and one primary action (Retry the step, Re-plan, Refine or Cancel) through routes that already exist. The row disappears the moment the mission can move again.
- A **silent-run watchdog**: every agent event stamps the run's `last_event_at`. Quiet for 10 minutes, the step reads "Quiet"; quiet for longer (30 minutes, or half the step's wall-time budget if that is sooner) the Inbox gets a row "Quiet for 34 min: <step>" with **Stop and retry** and **Keep waiting**. The daemon never stops a run on its own.

Everything is derived at read time from the rows. Nothing an agent says decides it.

## Not in P9

- Reassigning a stuck step to another agent or runtime automatically.
- A model judging whether an agent is "making progress"; silence is measured, not interpreted.
- A ledger of run outcomes over time (P10 reads the facts this slice publishes).
- Stopping a quiet run automatically. The wall-time budget stays the only automatic stop.

## 1. The liveness invariant

The rule is a pure function in the domain (`classifyLiveness` in `packages/domain/src/entities/liveness.ts`), fed from rows by `LivenessService`. It is exhaustive over every non-terminal mission status and every task status in the codebase, including P6 refining drafts, P7 queued drafts and P8 limit pauses. The table below is the rule; each row has an id the offline check seeds and asserts.

Kinds:

- **moving**: the daemon moves it without anyone (a run, a dispatch, a pull, a planner).
- **waiting**: it waits on the person, and an Inbox item for that already exists.
- **parked**: the person's own choice (paused, kept paused, a draft not queued). No row.
- **finished**: nothing more will happen. No row.
- **stalled**: nothing moves it and nothing asks the person. One **Stalled** row.

### Missions

| Id | Mission status | Condition | Kind | Inbox item |
|---|---|---|---|---|
| L1 | COMPLETE, FAILED, CANCELLED | terminal | finished | none |
| L2 | RELEASED, OBSERVING | after shipping (no code path sets them today) | finished | none |
| L3 | PAUSED | paused at a limit ("Limit reached: …", "Monthly limit reached: …") | waiting | the limit card (P8) |
| L4 | PAUSED | paused by the person, or "Kept paused at its limit" | parked | none |
| L5 | DRAFT | a refinement pass is running (P6) | moving | none |
| L6 | DRAFT | refinement left questions or proposals to decide (P6) | waiting | Refinement row |
| L7 | DRAFT | not queued (P7) | parked | none |
| L8 | DRAFT | queued and ready to plan (P7) | moving: pulled when there is room; its Backlog row says what holds it (WIP, spend) | none |
| L9 | DRAFT | queued, not ready, nothing to decide, not refining | stalled | Stalled → **Refine** |
| L10 | PLANNING | the planner is running in this daemon | moving | none |
| L11 | PLANNING | no planner is running | stalled | Stalled → **Re-plan** |
| L12 | AWAITING_PLAN_APPROVAL | a pending plan card | waiting | the plan card |
| L13 | AWAITING_PLAN_APPROVAL | no pending plan card | stalled | Stalled → **Re-plan** |
| L14 | working¹ or BLOCKED | the mission has no steps | stalled | Stalled → **Re-plan** (BLOCKED) or **Cancel** (working) |
| L15 | working¹ | a step can move (T1, T4, T5, T8), or every step is finished (the scheduler completes it on its next pass) | moving | none; a quiet run gets its own row (§2) |
| L16 | BLOCKED | a step is RUNNING or AWAITING_INPUT (its run settles) | moving | none |
| L17 | working¹ or BLOCKED | nothing moves, and the person is asked: a pending card on the mission other than a check, or a step waiting on a person (T6, T7, T9, T11) | waiting | that card or step row |
| L18 | working¹ or BLOCKED | nothing moves and nothing asks | stalled | Stalled → **Retry <step>**, else **Re-plan**, else **Cancel** |

¹ working = EXECUTING, REVIEWING, QA, READY_TO_SHIP: the statuses the scheduler dispatches in.

A check card (`kind: check`) waits on nobody: work never stops for it, so it never counts as the item a stalled mission waits on.

### Steps (tasks)

Read inside a working¹ mission unless the row says otherwise. In a BLOCKED mission the scheduler dispatches nothing, so only a live run (T5, T6) moves.

| Id | Task status | Condition | Counts as |
|---|---|---|---|
| T1 | PENDING | every dependency SUCCEEDED or SKIPPED | can move: promoted on the next pass |
| T2 | PENDING | a dependency is not finished | follows its upstream; never a cause itself |
| T3 | PENDING | a dependency FAILED or CANCELLED | follows its upstream (the scheduler blocks it) |
| T4 | READY | | can move: dispatched; a deferral ("Waiting for a runtime slot") stays on its row |
| T5 | RUNNING | | can move; watched for silence (§2) |
| T6 | AWAITING_INPUT | a live run parked on its question card | waiting (the question card) |
| T7 | AWAITING_HUMAN | | waiting (the Inbox step row) |
| T8 | AWAITING_EXTERNAL | a wait step polls until its own timeout | can move |
| T9 | AWAITING_APPROVAL | a pending card for it | waiting |
| T10 | AWAITING_APPROVAL | no pending card | stall cause → Retry |
| T11 | BLOCKED | a pending card for it ("… exhausted its retries") | waiting |
| T12 | BLOCKED | "Blocked by <upstream>" | follows its upstream |
| T13 | BLOCKED | any other reason (no runtime routed, left blocked, output rejected, start declined, attempt threw) | stall cause → Retry |
| T14 | FAILED, CANCELLED | the mission is not finished | stall cause → Retry |
| T15 | SUCCEEDED, SKIPPED | | done |

### The stalled row's action

The first that applies, so a person always has one thing to press:

1. **Retry <step key>**: the first stall cause (T10, T13, T14) in plan order, via `POST /v1/tasks/:id/retry`. The reason names the step and quotes its status reason: "'implement' is blocked: A human declined to retry this task."
2. **Re-plan**: nothing has started (every step PENDING or READY with no attempts, as after a rejected plan) and the mission may re-enter planning, via `POST /v1/missions/:id/plan`. The reason is the mission's own ("The plan was rejected. Re-plan or change the mission goal.").
3. **Refine** (L9) via `POST /v1/missions/:id/refine`, **Re-plan** (L11, L13, L14 BLOCKED) via `POST /v1/missions/:id/plan`.
4. **Cancel mission** otherwise (a failed branch integration, a working mission with no steps), via `POST /v1/missions/:id/cancel`, confirmed first.

Every row also opens the mission. The row is derived on each read; it is gone as soon as the action moves the mission, with no state to clear.

### One item per cause

The invariant is what keeps the Inbox honest: a mission is stalled **only** when nothing asks the person, so a stalled row never sits next to a card or a step row for the same mission. A limit-paused mission has its card and no stalled row (L3); a mission the person paused has neither (L4). A quiet run's mission is moving (L15), so it has the quiet row and never a stalled row. Home's blocked-mission cards leave out any mission already in "Needs you now", so Home never shows one cause twice either.

## 2. The silent-run watchdog

- Every agent event of a run stamps `runs.last_event_at` (it starts at the run's start). The existing heartbeat stays throttled for recovery; `last_event_at` is exact.
- Thresholds, per run: **quiet** after `TANDEMISE_QUIET_MS` (default 10 minutes); **silent** after the sooner of 3 × quiet (30 minutes) and half the step's wall-time budget, never before quiet. With the default 30-minute budget a step is silent after 15 minutes, while half its budget is still left to act on.
- Only a run that is live (STARTING, RUNNING) on a RUNNING step is watched. A step parked on a question (AWAITING_INPUT) is waiting on the person, not silent.
- **Quiet**: the step's drawer reads "Last activity 12 min ago · Quiet". No row.
- **Silent**: the Inbox shows "Quiet for 16 min: <step>" with the mission, and **Stop and retry** / **Keep waiting**. Home's "Needs you now" counts it.
- **Keep waiting** (`POST /v1/runs/:id/snooze`) hides the row until the run has been silent one more silent interval; any agent event clears it for good. A timeline note says so.
- **Stop and retry** is `POST /v1/tasks/:id/retry` with `stopRun: true`: the run is cancelled and the step goes back to READY in one decision, its attempt budget extended, exactly as a retry with more access already stops a run parked on a question. The scheduler starts attempt 2 once the old run has unwound.
- The scheduler's pass asks the watchdog once per pass. When a run first turns quiet or silent (or a snooze runs out) the mission's timeline gets one note ("'implement' has been quiet for 10 min: its agent wrote nothing. It keeps running; Tandemise never stops it on its own.") and the tasks topic is invalidated, so the window refreshes without polling.

## 3. Facts

| Fact | Meaning |
|---|---|
| `mission.stalled` | 1 when the liveness rule says the mission is stalled, 0 otherwise |
| `run.silent_minutes` | minutes since the step's live run last wrote an event; absent with no live run |

Both are in the published vocabulary; `LivenessService.facts(missionId)` computes them (P10 reads them). They are not part of `GateService.factsFor`: no step's completion gate reads liveness.

## 4. Data (migration 015)

Additive:

- `runs.last_event_at TEXT` (backfilled from `heartbeat_at`, else `started_at`).
- `runs.watch_snoozed_until TEXT NULL`.

The stalled state is not stored: it is derived at read time, so it can never disagree with the rows it is derived from.

## 5. API

| Route | Does |
|---|---|
| `GET /v1/inbox` | gains `stalled[]` (`InboxStalledView`: mission, reason, rule id, one action) and `silentRuns[]` (`InboxSilentRunView`: run, step, mission, quiet for, thresholds) |
| `POST /v1/runs/:id/snooze` | Keep waiting: 200 with the run's `snoozedUntil`; 412 when the run is not live or not silent |
| `POST /v1/tasks/:id/retry` | gains `stopRun?: boolean`: a RUNNING or AWAITING_INPUT step is stopped and retried |

`TaskView.watch` (`{ level: active|quiet|silent, lastEventAt, quietForMs, snoozedUntil }`, null unless the step runs) feeds the drawer.

## 6. Desktop

- **Inbox**: a Stalled row, "Stalled: <mission>", its reason, the primary action as a button on the row, and the row opens the mission. A quiet row, "Quiet for 16 min: <step>", the mission, **Stop and retry** and **Keep waiting**. Both use the existing list row, chip and button classes.
- **Home → Needs you now**: both kinds count and show, like every other Inbox item; a blocked-mission card is left out when that mission is already listed.
- **Step drawer**: "Last activity 12 min ago" under the run, with a "Quiet" chip at the quiet threshold.
- The missions topic now also refreshes the Inbox, since a mission's status alone can make it stalled.

## Testing

**Offline:** `scratch/p9-liveness-check.mjs`, added to OFFLINE_CHECKS, written first and seen failing (`LIVENESS_RULES` did not exist: `Cannot read properties of undefined (reading 'filter')`). It covers:

- The rule, pure: every mission status and every task status appears in the rule table; one seeded input per row L1–L18 and T1–T15 gets the kind and action the table says; thresholds (quiet, silent, the budget cap, the floor, snooze).
- The engine over a real SQLite file, no scheduler running: one mission seeded per shape (every L row, and a working or BLOCKED mission per T row), then `GET /v1/inbox`'s projection: **the number of stalled missions equals `inbox.stalled.length`**, each stalled mission appears once, and **no mission has a stalled row and another Inbox item** (card, step row, refinement row) at the same time. The limit-paused mission has its card only; the paused mission has nothing.
- Migration 015; `mission.stalled` and `run.silent_minutes` in the vocabulary and from `facts`.
- A real daemon with the scripted agent: J1 (retries exhausted, card, "Leave blocked" → one stalled row "Retry implement" → retried → gone), J2 (plan rejected → "Re-plan" → planning, row gone, plan card instead), J3 (a hanging run with `quietMs` 1 s: quiet, silent row, snooze hides it, it comes back, stop and retry → attempt 2 succeeds), J4 (paused, and paused at a limit: no stalled row; the limit card is the only item).

**Real app** (`scratch/acceptance/p9/`, CDP 9344, home `/tmp/tdm-p9`, `TANDEMISE_QUIET_MS=3000`, scripted knobs `SCRIPTED_FAIL_TIMES`, `SCRIPTED_HANG_ONCE`):

| # | Scenario | Must observe in the window |
|---|---|---|
| J1 | A step fails its gate on both attempts | the "exhausted its retries" card and no Stalled row; "Leave blocked" → "Stalled: <mission>" with "Retry implement"; clicking it → attempt 3, the mission completes, the row is gone |
| J2 | Reject the plan | "Stalled: <mission>" with "The plan was rejected…" and "Re-plan"; clicking it → "Planning", then the plan card and no Stalled row |
| J3 | The agent hangs | the drawer reads "Quiet"; the Inbox row "Quiet for …: implement" with Stop and retry and Keep waiting; Keep waiting hides it; when it comes back, Stop and retry → attempt 2 runs and succeeds, the row is gone |
| J4 | Pause a mission mid-step; another stops at a limit | the paused one has no Inbox row at all; the limit-paused one has only its "Limit reached" card; `inbox.stalled` is empty |

## Rulings

1. **Five kinds, not three.** "Parked" (the person's own choice: paused, kept paused, a draft not queued) and "finished" are separate from "waiting": neither gets a row, and neither is stalled.
2. **The silent threshold is capped by the budget.** 30 minutes would come after the default 25- and 30-minute wall-time budgets had already ended the run, so the row would never be seen. Silent is the sooner of 3 × quiet and half the step's budget, never before quiet.
3. **Stop and retry is one call** (`retry` with `stopRun`), not cancel then retry: there is no route that cancels one step, and doing it in two calls leaves a window where the step is CANCELLED and the mission may be marked blocked. It follows the path a retry with more access already takes for a step parked on a question.
4. **RELEASED and OBSERVING count as finished.** No code sets them today; if a release flow ever does, the work has shipped.
5. **A queued draft that is not ready and has nothing to decide is stalled (L9)**, with Refine as its action: the person queued it expecting it to run, and nothing will ever pull it. A queued ready draft held by the WIP limit or monthly spend (P7, P8) is moving: its Backlog row already says what holds it, and it moves when that changes.
6. **A PLANNING mission with no planner is stalled**, not assumed moving: a daemon restart re-plans it (`resumeInterrupted`), and anything else is a bug the person should see rather than wait on.
7. **A check card never counts as the item.** It waits on nobody (P0 ruling), so a stalled mission with only a check pending still gets its Stalled row. They are different causes.
8. **No new approval kind, no stored stalled state.** Stalled and silent are derived per read from rows; the only writes are `last_event_at` and `watch_snoozed_until`.
9. **The Cancel action is last**, and confirmed: it is offered only where retrying a step or re-planning cannot move the mission.
10. **A quiet row is per run, a stalled row per mission.** A mission with a silent run is moving, so it never has both.
