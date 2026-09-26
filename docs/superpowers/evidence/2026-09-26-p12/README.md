# P12 evidence: model routing

Headline: **4/4 real-app scenarios pass** (M1–M4, 31/31 checks) on a fresh install, built from `feat/p12-model-routing`. Offline: `p12-models-check` 82/82; `npm run ci` green (34 offline checks).

## How it was run

```bash
npm run build
node scratch/acceptance/p12/run-all.mjs --keep-going          # CDP 9347, home /tmp/tdm-p12
ACCEPTANCE_LINK=/tmp/tdm-p12r0 CDP_PORT=9361 node scratch/acceptance/p0/run-all.mjs [--p1|--p2] --skip-claude --keep-going
node scratch/acceptance/p5/run-all.mjs --skip-claude --keep-going   # and p6 … p11
```

Setup shortcut (as P8's): the scripted agent's runtime profile is PATCHed to `outputFormat: ndjson`, `modelFlag: --model`, `model: profile-model`. The scripted agent records every run's argv under `<scratch>/args` (`SCRIPTED_ARGS_DIR`), which is the proof of what the runtime was started with. Every setting a person makes is made in the window: role models in Team → Roles, New mission with its limit and warning level, plan approval in the Inbox, Retry task in the step drawer. API and SQL are read only as proof.

No real-model scenario: which model a run gets is decided by the daemon's rule; the scripted agent only shows what it was given.

## Scenarios

| # | Scenario | Result |
|---|---|---|
| M1 | Developer role on `role-dev`; "P12 models": implement says `model: step-model` → drawer "Model: step-model · step override"; review → "Model: profile-model · runtime profile default"; Usage by model lists both; argv `--model step-model`, `--model profile-model` | PASS 11/11 |
| M2 | `SCRIPTED_FAIL_TIMES=1` on a step with `escalate: [strong-model]` → attempt 2 "Model: strong-model · retry escalation (attempt 2)"; argv run 1 `step-model`, run 2 `strong-model` | PASS 5/5 |
| M3 | Product Manager economy model `economy-model`; 20-minute limit warning at 25%, 6 min per run → step 2 "Model: economy-model · economy: 30% of limit" | PASS 8/8 |
| M4 | Reviewer on `shared-model` = implement's model → review blocks on `review.independent`; Reviewer moved to `review-model`, Retry task → passes, mission completes | PASS 7/7 |

## Regression (same build)

| Suite | Result |
|---|---|
| p0 | A1 PASS; stops at s02, which fails on `main` already ("Add person" removed in 0.4.0; being rewritten separately) |
| p1 | ALL PASS 14/14 |
| p2 | ALL PASS 11/11 |
| p5 | ALL PASS 5/5 (the first run lost its window mid-E1 — "no page target" — and passed unchanged on rerun) |
| p6 | ALL PASS 6/6 |
| p7 | ALL PASS 5/5 |
| p8 | ALL PASS 5/5 |
| p9 | ALL PASS 4/4 |
| p10 | ALL PASS 3/3 |
| p11 | ALL PASS 4/4 |

## Found and fixed while proving it

- Saving a role never re-read it (the save refreshed `workspaces`, the editor reads `roles`), so the editor kept saying "Unsaved changes" after a save. The `workspaces` topic now refreshes roles too.

## Parked

- Planning and refinement runs keep the profile's model (no Run row to record one on).
- Generic CLI profiles set `modelFlag` in their settings JSON; there is no form field on the Runtimes screen yet.
