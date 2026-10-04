# Plan fit acceptance report

Run: 2026-10-04T02:10:16.026Z · build 9704831 · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-pf-run-mut6kicj
Command: `node scratch/acceptance/plan-fit/run-all.mjs --keep-going`
Result: **ALL PASS** (4/4 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| F1 — A person's step shows what the step before it handed over | PASS | 7/7 |
| F2 — A stop holds the steps after it; skipping them finishes the mission | PASS | 9/9 |
| F3 — Sending the stopped step back runs its next round, and the plan goes on from it | PASS | 5/5 |
| F4 — Continuing as planned releases the steps after a stop | PASS | 3/3 |

## F1 — A person's step shows what the step before it handed over

- ✅ proof (API): intake wrote Evidence whose handoff needs a decision — `{"headline":"The role is US-only, so I stopped before the CV","points":["All 14 listed cities and all 4 pay tiers are in the US","No questions file was written"],"needs":"Decide: skip it, or ask whether Panama counts as Americas","changed":[],"links":[]}`
- ✅ proof (API): the person step's view carries that Evidence as what came in — `[{"id":"art_01m42amzseb4qpsb3njg","headline":"The role is US-only, so I stopped before the CV"}]`
- ✅ the drawer names the step it came from — `"answer\nThis one is yours\nFROM “INTAKE”\n\nThe role is US-only, so I stopped before the CV\n\nAll 14 listed cities and all 4 pay tiers are in the US\nNo questions file was written\nNeeds Decide: skip it, or ask whether Panama counts as Americas\nFull doc\n\nRead the questions in applications/23/qu`
- ✅ the drawer shows the intake headline and points — `"answer\nThis one is yours\nFROM “INTAKE”\n\nThe role is US-only, so I stopped before the CV\n\nAll 14 listed cities and all 4 pay tiers are in the US\nNo questions file was written\nNeeds Decide: skip it, or ask whether Panama counts as Americas\nFull doc\n\nRead the questions in applications/23/qu`
- ✅ the drawer shows what it needs from the person — `"answer\nThis one is yours\nFROM “INTAKE”\n\nThe role is US-only, so I stopped before the CV\n\nAll 14 listed cities and all 4 pay tiers are in the US\nNo questions file was written\nNeeds Decide: skip it, or ask whether Panama counts as Americas\nFull doc\n\nRead the questions in applications/23/qu`
- ✅ what came in reads before the objective planned ahead of it — `{"headline":40,"objective":248}`
- ✅ "Full doc" opens the Evidence in the drawer — `"answer\nThis one is yours\nFROM “INTAKE”\n\nThe role is US-only, so I stopped before the CV\n\nAll 14 listed cities and all 4 pay tiers are in the US\nNo questions file was written\nNeeds Decide: skip it, or ask whether Panama counts as Americas\nHide full doc\n\nRead the questions in applications/`
- screenshot: `F1-person-step-what-came-in.png`
- screenshot: `F1-person-step-full-doc.png`

## F2 — A stop holds the steps after it; skipping them finishes the mission

- ✅ proof (API): intake succeeded, its handoff says stop
- ✅ proof (API): draft waits, PENDING with "Waiting for you: 'intake' says the plan no longer fits." — `{"status":"PENDING","reason":"Waiting for you: 'intake' says the plan no longer fits."}`
- ✅ proof (API): one card, offering skip, send back and continue — `[{"id":"skip_rest","label":"Skip the steps after it","recommended":true},{"id":"request_changes","label":"Send it back with a note"},{"id":"continue_plan","label":"Continue as planned"}]`
- ✅ the intake card in the feed carries the decision and the stop — `"PRODUCT MANAGER\nintake\nDone\njust now\nby\nProduct agent\n·\nresponsible\nYou\nFull doc\n\nEvidence ready for the hello page\n\nWritten by the scripted acceptance agent\nNo model was called\nNeeds The plan no longer fits: The role is US-only, so the steps after this have nothing to work on.\nYou `
- ✅ draft's drawer says "Waiting for you: 'intake' says the plan no longer fits." — `"draft\nPending\nProduct Designer\nnone isolation\nWould go to\nDesign agent\n·\nResponsible\nYou\nChange\nWaiting for you: 'intake' says the plan no longer fits.\nOBJECTIVE\nDraft the application from what intake found.\nSTARTED\n—\nFINISHED\n—\nDetails\nRequest changes\nClose"`
- ✅ the Inbox lists it as "Plan no longer fits" — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\n2\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nSkills\nEvals\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 59692\nInbox\nWhat is waiting on a person.\nanswer\nFor you·Apply to the Ashby role SCRIPTED_NEEDS\nTask\n49s ago\n‘inta`
- ✅ proof (API): draft and polish are SKIPPED with "Skipped: 'intake' said the plan no longer fits." — `[["draft","SKIPPED","Skipped: 'intake' said the plan no longer fits."],["polish","SKIPPED","Skipped: 'intake' said the plan no longer fits."]]`
- ✅ proof (API): the mission finished on what was done — `"COMPLETE"`
- ✅ proof (API): nothing after intake ever ran
- screenshot: `F2-feed-plan-no-longer-fits.png`
- screenshot: `F2-draft-held-drawer.png`
- screenshot: `F2-inbox-decided-skip.png`
- screenshot: `F2-mission-finished-after-skip.png`

## F3 — Sending the stopped step back runs its next round, and the plan goes on from it

- ✅ proof (API): intake ran again as round 2 — `{"round":2,"status":"SUCCEEDED"}`
- ✅ round 2 was briefed with the note — `"## Role: Product Manager\nTurns an outcome into a scoped, testable specification.\n\nYou are the Product Manager for this mission.\n\nYour job is to convert the stated outcome into a specification precise enough\nthat an engineer could implement it and a tester could verify it — without\nasking you`
- ✅ proof (API): round 2's output no longer says stop — `[{"headline":"Evidence ready for the hello page","points":["Written by the scripted acceptance agent","No model was called"],"needs":null,"changed":[{"what":"Applied: Panama counts as Americas for this role: go on with the CV.","feedback":"fb_01m42aqz94gaeb6nh2wg"}],"links":[]}]`
- ✅ proof (API): draft and polish ran on it — `"SUCCEEDED"`
- ✅ proof (API): no second card was filed
- screenshot: `F3-inbox-decided-send-back.png`

## F4 — Continuing as planned releases the steps after a stop

- ✅ proof (API): draft and polish ran — `"SUCCEEDED"`
- ✅ proof (API): intake stayed round 1 — `1`
- ✅ proof (API): the card reads approved
- screenshot: `F4-inbox-decided-continue.png`
