# Replan acceptance report

Run: 2026-10-09T18:55:10.376Z · build cbb3dcc · fresh install at /tmp/tdm-rp-run-mv1bojuq
Command: `node scratch/acceptance/replan/run-all.mjs --keep-going`
Result: **ALL PASS** (4/4 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| R1 — Plan the rest again from a stop: new steps for what is left, built on what is done | PASS | 9/9 |
| R2 — Rejecting the new plan leaves the mission as it was, still waiting on the stop | PASS | 5/5 |
| R3 — A paused mission keeps what is done: the old re-plan route and the header both plan only the rest | PASS | 8/8 |
| R4 — A mission with a step still running refuses a replan and stays as it was | PASS | 2/2 |

## R1 — Plan the rest again from a stop: new steps for what is left, built on what is done

- ✅ proof (API): a plan card for the rest, with what it keeps, replaces and adds — `"Keeps 1 step already started · replaces 2 steps not started · adds 2 steps"`
- ✅ the planner was told what is done, what intake found and the note — `"# Already done: plan only the rest\n\nThis mission is under way. The steps below already ran and are kept exactly as\nthey are; you are planning only what is still needed after them.\n\nWhy the person wants a new plan for the rest:\n````\nAsk Ashby whether Panama counts, then tailor the application`
- ✅ proof (API): nothing changed yet: draft and polish are still there, held — `["draft","intake","polish"]`
- ✅ the feed asks for the new plan, with the line — `"msn_01m4h0559yxv4xzfr9vc\nMissions\nplan-fit-chain\nApply to the role, replan SCRIPTED_REPLAN SCRIPTED_STOP\nApply to the role, replan SCRIPTED_REPLAN SCRIPTED_STOP\nAwaiting plan approval\nStart\nRe-plan\nCancel\nFeed\n1\nPlan\n3\nTimeline\nArtifacts\n2\nChecks & Gates\nMetrics\nDone when\n0 of 1 `
- ✅ proof (API): the new steps ran — `"SUCCEEDED"`
- ✅ proof (API): the unstarted steps were replaced — `["ask_first","intake","tailor"]`
- ✅ proof (API): intake kept its id, runs and outputs — `{"before":{"runs":["run_01m4h058dys8mvd4ez18"],"artifacts":["art_01m4h05a0z72tzman909"]},"after":{"runs":["run_01m4h058dys8mvd4ez18"],"artifacts":["art_01m4h05a0z72tzman909"]}}`
- ✅ proof (API): the first new step was handed intake's output — `["art_01m4h05a0z72tzman909"]`
- ✅ proof (API): the mission completed
- screenshot: `R1-inbox-decided-plan-the-rest.png`
- screenshot: `R1-feed-new-plan-asks.png`
- screenshot: `R1-inbox-new-plan-approved.png`
- screenshot: `R1-mission-finished-on-new-plan.png`

## R2 — Rejecting the new plan leaves the mission as it was, still waiting on the stop

- ✅ proof (API): the mission is back to executing, saying so — `"The new plan for the rest was rejected: Not like that. The mission is as it was."`
- ✅ proof (API): the steps are as they were — `["draft","intake","polish"]`
- ✅ proof (API): draft is still held behind the stop — `{"s":"PENDING","r":"Waiting for you: 'intake' says the plan no longer fits."}`
- ✅ proof (API): the plan-fit card is open again — `"PENDING"`
- ✅ the Inbox lists the plan-fit card again — `"Inbox\nWhat is waiting on a person.\n‘intake’ says the plan no longer fits\nEvidence ready for the hello page\nFor you·Apply to the role, reject SCRIPTED_REPLAN SCRIPTED_STOP\nPlan no longer fits\njust now\nDecided\n5 decisions\nApprove the new plan for the rest of Apply to the role, reject SCRIPTE`
- screenshot: `R2-inbox-new-plan-rejected.png`
- screenshot: `R2-inbox-stop-card-open-again.png`

## R3 — A paused mission keeps what is done: the old re-plan route and the header both plan only the rest

- ✅ proof (API): POST /plan with a finished step files a replan card, not a replace-all — `["Replan","Summary","ask_first (design)","tailor (design)","MissionPlan"]`
- ✅ proof (API): intake is untouched, same id, runs and outputs
- ✅ proof (API): rejected, it goes back to paused, not executing — `"PAUSED"`
- ✅ the header of a paused mission with finished work offers Plan the rest again — `["Resume","Plan the rest again","Cancel"]`
- ✅ proof (API): the header button files a new replan card
- ✅ proof (API): approved, the new steps ran and the mission completed — `["ask_first","intake","tailor"]`
- ✅ proof (API): intake is still untouched
- ✅ proof (API): the new plan answered the stop card it left open — `{"status":"REJECTED","option":"replan_rest"}`
- screenshot: `R3-paused-header-plan-the-rest.png`

## R4 — A mission with a step still running refuses a replan and stays as it was

- ✅ proof (API): refused with the reason, naming the step — `"POST /v1/missions/msn_01m4h09q41y6pfxv8zfn/replan -> 412 {\"error\":{\"code\":\"PRECONDITION_FAILED\",\"message\":\"Wait for 'intake' to finish, or stop it, before planning the rest again.\",\"details\":{\"missionId\":\"msn_01m4h09q41y6pfxv8zfn\"},\"retryable\":false}}"`
- ✅ proof (API): the mission kept executing — `"EXECUTING"`
