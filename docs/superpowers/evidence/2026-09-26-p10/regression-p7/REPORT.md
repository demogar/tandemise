# P7 acceptance report

Run: 2026-09-26T13:36:41.917Z · build 8edafd4 · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p7-run-muifjibu
Result: **ALL PASS** (5/5 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| G1 — The urgent mission is pulled first; the rest wait in order | PASS | 11/11 |
| G2 — A freed slot pulls the next queued mission | PASS | 6/6 |
| G3 — Keyboard reorder: Low moved above Normal is pulled next | PASS | 9/9 |
| G4 — A queued mission that is not ready is skipped | PASS | 7/7 |
| G5 — Limit off: nothing is pulled automatically | PASS | 9/9 |

## G1 — The urgent mission is pulled first; the rest wait in order

- ✅ "Add to backlog" leaves each one a queued draft
- ✅ the backlog lists Urgent, Normal, Low in that order — `["Urgent G1 urgent: fix the sign-in crash muifjlbk","Normal G1 normal: a hello page muifjlbk","Low G1 low: tidy the footer muifjlbk"]`
- ✅ each row: priority chip, "Ready", and its place in the queue — `[{"title":"G1 urgent: fix the sign-in crash muifjlbk","priority":"Urgent","chip":"Urgent","readiness":"Ready","queue":"Queued · 1/3","subtitle":"G1 urgent: fix the sign-in crash muifjlbk","selected":true},{"title":"G1 no`
- ✅ limit off: "Working on 0 · no limit · 3 queued" — `"Working on 0 · no limit · 3 queued\n\nLimit off: queued missions wait until you plan them yourself or set a limit.\n\nWork on at most\nOff\n1\n2\n3\n5"`
- ✅ the urgent mission leaves the backlog — `["G1 normal: a hello page muifjlbk","G1 low: tidy the footer muifjlbk"]`
- ✅ Normal reads "Queued · 1/2", Low "Queued · 2/2" — `[{"title":"G1 normal: a hello page muifjlbk","priority":"Normal","chip":"Normal","readiness":"Ready","queue":"Queued · 1/2","subtitle":"G1 normal: a hello page muifjlbk","selected":true},{"title":"G1 low: tidy the footer`
- ✅ header: "Working on 1 of 1 · 2 queued" — `"Working on 1 of 1 · 2 queued\n\nFull: the next queued mission that is ready is planned as soon as one in progress finishes.\n\nWork on at most\nOff\n1\n2\n3\n5"`
- ✅ the hint says it is full and what happens next — `"Working on 1 of 1 · 2 queued\n\nFull: the next queued mission that is ready is planned as soon as one in progress finishes.\n\nWork on at most\nOff\n1\n2\n3\n5"`
- ✅ the urgent mission is being planned (Planning, then its plan approval) — `"msn_01m3eypr7c2gwy7gqw4s\nMissions\np2-solo\nG1 urgent: fix the sign-in crash muifjlbk\nG1 urgent: fix the sign-in crash muifjlbk\nAwaiting plan approval\nStart\nRe-plan\nCancel"`
- ✅ proof (API): urgent left DRAFT; normal and low are still DRAFT — `["AWAITING_PLAN_APPROVAL","DRAFT","DRAFT"]`
- ✅ proof (SQL): one mission.pulled {position 1, limit 1, active 1} — `[{"type":"mission.pulled","position":1,"limit":1,"active":1,"skipped":0}]`
- screenshot: `G1-backlog-limit-off.png`
- screenshot: `G1-urgent-pulled.png`
- screenshot: `G1-urgent-planning.png`

## G2 — A freed slot pulls the next queued mission

- ✅ the urgent mission completes
- ✅ proof (API): Normal is pulled once the slot is free; Low still waits — `["AWAITING_PLAN_APPROVAL","DRAFT"]`
- ✅ its timeline: "Pulled from the backlog (1 of 1)" — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\n1\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 60782\nmsn_01m3eypmft1dgfd1wesy\nMissions\np2-solo\nG1 `
- ✅ and why: "It was first in the queue. This project works on at most 1 mission at a time."
- ✅ the backlog now holds only Low, "Queued · 1/1" — `[{"title":"G1 low: tidy the footer muifjlbk","priority":"Low","chip":"Low","readiness":"Ready","queue":"Queued · 1/1","subtitle":"G1 low: tidy the footer muifjlbk","selected":true}]`
- ✅ header: "Working on 1 of 1 · 1 queued" — `"Working on 1 of 1 · 1 queued\n\nFull: the next queued mission that is ready is planned as soon as one in progress finishes.\n\nWork on at most\nOff\n1\n2\n3\n5"`
- screenshot: `G2-pulled-timeline.png`
- screenshot: `G2-backlog-after.png`

## G3 — Keyboard reorder: Low moved above Normal is pulled next

- ✅ before: the new Normal is above Low — `["Normal G3 normal: a settings page muifjlbk","Low G1 low: tidy the footer muifjlbk"]`
- ✅ j selects the second row (Low) — `[["G3 normal: a settings page muifjlbk",false],["G1 low: tidy the footer muifjlbk",true]]`
- ✅ ⌥↑ moves Low above the Normal — `["G1 low: tidy the footer muifjlbk","G3 normal: a settings page muifjlbk"]`
- ✅ it now reads Normal (chip and select) — `{"title":"G1 low: tidy the footer muifjlbk","priority":"Normal","chip":"Normal","readiness":"Ready","queue":"Queued · 1/2","subtitle":"G1 low: tidy the footer muifjlbk","selected":true}`
- ✅ the window says so — `"Now Normal priority, above “G3 normal: a settings page muifjlbk”."`
- ✅ the selection follows the moved row — `[["G1 low: tidy the footer muifjlbk",true],["G3 normal: a settings page muifjlbk",false]]`
- ✅ proof (API): Low is now normal priority and ranked first
- ✅ proof (API): the moved mission is pulled; the other Normal waits — `["AWAITING_PLAN_APPROVAL","DRAFT"]`
- ✅ its timeline: "Pulled from the backlog (1 of 1)" — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\n1\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 60782\nmsn_01m3eypvyvh5fdd59x5w\nMissions\np2-solo\nG1 `
- screenshot: `G3-low-selected.png`
- screenshot: `G3-low-moved-up.png`
- screenshot: `G3-low-pulled.png`

## G4 — A queued mission that is not ready is skipped

- note: setup: cancelled 2 mission(s) left by earlier scenarios, limit off
- ✅ a queued mission with no Done-when line is not pulled, even with a free slot
- ✅ its row: Urgent, "Needs refinement", "Queued · 1/1" — `{"title":"G4 urgent but rough: make onboarding nicer muifmch4","priority":"Urgent","chip":"Urgent","readiness":"Needs refinement","queue":"Queued · 1/1","subtitle":"Add at least one Done-when criterion to plan","selected`
- ✅ and what it needs: "Add at least one Done-when criterion to plan" — `"Add at least one Done-when criterion to plan"`
- ✅ proof (API): the ready Normal is pulled; the rough Urgent stays a draft
- ✅ its timeline says it was second, and why — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\n2\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 60782\nmsn_01m3eytvmzzh7ykmhcqg\nMissions\np2-solo\nG4 `
- ✅ the rough Urgent is still "Queued · 1/1", "Needs refinement" — `[{"title":"G4 urgent but rough: make onboarding nicer muifmch4","priority":"Urgent","chip":"Urgent","readiness":"Needs refinement","queue":"Queued · 1/1","subtitle":"Add at least one Done-when criterion to plan","selecte`
- ✅ header: "Working on 1 of 1 · 1 queued" — `"Working on 1 of 1 · 1 queued\n\nFull: the next queued mission that is ready is planned as soon as one in progress finishes.\n\nWork on at most\nOff\n1\n2\n3\n5"`
- screenshot: `G4-rough-waits.png`
- screenshot: `G4-ready-pulled-timeline.png`
- screenshot: `G4-backlog-after.png`

## G5 — Limit off: nothing is pulled automatically

- note: setup: cancelled 2 mission(s) left by earlier scenarios, limit off
- ✅ proof (API): both stay drafts with nothing in progress
- ✅ header: "Working on 0 · no limit · 2 queued" — `"Working on 0 · no limit · 2 queued\n\nLimit off: queued missions wait until you plan them yourself or set a limit.\n\nWork on at most\nOff\n1\n2\n3\n5"`
- ✅ the hint: "Limit off: queued missions wait until you plan them yourself or set a limit." — `"Working on 0 · no limit · 2 queued\n\nLimit off: queued missions wait until you plan them yourself or set a limit.\n\nWork on at most\nOff\n1\n2\n3\n5"`
- ✅ "Work on at most" reads Off — `"Off"`
- ✅ both rows are "Ready" and queued in the order they were added — `[{"title":"G5 first: a hello page muifncc8","priority":"Normal","chip":"Normal","readiness":"Ready","queue":"Queued · 1/2","subtitle":"G5 first: a hello page muifncc8","selected":true},{"title":"G5 second: a help page mu`
- ✅ the Move up button puts the second above the first — `["G5 second: a help page muifncc8","G5 first: a hello page muifncc8"]`
- ✅ Remove from queue: "Not queued", and the button offers "Add to queue" — `[{"title":"G5 second: a help page muifncc8","priority":"Normal","chip":"Normal","readiness":"Ready","queue":"Queued · 1/1","subtitle":"G5 second: a help page muifncc8","selected":false},{"title":"G5 first: a hello page m`
- ✅ proof (API): its queuedAt is cleared
- ✅ proof (API): still nothing pulled
- screenshot: `G5-limit-off.png`
- screenshot: `G5-reordered-dequeued.png`
