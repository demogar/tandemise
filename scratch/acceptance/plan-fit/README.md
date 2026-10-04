# Plan fit real-app acceptance suite

```
npm run build
node scratch/acceptance/plan-fit/run-all.mjs [--keep-going] [--only=f1] [--hold]
```

A fresh install behind `/tmp/tdm-pf` (`p0/setup.mjs`), the daemon from this checkout, the real
desktop window (`electron-vite dev`, its own `--user-data-dir`, CDP on 9341). Evidence goes to
`docs/superpowers/evidence/2026-10-03-plan-fit/` (or `$ACCEPTANCE_EVIDENCE_DIR`).

| File | ID | What it proves |
|---|---|---|
| `f1-person-sees-what-came-in.mjs` | F1 | On "Plan fit", the person step's drawer shows intake's handoff (headline, points, Needs) before its stale objective, and opens the full document. |
| `f2-stop-then-skip.mjs` | F2 | On "Plan fit chain", intake says stop: the next steps wait, the card is in the Inbox and the feed, and skipping finishes the mission. |
| `f3-stop-then-send-back.mjs` | F3 | Sending intake back with a note runs round 2, which no longer stops, and the plan goes on from it. |
| `f4-stop-then-continue.mjs` | F4 | Continuing as planned releases the next steps. |

Scripted-agent modes, named in the goal: `SCRIPTED_NEEDS` writes a handoff that stopped early and
needs a decision, the way the real intake did; `SCRIPTED_STOP` has the step whose objective starts
"Look into the request" say `stop` in its first pass (a round does not).
