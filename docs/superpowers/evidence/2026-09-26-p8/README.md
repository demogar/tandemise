# P8 evidence: hard limits on spend and time

Headline: **5/5 real-app scenarios pass** (H1–H5, 39/39 checks) on a fresh install, built from `feat/p8-hard-limits`. Offline: `p8-limits-check` 112/112; `npm run ci` green (30 offline checks).

## How it was run

```bash
npm run build
node scratch/acceptance/p8/run-all.mjs --keep-going          # CDP 9343, home /tmp/tdm-p8, scripted agent
node scratch/acceptance/p0/run-all.mjs --skip-claude --keep-going
node scratch/acceptance/p0/run-all.mjs --p1 --skip-claude --keep-going
node scratch/acceptance/p0/run-all.mjs --p2 --skip-claude --keep-going
node scratch/acceptance/p5/run-all.mjs --skip-claude --keep-going
node scratch/acceptance/p6/run-all.mjs --skip-claude --keep-going
node scratch/acceptance/p7/run-all.mjs --keep-going
```

The suite runs the scripted agent with `SCRIPTED_DELAY_MS=4000` and switches its runtime profile to `outputFormat: "ndjson"` after setup (setup shortcut, through the API), so the agent's usage line is read. The mission goal carries `SCRIPTED_USAGE_MIN=5`: each run reports 5 agent minutes, 1,200 input and 300 output tokens, and no cost. Missions use the `P8 five steps` workflow (five sequential document steps) or `P2 solo`.

Limits are set in the window (New mission → More options → Limit; Repositories → Limits), cards are answered in the window (the mission page and the Inbox), and Resume is pressed in the header. The API and SQL are read only as proof. Each scenario that starts fresh cancels what earlier ones left in progress through the API first (noted in its JSON).

There is no real-model scenario: a stop is decided by the daemon from recorded usage, and no model output takes part in it.

## Scenarios

| # | Scenario | Result |
|---|---|---|
| H1 | Limit 12 agent minutes, 5 per run → after run 2 the timeline reads "Limit warning: 10 of 12 agent minutes used (83%). Work stops at 12 agent minutes."; after run 3 "Paused", "Limit reached: 15 of 12 agent minutes", the card with "Raise limit to (agent minutes)" / "Raise limit and resume" / "Keep paused" on the mission page, Metrics "15 / 12 agent min", a Home banner; exactly 3 runs, none while paused | PASS 11/11 |
| H2 | "Keep paused" on H1's card → still Paused, "Kept paused at its limit: 15 of 12 agent minutes. Raise the limit to resume.", incident resolved, card REJECTED/keep_paused; Resume refused "Limit reached: 15 of 12 agent minutes. Raise the limit to resume this mission."; no more runs | PASS 7/7 |
| H3 | Another mission stops at 12; in the Inbox 14 is refused ("Raise it above 15 agent minutes"), 30 → Executing, "15 / 30 agent min", resumed exactly once ("Limit raised to 30 agent minutes; resumed."); finishes at "25 / 30 agent min" | PASS 9/9 |
| H4 | Monthly limit set in Repositories → Limits so the month sits at ~85% ("Over 80%"); Home "Monthly limit warning: …"; WIP 1 with a Normal and a High queued → High pulled, Normal's row "Held: this project is over 80% of its monthly limit (… agent minutes). Only urgent and high missions are pulled."; still held with the slot free | PASS 6/6 |
| H5 | USD limit $5 on a runtime that reports no cost → completes; Metrics "not reported / $5.00", "Cost: not reported"; timeline "USD limit cannot be measured for this runtime …"; no incident; cost null, tokens 1,500 | PASS 6/6 |

Full per-check detail is in `REPORT.md` and `H*.json`; screenshots are `H*-*.png`.

## Offline check

`scratch/p8-limits-check.mjs` was written first and run against the P7 code: it failed at once (`TypeError: D.evaluateLimit is not a function`). Against the change it found three real gaps before passing 112/112: raising the limit of a mission that had been kept paused did not resume it; a limit lowered below usage waited for the next run instead of stopping at once; and a task dispatched but still choosing a runtime (no run row yet) was not stopped. It includes a stubbed scheduler ticked directly (the over-limit mission's task never starts) and two concurrent decisions on one card (one 200, one 409, one resume).

## Regressions

| Suite | Result |
|---|---|
| P0 (`regression-p0/`) | A1 11/11; stops at s02 — already failing on `main` (the "Add person" flow was removed in 0.4.0) |
| P1 (`regression-p1/`) | 14/14 |
| P2 (`regression-p2/`) | 11/11 |
| P5 (`regression-p5/`) | 5/5 |
| P6 (`regression-p6/`, F7 skipped: needs real Claude) | 6/6 |
| P7 (`regression-p7/`) | 5/5 |

All runs were on the change before it was committed, so the REPORTs name the base commit (`52a705c`).
