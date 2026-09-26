# P7: Backlog, priority and a work-in-progress limit

Status: design, 2026-09-26. Builds on P6 (the readiness gate, `ReadinessService`). Stacked on P6.

## Problem

A person running their own agents has more requests than agents, and today Tandemise only knows "planned now" or "not planned".

- There is no order. Every mission is equal, and when the workers are full the scheduler hands the next free slot to whichever mission the database lists first: the newest one (`scheduler.ts` dispatches missions in `created_at DESC` order). An urgent fix waits behind the last thing someone typed.
- There is no limit. Planning ten missions starts ten missions, and the person drowns in ten plan approvals and ten half-finished branches instead of seeing two things finish.
- There is nowhere to park a request. A mission is either planned now or a DRAFT that nothing will ever pick up; "do this next, after the current one" has to be remembered by the person.

## Goal

I keep a ranked backlog. I say how many missions Tandemise works on at once. When there is room, the daemon plans the next queued mission that is ready, in my order, and tells me it did.

- Each mission has a **priority** (Urgent, High, Normal, Low) and a **rank** inside it.
- A DRAFT mission can be **queued**. Only queued missions are ever picked up; a draft I have not queued is mine to finish.
- The project has a **work-in-progress limit** (off, or 1 to 50). Off means nothing is picked up automatically.
- The pick is a **deterministic total order**, decided by the daemon from rows and counts: same state, same pick.

## Not in P7

- Due dates, estimates, a kanban board, priority on individual tasks.
- Holding back normal work when the monthly spend limit is near (P8 adds that rule to the same pull).
- A Home card for work in progress (P10).

## 1. Concepts

### Priority, rank and the backlog order

`priority` is one of `urgent | high | normal | low` (default `normal`). `rank` is a number; lower comes first. The backlog order is a total order:

```
(priority level, rank, createdAt, id)      urgent = 0, high = 1, normal = 2, low = 3
```

Missions never share an id, so two missions never compare equal, and the same rows always produce the same order however they were read. A tie on rank (two missions moved to the same spot by two windows) falls to the older mission, then to the id.

A new mission is ranked last (`max(rank) + 1` in its project), so without any reordering the backlog is first come, first served within a priority.

### Moving a mission

**Move up** / **Move down** (buttons on each row, or `⌥↑` / `⌥↓` on the selected row) swaps the mission with its neighbour in the backlog order. The daemon renumbers the project's backlog ranks 1…n in the new order, so ranks never run out of room between two floats.

Priority comes first in the order, so moving a Low mission above a Normal one can only mean one thing: it is now Normal. A move that crosses a priority boundary gives the mission its new neighbour's priority, and the window says so ("Now Normal priority, above “Tidy the settings page”.").

### The queue

The backlog is every DRAFT mission. The queue is the part of it with `queued_at` set (roadmap decision 3: no new status). **Add to queue** / **Remove from queue** on each row; **Add to backlog** on the New mission form creates a mission that is already queued. Queue positions ("Queued · 1/2") count queued missions in backlog order.

### Work in progress and the pull

A mission is **in progress** when it is not DRAFT, not PAUSED and not finished (COMPLETE, FAILED, CANCELLED). A mission waiting on its plan approval or blocked is in progress: it has been started, and it will come back to the person before it finishes.

On every scheduler tick, for every project:

```
wip_has_room := workspace.active_missions < workspace.max_active_missions
```

While the gate passes, the daemon takes the first queued DRAFT in backlog order that is ready to plan (`ReadinessService.evaluate(id).ready`, the P6 gate, not a copy of it) and is not being refined right now, and calls `planning.begin`. A queued mission that is not ready is skipped, not removed: it is pulled once it is ready and first. An unqueued draft is never pulled.

With the limit off, `workspace.max_active_missions` is not measured, the gate never passes, and nothing is pulled: the person plans by hand as before.

