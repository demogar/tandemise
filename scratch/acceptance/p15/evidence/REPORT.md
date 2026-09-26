# P15 acceptance report

Run: 2026-09-26T23:53:16.909Z · build 73280cc · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p15-run-muj1m74b
Result: **ALL PASS** (4/4 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| Q1 — Export writes the setup to .tandemise/, byte-stable, with the hash in the window | PASS | 13/13 |
| Q2 — A role's model edited in the file: one Change in the preview, applied, shown in Team | PASS | 8/8 |
| Q3 — An imported routine arrives off, marked "Imported — review and turn on" | PASS | 8/8 |
| Q4 — A workflow gate reading mission.stalled, or missing its output check, is refused with the reason | PASS | 4/4 |

## Q1 — Export writes the setup to .tandemise/, byte-stable, with the hash in the window

- note: setup (API): monthly limit 600 agent minutes, WIP limit 2, one weekly routine
- ✅ the section says it has not been exported yet — `"Setup as code\nNot exported yet\nExport\n\nWrites your roles, workflows, routines, limits and project settings into .tandemise/ in a repository, so you can commit them and bring them to another machine. N"`
- ✅ the window lists the files written and the content hash — `"Setup as code\nLast exported 9b5107eef4e0\nExport\n\nWrites your roles, workflows, routines, limits and project settings into .tandemise/ in a repository, so you can commit them and bring them to another machine. No sec`
- ✅ workflows already in this repository are left as they are
- ✅ "Last exported <hash>" in the section header
- ✅ on disk: roles/development.md has the model and the retry model in its front matter — `"---\ncapabilities:\n  - artifact.write\n  - database\n  - filesystem.read\n  - filesystem.write\n  - git\n  - git.commit\n  - git.push\n  - github.pr.comment\n  - github.pr.create\n  - github.read\n  - human.ask\n  - mo`
- ✅ on disk: tandemise.yaml has version, the WIP limit and the monthly limit — `"defaults:\n  missionLimits: []\nlimits:\n  monthly:\n    - amount: 600\n      metric: agent_minutes\n      warnPercent: 80\nproject:\n  autonomy:\n    externalWrites: policy\n    financialActions: deny\n    localCodeCha`
- ✅ on disk: routines.yaml has the routine and no on/off or history
- ✅ on disk: every built-in role has a file — `["architecture.md","design.md","development.md","finance.md","product.md","qa.md","release.md","review.md"]`
- ✅ no timestamps, row ids or machine paths in the files
- ✅ a second export: the same hash — `["9b5107eef4e0","9b5107eef4e0"]`
- ✅ proof (git): the exported files show up as new files git will commit — `"?? .tandemise/roles/\n?? .tandemise/routines.yaml\n?? .tandemise/tandemise.yaml\n"`
- ✅ proof (git): none of them is ignored — `""`
- ✅ proof (API): the last export is remembered — `{"lastExport":{"hash":"9b5107eef4e0","repositoryName":"acceptance-project","files":21,"at":"2026-09-26T23:51:04.259Z"}}`
- screenshot: `Q1-before-export.png`
- screenshot: `Q1-exported.png`

## Q2 — A role's model edited in the file: one Change in the preview, applied, shown in Team

- note: edited on disk: roles/development.md model: base-model → better-model
- ✅ the preview counts one change and nothing else — `"From /tmp/tdm-p15/project/.tandemise: 0 to add · 1 to change · 0 to remove · 23 the same\n\nITEM\tKIND\tCHANGE\tYOUR CHOICE\n\nDeveloper\nmodel: base-model → better-model\n\tRole\tChange\t\nKeep mine\nTake theirs\n\n\nP`
- ✅ exactly one row is not Same: "Developer: Change" — `[["Developer: Change","Developer\nmodel: base-model → better-model\n\tRole\tChange\t\nKeep mine\nTake theirs"]]`
- ✅ it says what changes — `"Developer\nmodel: base-model → better-model\n\tRole\tChange\t\nKeep mine\nTake theirs"`
- ✅ its choice is "Take theirs"
- ✅ the model is unchanged until Apply (API)
- ✅ the window says it applied one change — `"Applied 1 change. Imported routines are off until you turn them on in Missions → Routines.\n\nChanged Developer: model: base-model → better-model"`
- ✅ Team → Roles → Developer: the "Model" field reads better-model — `"better-model"`
- ✅ proof (API): the role's model is better-model, its retry model kept — `{"model":"better-model","escalate":["strong-model"],"economyModel":null}`
- screenshot: `Q2-preview-one-change.png`
- screenshot: `Q2-applied.png`
- screenshot: `Q2-team-shows-new-model.png`

## Q3 — An imported routine arrives off, marked "Imported — review and turn on"

- note: edited on disk: routines.yaml gains "Friday status report" (weekly, Friday 16:00)
- ✅ the preview counts one to add — `"From /tmp/tdm-p15/project/.tandemise: 1 to add · 0 to change · 0 to remove · 24 the same\n\nITEM\tKIND\tCHANGE\tYOUR CHOICE\n\nFriday status report\nA new routine.\nArrives off: turn it on in Missions → Routines after r`
- ✅ its row: "Friday status report: Add", arriving off — `["Friday status report: Add","Friday status report\nA new routine.\nArrives off: turn it on in Missions → Routines after reviewing it.\n\tRoutine\tAdd\t\nKeep mine\nTake theirs"]`
- ✅ applied, and told routines arrive off — `"Applied 1 change. Imported routines are off until you turn them on in Missions → Routines.\n\nAdded Friday status report"`
- ✅ Missions → Routines: the row says "Imported — review and turn on" — `"Friday status report\nEvery Friday at 16:00 ·\nPaused\nImported — review and turn on\nStatus report\nOff\nRun now\nEdit"`
- ✅ and it is Off and paused — `"Friday status report\nEvery Friday at 16:00 ·\nPaused\nImported — review and turn on\nStatus report\nOff\nRun now\nEdit"`
- ✅ its switch is off
- ✅ proof (API): enabled false, no next run — `{"id":"rtn_01m3g24a53b2bk2j3s13","workspaceId":"ws_01m3g21zjrd1hxp0tq08","name":"Friday status report","kind":"status_report","goal":"","successCriteria":[],"priority":"normal","limits":null,"workflowPreset":null,"schedu`
- ✅ proof (API): nothing started — no new mission
- screenshot: `Q3-preview-routine-add.png`
- screenshot: `Q3-routine-off-imported.png`

## Q4 — A workflow gate reading mission.stalled, or missing its output check, is refused with the reason

- note: wrote .tandemise/workflows/q4-stalled.yaml and q4-no-output.yaml in the project
- ✅ mission.stalled: "only known for the whole mission, not inside a step" — `"This workflow cannot run yet — steps.0.gate: The gate on 'release' reads mission.stalled, which is only known for the whole mission, not inside a step. (/tmp/tdm-p15/project/.tandemise/workflows/q4-stalled.yaml)"`
- ✅ no output check: "never checks that the step wrote its output: add artifact.ChangeSet.exists" — `"This workflow cannot run yet — steps.0.gate: The gate on 'build' never checks that the step wrote its output: add artifact.ChangeSet.exists, so a run that writes nothing cannot pass. (/tmp/tdm-p15/project/.tandemise/wor`
- ✅ a correct workflow shows no warning — `""`
- ✅ proof (API): both files are listed with their issue and no steps — `[{"id":"q4-no-output","name":"q4-no-output","description":null,"path":"/tmp/tdm-p15/project/.tandemise/workflows/q4-no-output.yaml","inputs":[],"steps":[],"issues":[{"path":"steps.0.gate","message":"The gate on 'build' n`
- screenshot: `Q4-stalled-gate-refused.png`
- screenshot: `Q4-output-check-refused.png`
