# P15 acceptance report

Run: 2026-09-27T04:29:17.072Z · build 0aec3a9 · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p15-run-mujbfl43
Result: **ALL PASS** (6/6 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| Q1 — Export writes the setup to .tandemise/, byte-stable, with the hash in the window | PASS | 13/13 |
| Q2 — A role's model edited in the file: one Change in the preview, applied, shown in Team | PASS | 8/8 |
| Q3 — An imported routine arrives off, marked "Imported — review and turn on" | PASS | 8/8 |
| Q4 — A workflow gate reading mission.stalled, or missing its output check, is refused with the reason | PASS | 4/4 |
| Q5 — Skill pins export as skills.lock; a missing skill shows "Needs import", is fetched with a preview, then applies | PASS | 16/16 |
| Q6 — Imported GitHub issue settings arrive off, marked "Imported — review and turn on" | PASS | 5/5 |

## Q1 — Export writes the setup to .tandemise/, byte-stable, with the hash in the window

- note: setup (API): monthly limit 600 agent minutes, WIP limit 2, one weekly routine
- ✅ the section says it has not been exported yet — `"Setup as code\nNot exported yet\nExport\n\nWrites your roles, workflows, routines, limits, project settings, skill pins and GitHub issue settings into .tandemise/ in a repository, so you can commit them a"`
- ✅ the window lists the files written and the content hash — `"Setup as code\nLast exported cd4d11ad0f91\nExport\n\nWrites your roles, workflows, routines, limits, project settings, skill pins and GitHub issue settings into .tandemise/ in a repository, so you can commit them and br`
- ✅ workflows already in this repository are left as they are
- ✅ "Last exported <hash>" in the section header
- ✅ on disk: roles/development.md has the model and the retry model in its front matter — `"---\ncapabilities:\n  - artifact.write\n  - database\n  - filesystem.read\n  - filesystem.write\n  - git\n  - git.commit\n  - git.push\n  - github.pr.comment\n  - github.pr.create\n  - github.read\n  - human.ask\n  - mo`
- ✅ on disk: tandemise.yaml has version, the WIP limit and the monthly limit — `"defaults:\n  missionLimits: []\nlimits:\n  monthly:\n    - amount: 600\n      metric: agent_minutes\n      warnPercent: 80\nproject:\n  autonomy:\n    externalWrites: policy\n    financialActions: deny\n    localCodeCha`
- ✅ on disk: routines.yaml has the routine and no on/off or history
- ✅ on disk: every built-in role has a file — `["architecture.md","design.md","development.md","finance.md","product.md","qa.md","release.md","review.md"]`
- ✅ no timestamps, row ids or machine paths in the files
- ✅ a second export: the same hash — `["cd4d11ad0f91","cd4d11ad0f91"]`
- ✅ proof (git): the exported files show up as new files git will commit — `"?? .tandemise/roles/\n?? .tandemise/routines.yaml\n?? .tandemise/tandemise.yaml\n"`
- ✅ proof (git): none of them is ignored — `""`
- ✅ proof (API): the last export is remembered — `{"lastExport":{"hash":"cd4d11ad0f91","repositoryName":"acceptance-project","files":24,"at":"2026-09-27T04:25:52.501Z"}}`
- screenshot: `Q1-before-export.png`
- screenshot: `Q1-exported.png`

## Q2 — A role's model edited in the file: one Change in the preview, applied, shown in Team

- note: edited on disk: roles/development.md model: base-model → better-model
- ✅ the preview counts one change and nothing else — `"From /tmp/tdm-p15/project/.tandemise: 0 to add · 1 to change · 0 to remove · 26 the same\n\nITEM\tKIND\tCHANGE\tYOUR CHOICE\n\nDeveloper\nmodel: base-model → better-model\n\tRole\tChange\t\nKeep mine\nTake theirs\n\n\nP`
- ✅ exactly one row is not Same: "Developer: Change" — `[["Developer: Change","Developer\nmodel: base-model → better-model\n\tRole\tChange\t\nKeep mine\nTake theirs"]]`
- ✅ it says what changes — `"Developer\nmodel: base-model → better-model\n\tRole\tChange\t\nKeep mine\nTake theirs"`
- ✅ its choice is "Take theirs"
- ✅ the model is unchanged until Apply (API)
- ✅ the window says it applied one change — `"Applied 1 change. Imported routines and issue settings are off until you turn them on (Missions → Routines, Repositories → Issues).\n\nChanged Developer: model: base-model → better-model"`
- ✅ Team → Roles → Developer: the "Model" field reads better-model — `"better-model"`
- ✅ proof (API): the role's model is better-model, its retry model kept — `{"model":"better-model","escalate":["strong-model"],"economyModel":null}`
- screenshot: `Q2-preview-one-change.png`
- screenshot: `Q2-applied.png`
- screenshot: `Q2-team-shows-new-model.png`

## Q3 — An imported routine arrives off, marked "Imported — review and turn on"

- note: edited on disk: routines.yaml gains "Friday status report" (weekly, Friday 16:00)
- ✅ the preview counts one to add — `"From /tmp/tdm-p15/project/.tandemise: 1 to add · 0 to change · 0 to remove · 27 the same\n\nITEM\tKIND\tCHANGE\tYOUR CHOICE\n\nFriday status report\nA new routine.\nArrives off: turn it on in Missions → Routines after r`
- ✅ its row: "Friday status report: Add", arriving off — `["Friday status report: Add","Friday status report\nA new routine.\nArrives off: turn it on in Missions → Routines after reviewing it.\n\tRoutine\tAdd\t\nKeep mine\nTake theirs"]`
- ✅ applied, and told routines arrive off — `"Applied 1 change. Imported routines and issue settings are off until you turn them on (Missions → Routines, Repositories → Issues).\n\nAdded Friday status report"`
- ✅ Missions → Routines: the row says "Imported — review and turn on" — `"Friday status report\nEvery Friday at 16:00 ·\nPaused\nImported — review and turn on\nStatus report\nOff\nRun now\nEdit"`
- ✅ and it is Off and paused — `"Friday status report\nEvery Friday at 16:00 ·\nPaused\nImported — review and turn on\nStatus report\nOff\nRun now\nEdit"`
- ✅ its switch is off
- ✅ proof (API): enabled false, no next run — `{"id":"rtn_01m3ghvfxfwr0xyg91cy","workspaceId":"ws_01m3ghs4mvyz89a882pc","name":"Friday status report","kind":"status_report","goal":"","successCriteria":[],"priority":"normal","limits":null,"workflowPreset":null,"schedu`
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

## Q5 — Skill pins export as skills.lock; a missing skill shows "Needs import", is fetched with a preview, then applies

- note: setup (API): imported house-style v1 (cedb72e68e4d) from /tmp/tdm-p15/skill-src/house-style; pinned it to QA; issue settings for acceptance-project (label ready-for-agents, every 15 min)
- note: a second project "Second machine" with a repository named acceptance-project; the window switches to it
- note: preview: From /tmp/tdm-p15/project/.tandemise: 20 to add · 5 to change · 0 to remove · 7 the same
- ✅ the export lists .tandemise/skills.lock and .tandemise/issues.yaml — `"Setup as code\nLast exported 912167f54610\nExport\n\nWrites your roles, workflows, routines, limits, project settings, skill pins and GitHub issue settings into .tandemise/ in a repository, so you can commit them and br`
- ✅ on disk: skills.lock names house-style v1 with its hash and folder — `{"skills":[{"hash":"cedb72e68e4d9460e01ff1d73065f5b2bf32c98438eb1c7e9d9d9e9bf4e1f6d8","name":"house-style","source":{"kind":"path","path":"/tmp/tdm-p15/skill-src/house-style"},"version":1}],"version":1}`
- ✅ on disk: skills.lock has none of the skill's content
- ✅ on disk: roles/qa.md carries the pin with its hash — `"---\ncapabilities:\n  - artifact.write\n  - browser\n  - browser.navigate\n  - deploy.read\n  - filesystem.read\n  - human.ask\n  - monitoring.read\n  - repository.read\n  - shell.exec\n  - tests.run\nconsumes:\n  - Cha`
- ✅ proof (disk): the skills store no longer has the files — `"/tmp/tdm-p15/home/skills/cedb72e68e4d9460e01ff1d73065f5b2bf32c98438eb1c7e9d9d9e9bf4e1f6d8"`
- ✅ the skill row: "house-style v1: Add" with "Needs import: house-style from <folder>" — `["house-style v1: Add","house-style v1\nIts files (cedb72e68e4d) are not on this machine. Import them from where they came from, then preview again.\nNeeds import: house-style from /tmp/tdm-p15/skill-src/house-style\nFet`
- ✅ it cannot be taken: its choice reads "Keep mine"
- ✅ the QA role that pins it cannot be taken yet, and says why — `["QA Engineer: Change","QA Engineer\nskills: none → house-style (cedb72e68e4d)\nNeeds import: house-style from /tmp/tdm-p15/skill-src/house-style. Import it first, then preview again.\nRuns on none in the files and on Sc`
- ✅ the row offers "Fetch house-style from its source…" — `["house-style v1: Add","house-style v1\nIts files (cedb72e68e4d) are not on this machine. Import them from where they came from, then preview again.\nNeeds import: house-style from /tmp/tdm-p15/skill-src/house-style\nFet`
- ✅ the fetch shows the skill's preview: name, hash, SKILL.md, "New skill" — `"house-style\ncedb72e68e4d\n1 file · 122 B\n\nHow we name and shape code.\n\nFrom /tmp/tdm-p15/skill-src/house-style\n\nNew skill\n\nFiles\nSKILL.md (122 B)\nSKILL.md\n\nName things after what they do. Keep functions sho`
- ✅ after importing, the folder is read again: "house-style v1: Same"
- ✅ and the QA role can be taken: "QA Engineer: Change", Take theirs — `["QA Engineer: Change","QA Engineer\nskills: none → house-style (cedb72e68e4d)\nRuns on none in the files and on Scripted agent here. Runtimes are set in Team, so this is not changed.\n\tRole\tChange\t\nKeep mine\nTake t`
- ✅ proof (API): house-style v1 is in the second project's library with the same hash
- ✅ applied, and the lines name the QA role — `"Applied 21 changes. Imported routines and issue settings are off until you turn them on (Missions → Routines, Repositories → Issues). Kept yours for 3.\n\nChanged Work-in-progress limit: limit: off → 2\n\nChanged Monthl`
- ✅ proof (API): QA in the second project pins house-style v1 — `[{"name":"house-style","version":1}]`
- ✅ reading the folder again: the skill and QA are Same — `"From /tmp/tdm-p15/project/.tandemise: 2 to add · 1 to change · 0 to remove · 29 the same"`
- screenshot: `Q5-export-skills-lock.png`
- screenshot: `Q5-needs-import.png`
- screenshot: `Q5-fetch-preview.png`

## Q6 — Imported GitHub issue settings arrive off, marked "Imported — review and turn on"

- note: the window is back on the acceptance project
- ✅ on disk: issues.yaml has the repository's settings, and no cursor or timestamp — `{"repositories":[{"closeOnComplete":true,"enabled":false,"githubRepo":"example/hello-site","label":"ready-for-agents","pollMinutes":15,"postComments":false,"repository":"acceptance-project","workflow":null}]}`
- ✅ the status reads "Imported — review and turn on" — `"Imported — review and turn on"`
- ✅ the "Turn labelled issues into missions" switch is off
- ✅ the label and the GitHub repository came across — `"Issues\nTurn labelled GitHub issues into missions\nacceptance-project\nOpen issues with the label become draft missions. An issue that lists “Done when” or “Acceptance criteria” is queued, ready to plan; any other waits`
- ✅ proof (API): off, every 15 minutes, close on complete, no comments, never checked — `{"enabled":false,"githubRepo":"example/hello-site","label":"ready-for-agents","pollMinutes":15,"closeOnComplete":true,"postComments":false,"workflowPreset":null,"lastCheckedAt":null,"lastError":"Imported — review and tur`
- screenshot: `Q6-issues-imported-off.png`