Each pull records `mission.pulled { position, limit, active }` on the mission (its place in the queue when pulled, the limit, and missions in progress including it). The timeline reads "Pulled from the backlog (1 of 1)" and says how far down the queue it was and how many ahead of it were not ready.

A pull that fails (planning refused it for a reason the readiness gate did not see) takes the mission off the queue with a timeline note, so one bad row cannot be retried every 1.5 seconds.

### Dispatch across missions

Worker slots follow the same order. The scheduler dispatches missions' ready tasks in backlog order, not in the order the database lists them, so when the workers are full an urgent mission gets the next free slot.

### Facts

| Fact | Meaning |
|---|---|
| `mission.priority` | 0 urgent, 1 high, 2 normal, 3 low |
| `workspace.active_missions` | missions in progress in the project |
| `workspace.max_active_missions` | the limit; not measured when the limit is off |

## 2. Cancelling a mission that is being planned

The known bug "cancelling a mission while it is PLANNING still lets the planner raise a plan approval" matters here. A pulled mission is planned without the person pressing Plan, so the natural reaction to a pull they did not want is to cancel it mid-plan. Today the planner run keeps going, then writes tasks and a plan approval onto the cancelled mission.

Fixed in this slice:

- Cancelling a mission aborts its planner run (`PlanningService.abandon`).
- Before a finished plan is written, planning re-reads the mission. If it is no longer PLANNING, the plan is discarded with a timeline note ("Planning finished after the mission was cancelled; the plan was discarded.") and no tasks or approval are written.

## 3. Data (migration 013)

- `missions.priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low'))`
- `missions.rank REAL NOT NULL DEFAULT 0`, backfilled 1…n per project in `created_at, id` order.
- `missions.queued_at TEXT` (NULL: not queued).
- `workspaces.max_active_missions INTEGER CHECK (max_active_missions IS NULL OR max_active_missions >= 1)` (NULL: off; decision 4).
- Index `ix_missions_backlog (workspace_id, status, priority, rank)`.

All additive (`ALTER TABLE … ADD COLUMN`).

## 4. API

| Route | Does |
|---|---|
| `GET /v1/workspaces/:id/backlog` | the Backlog view (below) |
| `PATCH /v1/missions/:id` | `{ priority?, rank?, queued?, move?: 'up' \| 'down' }` → the Backlog view. `queued`, `rank` and `move` are DRAFT only (412 otherwise); `priority` works until the mission finishes, because it orders dispatch too |
| `PATCH /v1/workspaces/:id` | gains `{ maxActiveMissions: number \| null }` |
| `POST /v1/missions` | gains `priority?` and `queued?` |

```
BacklogView = {
  limit: number | null, active: number, queued: number,
  headline: "Working on 1 of 2 · 3 queued" | "Working on 1 · no limit · 3 queued",
  hint: what happens next, in one sentence,
  items: [{ summary, priority, queuePosition | null, ready, readinessLabel, refining }]   // DRAFTs in backlog order
}
```

Every write invalidates `missions`; a pull does too, and refinement decisions now refresh the backlog's readiness badges.

## 5. Desktop

- **Missions → Backlog** tab (drafts move there from Active). Top of the tab: the headline ("Working on 1 of 2 · 3 queued"), **Work on at most** Off / 1 / 2 / 3 / 5, and the hint ("When fewer than 2 missions are in progress, Tandemise plans the next queued mission that is ready, in this order." / "Limit off: queued missions wait until you plan them or set a limit.").
- **Rows**, in backlog order: priority chip, title (opens the mission), readiness badge **Ready** / **Needs refinement** (with what is missing), queue label **Queued · 1/2** or **Not queued**, **Add to queue** / **Remove from queue**, a priority select, **Move up** / **Move down**.
- **Keyboard**: `j` / `k` (or ↓ / ↑) select a row, `⌥↑` / `⌥↓` move it, `↵` opens it. The footer says so. Selection follows the moved row.
- **New mission**: Priority (Urgent / High / Normal / Low) under More options. Next to the primary button, **Add to backlog** creates the mission queued without planning it, with or without Done-when lines.
- **Timeline**: "Pulled from the backlog (1 of 1)".

