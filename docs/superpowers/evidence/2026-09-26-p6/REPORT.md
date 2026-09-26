# P6 acceptance report

Run: 2026-09-26T08:22:17.127Z · build 7776818 · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p6-run-mui49ook
Result: **ALL PASS** (7/7 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| F1 — A rough request is refined into proposals and a question | PASS | 11/11 |
| F2 — Planning is refused until the request is ready | PASS | 7/7 |
| F3 — Decisions make it ready; the planner reads them | PASS | 11/11 |
| F4 — Refine again replaces pending proposals | PASS | 6/6 |
| F5 — Autonomous accepts criteria, never answers questions | PASS | 5/5 |
| F6 — The Inbox asks for refinement decisions until they are made | PASS | 4/4 |
| F7 — Real runtime: Claude Code refines a rough request | PASS | 5/5 |

## F1 — A rough request is refined into proposals and a question

- note: mission msn_01m3ecms2kpn14bkfr1z
- ✅ with no Done-when line New mission offers "Create and refine", not "Plan mission" — `"Create and refine\n⌘↵"`
- ✅ the mission is created as a draft, not planned — `"DRAFT"`
- ✅ the draft opens on "Get it ready", explaining what Refine does — `"Get it ready\nNeeds a Done-when criterion\n\nBefore anything is planned, say what done means. Refine asks the product agent to read your request, propose criteria you can check, and ask only what would change the plan. `
- ✅ the Plan button is disabled and asks for a criterion — `{"text":"Add at least one Done-when criterion to plan","disabled":true}`
- ✅ three proposed criteria, each with Accept and Reject — `["P1 Visiting the home page shows \"Hello, <name>\" for a signed-in visitor Proposed by the product agent. Accept it to make it part of what done means. Accept Reject Edit","P2 A visitor who is not signed in sees \"Hello`
- ✅ numbered P1, P2, P3 by the daemon — `["P1 Visiting the home page shows \"Hello, <name>\" for a signed-in visitor Proposed by the product agent. Accept it to make it part of what done means. Accept Reject Edit","P2 A visitor who is not signed in sees \"Hello`
- ✅ one question, Q1, with its reason and one-click options — `"Questions\n1 to answer\nQ1\nWhich pages should greet the visitor by name?\nWhy it matters: It decides how many pages the plan touches and what QA checks\nOnly the home page\nEvery page\nAnswer"`
- ✅ the Plan button reads "Answer 1 question and decide 3 criteria to plan", disabled — `{"text":"Answer 1 question and decide 3 criteria to plan","disabled":true}`
- ✅ the panel says 4 to decide and offers Refine again — `"Get it ready\n4 to decide\n\nRefinement ready for the hello page\n\nRefine again\nRead the refinement\nAnswer 1 question and decide 3 criteria to plan."`
- ✅ proof (API): 3 proposed, 1 open question, a Refinement artifact — `{"criteria":[["P1","proposed"],["P2","proposed"],["P3","proposed"]],"q":[["Q1","open"]],"artifactId":"art_01m3ecmv74mpezxcc4p2"}`
- ✅ proof (SQL): proposals are not on the ledger yet
- screenshot: `F1-draft-before-refine.png`
- screenshot: `F1-proposals-and-question.png`

## F2 — Planning is refused until the request is ready

- ✅ the Plan button is disabled with the readiness sentence — `{"text":"Answer 1 question and decide 3 criteria to plan","disabled":true}`
- ✅ clicking it anyway leaves the mission a draft
- ✅ API bypass: POST /v1/missions/:id/plan is 412 PRECONDITION_FAILED — `{"error":{"code":"PRECONDITION_FAILED","message":"Not ready to plan: answer 1 question and decide 3 criteria first. (Not met: ready.criteria is 0, needs >= 1; ready.open_questions is 1, needs 0; ready.proposed_pending is`
- ✅ it says what to do, then the gate's explanation — `"Not ready to plan: answer 1 question and decide 3 criteria first. (Not met: ready.criteria is 0, needs >= 1; ready.open_questions is 1, needs 0; ready.proposed_pending is 3, needs 0)"`
- ✅ API: planNow with no Done-when line is refused too — `{"error":{"code":"PRECONDITION_FAILED","message":"Not ready to plan: add at least one Done-when criterion first. (Not met: ready.criteria is 0, needs >= 1)","details":{"missionId":null,"gate":"ready.criteria >= 1 && read`
- ✅ proof (SQL): and it wrote no mission
- ✅ proof (SQL): the mission is still DRAFT with no tasks — `{"row":{"status":"DRAFT"},"tasks":0}`
- screenshot: `F2-plan-disabled.png`

## F3 — Decisions make it ready; the planner reads them

- ✅ accepted proposals become U1 and U2 under "Done when" — `["U1 Visiting the home page shows \"Hello, <name>\" for a signed-in visitor Proposed by the product agent; accepted by you Accepted","U2 A visitor who is not signed in sees \"Hello, friend\" instead of an empty name Prop`
- ✅ the rejected one moves to "Earlier proposals" as Rejected — `["P3 The greeting is readable on a 375px wide phone screen without scrolling sideways Rejected"]`
- ✅ only the question is left: "Answer 1 question to plan" — `{"text":"Answer 1 question to plan","disabled":true}`
- ✅ the question shows its answer — `"Questions\nAll answered\nQ1\nWHICH PAGES SHOULD GREET THE VISITOR BY NAME?\nAnswered: Only the home page"`
- ✅ the button now reads "Plan" and is enabled — `{"text":"Plan","disabled":false}`
- ✅ the panel says it is ready
- ✅ clicking Plan starts planning — `"msn_01m3ecq0dyqnex465ca2\nMissions\nfeature-delivery\nF3 hello page mui4bbmt\nF3 hello page mui4bbmt\nPlanning\nCancel"`
- ✅ the planner prompt holds the answer to Q1 — `"You are the Planner for Tandemise, an orchestration system that runs software\nmissions across multiple AI workers. You do not implement anything. You produce\none thing: a mission plan, as JSON.\n\n# The mission\n\nGoa`
- ✅ and both accepted criteria, as U1 and U2
- ✅ and not the rejected one — `"The greeting is readable on a 375px wide phone screen without scrolling sideways"`
- ✅ proof (API): the mission left DRAFT — `"PLANNING"`
- screenshot: `F3-criteria-decided.png`
- screenshot: `F3-ready-to-plan.png`
- screenshot: `F3-planning.png`

## F4 — Refine again replaces pending proposals

- ✅ the panel offered "Refine again" — `"Refine again"`
- ✅ the two undecided proposals read "Replaced by a newer proposal" — `["P2 A visitor who is not signed in sees \"Hello, friend\" instead of an empty name Replaced by a newer proposal","P3 The greeting is readable on a 375px wide phone screen without scrolling sideways Replaced by a newer p`
- ✅ the new pass is numbered on: P4, P5, P6 — `["P4 A visitor who is not signed in sees \"Hello, friend\" instead of an empty name Proposed by the product agent. Accept it to make it part of what done means. Accept Reject Edit","P5 The greeting is readable on a 375px`
- ✅ the accepted criterion stays U1 — `["U1 Visiting the home page shows \"Hello, <name>\" for a signed-in visitor Proposed by the product agent; accepted by you Accepted"]`
- ✅ the unanswered question was replaced by the new pass's Q2 — `"Questions\n1 to answer\nQ2\nWhich pages should greet the visitor by name?\nWhy it matters: It decides how many pages the plan touches and what QA checks\nOnly the home page\nEvery page\nAnswer"`
- ✅ proof (API): P2, P3 and Q1 are stale — `{"c":[["U1","accepted"],["P2","stale"],["P3","stale"],["P4","proposed"],["P5","proposed"],["P6","proposed"]],"q":[["Q1","stale"],["Q2","open"]]}`
- screenshot: `F4-replaced-by-newer.png`

## F5 — Autonomous accepts criteria, never answers questions

- ✅ the mission runs autonomously
- ✅ every proposal was "Accepted automatically", as U1-U3 — `["U1 Visiting the home page shows \"Hello, <name>\" for a signed-in visitor Proposed by the product agent; accepted because this mission runs autonomously Accepted automatically","U2 A visitor who is not signed in sees \`
- ✅ nothing is left to decide among criteria
- ✅ the question still blocks: "Answer 1 question to plan", disabled — `{"text":"Answer 1 question to plan","disabled":true}`
- ✅ proof (API): decided by autonomy, question open — `{"c":[["U1","autonomy"],["U2","autonomy"],["U3","autonomy"]],"q":["open"]}`
- screenshot: `F5-accepted-automatically.png`

## F6 — The Inbox asks for refinement decisions until they are made

- ✅ the Inbox shows "Refinement: 4 to decide" for the mission — `"Refinement: 4 to decide 3 criteria to decide and 1 question to answer before it can be planned·F6 hello page mui4ds8g Refinement just now"`
- ✅ clicking the row opens the mission on "Get it ready"
- ✅ once everything is decided the row is gone — `"gone"`
- ✅ proof (API): no refinement row for the mission — `[]`
- screenshot: `F6-inbox-row.png`
- screenshot: `F6-inbox-cleared.png`

## F7 — Real runtime: Claude Code refines a rough request

- note: mission msn_01m3ecvtp7d09cymdymt
- note: P1: Someone who has never seen the repo can say, after reading only the README's opening paragraph, what the project is for (a fixture for exercising Tandemise workflows) and that it is not a real product.
- note: P2: The README lists every workflow in .tandemise/workflows by name, with one sentence each on what it exercises, and the list matches the files in the folder.
- note: P3: Following the README's setup steps on a fresh clone, a newcomer runs `npm test` and `npm run build` successfully, and the README says both are placeholders that always pass.
- note: P4: The README states that the "hello page" the workflows refer to does not exist yet and is what the workflows are meant to produce, so nobody goes looking for it.
- note: Q1: Who is the newcomer the README is for? | why: If they will run these workflows, the README must also explain how to start one in Tandemise and what output to expect; if they only need orientation, that section is dropped. | options: Someone who will run the workflows in Tandemise / Someone who only needs to understand the repo
- note: headline: A newcomer learns what this repo is for and how to use it from the README alone
- note: panel: Get it ready 5 to decide A newcomer learns what this repo is for and how to use it from the README alone Refine again Read the refinement Answer 1 question and decide 4 criteria to plan.
- ✅ the real pass finished and was accepted by the contract — `{"state":"idle","failure":null}`
- ✅ it proposed between 1 and 8 criteria — `4`
- ✅ it asked at most 5 questions — `1`
- ✅ each proposal is on screen with Accept and Reject — `["P1 Someone who has never seen the repo can say, after reading only the README's opening paragraph, what the project is for (a fixture for exercising Tandemise workflows) and that it is not a real product. Proposed by t`
- ✅ the Plan button says what is left — `{"text":"Answer 1 question and decide 4 criteria to plan","disabled":true}`
- screenshot: `F7-real-refinement.png`
