# P11 evidence: routines

Headline: **4/4 real-app scenarios pass** (L1–L4, 37/37 checks) on a fresh install, built from `feat/p11-recurring-missions` (774e45b). Offline: `p11-routines-check` 109/109; `npm run ci` green (33 offline checks).

## How it was run

```bash
npm run build
node scratch/acceptance/p11/run-all.mjs --keep-going          # CDP 9346, home /tmp/tdm-p11, TANDEMISE_CLOCK_OFFSET_MS=0
node scratch/acceptance/p0/run-all.mjs --skip-claude --keep-going
node scratch/acceptance/p0/run-all.mjs --p1 --skip-claude --keep-going
node scratch/acceptance/p0/run-all.mjs --p2 --skip-claude --keep-going
node scratch/acceptance/p5/run-all.mjs --skip-claude --keep-going   # and p6, p7, p8, p9, p10
```

The daemon runs with the test clock knob `TANDEMISE_CLOCK_OFFSET_MS=0`, so the suite moves the daemon's time with `POST /v1/test/clock {advanceMs}` instead of waiting for a routine's next run. Every decision is made in the window: New routine and its starter templates, the Repeats preset and time, Run now, the on/off switch, following the "Last:" link, deleting a queued draft. API and SQL are read only as proof.

No real-model scenario: a routine only adds queued drafts (or writes the report from facts); no model runs.

## Scenarios

| # | Scenario | Result |
|---|---|---|
| L1 | "Weekly dependency updates" template, changed to every day an hour ahead → "Next: …"; clock +2 h → a queued, Ready mission in the Backlog with U1–U3 and "From routine: Weekly dependency updates" | PASS 13/13 |
| L2 | Clock +1 day with that draft still queued → "Skipped: previous run still active", still one mission, a note on its timeline | PASS 6/6 |
| L3 | Delete the draft, "Run now" → a new queued mission, schedule unchanged; "Weekly status report" template, "Run now" → "Wrote status report v1", opens in the reader | PASS 11/11 |
| L4 | Switch off, clock +2 days → "Paused", no mission, no run; switch on → next run after now, nothing caught up | PASS 7/7 |

## Regression (same build)

| Suite | Result |
|---|---|
| p0 | A1 PASS; stops at s02, which fails on `main` already ("Add person" was removed in 0.4.0; recorded in the handoffs since slice 0) |
| p1 | ALL PASS 14/14 |
| p2 | ALL PASS 11/11 |
| p5 | ALL PASS 5/5 |
| p6 | ALL PASS 6/6 |
| p7 | ALL PASS 5/5 |
| p8 | ALL PASS 5/5 |
| p9 | ALL PASS 4/4 |
| p10 | ALL PASS 3/3 |

## Found and fixed while proving it

- The filtered Missions routes (`/missions/backlog`, `/missions/routines`, `/missions/in-progress`) render one screen, and React kept it mounted between them, so navigating from one to another kept the first tab. The screen now follows the route.
- A queued draft has no Cancel (only started missions do), so L3/L4 drop a run by deleting the draft; the next run then proceeds (spec ruling 14).

## Parked

- Removing a draft from the queue does not stop coalescing: it is still unfinished work from its routine. If that surprises people, a "Skip this run" on the draft is the follow-up.
