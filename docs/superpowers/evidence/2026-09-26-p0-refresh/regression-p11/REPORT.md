# P11 acceptance report

Run: 2026-09-26T20:31:26.826Z · build 4d38b48 · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p11-run-muiue24w
Result: **ALL PASS** (4/4 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| L1 — A daily routine adds a queued, ready mission when its time comes | PASS | 13/13 |
| L2 — A run is skipped while the previous mission from the routine is unfinished | PASS | 6/6 |
| L3 — Run now adds a mission through the same checks; a status report routine writes the report | PASS | 11/11 |
| L4 — A routine that is off never fires, and turning it on catches nothing up | PASS | 7/7 |

## L1 — A daily routine adds a queued, ready mission when its time comes

- note: daemon clock Sat Sep 26 2026 15:28:41 GMT-0500 (Eastern Standard Time); routine set to every day at 16:28
- ✅ the dialog offers the three starters — `"New routine\nStart from\nWeekly dependency updates\nNightly: fix failing checks\nWeekly status report\nName\nEach mission it adds is called this, with the day of the run.\nWhat it does\nAdds a mission\nWrites "`
- ✅ the template filled the goal and three Done-when lines — `["Update the project's dependencies to their latest compatible versions, run the tests, and fix anything the updates break.","Every direct dependency is on its latest compatible version, or the reason it is held back is `
- ✅ the row reads "Every day at 16:28 · Next: …" and "Has not run yet." — `"Weekly dependency updates Every day at 16:28 · Next: Sat 16:28 Has not run yet. Normal mission On Run now Edit"`
- ✅ proof (API): the next run is about an hour ahead on the daemon's clock — `{"now":"2026-09-26T20:28:41.222Z","next":"2026-09-26T21:28:00.000Z"}`
- ✅ proof (SQL): no mission yet
- ✅ after the clock moves on, the row reads "Last: Created “Weekly dependency updates · …”" — `"Weekly dependency updates Every day at 16:28 · Next: Sun 16:28 Last: Created “Weekly dependency updates · Sat 26 Sep” Normal mission On Run now Edit"`
- ✅ and the next run is tomorrow — `"Weekly dependency updates Every day at 16:28 · Next: Sun 16:28 Last: Created “Weekly dependency updates · Sat 26 Sep” Normal mission On Run now Edit"`
- ✅ proof (SQL): one mission, a queued DRAFT, normal priority — `[{"id":"msn_01m3fpfz0tcjen9x4nsh","title":"Weekly dependency updates · Sat 26 Sep","status":"DRAFT","queued_at":"2026-09-26T22:28:49.051Z","priority":"normal"}]`
- ✅ the Backlog lists "Weekly dependency updates · Sat 26 Sep" as Ready and "Queued · 1/1" — `[{"title":"Weekly dependency updates · Sat 26 Sep","priority":"Normal","chip":"Normal","readiness":"Ready","queue":"Queued · 1/1","subtitle":"Update the project's dependencies to their latest compatible versions, run the`
- ✅ the mission header says "From routine: Weekly dependency updates" — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 54211\nmsn_01m3fpfz0tcjen9x4nsh\nFrom routine: Weekly depe`
- ✅ its Done when lists U1–U3 with the template's lines — `"Done when\n3 criteria\nU1\nEvery direct dependency is on its latest compatible version, or the reason it is held back is written down\nFrom your request\nAccepted\nU2\nThe test suite passes after the updates\nFrom your `
- ✅ proof (API): the ledger is U1, U2, U3 from the routine — `["U1 Every direct dependency is on its latest compatible version, or the reason it is held back is written down","U2 The test suite passes after the updates","U3 The change lists each updated package with its old and new`
- ✅ proof (API): the timeline says which routine made it — `["Mission created: Update the project's dependencies to their latest compatible versions, run the tests, and fix anything the updates break.","Created by the routine “Weekly dependency updates” (Sat 16:28 run)."]`
- screenshot: `L1-template-filled.png`
- screenshot: `L1-routine-next-run.png`
- screenshot: `L1-routine-created-mission.png`
- screenshot: `L1-backlog-queued.png`
- screenshot: `L1-mission-from-routine.png`

## L2 — A run is skipped while the previous mission from the routine is unfinished

- ✅ before: L1's mission is still a queued draft
- ✅ the row reads "Skipped: previous run still active" — `"Weekly dependency updates Every day at 16:28 · Next: Mon 16:28 Skipped: previous run still active Earlier: Created “Weekly dependency updates · Sat 26 Sep” Normal mission On Run now Edit"`
- ✅ the run before it is still listed ("Earlier: Created …") — `"Weekly dependency updates Every day at 16:28 · Next: Mon 16:28 Skipped: previous run still active Earlier: Created “Weekly dependency updates · Sat 26 Sep” Normal mission On Run now Edit"`
- ✅ proof (SQL): still one mission from the routine — `[{"id":"msn_01m3fpfz0tcjen9x4nsh","title":"Weekly dependency updates · Sat 26 Sep","status":"DRAFT","queued_at":"2026-09-26T22:28:49.051Z","priority":"normal"}]`
- ✅ proof (SQL): the skip is a routine_runs row pointing at the unfinished mission — `[{"outcome":"skipped_active","trigger":"schedule","mission_id":"msn_01m3fpfz0tcjen9x4nsh"},{"outcome":"created","trigger":"schedule","mission_id":"msn_01m3fpfz0tcjen9x4nsh"}]`
- ✅ the unfinished mission's timeline says the routine skipped a run — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 54211\nmsn_01m3fpfz0tcjen9x4nsh\nFrom routine: Weekly depe`
- screenshot: `L2-skipped-previous-active.png`
- screenshot: `L2-timeline-skip-note.png`

## L3 — Run now adds a mission through the same checks; a status report routine writes the report

- ✅ L1's queued draft is deleted in the window
- ✅ after "Run now" the row reads "Last: Created “…”" — `"Weekly dependency updates Every day at 16:28 · Next: Mon 16:28 Last: Created “Weekly dependency updates · Sun 27 Sep” Earlier: Skipped: previous run still active Earlier: Created “Weekly dependency updates · Sat 26 Sep”`
- ✅ proof (SQL): a new mission, a queued DRAFT — `[{"id":"msn_01m3fpj9h7adnym3km9s","title":"Weekly dependency updates · Sun 27 Sep","status":"DRAFT","queued_at":"2026-09-27T22:30:05.351Z","priority":"normal"}]`
- ✅ proof (API): Run now did not move the schedule — `["2026-09-28T21:28:00.000Z","2026-09-28T21:28:00.000Z"]`
- ✅ proof (SQL): recorded as a manual run
- ✅ the Backlog lists it as Ready and queued — `[{"title":"Weekly dependency updates · Sun 27 Sep","priority":"Normal","chip":"Normal","readiness":"Ready","queue":"Queued · 1/1","subtitle":"Update the project's dependencies to their latest compatible versions, run the`
- ✅ the report template says no agent runs and asks for no Done-when lines — `"New routine\nStart from\nWeekly dependency updates\nNightly: fix failing checks\nWeekly status report\nName\nEach mission it adds is called this, with the day of the run.\nWhat it does\nAdds a mission\nWrites a status r`
- ✅ the report routine reads "Every Friday at 16:00 · Next: …" — `"Weekly status report Every Friday at 16:00 · Next: Fri 16:00 Has not run yet. Status report On Run now Edit"`
- ✅ after "Run now" the row reads "Last: Wrote status report v1" — `"Weekly status report Every Friday at 16:00 · Next: Fri 16:00 Last: Wrote status report v1 Status report On Run now Edit"`
- ✅ the link opens the status report in the reader — `"Status report: Acceptance\nby\nTandemise\n·\nresponsible\nYou\n\n0 need you · working on 0\n\nStatus Report\nSep 26, 2026, 3:30 PM\nDetails\nAt a glance\nNeeds you: 0\nWorking on: 0 · no limit · 1 queued\nCriteria verif`
- ✅ proof (SQL): a StatusReport artifact — `{"type":"StatusReport"}`
- screenshot: `L3-run-now-created.png`
- screenshot: `L3-report-template.png`
- screenshot: `L3-report-written.png`
- screenshot: `L3-report-in-reader.png`

## L4 — A routine that is off never fires, and turning it on catches nothing up

- ✅ the switch turns it off: the row reads "Off" and "Paused" — `"Weekly dependency updates Every day at 16:28 · Paused Last: Created “Weekly dependency updates · Sun 27 Sep” Earlier: Skipped: previous run still active Earlier: Created “Weekly dependency updates · Sat 26 Sep” Normal m`
- ✅ proof (API): no next run while off
- ✅ two days later it still reads "Paused" — `"Weekly dependency updates Every day at 16:28 · Paused Last: Created “Weekly dependency updates · Sun 27 Sep” Earlier: Skipped: previous run still active Earlier: Created “Weekly dependency updates · Sat 26 Sep” Normal m`
- ✅ proof (SQL): no mission and no run while it was off
- ✅ turned on: the row reads "On" and "Next: …" — `"Weekly dependency updates Every day at 16:28 · Next: Wed 16:28 Last: Created “Weekly dependency updates · Sun 27 Sep” Earlier: Skipped: previous run still active Earlier: Created “Weekly dependency updates · Sat 26 Sep”`
- ✅ proof (API): the next run is after now, within a day — `{"now":"2026-09-29T22:30:56.868Z","next":"2026-09-30T21:28:00.000Z"}`
- ✅ proof (SQL): turning it on caught nothing up
- screenshot: `L4-paused-two-days.png`
- screenshot: `L4-turned-on.png`
