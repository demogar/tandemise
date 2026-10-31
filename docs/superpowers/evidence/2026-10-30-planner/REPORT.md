# Planner acceptance (#53)

Run: 2026-10-31T04:23:05.122Z · build ab68aed · fresh install at /tmp/tdm-planner-run-mvvvu2au
Result: **ALL PASS** (10/10 scenarios, PM1–PM10, scripted agent). PM1R on the real Claude Code runtime: **PASS** (separate fresh install, below; the first --real-claude attempt in this run stopped in its own setup, a non-fast-forward push of the README fixture, fixed and rerun).

## PM1 — A tiny fix plans at once in the quick lane and opens a pull request: PASS

- note: mission msn_01m682ch8vk50mzddmhr
- note: mission ends EXECUTING
- ok New mission: the workflow defaults to "Let the factory decide" — `"Let the factory decide"`
- ok a factory draft offers Plan, Plan quick and Plan careful, Plan not held back for a Done-when line — `["Plan","Plan quick","Plan careful",""]`
- ok planned and running at once, with no Done-when line — `"EXECUTING"`
- ok no "Approve the plan" card — `[]`
- ok Plan header reads "Fix · tiny · low risk" — `"Fix\ntiny\nlow risk\nMake it careful\n\nFix · tiny · low risk\n\nQuick lane: one step, then a pull request. The project's lane rules matched it.\n\nNo plan approval.\nNo separate review or QA: the tests carry it, and th`
- ok …and "Quick lane: one step, then a pull request." — `"Fix\ntiny\nlow risk\nMake it careful\n\nFix · tiny · low risk\n\nQuick lane: one step, then a pull request. The project's lane rules matched it.\n\nNo plan approval.\nNo separate review or QA: the tests carry it, and th`
- ok …skipped ceremony in words ("No plan approval.") — `"Fix\ntiny\nlow risk\nMake it careful\n\nFix · tiny · low risk\n\nQuick lane: one step, then a pull request. The project's lane rules matched it.\n\nNo plan approval.\nNo separate review or QA: the tests carry it, and th`
- ok …the step line "Implement · role model" — `"Fix\ntiny\nlow risk\nMake it careful\n\nFix · tiny · low risk\n\nQuick lane: one step, then a pull request. The project's lane rules matched it.\n\nNo plan approval.\nNo separate review or QA: the tests carry it, and th`
- ok the "Fix" chip opens its signals as sentences — `"Title prefix fix: → type fix"`
- ok one agent step, then the ship step — `["implement:agent","ship:ship"]`
- ok GET /ship: one pull request opened on acme/web — `{"missionId":"msn_01m682ch8vk50mzddmhr","taskId":"tsk_01m682ck6je6g0m4j01q","prs":[{"repo":"acme/web","number":1,"url":"https://github.com/acme/web/pull/1","state":"opened","decision":null}],"stage":"ci","headline":"Wait`
- ok ship card shows the pull request with Open in GitHub — `"Waiting for CI (0 of 0 checks done)\n\nThe pull request is open; Tandemise decides once CI is green on its head commit.\n\nacme/web #1\nOpen in GitHub"`
- ok fake gh saw `pr create` without --draft — `["pr create --repo acme/web --head tandemise/fix-typo-in-the-settings-title/fix-typo-in-the-settings-title-implement-g0m4j01p --base main --title fix: typo in the settings title --body-file -"]`
- ok the pull request is not a draft and is titled from the profile — `{"title":"fix: typo in the settings title","isDraft":false}`
- screenshot: `pm1-draft.png`
- screenshot: `pm1-why-these-steps.png`
- screenshot: `pm1-ship-card.png`

## PM2 — With auto-merge off, a green tiny fix asks for review and says what would have happened: PASS

