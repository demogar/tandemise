# P0 acceptance report

Run: 2026-09-26T19:50:25.352Z · build 940d0c6 · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p0-run-muisrfsm
Result: **ALL PASS** (14/14 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| A1 — Solo, no configuration | PASS | 11/11 |
| TEAM — Build you + your agents and their staffing in the Team screen (with A14) | PASS | 16/16 |
| PLAN — Before anything runs, the Plan says who will do each task | PASS | 3/3 |
| A2 — AI drafts, you approve | PASS | 5/5 |
| A2d — Your agent's design is yours to approve | PASS | 5/5 |
| A8 — AI drafts, you check later | PASS | 7/7 |
| A9a — Safety net: a low-risk task needs no approval | PASS | 2/2 |
| A3 — You do a stage yourself | PASS | 2/2 |
| A7q — QA runs on the agent staffed first | PASS | 2/2 |
| A9b — Safety net: a task with an external side effect needs an approval | PASS | 3/3 |
| A13 — Beyond design: code, finance and release follow the same rules | PASS | 3/3 |
| A12 — Staffing change mid-mission | PASS | 6/6 |
| A11 — Remove an agent | PASS | 8/8 |
| A18 — Hand a task that has not started to another agent | PASS | 8/8 |

## A1 — Solo, no configuration

- note: mission msn_01m3fkw8mtwapsm3ac5j
- ✅ plan approval appears in Inbox → For me, marked "For you"
- ✅ solo: your step is assigned to you, not up for grabs — `{"id":"mem_01m3fkw43thsrsgadg8f","name":"Demostenes Garcia G.","kind":"person"}`
- ✅ status reason has no double period — `"Waiting for Demostenes Garcia G."`
- ✅ no Claim button for your own step
- ✅ mission completes — `"COMPLETE"`
- ✅ every task: responsible is you — `["spec:Demostenes Garcia G.","design:Demostenes Garcia G.","architecture:Demostenes Garcia G.","build:Demostenes Garcia G.","docs:Demostenes Garcia G.","finance:Demostenes Garcia G.","qa:Demostenes Garcia G.","release:De`
- ✅ agent artifacts are authored by the runtime (no agents configured) — `["ReleaseCandidate:Runtime","QAPlan:Runtime","ChangeSet:Runtime","Evidence:Demostenes Garcia G.","DesignBrief:Runtime","FinanceReport:Runtime","ArchitecturePlan:Runtime","ProductSpec:Runtime","MissionPlan:Runtime"]`
- ✅ your docs are authored by you and readable as text — `{"author":"Demostenes Garcia G.","mediaType":"text/markdown"}`
- ✅ plan approval addressed to you and decided by you (a member, not "user")
- ✅ Plan shows "Responsible You"
- ✅ Artifacts reader shows your docs text and "by You"
- screenshot: `evidence/A1-inbox-plan.png`
- screenshot: `evidence/A1-docs-open.png`
- screenshot: `evidence/A1-plan.png`
- screenshot: `evidence/A1-artifact-docs.png`

## TEAM — Build you + your agents and their staffing in the Team screen (with A14)

- ✅ the Team screen offers "Add agent" and no "Add person" — `["Add agent","Add agent"]`
- ✅ the first tab reads "You & agents"
- ✅ the Owner picker offers only you — `["You"]`
- ✅ the team is you and seven agents — `["person:Demostenes Garcia G.","agent:Product agent","agent:Design agent","agent:Architecture agent","agent:Coding agent","agent:QA agent","agent:Finance agent","agent:Release agent"]`
- ✅ every agent is yours
- ✅ every agent runs on the scripted runtime — `["Product agent:1","Design agent:1","Architecture agent:1","Coding agent:1","QA agent:1","Finance agent:1","Release agent:1"]`
- ✅ the team has no invariant issues
- ✅ the tree lists every agent as "Agent · yours"
- ✅ the staffing picker offers no people presets — `["AI only","AI drafts, responsible approves","AI drafts, responsible checks later","AI with a safety net","Custom"]`
- ✅ product and design: their agent drafts, the responsible person approves — `{"product":{"assignees":["mem_01m3fky57fr5d81r12tc"],"mode":"first_available","responsible":null,"reviews":[{"by":"responsible","mode":"blocking","when":"always"}]},"design":{"assignees":["mem_01m3fky99r99gcw0f5b4"],"mod`
- ✅ architecture: checked later; finance and release: safety net — `{"architecture":{"assignees":["mem_01m3fkydc3g8zm4rwxdr"],"mode":"first_available","responsible":null,"reviews":[{"by":"responsible","mode":"after","when":"always"}]},"finance":{"assignees":["mem_01m3fkysk8wgbwymb6kg"],"`
- ✅ the QA drawer preselects the agent that holds the role and offers only agents — `{"QA agent":"true","Product agent":"false","Design agent":"false","Architecture agent":"false","Coding agent":"false","Finance agent":"false","Release agent":"false"}`
- ✅ qa: the QA agent first, then the Coding agent — `{"assignees":["mem_01m3fkyngtdftwsh3prk","mem_01m3fkyhefp1f3jh79w1"]}`
- ✅ A14: saving QA left every other role unchanged
- ✅ the agent drawer saved its title
- ✅ A14: editing an agent in its drawer leaves all staffing unchanged
- screenshot: `evidence/TEAM-tree.png`
- screenshot: `evidence/TEAM-qa-drawer.png`
- screenshot: `evidence/TEAM-staffing.png`

## PLAN — Before anything runs, the Plan says who will do each task

- ✅ build: Coding agent, responsible you
- ✅ design: Design agent, responsible you
- ✅ qa: QA agent, responsible you
- screenshot: `evidence/PLAN-plan.png`

## A2 — AI drafts, you approve

- ✅ spec approval addressed to you only — `["mem_01m3fkw43thsrsgadg8f"]`
- ✅ listed under For me as "For you"
- ✅ evidence names the artifact by title, not by id
- ✅ decided by you
- ✅ approving released the next tasks — `["design:RUNNING","architecture:RUNNING","finance:RUNNING","docs:AWAITING_HUMAN"]`
- screenshot: `evidence/A2-inbox.png`
- screenshot: `evidence/A2-card.png`

## A2d — Your agent's design is yours to approve

- ✅ done by your Design agent; responsible you — `{"assignee":"Design agent","responsible":"Demostenes Garcia G."}`
- ✅ addressed to you only — `["mem_01m3fkw43thsrsgadg8f"]`
- ✅ listed under For me as "For you"
- ✅ no "Recording for" on your own decision
- ✅ decided by you, on your own behalf — `{"decidedBy":"mem_01m3fkw43thsrsgadg8f","recordedBy":"mem_01m3fkw43thsrsgadg8f"}`
- screenshot: `evidence/A2d-card.png`

## A8 — AI drafts, you check later

- ✅ architecture finished without waiting; a check card is open for you
- ✅ build went ahead while the check was open — `"RUNNING"`
- ✅ the Inbox opens the impact dialog: build used architecture v1 — `"Round 2 of architecture\n\nBuild (done) used Architecture v1.\n\nRedo them after the new version\nKeep their work\nThey are flagged when the new version lands.\nNot now\nStart round 2"`
- ✅ chose "Keep their work" and started round 2
- ✅ architecture starts round 2 — `{"round":2,"status":"RUNNING"}`
- ✅ build was not stopped or redone — `"SUCCEEDED"`
- ✅ once architecture round 2 lands, build is flagged for attention — `{"needsAttention":true,"status":"SUCCEEDED"}`
- screenshot: `evidence/A8-check-card.png`
- screenshot: `evidence/A8-impact-dialog.png`
- screenshot: `evidence/A8-plan-attention.png`

## A9a — Safety net: a low-risk task needs no approval

- ✅ finance succeeded with no approval card
- ✅ timeline records the skipped review with task.risk_level below 2 — `{"type":"review.skipped","taskId":"tsk_01m3fm0r2bytya4apggp","when":"task.risk_level >= 2","facts":{"task.risk_level":0}}`

## A3 — You do a stage yourself

- ✅ docs is assigned to you (the only owner) — `{"id":"mem_01m3fkw43thsrsgadg8f","name":"Demostenes Garcia G.","kind":"person"}`
- ✅ artifact by you, responsible you, readable text — `{"author":"Demostenes Garcia G.","mediaType":"text/markdown"}`

## A7q — QA runs on the agent staffed first

- ✅ qa ran on the QA agent (first in its staffing), responsible you — `{"assignee":"QA agent","responsible":"Demostenes Garcia G."}`
- ✅ QAPlan by the QA agent, you responsible — `{"author":"QA agent"}`

## A9b — Safety net: a task with an external side effect needs an approval

- ✅ release approval addressed to you
- ✅ mission banner: "1 decision waiting on you. Approve the output of release?"
- ✅ approved (after the release-class confirmation) → mission COMPLETE — `"COMPLETE"`
- screenshot: `evidence/A9b-banner.png`

## A13 — Beyond design: code, finance and release follow the same rules

- ✅ ChangeSet by your Coding agent, you responsible
- ✅ FinanceReport by your Finance agent, you responsible
- ✅ ReleaseCandidate by your Release agent, you responsible
- screenshot: `evidence/A13-plan-complete.png`

## A12 — Staffing change mid-mission

- note: spec:SUCCEEDED design:RUNNING architecture:READY build:PENDING docs:READY finance:READY qa:PENDING release:PENDING
- ✅ finance is READY, snapshotted to the Finance agent with the safety net — `[{"by":"responsible","mode":"blocking","when":"task.risk_level >= 2"}]`
- ✅ the project staffing changed: finance always approved, qa on the Architecture agent — `{"finance":[{"by":"responsible","mode":"blocking","when":"always"}],"qa":["mem_01m3fkydc3g8zm4rwxdr"]}`
- ✅ qa (still PENDING) would now go to the Architecture agent — `{"assignee":{"id":"mem_01m3fkydc3g8zm4rwxdr","name":"Architecture agent","kind":"agent"},"responsible":{"id":"mem_01m3fkw43thsrsgadg8f","name":"Demostenes Garcia G.","kind":"person"},"claimable":[],"executor":"agent"}`
- ✅ finance (already READY) still ran on the Finance agent — `{"status":"SUCCEEDED","by":"Finance agent"}`
- ✅ finance kept its safety net: no approval was asked for it
- ✅ qa resolved with the new staffing: the Architecture agent, not the QA agent — `{"status":"RUNNING","candidates":["mem_01m3fkydc3g8zm4rwxdr"]}`
- screenshot: `evidence/A12-plan-after-change.png`

## A11 — Remove an agent

- ✅ confirmation names the agent and says its past work keeps its name — `"Remove Design agent? Their past work keeps their name. Can"`
- ✅ the agent is removed and no longer active
- ✅ the Team screen hides it and offers "Show 1 removed member"
- ✅ shown again, it reads "Removed"
- ✅ its past DesignBrief still names it as the author — `{"id":"mem_01m3fky99r99gcw0f5b4","name":"Design agent","kind":"agent"}`
- ✅ the finished mission's Plan still shows "Design agent"
- ✅ design no longer routes to the removed agent, nor silently to any runtime: it waits for you — `{"assignee":null,"responsible":{"id":"mem_01m3fkw43thsrsgadg8f","name":"Demostenes Garcia G.","kind":"person"},"claimable":[{"id":"mem_01m3fkw43thsrsgadg8f","name":"Demostenes Garcia G.","kind":"person"}],"executor":"hum`
- ✅ restored in its drawer, the agent takes design again — `{"assignee":{"id":"mem_01m3fky99r99gcw0f5b4","name":"Design agent","kind":"agent"},"responsible":{"id":"mem_01m3fkw43thsrsgadg8f","name":"Demostenes Garcia G.","kind":"person"},"claimable":[],"executor":"agent"}`
- screenshot: `evidence/A11-confirm.png`
- screenshot: `evidence/A11-tree.png`
- screenshot: `evidence/A11-plan.png`

## A18 — Hand a task that has not started to another agent

- ✅ qa has not started and would go to the QA agent — `{"status":"PENDING","wouldBe":"QA agent"}`
- ✅ qa now would go to the Release agent, through an override on this task — `{"assignees":["mem_01m3fkyxnmm3he2eeg6v"],"mode":"first_available","responsible":null,"reviews":[]}`
- ✅ the drawer marks the task "override"
- ✅ the project staffing for QA is unchanged
- ✅ qa ran on the Release agent — `"Release agent"`
- ✅ its QAPlan is by the Release agent, you responsible — `{"author":"Release agent"}`
- ✅ a task that already ran refuses a staffing change (409) — `409`
- ✅ and its drawer offers no "Change"
- screenshot: `evidence/A18-change.png`
- screenshot: `evidence/A18-override.png`
