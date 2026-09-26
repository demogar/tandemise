# P10 acceptance report

Run: 2026-09-26T20:28:31.090Z · build 4d38b48 · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p10-run-muiua85z
Result: **ALL PASS** (3/3 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| K1 — The desk: five numbers, each opening the view behind it | PASS | 18/18 |
| K2 — A status report written from facts, twice, byte for byte | PASS | 18/18 |
| K3 — The month against its limit, on the desk and in the report | PASS | 9/9 |

## K1 — The desk: five numbers, each opening the view behind it

- note: A msn_01m3fpb0enw69ebkjczt "K1 greeting page muiuacwq SCRIPTED_QA_PARTIAL"; B msn_01m3fpabh46bb1qrn3r8 "K1 offline mode muiuacwq SCRIPTED_SPEC_THREE_ACS SCRIPTED_FAIL_RELEASE"
- ✅ proof (API): the work-in-progress limit is 2, set in the window
- ✅ proof (API): B's release exhausted its retries — `"release exhausted its retries"`
- ✅ proof (API): A's release exhausted its retries (a card asks) — `"release exhausted its retries"`
- ✅ card "Needs you 1" — `"Needs you 1 Decisions and steps in your inbox"`
- ✅ card "Working on 2 of 2" — `"Working on 2 of 2 0 queued"`
- ✅ card "Criteria verified 4 of 6", across 2 missions — `"Criteria verified 4 of 6 Across 2 missions in progress"`
- ✅ card "Stalled 1" — `"Stalled 1 Nothing moves them"`
- ✅ card "This month" says no monthly limit is set yet — `"This month 0.2 agent min No monthly limit set"`
- ✅ proof (API): metrics needsYou 1, active 2 of 2, criteria 4 of 6, stalled 1 — `{"needsYou":1,"active":2,"wipLimit":2,"queued":0,"criteriaVerified":4,"criteriaTotal":6,"criteriaMissions":2,"month":"2026-09","monthUsage":[],"usage":{"agentMinutes":0.16,"tokens":null,"costUsd":null,"runs":8},"stalled"`
- ✅ proof (API): B is the one stalled mission, A has the one card — `{"stalled":["K1 offline mode muiuacwq SCRIPTED_SPEC_THREE_ACS SCRIPTED_FAIL_RELEASE"],"cards":["release exhausted its retries"]}`
- ✅ the Stalled card opens the Inbox filtered to stalled missions — `"#/inbox/stalled"`
- ✅ it shows "Stalled: K1 offline mode muiuacwq SCRIPTED_SPEC_THREE_ACS SCRIPTED_FAIL_RELEASE" with "Retry release" — `"Inbox\nWhat is waiting on a person.\nShowing stalled missions only: nothing moves them until you act.\nShow everything\nStalled: K1 offline mode muiuacwq SCRIPTED_SPEC_THREE_ACS SCRIPTED_FAIL_RELEASE\n'release' is block`
- ✅ and not A's card — `"Inbox\nWhat is waiting on a person.\nShowing stalled missions only: nothing moves them until you act.\nShow everything\nStalled: K1 offline mode muiuacwq SCRIPTED_SPEC_THREE_ACS SCRIPTED_FAIL_RELEASE\n'release' is block`
- ✅ "Show everything" brings A's card back — `"Inbox\nWhat is waiting on a person.\nStalled: K1 offline mode muiuacwq SCRIPTED_SPEC_THREE_ACS SCRIPTED_FAIL_RELEASE\n'release' is blocked: A human declined to retry this task.\nStalled\njust now\nRetry release\nrelease`
- ✅ the Criteria card opens Missions filtered to the missions in progress (blocked ones included) — `"Missions\nEvery outcome the workforce is pursuing, past and present.\nNew mission\nBacklog\n0\nRoutines\n0\nActive\n0\nNeeds attention\n2\nFinished\n0\nAll\n2\nShowing the 2 missions in progress, blocked ones included: `
- ✅ A's row reads "1 of 3 verified", B's "3 of 3 verified" — `["K1 greeting page muiuacwq SCRIPTED_QA_PARTIAL msn_01m3fpb0enw69ebkjczt Waiting on release: Not met: qa.criteria_unverified is 2, needs 0 1 of 3 verified 1 acceptance-project 2/3 Blocked just now","K1 offline mode muiua`
- ✅ the Needs you card opens the Inbox
- ✅ the This month card opens Repositories (its Limits)
- screenshot: `K1-desk.png`
- screenshot: `K1-inbox-stalled-only.png`
- screenshot: `K1-missions-criteria.png`

## K2 — A status report written from facts, twice, byte for byte

- ✅ the report opens in the artifact reader
- ✅ heading "At a glance" — `"Status report: Acceptance\nby\nTandemise\n·\nresponsible\nYou\n\n1 needs you · working on 2 of 2 · 4 of 6 criteria verified · 1 stalled\n\nStalled: K1 offline mode muiuacwq SCRIPTED_SPEC_THREE_ACS SCRIPTED_FAIL_RELEASE `
- ✅ heading "Missions" — `"Status report: Acceptance\nby\nTandemise\n·\nresponsible\nYou\n\n1 needs you · working on 2 of 2 · 4 of 6 criteria verified · 1 stalled\n\nStalled: K1 offline mode muiuacwq SCRIPTED_SPEC_THREE_ACS SCRIPTED_FAIL_RELEASE `
- ✅ heading "Backlog" — `"Status report: Acceptance\nby\nTandemise\n·\nresponsible\nYou\n\n1 needs you · working on 2 of 2 · 4 of 6 criteria verified · 1 stalled\n\nStalled: K1 offline mode muiuacwq SCRIPTED_SPEC_THREE_ACS SCRIPTED_FAIL_RELEASE `
- ✅ heading "How this report was made" — `"Status report: Acceptance\nby\nTandemise\n·\nresponsible\nYou\n\n1 needs you · working on 2 of 2 · 4 of 6 criteria verified · 1 stalled\n\nStalled: K1 offline mode muiuacwq SCRIPTED_SPEC_THREE_ACS SCRIPTED_FAIL_RELEASE `
- ✅ at a glance: "Needs you: 1", "Working on: 2 of 2", "Criteria verified: 4 of 6", "Stalled: 1" — `"Status report: Acceptance\nby\nTandemise\n·\nresponsible\nYou\n\n1 needs you · working on 2 of 2 · 4 of 6 criteria verified · 1 stalled\n\nStalled: K1 offline mode muiuacwq SCRIPTED_SPEC_THREE_ACS SCRIPTED_FAIL_RELEASE `
- ✅ K1 greeting page muiuacwq SCRIPTED_QA_PARTIAL: "Criteria: 1 of 3 verified; AC2, AC3 not verified." — `"Status: Blocked. Waiting on release: Not met: qa.criteria_unverified is 2, needs 0\nCriteria: 1 of 3 verified; AC2, AC3 not verified.\nLimit: no limit set.\nWaiting on you: release exhausted its retries.\nLast gate fail`
- ✅ K1 greeting page muiuacwq SCRIPTED_QA_PARTIAL: "Last gate failure (release): Not met: qa.criteria_unverified is 2, needs 0" — `"Status: Blocked. Waiting on release: Not met: qa.criteria_unverified is 2, needs 0\nCriteria: 1 of 3 verified; AC2, AC3 not verified.\nLimit: no limit set.\nWaiting on you: release exhausted its retries.\nLast gate fail`
- ✅ K1 offline mode muiuacwq SCRIPTED_SPEC_THREE_ACS SCRIPTED_FAIL_RELEASE: stalled with its reason and "Next: Retry release."; "3 of 3 verified" — `"Status: Blocked. Waiting on release: Not met: artifact.ReleaseCandidate.exists is false Missing expected artifacts: ReleaseCandidate.\nStalled: 'release' is blocked: A human declined to retry this task. Next: Retry rele`
- ✅ it says how it was made: no model wrote it
- ✅ the Inbox card for A's release says the same words: "Not met: qa.criteria_unverified is 2, needs 0" — `"Inbox\nWhat is waiting on a person.\nStalled: K1 offline mode muiuacwq SCRIPTED_SPEC_THREE_ACS SCRIPTED_FAIL_RELEASE\n'release' is blocked: A human declined to retry this task.\nStalled\n1m ago\nRetry release\nrelease e`
- ✅ a second report is a new artifact — `["art_01m3fpcqqa2a3grqgvgs","art_01m3fpcxke8yypeghamx"]`
- ✅ the reader shows v1 and v2, on v2 — `["v1","v2*"]`
- ✅ "Compare with v1" reads "v1 → v2: 0 lines added, 0 lines removed" — `"v1 → v2: 0 lines added, 0 lines removed"`
- ✅ proof (API): v2 supersedes v1; both StatusReport, by Tandemise — `{"supersedes":"art_01m3fpcqqa2a3grqgvgs","author":{"id":"system","name":"Tandemise","kind":"system"}}`
- ✅ proof (API): the two bodies are byte-identical after the front matter — `[1319,1319]`
- ✅ proof (API): only asOf differs in the front matter
- ✅ proof (SQL): the reports belong to the project's "Status reports" holder, which no list shows — `{"title":"Status reports","workflow_preset":"status-reports","status":"COMPLETE"}`
- screenshot: `K2-report-v1.png`
- screenshot: `K2-inbox-card-same-gate-text.png`
- screenshot: `K2-compare-no-differences.png`

## K3 — The month against its limit, on the desk and in the report

- note: this month so far: 0.16 agent minutes; one run reports 25.36 more
- ✅ proof (API): 25.5 agent minutes used this month — `25.52`
- ✅ the backlog route opens Missions on its Backlog tab — `"Missions\nEvery outcome the workforce is pursuing, past and present.\nNew mission\nBacklog\n1\nRoutines\n0\nActive\n0\nNeeds attention\n2\nFinished\n1\nAll\n4\nWorking on 2 of 2 · 1 queued\n\nFull: the next queued missi`
- ✅ banner "Monthly limit at 85% — only urgent and high work will be pulled" — `["Monthly limit at 85% — only urgent and high work will be pulled. This project used 25.5 of 30 agent minutes this month; work stops at 30 agent minutes. See limit","Working on 2 of 2 — 1 queued mission waits for a free `
- ✅ the project warning is said once (no second "Monthly limit warning" banner) — `["Monthly limit at 85% — only urgent and high work will be pulled. This project used 25.5 of 30 agent minutes this month; work stops at 30 agent minutes. See limit","Working on 2 of 2 — 1 queued mission waits for a free `
- ✅ banner "Working on 2 of 2 — 1 queued mission waits for a free slot." — `["Monthly limit at 85% — only urgent and high work will be pulled. This project used 25.5 of 30 agent minutes this month; work stops at 30 agent minutes. See limit","Working on 2 of 2 — 1 queued mission waits for a free `
- ✅ card "This month 85%" with "25.5 / 30 agent min this month" — `"This month 85% 25.5 / 30 agent min this month"`
- ✅ card "Working on 2 of 2" with "1 queued" — `"Working on 2 of 2 1 queued"`
- ✅ the report: "This month (YYYY-MM): 25.5 / 30 agent min (85%)" — `"Status report: Acceptance\nby\nTandemise\n·\nresponsible\nYou\n\n1 needs you · working on 2 of 2 · 4 of 6 criteria verified · 1 stalled\n\nStalled: K1 offline mode muiuacwq SCRIPTED_SPEC_THREE_ACS SCRIPTED_FAIL_RELEASE `
- ✅ the report: the queued mission in the backlog, held by the monthly rule — `"\nK3 queued: tidy the footer muiucwo4 · Normal · Ready to plan · Held: this project is over 80% of its monthly limit (25.5 of 30 agent minutes). Only urgent and high missions are pulled.\nHow this report was made\n\nRen`
- screenshot: `K3-month-banner.png`
- screenshot: `K3-report-month.png`