- note: mission msn_01m682dpebt6e0zjn8p8
- ok GET /ship: waiting for your review — `"Waiting for your review"`
- ok …the decision asks, with "Auto-merge is off for this project." — `{"id":"mrg_01m682dtwsmef4x19k8y","verdict":"ask","headSha":"cb986f3e89c326b59512ef0e1448c644d2d1e577","scoreLine":"Risk score 1 of 2 allowed","reasons":["Auto-merge is off for this project."],"factors":["no independent r`
- ok …and would have merged: score 1 of 2 (no independent review in the quick lane) — `"would have merged: score 1 of 2"`
- ok the ship card says "Waiting for your review" — `"Waiting for your review\n\nWaiting for your review: Auto-merge is off for this project.\n\nacme/web #2\nOpen in GitHub\nMerge\nAuto-merge is off for this project.\n\nRisk score 1 of 2 allowed: no independent review (+1)`
- ok …"Auto-merge is off for this project." — `"Waiting for your review\n\nWaiting for your review: Auto-merge is off for this project.\n\nacme/web #2\nOpen in GitHub\nMerge\nAuto-merge is off for this project.\n\nRisk score 1 of 2 allowed: no independent review (+1)`
- ok …"What would have happened with auto-merge on: would have merged: score 1 of 2" — `"Waiting for your review\n\nWaiting for your review: Auto-merge is off for this project.\n\nacme/web #2\nOpen in GitHub\nMerge\nAuto-merge is off for this project.\n\nRisk score 1 of 2 allowed: no independent review (+1)`
- ok …and a Merge button — `"Waiting for your review\n\nWaiting for your review: Auto-merge is off for this project.\n\nacme/web #2\nOpen in GitHub\nMerge\nAuto-merge is off for this project.\n\nRisk score 1 of 2 allowed: no independent review (+1)`
- ok the Inbox has "Review and merge" — `["Review and merge fix: typo in the profile title"]`
- ok fake gh saw no pr merge
- screenshot: `pm2-ship-card.png`

## PM3 — Turning auto-merge on needs the brain, shows the backtest first and records a Decision: PASS

- ok without a brain, auto-merge cannot be turned on — `"PUT /v1/workspaces/ws_01m682cdcy155ydr66ze/merge-policy -> 412 {\"error\":{\"code\":\"PRECONDITION_FAILED\",\"message\":\"Auto-merge needs a brain: link one in Project settings first, so the policy and who turned it on `
- ok a local brain is linked — `{"clone_path":"/tmp/tdm-planner/home/brains/ws_01m682cdcy155ydr66ze"}`
- ok the backtest is shown before saving: "Over the last 90 days this would have merged …" — `"Merge\nWhen Tandemise merges a pull request on its own\nAuto-merge is off\n\nEvery pull request asks for your review. The ship card still says what would have happened.\n\nOver the last 90 days this would have merged 2 `
- ok …and nothing is written yet — `""`
- ok the brain's factory/merge.yaml says autoMerge: on — `"version: 1\nautoMerge: on\nmethod: squash\nreviewers: []\ntests:\n  - \"**/*.test.*\"\n  - \"**/*.spec.*\"\n  - \"**/test/**\"\n  - \"**/tests/**\"\n  - scratch/**/*-check.mjs\nnever:\n  - paths:\n      - \"**/migration`
- ok a Decision records it: "Auto-merge low-risk pull requests in …" — `[{"title":"Auto-merge low-risk pull requests in Acceptance","status":"accepted"}]`
- ok the Merge section says auto-merge is on, with Stop auto-merging — `"Merge\nWhen Tandemise merges a pull request on its own\nAuto-merge is on\nStop auto-merging\n\nA pull request merges on its own when CI is green on its head commit, nothing below says never, and its risk score is at mos`
- screenshot: `pm3-backtest.png`
- screenshot: `pm3-on.png`

## PM4 — A tiny fix with CI green merges on its own: PASS

