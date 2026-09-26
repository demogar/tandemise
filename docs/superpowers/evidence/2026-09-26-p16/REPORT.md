# P16 acceptance report

Run: 2026-09-26T23:07:08.175Z · build 06fa4ee · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p16-run-muizzcj0
Result: **ALL PASS** (3/3 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| R1 — One new decision: one notification, and its click opens the decision | PASS | 12/12 |
| R2 — Three at once become one notification; a switched-off kind stays quiet | PASS | 12/12 |
| R3 — Quiet hours hold and summarise once; the test button reaches you | PASS | 13/13 |

## R1 — One new decision: one notification, and its click opens the decision

- note: mission msn_01m3fzec451w8qrrdg9m "Publish the changelog", plan card apr_01m3fzec55zmjr4jy36v
- note: mission msn_01m3fzem49nvqatsabpq "R1 tidy the release notes muizzgag", plan card apr_01m3fzem4xjvvhk586dh
- ✅ the window is hidden (as the main process sees it) — `{"visible":false,"focused":false}`
- ✅ one notification "Decision needed" — `{"title":"Decision needed","body":"Approve the plan for Publish the changelog? · Publish the changelog","route":"/missions/msn_01m3fzec451w8qrrdg9m","workspaceId":"ws_01m3fze67m7h0a6cqej4","ids":["apr_01m3fzec55zmjr4jy36`
- ✅ its body names the card and the mission: "Approve the plan for Publish the changelog? · Publish the changelog" — `"Approve the plan for Publish the changelog? · Publish the changelog"`
- ✅ it was shown while the window was hidden — `{"title":"Decision needed","body":"Approve the plan for Publish the changelog? · Publish the changelog","route":"/missions/msn_01m3fzec451w8qrrdg9m","workspaceId":"ws_01m3fze67m7h0a6cqej4","ids":["apr_01m3fzec55zmjr4jy36`
- ✅ it opens /missions/msn_01m3fzec451w8qrrdg9m — `"/missions/msn_01m3fzec451w8qrrdg9m"`
- ✅ nothing more on later polls (same Inbox, same ids) — `1`
- ✅ proof (settings.json): the card id is recorded as announced — `{"notified":["apr_01m3fzec55zmjr4jy36v"],"held":[]}`
- ✅ clicking it shows the window on the mission — `{"visible":true,"focused":true}`
- ✅ the mission page shows its plan card to decide — `"msn_01m3fzec451w8qrrdg9m\nMissions\np2-solo\nPublish the changelog\nPublish the changelog\nAwaiting plan approval\nStart\nRe-plan\nCancel\nFeed\n1\nPlan\n1\nTimeline\nArtifacts\n1\nChecks & Gates\nMetrics\nDone when\n0 `
- ✅ on the Inbox and focused: no notification for the new card — `0`
- ✅ proof (settings.json): it is recorded as seen — `["apr_01m3fzec55zmjr4jy36v","apr_01m3fzem4xjvvhk586dh"]`
- ✅ leaving the Inbox does not announce it late — `0`
- screenshot: `R1-opened-from-notification.png`

## R2 — Three at once become one notification; a switched-off kind stays quiet

- note: setup: cancelled 2 mission(s) left by earlier scenarios, limit off
- note: missions: msn_01m3fzfj22jxfzvyssbr "R2 fix the footer links muj00a9o"; msn_01m3fzfmgtmjfxnar53s "R2 add a sitemap muj00a9o"; msn_01m3fzfpznkxww3hzwe2 "R2 compress the images muj00a9o"
- note: draft msn_01m3fzfxkht6nsx4rwyx
- ✅ one poll, one notification for three new cards — `{"got":1,"count":1}`
- ✅ it reads "3 things need you" — `{"title":"3 things need you","body":"Approve the plan for R2 compress the images muj00a9o? · R2 compress the images muj00a9o; Approve the plan for R2 add a sitemap muj00a9o? · R2 add a sitemap muj00a9o; and 1 more","rout`
- ✅ its body names two of the three cards and "and 1 more" — `"Approve the plan for R2 compress the images muj00a9o? · R2 compress the images muj00a9o; Approve the plan for R2 add a sitemap muj00a9o? · R2 add a sitemap muj00a9o; and 1 more"`
- ✅ it opens the Inbox — `"/inbox"`
- ✅ proof (settings.json): all three card ids are recorded — `["apr_01m3fzem4xjvvhk586dh","apr_01m3fzfq04g5109sgd7x","apr_01m3fzfmherj9fac7gnr","apr_01m3fzfj2mvbh62v83kd"]`
- ✅ nothing more on the next polls
- ✅ clicking it opens the Inbox with the three missions — `"Inbox\nWhat is waiting on a person.\nApprove the plan for R2 fix the footer links muj00a9o?\nOne document task and nothing downstream, for rounds without dependents.\nFor you·R2 fix the footer links muj00a9o\nPlan\njust`
- ✅ the Refinements switch reads off
- ✅ proof (API): kinds.refinements is false, the rest on — `{"decisions":true,"refinements":false,"stalled":true,"quiet":true,"limits":true}`
- ✅ the refinement is in the Inbox and no notification was shown for it — `[]`
- ✅ proof (settings.json): it is recorded as seen — `["apr_01m3fzfmherj9fac7gnr","apr_01m3fzfj2mvbh62v83kd","refinement:msn_01m3fzfxkht6nsx4rwyx"]`
- ✅ switching Refinements back on does not announce the old one — `[]`
- screenshot: `R2-inbox-from-coalesced.png`
- screenshot: `R2-settings-refinements-off.png`

## R3 — Quiet hours hold and summarise once; the test button reaches you

- note: setup: cancelled 4 mission(s) left by earlier scenarios, limit off
- note: mission msn_01m3fzh09pem4tt2sg4x "R3 rotate the API keys muj017hk", plan card apr_01m3fzh0a8wc7kzd8tz4
- ✅ the section reads "Quiet hours now" and "17:36 to 19:06" — `"Notifications\nQuiet hours now\nDecisions and approvals\nA plan, a card or a step waits on your answer.\nRefinements\nA draft has proposals or questions to decide before it can be planned.\nStalled missions\nNothing mov`
- ✅ proof (API): quiet hours saved and in force — `{"kinds":{"decisions":true,"refinements":true,"stalled":true,"quiet":true,"limits":true},"quietHours":{"from":"17:36","to":"19:06"},"quietNow":true}`
- ✅ during quiet hours: no notification for the new card — `[]`
- ✅ proof (settings.json): the card is held, not announced — `{"notified":["apr_01m3fzec55zmjr4jy36v","apr_01m3fzem4xjvvhk586dh","apr_01m3fzfq04g5109sgd7x","apr_01m3fzfmherj9fac7gnr","apr_01m3fzfj2mvbh62v83kd","refinement:msn_01m3fzfxkht6nsx4rwyx"],"held":["apr_01m3fzh0a8wc7kzd8tz4`
- ✅ once quiet hours end: one notification "After quiet hours: 1 thing needs you" — `{"title":"After quiet hours: 1 thing needs you","body":"Decision needed: Approve the plan for R3 rotate the API keys muj017hk? · R3 rotate the API keys muj017hk","route":"/missions/msn_01m3fzh09pem4tt2sg4x","workspaceId"`
- ✅ it names the card and the mission, and opens the mission — `{"title":"After quiet hours: 1 thing needs you","body":"Decision needed: Approve the plan for R3 rotate the API keys muj017hk? · R3 rotate the API keys muj017hk","route":"/missions/msn_01m3fzh09pem4tt2sg4x","workspaceId"`
- ✅ nothing more after it
- ✅ proof (settings.json): held is empty, the card announced — `{"notified":["apr_01m3fzec55zmjr4jy36v","apr_01m3fzem4xjvvhk586dh","apr_01m3fzfq04g5109sgd7x","apr_01m3fzfmherj9fac7gnr","apr_01m3fzfj2mvbh62v83kd","refinement:msn_01m3fzfxkht6nsx4rwyx","apr_01m3fzh0a8wc7kzd8tz4"],"held"`
- ✅ its click opens the mission
- ✅ "Send a test notification" shows "Notifications are on" — `{"title":"Notifications are on","body":"This is how Tandemise will tell you something needs you.","route":"/settings","workspaceId":null,"ids":[],"shape":"test","at":"2026-09-26T23:06:46.304Z","test":true,"windowVisible"`
- ✅ the window confirms "Test notification sent."
- ✅ the test touches nothing in the daemon (no notices on the next poll)
- ✅ quiet hours switched off in the window — `{"kinds":{"decisions":true,"refinements":true,"stalled":true,"quiet":true,"limits":true},"quietHours":null,"quietNow":false}`
- screenshot: `R3-settings-quiet-hours.png`
