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

Scripted-agent mode: `SCRIPTED_NEEDS` (in the goal) writes a handoff that stopped early and needs a
decision, the way the real intake did.