- note: mission msn_01m6833bypzs958dd7zs
- ok GET /ship: "Merged on its own" — `{"headline":"Merged on its own","d":{"id":"mrg_01m6833fz1yg2ps1zc48","verdict":"merge","headSha":"ebd1ed5e77ec9b497884b7db6d72a28b60b2dd49","scoreLine":"Risk score 1 of 2 allowed","reasons":[],"factors":["no independent `
- ok fake gh saw `pr merge … --squash --match-head-commit <the decided sha>` — `"pr merge 8 --repo acme/web --squash --match-head-commit ebd1ed5e77ec9b497884b7db6d72a28b60b2dd49 --subject fix: typo in the about title (#8) --body Tandemise-Merge: auto; score 1/2\nTandemise-Policy: planner shipped, ro`
- ok the PR comment says "Tandemise merged this on its own: risk score …" — `["Tandemise merged this on its own: risk score 1 of 2 allowed. Touched `hello.txt` (no sensitive areas), 1 line, no tests changed, CI green on `ebd1ed5`. Policy: planner shipped, routing shipped, merge brain:3985b9c22628`
- ok the ship card reads "Merged on its own" with the score, the policy and Revert — `"Merged on its own\n\nMerged on its own: risk score 1 of 2 allowed.\n\nacme/web #8\nOpen in GitHub\nRevert\n\nRisk score 1 of 2 allowed: no independent review (+1)\n\nChecked ebd1ed5 · policy planner shipped, routing shi`
- screenshot: `pm4-ship-card.png`

## PM5 — A change that touches a migration always asks: PASS

- note: mission msn_01m682ev627xr9z1dry9
- ok the decision asks: "Touches db/migrations/0042_add_index.sql — never merged on its own in this project." — `["Auto-merge is off for this project.","Touches db/migrations/0042_add_index.sql — never merged on its own in this project.","This was careful work, which always asks for a review.","Risk score 3 of 2 allowed: no tests c`
- ok the ship card says so — `"Waiting for your review\n\nWaiting for your review: Auto-merge is off for this project.\n\nacme/web #3\nOpen in GitHub\nMerge\nAuto-merge is off for this project.\nTouches db/migrations/0042_add_index.sql — never merged`
- ok fake gh saw no pr merge
- screenshot: `pm5-ship-card.png`

## PM6 — A quick fix that touches auth gets a security review before its pull request: PASS

- note: mission msn_01m682g1cvr2ehavh0gw
- ok predicted quick: "Quick lane: one step, then a pull request." — `"Fix\ntiny\nlow risk\nMake it careful\n\nFix · tiny · low risk\n\nQuick lane: one step, then a pull request. The project's lane rules matched it.\n\nNo plan approval.\nNo separate review or QA: the tests carry it, and th`
- ok a Security review step was added and ran — `{"title":"Security review","status":"SUCCEEDED"}`
- ok the mission's events say "It touched src/auth/session.ts, so I added a security review." — `["Mission created: fix: typo in the login button label SCRIPTED_TOUCH=src/auth/session.ts","Plan chosen by the factory (2 tasks: development → ship): quick lane.","It touched src/auth/session.ts, so I added a security re`
- ok the Timeline shows it in those words — `"msn_01m682g1cvr2ehavh0gw\nMissions\nChosen by the factory\nfix: typo in the login button label…\nfix: typo in the login button label SCRIPTED_TOUCH=src/auth/session.ts\nExecuting\nPause\nCancel\n1 decision waiting on yo`
- ok the Plan header now says "Added a security review because it touches auth." — `"Fix\ntiny\nhigh risk\n\nFix · tiny · high risk\n\nCareful lane now: the change turned out riskier than planned, so 2 steps run before a pull request that always asks for review. The project's lane rules matched it.\n\nN`
- ok …and lists the Security review step — `"Fix\ntiny\nhigh risk\n\nFix · tiny · high risk\n\nCareful lane now: the change turned out riskier than planned, so 2 steps run before a pull request that always asks for review. The project's lane rules matched it.\n\nN`
- ok GET /ship: the pull request opened after the review — `{"missionId":"msn_01m682g1cvr2ehavh0gw","taskId":"tsk_01m682g2snarge44kqkt","prs":[{"repo":"acme/web","number":4,"url":"https://github.com/acme/web/pull/4","state":"opened","decision":{"id":"mrg_01m682g74atdy1nt5sc4","ve`
- ok …and only after the security review finished — `{"reviewDone":"2026-10-31T04:11:49.797Z","opened":"2026-10-31T04:11:50.119Z"}`
- screenshot: `pm6-predicted.png`
- screenshot: `pm6-timeline.png`
- screenshot: `pm6-measured.png`

