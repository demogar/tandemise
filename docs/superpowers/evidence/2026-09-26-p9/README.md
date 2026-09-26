# P9 evidence: nothing waits silently

Headline: **4/4 real-app scenarios pass** (J1–J4, 36/36 checks) on a fresh install, built from `feat/p9-nothing-waits-silently`. Offline: `p9-liveness-check` 204/204; `npm run ci` green (31 offline checks).

## How it was run

```bash
npm run build
node scratch/acceptance/p9/run-all.mjs --keep-going          # CDP 9344, home /tmp/tdm-p9, scripted agent
node scratch/acceptance/p0/run-all.mjs --skip-claude --keep-going
node scratch/acceptance/p0/run-all.mjs --p1 --skip-claude --keep-going
node scratch/acceptance/p0/run-all.mjs --p2 --skip-claude --keep-going
node scratch/acceptance/p5/run-all.mjs --skip-claude --keep-going   # and p6, p7, p8
```

The daemon runs with `TANDEMISE_QUIET_MS=3000`, so a run is quiet after 3 s and silent (in the Inbox) after 9 s; the scripted agent uses `SCRIPTED_DELAY_MS=1500` and keeps its run counts in `SCRIPTED_STATE_DIR` under the run's folder. Knobs are written in the mission goal: `SCRIPTED_FAIL_TIMES=2` (the first two runs of the step write nothing, so its gate fails and its retries run out) and `SCRIPTED_HANG_ONCE` (the first run prints nothing and sleeps until stopped). Missions use the one-step `P9 implement` workflow, or `P8 five steps` for J4.

Plans are approved and rejected in the Inbox, the "exhausted its retries" card is answered "Leave blocked" in the Inbox, Pause is pressed in the mission header, and Retry / Re-plan / Keep waiting / Stop and retry are clicked on the Inbox rows. The API and SQL are read only as proof. Each scenario first cancels what earlier ones left in progress (noted in its JSON).

There is no real-model scenario: whether work can move is derived by the daemon from rows, and no model output takes part in it.

## Scenarios

| # | Scenario | Result |
|---|---|---|
| J1 | A step fails its gate twice → the "implement exhausted its retries" card and no Stalled row; "Leave blocked" → "Stalled: <mission>" with "'implement' is blocked: A human declined to retry this task." and "Retry implement", shown once on Home; clicking it runs attempt 3, the mission completes, the row is gone | PASS 12/12 |
| J2 | Reject the plan → "Stalled: <mission>" with "The plan was rejected. Re-plan or change the mission goal." and "Re-plan"; clicking it plans again ("Planning “…” again."), the new plan card replaces the Stalled row | PASS 8/8 |
| J3 | The agent hangs → the drawer reads "Last activity N s ago" and "Quiet"; the Inbox row "Quiet for 9 s: implement" with "Keep waiting" and "Stop and retry"; Keep waiting hides it (the run is never stopped by Tandemise); it comes back; Stop and retry → run 1 CANCELLED, attempt 2 SUCCEEDED, row gone; the timeline says it was quiet and kept waiting | PASS 11/11 |
| J4 | A mission paused mid-step has nothing in the Inbox; a mission paused at its limit has only its "Limit reached" card; `inbox.stalled` is empty | PASS 5/5 |

Full per-check detail is in `REPORT.md` and `J*.json`; screenshots are `J*-*.png`.

## Offline check

`scratch/p9-liveness-check.mjs` was written first and run against the P8 code: it failed at once (`TypeError: Cannot read properties of undefined (reading 'filter')` — `LIVENESS_RULES` did not exist). It proves the table is exhaustive (every mission and task status has a row, every row L1–L18 and T1–T15 is reached by an input with the kind and action the spec says), the watchdog thresholds, and then, over a real SQLite file with one mission seeded per shape, that the number of stalled missions equals `inbox.stalled.length`, that no mission has a Stalled row next to any other Inbox item, that every waiting mission has its item, that the limit-paused mission has only its card and the paused one nothing. A real daemon then runs J1–J4 end to end. While it was being made to pass, one expectation in the check itself was corrected (a working mission whose steps have all finished is moving: the scheduler completes or fails it on its next pass, so it is never a Stalled row), and a race in the check was closed (the silent note is written by the scheduler's pass, so the check waits a pass for it).

## Regressions

| Suite | Result |
|---|---|
| P0 (`regression-p0/run.log`) | A1 11/11; stops at s02 — already failing on `main` (the "Add person" flow was removed in 0.4.0) |
| P1 (`regression-p1/run.log`) | 14/14 |
| P2 (`regression-p2/`) | 11/11 |
| P5 (`regression-p5/`) | 5/5 |
| P6 (`regression-p6/`, F7 skipped: needs real Claude) | 6/6 |
| P7 (`regression-p7/`) | 5/5 |
| P8 (`regression-p8/`) | 5/5 |

All runs were on the change before it was committed, so the REPORTs name the base commit (`730e098`).
