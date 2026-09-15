# P0 acceptance report

Run: 2026-09-14T01:11:22.580Z · build c573415 · fresh install at /private/tmp/claude-501/-Users-you-projects-tandemise/cc66c6e8-7692-47c2-87a0-4cd092a78e23/scratchpad/tdm-p0-run-mu0jd1sz
Result: **ALL PASS** (20/20 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| A1 — Solo, no configuration | PASS | 11/11 |
| TEAM — Build the team and staffing in the Team screen (with A14) | PASS | 10/10 |
| PLAN — Before anything runs, the Plan says who will do each task | PASS | 2/2 |
| A2 — AI drafts, you approve | PASS | 5/5 |
| A4 — Team without accounts: design by Ana's agent is Ana's to approve | PASS | 5/5 |
| A6 — Record Ana's approval on her behalf | PASS | 3/3 |
| A8 — AI drafts, you check later | PASS | 4/4 |
| A9a — Safety net: a low-risk task needs no approval | PASS | 2/2 |
| A3 — You do a stage yourself | PASS | 2/2 |
| A7 — Pool and claim | PASS | 5/5 |
| A9b — Safety net: a task with an external side effect needs an approval | PASS | 3/3 |
| A13 — Beyond design: code, finance and release follow the same rules | PASS | 3/3 |
| A5 — The lead also signs off (both_sign_off) | PASS | 5/5 |
| A10 — Nobody answers: the request climbs the tree | PASS | 6/6 |
| A12 — Staffing change mid-mission | PASS | 4/4 |
| A15 — Real runtime: Ana's agent on Claude Code | PASS | 9/9 |
| A11 — Remove a person | PASS | 5/5 |
| A16 — One-person pool: nobody responds, the owner takes it | PASS | 6/6 |
| A17 — A person's own work goes through its review and the lead's sign-off | PASS | 7/7 |
| A18 — Hand a waiting task to someone else | PASS | 4/4 |

## A1 — Solo, no configuration

- note: mission msn_01m2epvckjn1qpwp7map
- ✅ plan approval appears in Inbox → For me, marked "For you"
- ✅ solo: your step is assigned to you, not up for grabs — `{"id":"mem_01m2epv84cvfv13et60y","name":"Demostenes Garcia G.","kind":"person"}`
- ✅ status reason has no double period — `"Waiting for Demostenes Garcia G."`
- ✅ no Claim button for your own step
- ✅ mission completes — `"COMPLETE"`
- ✅ every task: responsible is you — `["spec:Demostenes Garcia G.","design:Demostenes Garcia G.","architecture:Demostenes Garcia G.","build:Demostenes Garcia G.","docs:Demostenes Garcia G.","finance:Demostenes Garcia G.","qa:Demostenes Garcia G.","release:De`
- ✅ agent artifacts are authored by the runtime (no agents configured) — `["ReleaseCandidate:Runtime","QAPlan:Runtime","ChangeSet:Runtime","Evidence:Demostenes Garcia G.","FinanceReport:Runtime","DesignBrief:Runtime","ArchitecturePlan:Runtime","ProductSpec:Runtime","MissionPlan:Runtime"]`
- ✅ your docs are authored by you and readable as text — `{"author":"Demostenes Garcia G.","mediaType":"text/markdown"}`
- ✅ plan approval addressed to you and decided by you (a member, not "user")
- ✅ Plan shows "Responsible You"
- ✅ Artifacts reader shows your docs text and "by You"
- screenshot: `evidence/A1-inbox-plan.png`
- screenshot: `evidence/A1-docs-open.png`
- screenshot: `evidence/A1-plan.png`
- screenshot: `evidence/A1-artifact-docs.png`

## TEAM — Build the team and staffing in the Team screen (with A14)

- ✅ Maria reports to you; Ana reports to Maria; Bo reports to you
- ✅ Figma agent is Ana's; Coding agent is Bo's
- ✅ every agent runs on the scripted runtime — `["Figma design agent:1","Coding agent:1","Product agent:1","Architecture agent:1","Finance agent:1","Release agent:1"]`
- ✅ the Reports-to picker offered no cycle (no invariant issues)
- ✅ "Anyone from a group" preselects the people who cover QA (Bo), not unrelated people — `{"You":"false","Ana Ruiz":"false","Bo Chen":"true","Maria Lopez":"false"}`
- ✅ product and design: AI drafts, the responsible person approves
- ✅ architecture: checked later; finance and release: safety net
- ✅ qa: pool of exactly Ana and Bo — `{"assignees":["mem_01m2epwja4nrv04q9sqh","mem_01m2epwdzw3c77x6ewbh"],"mode":"pool","responsible":null,"reviews":[]}`
- ✅ A14: saving QA left every other role unchanged
- ✅ A14: editing an agent in its drawer leaves all staffing unchanged
- screenshot: `evidence/TEAM-tree.png`
- screenshot: `evidence/TEAM-qa-drawer.png`
- screenshot: `evidence/TEAM-staffing.png`

## PLAN — Before anything runs, the Plan says who will do each task

- ✅ build: Coding agent, responsible Bo
- ✅ design: Figma design agent, responsible Ana
- screenshot: `evidence/PLAN-plan.png`

## A2 — AI drafts, you approve

- ✅ spec approval addressed to you only — `["mem_01m2epv84cvfv13et60y"]`
- ✅ listed under For me as "For you"
- ✅ evidence names the artifact by title, not by id
- ✅ decided by you
- ✅ approving released the next tasks — `["design:RUNNING","architecture:RUNNING","finance:RUNNING","docs:AWAITING_HUMAN"]`
- screenshot: `evidence/A2-inbox.png`
- screenshot: `evidence/A2-card.png`

## A4 — Team without accounts: design by Ana's agent is Ana's to approve

- ✅ done by Ana's Figma agent; responsible Ana
- ✅ addressed to Ana only; Maria (her lead) not asked — `["mem_01m2epwdzw3c77x6ewbh"]`
- ✅ not in your For me
- ✅ under Everyone as "For Ana Ruiz"
- ✅ Plan: design is "Waiting for Ana Ruiz"
- screenshot: `evidence/A4-inbox-everyone.png`
- screenshot: `evidence/A4-plan.png`

## A6 — Record Ana's approval on her behalf

- ✅ card offers "Recording for"
- ✅ stored: decided by Ana, recorded by you
- ✅ history reads "by Ana Ruiz · recorded by You"
- screenshot: `evidence/A6-recording-for.png`
- screenshot: `evidence/A6-history.png`

## A8 — AI drafts, you check later

- ✅ architecture finished without waiting; a check card is open for you
- ✅ build went ahead while the check was open — `"SUCCEEDED"`
- ✅ architecture is flagged for attention
- ✅ flagging did not stop work already under way
- screenshot: `evidence/A8-check-card.png`
- screenshot: `evidence/A8-plan-attention.png`

## A9a — Safety net: a low-risk task needs no approval

- ✅ finance succeeded with no approval card
- ✅ timeline records the skipped review with task.risk_level below 2 — `{"type":"review.skipped","taskId":"tsk_01m2epy70pd10d5aj4mz","when":"task.risk_level >= 2","facts":{"task.risk_level":0}}`

## A3 — You do a stage yourself

- ✅ docs is assigned to you (the only owner) — `{"id":"mem_01m2epv84cvfv13et60y","name":"Demostenes Garcia G.","kind":"person"}`
- ✅ artifact by you, responsible you, readable text — `{"author":"Demostenes Garcia G.","mediaType":"text/markdown"}`

## A7 — Pool and claim

- ✅ qa is unassigned and claimable by Ana and Bo; you are responsible until claimed — `["Bo Chen","Ana Ruiz"]`
- ✅ "Claim for" offers only Ana and Bo — `["Ana Ruiz","Bo Chen"]`
- ✅ Bo is the assignee and now responsible
- ✅ "Done by" offers only Bo — `["Bo Chen"]`
- ✅ QAPlan: by Bo, recorded by you, Bo responsible — `{"author":"Bo Chen","recordedBy":"Demostenes Garcia G."}`
- screenshot: `evidence/A7-claim.png`

## A9b — Safety net: a task with an external side effect needs an approval

- ✅ release approval addressed to you
- ✅ mission banner: "1 decision waiting on you. Approve the output of release?"
- ✅ approved (after the release-class confirmation) → mission COMPLETE — `"COMPLETE"`
- screenshot: `evidence/A9b-banner.png`

## A13 — Beyond design: code, finance and release follow the same rules

- ✅ ChangeSet by Bo's Coding agent, Bo responsible
- ✅ FinanceReport by your Finance agent, you responsible
- ✅ ReleaseCandidate by your Release agent, you responsible
- screenshot: `evidence/A13-plan-complete.png`

## A5 — The lead also signs off (both_sign_off)

- ✅ Maria's drawer toggle stores oversight = both_sign_off
- ✅ after Ana approves, design still waits
- ✅ a sign-off card goes to Maria only
- ✅ card shows the "Lead sign-off" badge, not the raw marker row
- ✅ design succeeds only after Maria signs off (recorded by you)
- screenshot: `evidence/A5-maria-drawer.png`
- screenshot: `evidence/A5-lead-signoff.png`

## A10 — Nobody answers: the request climbs the tree

- ✅ starts with Ana only
- ✅ about a minute later it reaches Maria (level 1) — `{"seconds":62}`
- ✅ Inbox: "For Ana Ruiz and Maria Lopez · Escalated to Maria Lopez"
- ✅ another minute later it reaches you (level 2)
- ✅ For me: names you and says "Escalated to you" — `"Inbox\nWhat is waiting on a person.\nFor me · 3\nEveryone · 3\nApprove the output of design?\nFor you, Ana Ruiz and Maria Lopez·Escalated to you·Escalation mu0jgixb\nAction\n2m ago\ndocs\nFor you·Escalation mu0jgixb\nTa`
- ✅ timeline shows the escalations
- screenshot: `evidence/A10-maria.png`
- screenshot: `evidence/A10-you.png`
- screenshot: `evidence/A10-timeline.png`

## A12 — Staffing change mid-mission

- note: spec:SUCCEEDED design:RUNNING architecture:READY build:PENDING docs:READY finance:READY qa:PENDING release:PENDING
- ✅ finance is READY, snapshotted to the Finance agent
- ✅ qa (still PENDING) would now go to a runtime instead of the Ana/Bo pool — `{"assignee":null,"responsible":{"id":"mem_01m2epv84cvfv13et60y","name":"Demostenes Garcia G.","kind":"person"},"claimable":[],"executor":"agent"}`
- ✅ finance (already READY) still ran on the Finance agent — `{"status":"SUCCEEDED","by":"Finance agent"}`
- ✅ qa resolved with the new staffing: an agent run, not a human pool — `{"status":"RUNNING","executor":"agent"}`
- screenshot: `evidence/A12-plan-after-change.png`

## A15 — Real runtime: Ana's agent on Claude Code

- ✅ Ana's agent runs on Claude Code only (set in its drawer)
- ✅ Claude's question "Where should I produce the design for the hello page?" is addressed to Ana only — `["mem_01m2epwdzw3c77x6ewbh"]`
- ✅ answer recorded as Ana, by you — `{"option":"brief"}`
- ✅ design finished its Claude run and waits for review — `{"status":"AWAITING_APPROVAL","reason":"Approve the output of design?"}`
- ✅ the run used Claude Code — `"Claude Code"`
- ✅ done by Ana's agent; Ana responsible
- ✅ DesignBrief by Ana's agent, Ana responsible — `{"title":"Hello page, a single static greeting screen at /","bytes":7469}`
- ✅ review addressed to Ana only
- ✅ every event of the run carries Ana's agent as actor — `{"events":28,"actors":["mem_01m2epwpcfbd8gk24yha"]}`
- screenshot: `evidence/A15-agent-drawer.png`
- screenshot: `evidence/A15-question.png`
- screenshot: `evidence/A15-plan.png`

## A11 — Remove a person

- ✅ confirmation explains the consequence in plain words — `"Remove Ana Ruiz?\n\nTheir past work keeps their name. Their agent stops taking work until someone else owns it.\n\nCancel\nRemove\nRemove\nCancel\nS"`
- ✅ Ana's seat is removed; her agent is kept but inactive
- ✅ Team screen marks the agent "Inactive: owner removed"
- ✅ past decisions still carry Ana's name
- ✅ design no longer routes to Ana's agent, nor silently to any runtime: it waits for a real person — `{"assignee":null,"responsible":{"id":"mem_01m2epv84cvfv13et60y","name":"Demostenes Garcia G.","kind":"person"},"claimable":[{"id":"mem_01m2epv84cvfv13et60y","name":"Demostenes Garcia G.","kind":"person"}],"executor":"hum`
- screenshot: `evidence/A11-confirm.png`
- screenshot: `evidence/A11-tree.png`
- screenshot: `evidence/A11-plan.png`

## A16 — One-person pool: nobody responds, the owner takes it

- note: task view offers {"label":"Claim for","options":["Demostenes Garcia G. (you)","Bo Chen"]}
- ✅ QA staffed as a pool of Bo only — `{"assignees":["mem_01m2epwja4nrv04q9sqh"],"mode":"pool","responsible":null,"reviews":[],"escalateAfterMs":60000}`
- ✅ qa goes straight to Bo (a pool of one is his) — `"Bo Chen"`
- ✅ not in your For me yet
- ✅ after about a minute you (owner) can take it; Bo stays assigned
- ✅ now in your For me
- ✅ you finished it: QAPlan by you — `{"author":"Demostenes Garcia G.","assignee":"Demostenes Garcia G."}`
- screenshot: `evidence/A16-inbox.png`
- screenshot: `evidence/A16-taken.png`

## A17 — A person's own work goes through its review and the lead's sign-off

- ✅ your drawer stores oversight = both_sign_off
- ✅ product staffed to Bo with a blocking review by the responsible person — `{"assignees":["mem_01m2epwja4nrv04q9sqh"],"mode":"first_available","responsible":null,"reviews":[{"by":"responsible","mode":"blocking","when":"always"}]}`
- ✅ spec is Bo’s to do
- ✅ Bo is not asked to approve his own spec; the card goes to you as his lead — `["mem_01m2epv84cvfv13et60y"]`
- ✅ timeline records that Bo's self-review was skipped
- ✅ the card is marked "Lead sign-off"
- ✅ spec succeeds only after your sign-off
- screenshot: `evidence/A17-staffing-drawer.png`
- screenshot: `evidence/A17-sign-off.png`

## A18 — Hand a waiting task to someone else

- ✅ docs is waiting for Bo — `"Bo Chen"`
- ✅ docs now waits for Maria, who is responsible — `{"reason":"Waiting for Maria Lopez."}`
- ✅ Inbox shows docs "For Maria Lopez"
- ✅ a task that already ran refuses a staffing change (409) — `409`
- screenshot: `evidence/A18-change.png`
- screenshot: `evidence/A18-inbox.png`