## PM7 — Plan careful asks for a Done-when line first, then plans with an approval card: PASS

- note: mission msn_01m682h78vmr0zktjdqr
- ok Plan careful with no criteria opens "Get it ready" on the feed — `"Get it ready\nNeeds a Done-when criterion\n\nBefore anything is planned, say what done means. Refine asks the product agent to read your request, propose criteria you can check, and ask only what would change the plan. `
- ok …the mission stays a draft, marked careful — `{"status":"DRAFT","laneRequest":"careful"}`
- ok …and Plan now waits for the Done-when line — `["(disabled) Add at least one Done-when criterion to plan","Plan quick","Plan careful",""]`
- ok planned careful: the plan waits for your approval — `"AWAITING_PLAN_APPROVAL"`
- ok …with a plan card — `["Approve the plan for fix: the export button label is wrong?"]`
- ok the Plan header carries the lane line "Careful lane" — `"Fix\nsmall\nlow risk\nMake it quick\n\nFix · small · low risk\n\nCareful lane: 4 steps, a plan you approve, then a pull request that always asks for review. You chose it.\n\nInvestigate · role model\nImplement · role mo`
- ok …and says you chose it — `"Fix\nsmall\nlow risk\nMake it quick\n\nFix · small · low risk\n\nCareful lane: 4 steps, a plan you approve, then a pull request that always asks for review. You chose it.\n\nInvestigate · role model\nImplement · role mo`
- ok GET /ship: waiting, no pull request yet — `{"missionId":"msn_01m682h78vmr0zktjdqr","taskId":"tsk_01m682hdcjxs4tjfsqq7","prs":[],"stage":"waiting","headline":"Pull request not open yet","status":"The pull request opens once the steps before it are done."}`
- screenshot: `pm7-get-ready.png`
- screenshot: `pm7-plan.png`
- screenshot: `pm7-plan-card.png`

## PM8 — A push after the decision voids it and decides again: PASS

- note: mission msn_01m6834gppseka6fk554
- ok the first decision was voided — `[{"headSha":"3a4e614cd138e181f71e3b20f7391da387a17cdc","voidedAt":"2026-10-31T04:22:59.614Z","verdict":"merge"},{"headSha":"dddddddddddddddddddddddddddddddddddddddd","voidedAt":null,"verdict":"ask"}]`
- ok …and a new one made on the new sha — `[{"headSha":"3a4e614cd138e181f71e3b20f7391da387a17cdc","voidedAt":"2026-10-31T04:22:59.614Z","verdict":"merge"},{"headSha":"dddddddddddddddddddddddddddddddddddddddd","voidedAt":null,"verdict":"ask"}]`
- ok the feed says "The pull request changed after it was checked; checking again." — `["Mission created: fix: typo in the help title","Plan chosen by the factory (2 tasks: development → ship): quick lane.","Opened the pull request https://github.com/acme/web/pull/9.","The pull request changed after it was`
- ok the refused merge was bound to the first decision's sha — `"pr merge 9 --repo acme/web --squash --match-head-commit 3a4e614cd138e181f71e3b20f7391da387a17cdc --subject fix: typo in the help title (#9) --body Tandemise-Merge: auto; score 1/2\nTandemise-Policy: planner shipped, rou`

