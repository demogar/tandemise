# P3b acceptance report

Run: 2026-09-28T18:22:09.250Z · build b334b0e · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p3b-run-mulkmanl
Command: `node scratch/acceptance/p3-evals/run-all.mjs --keep-going`
Result: **ALL PASS** (6/6 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| E1 — Save as eval case on a succeeded build step | PASS | 14/14 |
| E2 — A Models candidate against the role on "bad": progress, then a +100 point scorecard; no trial shows anywhere | PASS | 19/19 |
| E3 — Setup as code: a fixture folder's "Try on evals" prefills the Runs form and applies nothing | PASS | 11/11 |
| E4 — A $0.60 spend cap at $0.25 a run stops the run | PASS | 6/6 |
| E5 — From your runs: role × model rows from the real missions | PASS | 5/5 |
| E6 — No trial worktree or branch is left after the runs | PASS | 6/6 |

## E1 — Save as eval case on a succeeded build step

- note: the daemon runs with SCRIPTED_FAIL_MODEL=bad and SCRIPTED_COST_USD=0.25: a run on "bad" writes nothing, every run reports $0.25
- note: the case row reads: ["Hello banner build","build","Developer","ba4a4cd","DesignBrief: Scripted work (DesignBrief)","from Add a hello banner to the page",""]
- ✅ setup (API): the scripted runtime reports NDJSON and takes --model — `{"outputFormat":"ndjson","modelFlag":"--model"}`
- ✅ setup (API): the Developer role is on the model "good" — `{"model":"good","escalate":[],"economyModel":null}`
- ✅ proof (API): the mission completed and its build step SUCCEEDED — `{"mission":"COMPLETE","build":"SUCCEEDED"}`
- ✅ proof (API): the build passed on its first run — `[{"id":"run_01m3mktyfs4gtekgnvsq","status":"SUCCEEDED"}]`
- ✅ the succeeded build card offers "Save as eval case" — `"DEVELOPER\nbuild\nDone\njust now\nby\nCoding agent\n·\nresponsible\nYou\nFull doc\nContinue elsewhere\nSave as eval case\nRequest changes\n\nChangeSet ready for the hello page\n\nWritten by the scripted acceptance agent\nNo model was called"`
- ✅ with no suite yet, the dialog offers a new suite, and the case name defaults to the step title — `{"suite":"New suite…","caseName":"build","newSuite":true,"stepTitle":"build"}`
- ✅ the dialog says "Saved to Runs." with a link to Evals — `"Save as eval case\n\nSaved to Runs. Open Evals\n\nDone"`
- ✅ proof (API): a suite "Runs" with one case, from this mission's build step — `{"suite":{"id":"esu_01m3mkv5k9wwmhs0nd65","workspaceId":"ws_01m3mktjshky99t38n8j","name":"Runs","createdAt":"2026-09-28T18:18:42.665Z","updatedAt":"2026-09-28T18:18:42.665Z","cases":1},"kase":{"name":"Hello banner build","source":{"missionId":"msn_01m3mktshd1bn3tg2jt8","missionTitle":"Add a hello ba`
- ✅ proof (API): the case keeps its base commit (a commit in the project) and its DesignBrief input — `{"baseSha":"ba4a4cd1833d25b6addc3333767b927f9ca240b6","inputs":[{"type":"DesignBrief","title":"DesignBrief: Scripted work"}]}`
- ✅ the Suites tab lists "Runs · 1 case" and the case row — `["Hello banner build","build","Developer","ba4a4cd","DesignBrief: Scripted work (DesignBrief)","from Add a hello banner to the page",""]`
- ✅ the row shows the short base commit (7 characters of the case's base) — `{"shown":"ba4a4cd","baseSha":"ba4a4cd1833d25b6addc3333767b927f9ca240b6"}`
- ✅ the row shows its input: the design brief, (DesignBrief) — `"DesignBrief: Scripted work (DesignBrief)"`
- ✅ the row names the mission it came from, linked
- ✅ the Evals tab is active in the sidebar
- screenshot: `E1-build-card.png`
- screenshot: `E1-save-dialog.png`
- screenshot: `E1-saved.png`
- screenshot: `E1-suites-tab.png`

## E2 — A Models candidate against the role on "bad": progress, then a +100 point scorecard; no trial shows anywhere

- note: Trials ["Trials","3 completed / 0 blocked / 3 failed","3 completed / 0 blocked / 0 failed","—"]; First-attempt ["First-attempt pass rate","0%","100%","+100 pts"]; Cost ["Cost (mean, total)","$0.50 · $1.50 total","$0.25 · $0.75 total","−$0.25"]
- ✅ proof (API): the Developer role is on "bad" now — `{"model":"bad","escalate":[],"economyModel":null}`
- ✅ a suite with no runs opens the new-run form, on Models, prefilled with the role's model "bad" — `"bad"`
- ✅ proof (API): the run is Models → Developer on "good", 3 repeats, cap $10 — `{"candidate":{"kind":"models","roles":{"development":"good"}},"repeats":3,"cap":10}`
- ✅ while it runs, the window shows "n / 6 trials" and "Cancel run" — `{"progress":"Progress\n1 / 6 trials\n3 repeats of each case, with the setup you have now and with the change","status":"running"}`
- ✅ the spend shows against the cap: "Spent $… of $10.00" — `"Spend\nSpent $0.50 of $10.00\nThe run stops when it reaches the cap."`
- ✅ proof (SQL): the trials are real missions ("Eval trial …") — `[{"id":"msn_01m3mkwe5j790x8q95z8","title":"Eval trial Hello banner build candidate 1","status":"COMPLETE"},{"id":"msn_01m3mkwgh0wr87mjnfva","title":"Eval trial Hello banner build baseline 2","status":"DRAFT"},{"id":"msn_01m3mkw7jsv97f2p7mbz","title":"Eval trial Hello banner build baseline 1","status`
- ✅ proof (API, during): the mission list, Home, the Inbox and approvals name no trial mission — `{"trials":3,"listed":["Add a hello banner to the page"]}`
- ✅ the Missions list (during, All) shows E1's mission, counts 1 mission, and no "Eval trial" — `"Missions\nEvery outcome the workforce is pursuing, past and present.\nNew mission\nBacklog\n0\nRoutines\n0\nActive\n0\nNeeds attention\n0\nFinished\n1\nAll\n1\nAdd a hello banner to the page\nmsn_01m3mktshd1bn3tg2jt8\nEvery task succeeded.\n0 of 1 verified\nacceptance-project\n2/2\nComplete\n50s ag`
- ✅ the Desk (during) shows no "Eval trial" — `"Nothing needs you\nAcceptance workspace\nStatus report\nNew mission\nNeeds you\n0\nNothing waits on you\nWorking on\n0\n0 queued · no limit\nCriteria verified\nNone yet\nNo mission in progress has criteria\nThis month\n0.1 agent min\nNo monthly limit set\nStalled\n0\nEverything can move\nNeeds you `
- ✅ the Inbox (during) shows no "Eval trial" — `"Inbox\nWhat is waiting on a person.\nNothing is waiting on you\n\nApprovals, questions, tasks for a person, work to hand back, stalled missions and quiet agents land here, one line each.\n\nDecided\n1 decision\nApprove the plan for Add a hello banner to the page?\nApproved·\nby\nYou\nAdd a hello ba`
- ✅ proof (API): the run completed, 6 of 6 trials — `{"status":"completed","progress":{"done":6,"total":6},"reason":null}`
- ✅ proof (API): gate pass rate baseline 0, candidate 1, difference +1 — `{"baseline":0,"candidate":1,"difference":1,"trials":{"baseline":{"completed":3,"blocked":0,"failed":3},"candidate":{"completed":3,"blocked":0,"failed":0}}}`
- ✅ the scorecard reads Gate pass rate: Baseline 0%, Candidate 100%, Difference +100 pts — `["Gate pass rate","0%","100%","+100 pts"]`
- ✅ the difference is marked better (the success colour)
- ✅ no few-repeats note at 3 repeats
- ✅ proof (API, after): the mission list, Home, the Inbox and approvals name no trial mission — `{"trials":6,"listed":["Add a hello banner to the page"]}`
- ✅ the Missions list (after, All) shows E1's mission, counts 1 mission, and no "Eval trial" — `"Missions\nEvery outcome the workforce is pursuing, past and present.\nNew mission\nBacklog\n0\nRoutines\n0\nActive\n0\nNeeds attention\n0\nFinished\n1\nAll\n1\nAdd a hello banner to the page\nmsn_01m3mktshd1bn3tg2jt8\nEvery task succeeded.\n0 of 1 verified\nacceptance-project\n2/2\nComplete\n1m ago`
- ✅ the Desk (after) shows no "Eval trial" — `"Nothing needs you\nAcceptance workspace\nStatus report\nNew mission\nNeeds you\n0\nNothing waits on you\nWorking on\n0\n0 queued · no limit\nCriteria verified\nNone yet\nNo mission in progress has criteria\nThis month\n0.1 agent min\nNo monthly limit set\nStalled\n0\nEverything can move\nNeeds you `
- ✅ the Inbox (after) shows no "Eval trial" — `"Inbox\nWhat is waiting on a person.\nNothing is waiting on you\n\nApprovals, questions, tasks for a person, work to hand back, stalled missions and quiet agents land here, one line each.\n\nDecided\n1 decision\nApprove the plan for Add a hello banner to the page?\nApproved·\nby\nYou\nAdd a hello ba`
- screenshot: `E2-run-form.png`
- screenshot: `E2-running.png`
- screenshot: `E2-missions-during.png`
- screenshot: `E2-desk-during.png`
- screenshot: `E2-inbox-during.png`
- screenshot: `E2-scorecard.png`
- screenshot: `E2-missions-after.png`
- screenshot: `E2-desk-after.png`
- screenshot: `E2-inbox-after.png`

## E3 — Setup as code: a fixture folder's "Try on evals" prefills the Runs form and applies nothing

- ✅ the fixture is the project's exported setup, with the Developer role on "good" instead of "bad" — `{"files":[".tandemise/roles/architecture.md",".tandemise/roles/design.md",".tandemise/roles/development.md",".tandemise/roles/finance.md",".tandemise/roles/product.md",".tandemise/roles/qa.md",".tandemise/roles/release.md",".tandemise/roles/review.md",".tandemise/routines.yaml",".tandemise/tandemise`
- ✅ the project is back to its committed files (the fixture lives outside it) — `""`
- ✅ control (daemon log): the log does record setup actions ("setup.exported" is there)
- ✅ the preview of the fixture shows the Developer role's model changing to "good" — `" so an import never starts work.\n\nImport from a folder…\n\nFrom /tmp/tdm-p3b/setup-fixture/.tandemise: 0 to add · 1 to change · 0 to remove · 28 the same\n\nITEM\tKIND\tCHANGE\tYOUR CHOICE\n\nDeveloper\nmodel: bad → good\n\tRole\tChange\t\nKeep mine\nTake theirs\n\n\nProject settings\n\tProject\t`
- ✅ the Runs form opens on Setup, prefilled with the fixture folder — `"New run\nSuite\nRuns (1 case)\nTry\nModels\nSkills\nSetup\nSetup folder\n/tmp/tdm-p3b/setup-fixture\nChange…\nA repository, or its .tandemise folder. Its roles are tried as they are there; nothing is applied to this project.\nRepeats\nEach case runs this many times with the setup you have now, and `
- ✅ the form is on E1's suite
- ✅ the location is the Evals Runs tab — `"#/evals?tab=runs"`
- ✅ proof (API): the project's roles are unchanged (the Developer is still on "bad") — `{"model":"bad","escalate":[],"economyModel":null}`
- ✅ proof (API): the setup status is unchanged, so no setup was applied — `{"lastExport":{"hash":"d41e1ad76b11","repositoryName":"acceptance-project","files":27,"at":"2026-09-28T18:20:22.007Z"}}`
- ✅ proof (daemon log): no "setup.applied" was logged, before or after — `{"before":0,"after":0}`
- ✅ proof (API): no run was started by opening the form
- screenshot: `E3-setup-preview.png`
- screenshot: `E3-runs-form-prefilled.png`

## E4 — A $0.60 spend cap at $0.25 a run stops the run

- note: run header: "Stopped at cap\nStarted Sep 28, 2026, 1:20 PM\n· finished Sep 28, 2026, 1:21 PM"
- ✅ proof (API): the run has a $0.60 cap, 2 repeats, Developer on "good" — `{"cap":0.6,"repeats":2,"candidate":{"kind":"models","roles":{"development":"good"}}}`
- ✅ proof (API): the run stopped at its cap — `{"status":"stopped_at_cap","reason":"Stopped at your $0.60 cap"}`
- ✅ proof (API): its reason is "Stopped at your $0.60 cap" — `"Stopped at your $0.60 cap"`
- ✅ proof (API): it spent at least the cap, measured, and the trials not yet run were cancelled — `{"spentUsd":0.75,"progress":{"done":4,"total":4},"trials":["baseline 1 failed","candidate 1 passed","baseline 2 cancelled","candidate 2 cancelled"]}`
- ✅ the window shows "Stopped at your $0.60 cap" — `"Stopped at your $0.60 cap"`
- ✅ the spend reads "Spent $… of $0.60" — `"Spend\nSpent $0.75 of $0.60"`
- screenshot: `E4-run-form.png`
- screenshot: `E4-stopped-at-cap.png`

## E5 — From your runs: role × model rows from the real missions

- note: API summary: [{"roleId":"development","model":"good","runs":1,"firstAttemptPassRate":1,"meanAttemptsToPass":1,"criteriaFailed":0,"medianCostUsd":0.25,"medianWallTimeMs":1564}]
- note: columns: ["ROLE","MODEL","RUNS","FIRST-ATTEMPT PASS","ATTEMPTS TO PASS","CRITERIA FAILED","MEDIAN COST","MEDIAN TIME"]
- note: rows: ["Developer on good"]
- ✅ proof (API): Developer on "good" — 1 run, first-attempt pass rate 1, median cost $0.25 — `{"roleId":"development","model":"good","runs":1,"firstAttemptPassRate":1,"meanAttemptsToPass":1,"criteriaFailed":0,"medianCostUsd":0.25,"medianWallTimeMs":1564}`
- ✅ proof (API): no Developer on "bad" row (every "bad" run was an eval trial) — `["development/good"]`
- ✅ proof (SQL): trials were scored too, but kept out of this summary — `{"trialScores":12}`
- ✅ the window has a "Developer on good" row: 1 run, First-attempt pass 100%, Median cost $0.25 — `["Developer","good","1","100%","1","0","$0.25","2s"]`
- ✅ no "Developer on bad" row in the window
- screenshot: `E5-from-your-runs.png`

## E6 — No trial worktree or branch is left after the runs

- note: trial execution targets: [{"branch":"tandemise/eval-trial-hello-banner-build-baseline-1/eval-trial-hello-banner-build-baseline-1-build-axvwfpev","path":"/tmp/tdm-p3b/home/workspaces/ws_01m3mktjshky99t38n8j/missions/msn_01m3mkw7jsv97f2p7mbz/worktrees/eval-trial-hello-banner-build-baseline-1-build-axvwfpev","status":"RELEASED"},{"branch":"tandemise/eval-trial-hello-banner-build-baseline-1/eval-trial-hello-banner-build-baseline-1-build-axvwfpev","path":"/tmp/tdm-p3b/home/workspaces/ws_01m3mktjshky99t38n8j/missions/msn_01m3mkw7jsv97f2p7mbz/worktrees/eval-trial-hello-banner-build-baseline-1-build-axvwfpev","status":"RELEASED"},{"branch":"tandemise/eval-trial-hello-banner-build-candidate-1/eval-trial-hello-banner-build-candidate-1-build-zvg7nrvq","path":"/tmp/tdm-p3b/home/workspaces/ws_01m3mktjshky99t38n8j/missions/msn_01m3mkwe5j790x8q95z8/worktrees/eval-trial-hello-banner-build-candidate-1-build-zvg7nrvq","status":"RELEASED"},{"branch":"tandemise/eval-trial-hello-banner-build-baseline-2/eval-trial-hello-banner-build-baseline-2-build-grhqkctk","path":"/tmp/tdm-p3b/home/workspaces/ws_01m3mktjshky99t38n8j/missions/msn_01m3mkwgh0wr87mjnfva/worktrees/eval-trial-hello-banner-build-baseline-2-build-grhqkctk","status":"RELEASED"},{"branch":"tandemise/eval-trial-hello-banner-build-baseline-2/eval-trial-hello-banner-build-baseline-2-build-grhqkctk","path":"/tmp/tdm-p3b/home/workspaces/ws_01m3mktjshky99t38n8j/missions/msn_01m3mkwgh0wr87mjnfva/worktrees/eval-trial-hello-banner-build-baseline-2-build-grhqkctk","status":"RELEASED"},{"branch":"tandemise/eval-trial-hello-banner-build-candidate-2/eval-trial-hello-banner-build-candidate-2-build-06gwcssw","path":"/tmp/tdm-p3b/home/workspaces/ws_01m3mktjshky99t38n8j/missions/msn_01m3mkwpz36s05hk8xw3/worktrees/eval-trial-hello-banner-build-candidate-2-build-06gwcssw","status":"RELEASED"},{"branch":"tandemise/eval-trial-hello-banner-build-baseline-3/eval-trial-hello-banner-build-baseline-3-build-q1wdt2qj","path":"/tmp/tdm-p3b/home/workspaces/ws_01m3mktjshky99t38n8j/missions/msn_01m3mkwsac46dq5brbvh/worktrees/eval-trial-hello-banner-build-baseline-3-build-q1wdt2qj","status":"RELEASED"},{"branch":"tandemise/eval-trial-hello-banner-build-baseline-3/eval-trial-hello-banner-build-baseline-3-build-q1wdt2qj","path":"/tmp/tdm-p3b/home/workspaces/ws_01m3mktjshky99t38n8j/missions/msn_01m3mkwsac46dq5brbvh/worktrees/eval-trial-hello-banner-build-baseline-3-build-q1wdt2qj","status":"RELEASED"},{"branch":"tandemise/eval-trial-hello-banner-build-candidate-3/eval-trial-hello-banner-build-candidate-3-build-k0szahmh","path":"/tmp/tdm-p3b/home/workspaces/ws_01m3mktjshky99t38n8j/missions/msn_01m3mkwzsg7ds3khsnb8/worktrees/eval-trial-hello-banner-build-candidate-3-build-k0szahmh","status":"RELEASED"},{"branch":"tandemise/eval-trial-hello-banner-build-baseline-1/eval-trial-hello-banner-build-baseline-1-build-g92nhkr7","path":"/tmp/tdm-p3b/home/workspaces/ws_01m3mktjshky99t38n8j/missions/msn_01m3mkz913ra1c8ywzrw/worktrees/eval-trial-hello-banner-build-baseline-1-build-g92nhkr7","status":"RELEASED"},{"branch":"tandemise/eval-trial-hello-banner-build-baseline-1/eval-trial-hello-banner-build-baseline-1-build-g92nhkr7","path":"/tmp/tdm-p3b/home/workspaces/ws_01m3mktjshky99t38n8j/missions/msn_01m3mkz913ra1c8ywzrw/worktrees/eval-trial-hello-banner-build-baseline-1-build-g92nhkr7","status":"RELEASED"},{"branch":"tandemise/eval-trial-hello-banner-build-candidate-1/eval-trial-hello-banner-build-candidate-1-build-rfc4wryv","path":"/tmp/tdm-p3b/home/workspaces/ws_01m3mktjshky99t38n8j/missions/msn_01m3mkzfgamp9teqn87t/worktrees/eval-trial-hello-banner-build-candidate-1-build-rfc4wryv","status":"RELEASED"}]
- note: git worktree list:
/private/var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p3b-run-mulkmanl/project                                                                                                                            ba4a4cd [main]
/private/var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p3b-run-mulkmanl/home/workspaces/ws_01m3mktjshky99t38n8j/missions/msn_01m3mktshd1bn3tg2jt8/worktrees/add-a-hello-banner-to-the-page-build-dy95hn8p  7643b08 [tandemise/add-a-hello-banner-to-the-page/add-a-hello-banner-to-the-page-build-dy95hn8p]
- note: git branch --list 'tandemise/eval-trial*': ""
- note: the project's other tandemise/* branches (real missions): "+ tandemise/add-a-hello-banner-to-the-page/add-a-hello-banner-to-the-page-build-dy95hn8p"
- ✅ proof (API): every eval run on the suite has ended — `[{"id":"ern_01m3mkw7jqycwg0a25sa","status":"completed"},{"id":"ern_01m3mkz91225zn23z5e4","status":"stopped_at_cap"}]`
- ✅ proof (API): no trial is still running — `["failed","passed","failed","passed","failed","passed","failed","passed","cancelled","cancelled"]`
- ✅ proof (SQL): the trials did work on tandemise/eval-trial-* branches — `[{"branch":"tandemise/eval-trial-hello-banner-build-baseline-1/eval-trial-hello-banner-build-baseline-1-build-axvwfpev","path":"/tmp/tdm-p3b/home/workspaces/ws_01m3mktjshky99t38n8j/missions/msn_01m3mkw7jsv97f2p7mbz/worktrees/eval-trial-hello-banner-build-baseline-1-build-axvwfpev","status":"RELEASED`
- ✅ `git worktree list` in the project shows no trial worktree — `"/private/var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p3b-run-mulkmanl/project                                                                                                                            ba4a4cd [main]\n/private/var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p3b-run-mulkm`
- ✅ `git branch --list 'tandemise/eval-trial*'` in the project shows none — `""`
- ✅ no trial worktree folder is left on disk — `[]`
