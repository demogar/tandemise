# P7 evidence: backlog, priority and a WIP limit

Headline: **5/5 real-app scenarios pass** (G1–G5, 42/42 checks) on a fresh install, built from `feat/p7-backlog-priority-wip`. Offline: `p7-backlog-check` 81/81; `npm run ci` green (29 offline checks).

## How it was run

```bash
npm run build
node scratch/acceptance/p7/run-all.mjs --keep-going         # CDP 9342, home /tmp/tdm-p7, scripted agent
node scratch/acceptance/p0/run-all.mjs --only=s01 --skip-claude
node scratch/acceptance/p0/run-all.mjs --p1 --skip-claude --keep-going
node scratch/acceptance/p0/run-all.mjs --p2 --skip-claude --keep-going
node scratch/acceptance/p5/run-all.mjs --skip-claude --keep-going
node scratch/acceptance/p6/run-all.mjs --skip-claude --keep-going
```

Missions are added from New mission with **Add to backlog** (priority under More options, the "P2 solo" workflow). The limit, moves, queue changes, the plan approval and the cancel are clicks and key presses in the window (keys through CDP `Input.dispatchKeyEvent`, not synthetic DOM events). The API and SQL are read only as proof; each scenario that starts fresh cancels what earlier scenarios left in progress and turns the limit off through the API first (setup shortcut, noted in its JSON).

There is no real-model scenario: which mission is pulled is decided by the daemon from rows and counts, and no model output takes part in it.

## Scenarios

| # | Scenario | Result |
|---|---|---|
| G1 | Limit Off; Normal, Urgent, Low added to the backlog → listed Urgent, Normal, Low, "Queued · 1/3…3/3", "Working on 0 · no limit · 3 queued"; set **1** → Urgent pulled (AWAITING_PLAN_APPROVAL), Normal "Queued · 1/2", Low "Queued · 2/2", "Working on 1 of 1 · 2 queued"; one `mission.pulled {1, 1, 1}` | PASS 11/11 |
| G2 | Approve Urgent's plan in the Inbox → it completes → Normal pulled; its timeline "Pulled from the backlog (1 of 1)" · "It was first in the queue. This project works on at most 1 mission at a time." | PASS 6/6 |
| G3 | Add another Normal; `j` selects Low, `⌥↑` moves it above → reads Normal, flash "Now Normal priority, above “…”", selection follows; cancel the one in progress from its page → Low is pulled | PASS 9/9 |
| G4 | Limit 1; a queued Urgent with no Done-when line is not pulled ("Needs refinement", "Add at least one Done-when criterion to plan"); a ready Normal is pulled, timeline "It was number 2 in the queue; 1 mission ahead of it is not ready to plan yet." | PASS 7/7 |
| G5 | Limit Off, two ready missions queued → nothing pulled after 6 s, hint "Limit off: queued missions wait until you plan them yourself or set a limit."; **Move up** button reorders, **Remove from queue** → "Not queued" | PASS 9/9 |

Full per-check detail is in `REPORT.md` and `G*.json`; screenshots are `G*-*.png`.

## Offline check

`scratch/p7-backlog-check.mjs` was written before the implementation and failed at once (`TypeError: D.backlogOrder is not a function`). Its cancel-while-planning section was also run with the fix switched off: the cancelled mission came back as AWAITING_PLAN_APPROVAL with 7 tasks and a plan approval. With the change it passes 81/81.

## Regressions

| Suite | Result |
|---|---|
| P0 A1 (`regression-p0/`) | 1/1 |
| P1 (`regression-p1/`) | 14/14 |
| P2 (`regression-p2/`) | 11/11 |
| P5 (`regression-p5/`) | 5/5 |
| P6 (`regression-p6/`, F7 skipped: needs real Claude) | 6/6 |

All regressions ran on build `ab340ad` (the feature commit). The G1–G5 run was on the same code before it was committed, so its REPORT names the base commit.

P0 s02–s08 were not run: they already fail on `main` (the "Add person" flow was removed in 0.4.0).

## Found and fixed while proving it

- **Cancel while planning** (the known race from P6): a planner finishing after a cancel wrote tasks and a plan approval and moved the cancelled mission to AWAITING_PLAN_APPROVAL. With auto-pull, cancelling a pulled mission mid-plan is a normal path, so it is fixed: cancel aborts the planner run and a late plan is discarded with a note.

## Parked

- A Home card for work in progress and the queue is P10's ("Working on 2 of 2").
