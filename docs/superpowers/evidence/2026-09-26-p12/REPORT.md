# P12 acceptance report

Run: 2026-09-26T19:53:22.295Z · build 940d0c6 · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p12-run-muit08b1
Result: **ALL PASS** (4/4 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| M1 — A step's own model wins over its role's; each run records which model and why | PASS | 11/11 |
| M2 — A step that fails once retries on the stronger model of its ladder | PASS | 5/5 |
| M3 — Past its warning level a mission runs on the role's economy model | PASS | 8/8 |
| M4 — A review on the same model as the work fails its gate; on a different model it passes | PASS | 7/7 |

## M1 — A step's own model wins over its role's; each run records which model and why

- ✅ Team → Roles → Developer shows the Models section — `"Models\n\nNames are passed to the runtime exactly as you type them. A workflow step's own model wins over these; leave a field empty to use the runtime's model.\n\nModel\nEvery run of this role, unless a step says other`
- ✅ proof (API): the Developer role now has model role-dev — `{"model":"role-dev","escalate":[],"economyModel":null}`
- ✅ the mission completes — `"COMPLETE"`
- ✅ implement drawer: "Model: step-model · step override" — `"Model: step-model · step override"`
- ✅ and its own settings: "This step: model step-model · retries use strong-model" — `"This step: model step-model · retries use strong-model"`
- ✅ review drawer: "Model: profile-model · runtime profile default" — `"Model: profile-model · runtime profile default"`
- ✅ and "This step: must differ from implement" — `"This step: must differ from implement"`
- ✅ its gate includes review.independent and passed — `"Review\nRetry with more access\nSucceeded\nReviewer\nScripted agent\nModel: profile-model · runtime profile default\nm1-hello-page-muit0dna-review\nworktree isolation\n\nThis step: must differ from implement\n\nDone by\`
- ✅ Metrics → "Usage by model" lists step-model and profile-model, one run each — `"Usage by model\nWhich model each run was given\nprofile-model\n1 run · 2s · tokens not reported\nstep-model\n1 run · 2s · tokens not reported"`
- ✅ proof (agent argv): run 1 got --model step-model, run 2 --model profile-model — `[["--model","step-model"],["--model","profile-model"]]`
- ✅ proof (SQL): runs.model / model_reason recorded — `[{"attempt":1,"status":"SUCCEEDED","model":"step-model","reason":"step override","key":"implement"},{"attempt":1,"status":"SUCCEEDED","model":"profile-model","reason":"runtime profile default","key":"review"}]`
- screenshot: `M1-developer-models.png`
- screenshot: `M1-implement-drawer.png`
- screenshot: `M1-review-drawer.png`
- screenshot: `M1-usage-by-model.png`

## M2 — A step that fails once retries on the stronger model of its ladder

- ✅ the mission completes on the second attempt — `"COMPLETE"`
- ✅ drawer: "Model: strong-model · retry escalation (attempt 2)" — `"Model: strong-model · retry escalation (attempt 2)"`
- ✅ drawer: "This step: model step-model · retries use strong-model" — `"This step: model step-model · retries use strong-model"`
- ✅ proof (agent argv): run 1 --model step-model, run 2 --model strong-model — `[["--model","step-model"],["--model","strong-model"]]`
- ✅ proof (SQL): attempt 1 failed its gate on step-model; attempt 2 on strong-model — `[{"attempt":1,"status":"SUCCEEDED","model":"step-model","reason":"step override","key":"implement"},{"attempt":2,"status":"SUCCEEDED","model":"strong-model","reason":"retry escalation (attempt 2)","key":"implement"}]`
- screenshot: `M2-drawer-escalated.png`

## M3 — Past its warning level a mission runs on the role's economy model

- ✅ proof (API): Product Manager economy model saved — `{"model":null,"escalate":[],"economyModel":"economy-model"}`
- ✅ proof (API): a 20-minute limit warning at 25% — `[{"metric":"agent_minutes","amount":20,"warnPercent":25}]`
- ✅ the mission completes — `"COMPLETE"`
- ✅ step 1 (under the warning level): "Model: profile-model · runtime profile default" — `"Model: profile-model · runtime profile default"`
- ✅ step 2 (6 of 20 minutes used): "Model: economy-model · economy: 30% of limit" — `"Model: economy-model · economy: 30% of limit"`
- ✅ Metrics → "Usage by model": profile-model and economy-model, 6 min each — `"Usage by model\nWhich model each run was given\neconomy-model\n1 run · 6m 0s · 1,500 tokens\nprofile-model\n1 run · 6m 0s · 1,500 tokens"`
- ✅ proof (agent argv): --model profile-model, then --model economy-model — `[["--model","profile-model"],["--model","economy-model"]]`
- ✅ proof (SQL): the reasons recorded — `[{"attempt":1,"status":"SUCCEEDED","model":"profile-model","reason":"runtime profile default","key":"first"},{"attempt":1,"status":"SUCCEEDED","model":"economy-model","reason":"economy: 30% of limit","key":"second"}]`
- screenshot: `M3-drawer-economy.png`
- screenshot: `M3-usage-by-model.png`

## M4 — A review on the same model as the work fails its gate; on a different model it passes

- ✅ review drawer: "Model: shared-model · role model" — `"Model: shared-model · role model"`
- ✅ the step is Blocked and its gate names review.independent — `"Review\nRetry with more access\nBlocked\nReviewer\nScripted agent\nModel: shared-model · role model\nm4-hello-page-muit3lmp-review\nworktree isolation\n\nThis step: must differ from implement\n\nDone by\nScripted agent\`
- ✅ proof (API): the gate failed on review.independent = false — `{"expression":"(artifact.ReviewReport.exists) && review.independent","passed":false,"detail":"Not met: review.independent is false","facts":{"artifact.ReviewReport.exists":true,"review.independent":false}}`
- ✅ after "Retry task" on the new model the mission completes — `"COMPLETE"`
- ✅ review drawer: "Model: review-model · role model" — `"Model: review-model · role model"`
- ✅ proof (agent argv): implement shared-model, review shared-model, review again review-model — `[["--model","shared-model"],["--model","shared-model"],["--model","review-model"]]`
- ✅ proof (SQL): runs and models — `[{"attempt":1,"status":"SUCCEEDED","model":"shared-model","reason":"step override","key":"implement"},{"attempt":1,"status":"SUCCEEDED","model":"shared-model","reason":"role model","key":"review"},{"attempt":2,"status":"`
- screenshot: `M4-review-blocked.png`
- screenshot: `M4-review-passed.png`
