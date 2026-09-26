# P16 evidence: reach me when it matters

Headline: **3/3 real-app scenarios pass** (R1–R3, 37/37 checks) on a fresh install, built from `feat/p16-desktop-notifications` merged with `main` 044fb92 (the suite was also green before the merge, on 940d0c6). Offline: `p16-notify-check` 74/74; `npm run ci` green (34 offline checks).

## How it was run

```bash
npm run build
node scratch/acceptance/p16/run-all.mjs --keep-going   # CDP 9351, /tmp/tdm-p16, scripted agent
```

The daemon runs with `TANDEMISE_CLOCK_OFFSET_MS=0` (test clock, used by R3 to move past the end of quiet hours). The desktop runs with `TANDEMISE_NOTIFY_RECORD=/tmp/tdm-p16/notifications.jsonl` (the main process records every notification it shows and enables `window.tandemise.notificationsDebug`) and `TANDEMISE_NOTIFY_POLL_MS=1000`. Decision items are plan cards of one-step "P2 solo" missions made in the window.

Every setting is changed in the window (Refinements switch, Quiet hours switch, From/To, "Save quiet hours", "Send a test notification"). The debug hook stands in for what a person does outside the window: hiding it, clicking the native notification, and whether the OS gives it focus. `settings.json` and the API are read only as proof.

## Scenarios

| # | Scenario | Result |
|---|---|---|
| R1 | One new decision while the window is hidden | PASS 12/12: one "Decision needed" with "Approve the plan for … · <mission>", shown while hidden, nothing more on later polls; click shows the window on `/missions/<id>` with the plan card; on the Inbox and focused a second card gives no notification, and none later |
| R2 | Three at once; Refinements switched off | PASS 12/12: one poll → one "3 things need you" naming two and "and 1 more", click opens the Inbox with the three; Refinements off in Settings → the refined draft's Inbox row gives no notification, and none when switched back on |
| R3 | Quiet hours and the test button | PASS 13/13: section reads "Quiet hours now"; the new card is held (settings.json), after the test clock moves 2 h one "After quiet hours: 1 thing needs you" opening the mission; "Send a test notification" shows "Notifications are on" and the window says "Test notification sent." |

## Regression

Run on their own links and CDP ports (`ACCEPTANCE_LINK=/tmp/tdm-p16r-*`, 9361–9366) so they could not collide with other slices' runs.

| Suite | Result |
|---|---|
| p0 (--skip-claude) | A1 PASS; stops at s02, which fails on `main` already ("Add person" was removed in 0.4.0; the refresh is PR #17) |
| p1 | ALL PASS 14/14 |
| p2 | ALL PASS 11/11 |
| p5 | ALL PASS 5/5 |
| p6 | ALL PASS 6/6 |
| p7 | ALL PASS 5/5 |
| p8 | ALL PASS 5/5 (first run lost its window at H3, "no page target"; passed on rerun) |
| p9 | ALL PASS 4/4 |

## Found and fixed

- A refinement row needs "Refine" pressed after "Create and refine"; R2 does that in the window.
- `document.visibilityState` stays "visible" for a hidden window when backgrounding is disabled, so R1 asks the main process (`notificationsDebug('window')`) instead.