## PM9 — Revert undoes an auto-merge through its own pull request: PASS

- ok Revert opened a revert mission that completed — `{"id":"msn_01m6834s6a0m49cef5aq","status":"COMPLETE"}`
- ok …its pull request "revert: …" merged on its own — `{"missionId":"msn_01m6834s6a0m49cef5aq","taskId":"tsk_01m6834s6b0jwy8q3gyf","prs":[{"repo":"acme/web","number":10,"url":"https://github.com/acme/web/pull/10","state":"opened","decision":{"id":"mrg_01m6834sfqwwjt97w3ct","`
- ok …titled revert: fix: typo in the about title — `["revert: fix: typo in the about title","MERGED"]`
- ok the original mission's history shows the revert — `["merge.decided","merge.merged","merge.reverted"]`

## PM10 — People stepping in tightens the next plan; Project → Factory shows the files and routing: PASS

- note: desktop-ui fix 1: mission msn_01m682jeym1es97rnnzj
- note: desktop-ui fix 2: mission msn_01m682q3mrvqsgsjbbac
- note: desktop-ui fix 3: mission msn_01m682vr9swex4d8gwd6
- note: fourth desktop-ui fix: mission msn_01m6830cy3nsd9fzmzt8
- note: routed fix: mission msn_01m6831e1456jmexxk94
- ok fix 1: a round started on its implement step — `{"round":2,"status":"READY"}`
- ok fix 2: a round started on its implement step — `{"round":2,"status":"READY"}`
- ok fix 3: a round started on its implement step — `{"round":2,"status":"READY"}`
- ok the fourth plan profiles desktop-ui from the path it names — `[{"label":"Fix","signals":["Title prefix fix: → type fix"]},{"label":"tiny","signals":["Rule item.keywords_any(\"typo\", \"copy\", \"rename\") → size xs"]},{"label":"low risk","signals":["Path apps/desktop/src/renderer/x`
- ok its Plan header says "you'll look at this one before it moves on" — `"Fix\ntiny\nlow risk\nMake it careful\n\nFix · tiny · low risk\n\nQuick lane: one step, then a pull request. The project's lane rules matched it.\n\nNo plan approval.\nNo separate review or QA: the tests carry it, and th`
- ok …because people stepped in on 3 of the last 3 desktop-ui implement steps — `"Fix\ntiny\nlow risk\nMake it careful\n\nFix · tiny · low risk\n\nQuick lane: one step, then a pull request. The project's lane rules matched it.\n\nNo plan approval.\nNo separate review or QA: the tests carry it, and th`
- ok …and the implement step asks for your look when it finishes — `{"beforeStart":false,"onCompletion":true,"reason":"People stepped in on 3 of the last 3 desktop-ui implement steps, so you'll look at this one before it moves on."}`
- ok Project → Factory: the planner file is "From this project's repository" — `"Factory\nHow tasks are planned, which models they use, and when a pull request merges\nWrite the defaults into the repository\nPlanner rules\nFrom this project's repository\n· …/project/.tandemise/factory/planner.yaml\n`
- ok …routing and merge are "Built in" — `"Factory\nHow tasks are planned, which models they use, and when a pull request merges\nWrite the defaults into the repository\nPlanner rules\nFrom this project's repository\n· …/project/.tandemise/factory/planner.yaml\n`
- ok …with a Routing section that says every step uses its role's model — `"Factory\nHow tasks are planned, which models they use, and when a pull request merges\nWrite the defaults into the repository\nPlanner rules\nFrom this project's repository\n· …/project/.tandemise/factory/planner.yaml\n`
- ok GET /factory: planner from the project, routing and merge built in — `[["planner","project","/tmp/tdm-planner/project/.tandemise/factory/planner.yaml"],["routing","shipped",null],["merge","shipped",null]]`
- ok GET /routing: no ladder written, with the empty sentence — `{"workspaceId":"ws_01m682cdcy155ydr66ze","ruleLine":"A model is chosen once its success rate is confidently at least 80%, over at least 8 similar steps; until then a step starts at its class's default.","classes":[],"emp`
- ok Write the defaults: routing and merge now come from the repository — `[["planner","project","/tmp/tdm-planner/project/.tandemise/factory/planner.yaml"],["routing","project","/tmp/tdm-planner/project/.tandemise/factory/routing.yaml"],["merge","project","/tmp/tdm-planner/project/.tandemise/f`
- ok …the project's own planner file is left as it was
- ok …and the Factory section says so for all three, with the button gone — `"Factory\nHow tasks are planned, which models they use, and when a pull request merges\nPlanner rules\nFrom this project's repository\n· …/project/.tandemise/factory/planner.yaml\nsha256:e1b5c187953c\nModel routing\nFrom`
- ok GET /routing: implement, "Quick lane · not sensitive", starting at sonnet — `{"workspaceId":"ws_01m682cdcy155ydr66ze","ruleLine":"A model is chosen once its success rate is confidently at least 80%, over at least 8 similar steps; until then a step starts at its class's default.","classes":[{"step`
- ok …the runs measured so far show as their own row (the model they ran on), never as a cost of $0 — `[{"model":"haiku","onLadder":true,"tasks":0,"firstPass":"not measured","success":"not measured","medianCost":"not measured","medianTime":"not measured","starting":false},{"model":"sonnet","onLadder":true,"tasks":0,"first`
- ok Project → Factory → Routing: a table for implement steps — `"Factory\nHow tasks are planned, which models they use, and when a pull request merges\nPlanner rules\nFrom this project's repository\n· …/project/.tandemise/factory/planner.yaml\nsha256:e1b5c187953c\nModel routing\nFrom`
- ok Plan header: "Implement · sonnet · … · if it fails, opus" — `"Fix\ntiny\nlow risk\nMake it careful\n\nFix · tiny · low risk\n\nQuick lane: one step, then a pull request. The project's lane rules matched it.\n\nNo plan approval.\nNo separate review or QA: the tests carry it, and th`
- screenshot: `pm10-plan-header.png`
- screenshot: `pm10-factory.png`
- screenshot: `pm10-routed-step.png`
## PM1R — Real runtime: Claude Code does a quick-lane fix and the factory opens its pull request: PASS

- note: mission msn_01m6835hjgvzy95y0466
- ok planned in the quick lane — `"Fix\ntiny\nlow risk\nMake it careful\n\nFix · tiny · low risk\n\nQuick lane: one step, then a pull request. The project's lane rules matched it.\n\nNo plan approval.\nNo separate review or QA: the tests carry it, and th`
- ok one pull request opened on acme/web — `[{"repo":"acme/web","number":1,"url":"https://github.com/acme/web/pull/1","state":"opened","decision":null}]`
- ok the pushed branch has Claude Code's fix on origin — `"# Acceptance project\n\nA small project the acceptance suite works in.\n"`
- ok the step ran on Claude Code — `[{"status":"SUCCEEDED","adapter":"claude-code"}]`
- ok the fake gh saw `pr create` (never real GitHub) — `["pr create --repo acme/web --head tandemise/fix-typo-in-the-readme-title-acceptence-should-b/fix-typo-in-the-readme-title-acceptence-should-b-bdkq0np4 --base main --title fix: typo in the README title (\"Acceptence\" sh`
- ok the ship card shows the pull request — `"Waiting for your review\n\nWaiting for your review: Auto-merge is off for this project.\n\nacme/web #1\nOpen in GitHub\nMerge\nAuto-merge is off for this project.\nThis repository has no CI checks, so Tandemise never me`
- screenshot: `pm1r-real-ship-card.png`