## Testing

**Offline:** `scratch/p7-backlog-check.mjs`, added to OFFLINE_CHECKS, written first and seen failing. It covers: migration 013 (columns, CHECKs, rank backfill, schema 13); the order (priority first, rank, then a tie on rank falls to createdAt, then id); determinism (every permutation of the same rows gives the same order and the same pick); the WIP gate and facts (off never passes); `choosePulls` (limit, skipping not-ready and unqueued, positions); `moveInBacklog` (swap, renumbering, adopting a neighbour's priority); a real daemon: limit 1 with normal/urgent/low queued pulls only urgent, with the `mission.pulled` event; freeing the slot pulls the next; a not-ready queued mission is skipped; an unqueued draft is never pulled; limit off pulls nothing; PATCH refusals; dispatch order across missions; cancelling a mission mid-plan leaves no tasks and no plan approval.

**Real app** (`scratch/acceptance/p7/`, CDP 9342, home `/tmp/tdm-p7`, scripted agent):

| # | Scenario | Must observe in the window |
|---|---|---|
| G1 | Limit off; add Normal, Urgent, Low to the backlog; set Work on at most 1 | Urgent leaves the backlog and is in progress; Normal "Queued · 1/2", Low "Queued · 2/2"; "Working on 1 of 1 · 2 queued" |
| G2 | Approve Urgent's plan; it completes | Normal is pulled; its timeline reads "Pulled from the backlog (1 of 1)" |
| G3 | Add another Normal; select Low with `j`, press `⌥↑` | Low is above it and reads Normal; when the slot frees, Low is pulled |
| G4 | A queued Urgent that needs refinement, then a ready Normal | the Normal is pulled; the Urgent stays "Queued" with "Needs refinement" |
| G5 | Limit Off; queue a ready mission | nothing is pulled; the hint says queued missions wait |

## Rulings

1. **Crossing a priority boundary changes priority.** The order is priority first (roadmap), so "move Low above Normal" (G3) is only possible if it becomes Normal. The window names the new priority, so nothing changes silently.
2. **Moves renumber.** The daemon renumbers the backlog 1…n on every move instead of taking float midpoints: the backlog is small, and the order stays exact.
3. **In progress = not DRAFT, not PAUSED, not finished.** Waiting on a plan approval, blocked, or waiting on a person all count: started work that will come back to the person.
4. **The limit gate is a gate expression** (`workspace.active_missions < workspace.max_active_missions`). Off is "not measured", which never passes, so "off pulls nothing" is the gate language's own rule, not a special case.
5. **Not-ready is skipped, not dequeued.** The person queued it; it is pulled when it becomes ready and is first. A mission being refined right now is skipped too, so a refinement pass never lands on a planned mission.
6. **A failed pull dequeues.** Otherwise one row the planner refuses would be retried on every tick.
7. **A backlog route.** `GET /v1/workspaces/:id/backlog` is added beside the roadmap's two PATCH routes: the readiness badge, queue positions and headline are computed by the daemon once rather than re-derived in the window.
8. **`move` on the mission PATCH.** The client says "up" or "down"; the daemon owns the order. `rank` and `priority` are still accepted for scripts.
9. **Add to backlog on the New mission form.** Without it a ready mission can only be created by planning it at once, so a queue of ready work could not be built from the window.
10. **Priority orders dispatch for any unfinished mission**, so it stays editable after planning; queue and rank changes are DRAFT only.
11. **The cancel-while-planning bug is fixed here** (spec §2): auto-pull makes it a normal path.
12. **A third fact, `workspace.max_active_missions`,** beside the roadmap's two, so the pull gate reads measured facts only.
