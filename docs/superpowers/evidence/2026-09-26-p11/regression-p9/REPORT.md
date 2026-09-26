# P9 acceptance report

Run: 2026-09-26T15:08:13.436Z · build 774e45b · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p9-run-muiit9fw
Result: **ALL PASS** (4/4 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| J1 — An exhausted step left blocked gets one Stalled row that retries it | PASS | 12/12 |
| J2 — A rejected plan gets one Stalled row that re-plans it | PASS | 8/8 |
| J3 — A quiet agent is reported; keep waiting, then stop and retry | PASS | 11/11 |
| J4 — Paused, and paused at a limit, are not stalled | PASS | 5/5 |

## J1 — An exhausted step left blocked gets one Stalled row that retries it

- ✅ proof (API): the step failed its gate twice and raised "… exhausted its retries" — `"implement exhausted its retries"`
- ✅ the Inbox shows the card — `"Inbox\nWhat is waiting on a person.\nimplement exhausted its retries\nFor you·J1 hello muiitcgm SCRIPTED_FAIL_TIMES=2\nIntervention\njust now"`
- ✅ and no "Stalled:" row while the card asks
- ✅ proof (API): inbox.stalled is empty for it
- ✅ "Stalled: J1 hello muiitcgm SCRIPTED_FAIL_TIMES=2" appears — `"Stalled: J1 hello muiitcgm SCRIPTED_FAIL_TIMES=2\n'implement' is blocked: A human declined to retry this task.\nStalled\njust now\nRetry implement"`
- ✅ it says what is stuck: "'implement' is blocked: A human declined to retry this task." — `"Stalled: J1 hello muiitcgm SCRIPTED_FAIL_TIMES=2\n'implement' is blocked: A human declined to retry this task.\nStalled\njust now\nRetry implement"`
- ✅ with one action: "Retry implement" — `"Stalled: J1 hello muiitcgm SCRIPTED_FAIL_TIMES=2\n'implement' is blocked: A human declined to retry this task.\nStalled\njust now\nRetry implement"`
- ✅ proof (API): exactly one stalled row, and no other item for the mission — `[{"missionId":"msn_01m3f3y9n028fg995hxf","missionTitle":"J1 hello muiitcgm SCRIPTED_FAIL_TIMES=2","missionStatus":"BLOCKED","rule":"L18","reason":"'implement' is blocked: A human declined to retry this task.","action":{"`
- ✅ Home → Needs you now shows it once (no second blocked card) — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\n1\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 54572\n1 request waiting on you\nAcceptance workspace\n`
- ✅ proof (SQL): attempt 3 ran and succeeded — `[{"id":"run_01m3f3ycq6az548y17wq","status":"SUCCEEDED","attempt":1},{"id":"run_01m3f3yk5v3g5k9w1z06","status":"SUCCEEDED","attempt":2},{"id":"run_01m3f3ywnv4nbdy0sjnj","status":"SUCCEEDED","attempt":3}]`
- ✅ the Stalled row is gone — `"Inbox\nWhat is waiting on a person.\nNothing is waiting on you\n\nApprovals, questions, tasks for a person, stalled missions and quiet agents land here, one line each.\n"`
- ✅ proof (API): inbox.stalled is empty
- screenshot: `J1-card-no-stalled-row.png`
- screenshot: `J1-stalled-row.png`
- screenshot: `J1-home-needs-you.png`
- screenshot: `J1-row-gone.png`

## J2 — A rejected plan gets one Stalled row that re-plans it

- note: plan card options: Approve / Reject
- ✅ proof (API): the plan card is pending and nothing is stalled
- ✅ "Stalled: J2 hello muiiuku0" appears — `"Stalled: J2 hello muiiuku0\nThe plan was rejected. Re-plan or change the mission goal.\nStalled\njust now\nRe-plan"`
- ✅ it says "The plan was rejected. Re-plan or change the mission goal." — `"Stalled: J2 hello muiiuku0\nThe plan was rejected. Re-plan or change the mission goal.\nStalled\njust now\nRe-plan"`
- ✅ with one action: "Re-plan" — `"Stalled: J2 hello muiiuku0\nThe plan was rejected. Re-plan or change the mission goal.\nStalled\njust now\nRe-plan"`
- ✅ the window says it is planning again — `"Planning “J2 hello muiiuku0” again."`
- ✅ proof (API): a new plan card
- ✅ the Inbox shows the new plan card — `"Inbox\nWhat is waiting on a person.\nApprove the plan for J2 hello muiiuku0?\nOne step named implement and nothing downstream, so a stuck or quiet step is the whole…\nFor you·J2 hello muiiuku0\nPlan\njust now"`
- ✅ and no Stalled row for it
- screenshot: `J2-stalled-replan.png`
- screenshot: `J2-new-plan-card.png`

## J3 — A quiet agent is reported; keep waiting, then stop and retry

- ✅ the drawer reads "Last activity … ago" — `"implement\nRunning\nProduct Manager\nScripted agent\nj3-hello-muiivgtm-scripted-hang-once-implement\nnone isolation\nLast activity 3 s ago\nQuiet\nDone by\nScripted agent\n·\nResponsible\nYou\nOBJECTIVE\nRecord how the `
- ✅ and "Quiet"
- ✅ the Inbox row reads "Quiet for … s: implement" with the mission — `"Quiet for 9 s: implement\nIts agent has written nothing; it is still running, and stops on its own only at its 30 min budget·J3 hello muiivgtm SCRIPTED_HANG_ONCE\nQuiet\nKeep waiting\nStop and retry"`
- ✅ it offers "Stop and retry" and "Keep waiting" — `"Quiet for 9 s: implement\nIts agent has written nothing; it is still running, and stops on its own only at its 30 min budget·J3 hello muiivgtm SCRIPTED_HANG_ONCE\nQuiet\nKeep waiting\nStop and retry"`
- ✅ proof (API): the mission is moving, not stalled
- ✅ Keep waiting hides the row — `"Inbox\nWhat is waiting on a person.\nNothing is waiting on you\n\nApprovals, questions, tasks for a person, stalled missions and quiet agents land here, one line each.\n"`
- ✅ proof (SQL): still one run, still live (never stopped by Tandemise) — `[{"id":"run_01m3f41dcc15bkbkdqcd","status":"STARTING","attempt":1}]`
- ✅ it comes back after another quiet spell — `"Quiet for 20 s: implement\nIts agent has written nothing; it is still running, and stops on its own only at its 30 min budget·J3 hello muiivgtm SCRIPTED_HANG_ONCE\nQuiet\nKeep waiting\nStop and retry"`
- ✅ proof (SQL): run 1 cancelled, attempt 2 succeeded — `[{"id":"run_01m3f41dcc15bkbkdqcd","status":"CANCELLED","attempt":1},{"id":"run_01m3f422h6j50zzzh5pr","status":"SUCCEEDED","attempt":2}]`
- ✅ the row is gone — `"Inbox\nWhat is waiting on a person.\nNothing is waiting on you\n\nApprovals, questions, tasks for a person, stalled missions and quiet agents land here, one line each.\n"`
- ✅ the timeline said it was quiet, and that it was kept waiting — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 54572\nmsn_01m3f41a9hdf7psntywh\nMissions\np9-implement\nJ`
- screenshot: `J3-drawer-quiet.png`
- screenshot: `J3-quiet-row.png`
- screenshot: `J3-kept-waiting.png`
- screenshot: `J3-row-gone.png`
- screenshot: `J3-timeline.png`

## J4 — Paused, and paused at a limit, are not stalled

- ✅ the Inbox has nothing for "J4 paused muiiwviw" — `"Inbox\nWhat is waiting on a person.\nNothing is waiting on you\n\nApprovals, questions, tasks for a person, stalled missions and quiet agents land here, one line each.\n"`
- ✅ proof (API): no Stalled row, card or quiet row for the paused mission — `[]`
- ✅ the limit-paused mission shows its "Limit reached" card — `"Inbox\nWhat is waiting on a person.\n“J4 limit muiiwviw SCRIPTED_USAGE_MIN=5” reached its limit: 5 of 4 agent minutes\nFor you·J4 limit muiiwviw SCRIPTED_USAGE_MIN=5\nLimit reached\njust now"`
- ✅ and no "Stalled:" row
- ✅ proof (API): its card is its only item, and nothing in the project is stalled — `{"stalled":[],"cards":["“J4 limit muiiwviw SCRIPTED_USAGE_MIN=5” reached its limit: 5 of 4 agent minutes"]}`
- screenshot: `J4-paused-no-row.png`
- screenshot: `J4-limit-card-only.png`
