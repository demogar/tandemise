# P14 acceptance report

Run: 2026-09-27T00:46:06.722Z · build 945a63e · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p14-run-muj3hnyi
Result: **ALL PASS** (4/4 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| O1 — A labelled issue with a Done-when checklist becomes a queued, ready draft | PASS | 12/12 |
| O2 — A labelled issue without criteria waits as "Needs refinement" | PASS | 4/4 |
| O3 — The mission completes: the issue gets the criteria table and is closed | PASS | 9/9 |
| O4 — A repeat check creates nothing; an issue closed upstream takes its draft off the queue | PASS | 8/8 |

## O1 — A labelled issue with a Done-when checklist becomes a queued, ready draft

- ✅ Repositories → Issues shows the repository, off — `"Issues\nTurn labelled GitHub issues into missions\nacceptance-project\nOpen issues with the label become draft missions. An issue that lists “Done when” or “Acceptance criteria” is queued, ready to plan; any other waits`
- ✅ switched on: the status line counts linked issues — `"Not checked yet · 0 linked"`
- ✅ Check now → "Last checked just now · 1 linked" — `"Last checked just now · 1 linked"`
- ✅ proof (API): on, example/hello-site, label tandemise, every 10 minutes, P10 desk — `{"enabled":true,"githubRepo":"example/hello-site","label":"tandemise","pollMinutes":10,"closeOnComplete":false,"postComments":true,"workflowPreset":"p10-desk","lastCheckedAt":"2026-09-27T00:43:27.159Z","lastError":null}`
- ✅ Backlog: the draft with an "#11" chip — `"Normal\n#11Offline mode for the hello page\nGitHub issue #11 in example/hello-site, opened by @sam: https://github.com/example/hello-site/issues/11 The request as the issue's author wrote it: Offline mode for the hello `
- ✅ …Ready and Queued — `{"title":"Offline mode for the hello page","priority":"Normal","chip":"Normal","readiness":"Ready","queue":"Queued · 1/1","subtitle":"GitHub issue #11 in example/hello-site, opened by @sam: https://github.com/example/hel`
- ✅ mission header: "From issue #11" — `"msn_01m3g5271h9v4qsk1h5f\nFrom issue #11\nMissions\np10-desk\nOffline mode for the hello page\nGitHub issue #11 in example/hello-site, opened by @sam: https://github.com/example/hello-site/issues/11 The request as the i`
- ✅ Done when lists U1–U3 from the checklist — `"Done when\n3 criteria\nU1\nThe page loads with no network\nFrom the GitHub issue\nAccepted\nU2\nIt says hello to the visitor\nFrom the GitHub issue\nAccepted\nU3\nIt shows when it was last updated\nFrom the GitHub issue`
- ✅ each line says it came from the GitHub issue — `"Done when\n3 criteria\nU1\nThe page loads with no network\nFrom the GitHub issue\nAccepted\nU2\nIt says hello to the visitor\nFrom the GitHub issue\nAccepted\nU3\nIt shows when it was last updated\nFrom the GitHub issue`
- ✅ the goal names the issue and its author — `"msn_01m3g5271h9v4qsk1h5f\nFrom issue #11\nMissions\np10-desk\nOffline mode for the hello page\nGitHub issue #11 in example/hello-site, opened by @sam: https://github.com/example/hello-site/issues/11 The request as the i`
- ✅ proof (fake gh): one comment on #11, "Queued in Tandemise — 3 criteria." — `[{"id":9001,"body":"<!-- tandemise:queued -->\nQueued in Tandemise — 3 criteria.\n\n| Key | Done when |\n|---|---|\n| U1 | The page loads with no network |\n| U2 | It says hello to the visitor |\n| U3 | It shows when it `
- ✅ proof (fake gh): read with --label tandemise --state open — `[{"args":["issue","list","--repo","example/hello-site","--label","tandemise","--state","open","--limit","100","--json","number,title,body,url,updatedAt,labels,author"],"at":"2026-09-27T00:43:27.145Z"},{"args":["api","use`
- screenshot: `O1-issues-settings.png`
- screenshot: `O1-backlog.png`
- screenshot: `O1-mission.png`

## O2 — A labelled issue without criteria waits as "Needs refinement"

- ✅ Check now → "… · 2 linked" — `"Last checked just now · 2 linked"`
- ✅ Backlog: "#12", "Needs refinement", "Not queued" — `{"row":{"title":"Make the footer friendlier","priority":"Normal","chip":"Normal","readiness":"Needs refinement","queue":"Not queued","subtitle":"Add at least one Done-when criterion to plan","selected":false},"rowText":"`
- ✅ proof (API): a DRAFT, not queued, no criteria — `{"id":"msn_01m3g53cn1nvasgr29k1","workspaceId":"ws_01m3g521jkk7r1rw0cgs","repositoryId":"repo_01m3g521n1c7zvsn0bpq","title":"Make the footer friendlier","goal":"GitHub issue #12 in example/hello-site, opened by @kim: htt`
- ✅ proof (fake gh): nothing posted on #12
- screenshot: `O2-needs-refinement.png`

## O3 — The mission completes: the issue gets the criteria table and is closed

- ✅ proof (API): close on completion is on — `{"enabled":true,"githubRepo":"example/hello-site","label":"tandemise","pollMinutes":10,"closeOnComplete":true,"postComments":true,"workflowPreset":"p10-desk","lastCheckedAt":"2026-09-27T00:44:05.667Z","lastError":null}`
- ✅ the mission completes — `"COMPLETE"`
- ✅ one completion comment: "Done in Tandemise — N of N criteria verified." — `"<!-- tandemise:completed -->\nDone in Tandemise — 4 of 4 criteria verified.\n\n| Key | Criterion | Result |\n|---|---|---|\n| U1 | The page loads with no network | Verified |\n| U2 | It says hello to the visitor | Verif`
- ✅ the table lists U1–U3 as Verified — `"<!-- tandemise:completed -->\nDone in Tandemise — 4 of 4 criteria verified.\n\n| Key | Criterion | Result |\n|---|---|---|\n| U1 | The page loads with no network | Verified |\n| U2 | It says hello to the visitor | Verif`
- ✅ and says it is closing the issue — `"<!-- tandemise:completed -->\nDone in Tandemise — 4 of 4 criteria verified.\n\n| Key | Criterion | Result |\n|---|---|---|\n| U1 | The page loads with no network | Verified |\n| U2 | It says hello to the visitor | Verif`
- ✅ proof (fake gh): exactly one `gh issue close 11 --repo example/hello-site` — `[{"args":["issue","close","11","--repo","example/hello-site"],"at":"2026-09-27T00:44:56.145Z"}]`
- ✅ proof (fake gh): two comments on #11 in all (queued, completed) — `["<!-- tandemise:queued -->","<!-- tandemise:completed -->"]`
- ✅ timeline: "Closed GitHub issue #11: every criterion was verified." — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nSkills\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 52817\nmsn_01m3g5271h9v4qsk1h5f\nFrom issue #11\nM`
- ✅ nothing more is written on later passes
- screenshot: `O3-timeline-closed.png`

## O4 — A repeat check creates nothing; an issue closed upstream takes its draft off the queue

- ✅ a repeat check read GitHub again
- ✅ …and created no mission — `{"before":2,"after":2}`
- ✅ #13 checked in: "… · 3 linked" — `"Last checked just now · 3 linked"`
- ✅ #13 is queued — `{"title":"Add a dark theme","priority":"Normal","chip":"Normal","readiness":"Ready","queue":"Queued · 1/1","subtitle":"GitHub issue #13 in example/hello-site, opened by @sam: https://github.com/example/hello-site/issues/`
- ✅ closed upstream: its draft reads "Not queued" — `{"title":"Add a dark theme","priority":"Normal","chip":"Normal","readiness":"Ready","queue":"Not queued","subtitle":"GitHub issue #13 in example/hello-site, opened by @sam: https://github.com/example/hello-site/issues/13`
- ✅ timeline: "Issue #13 was closed upstream, so this draft was taken off the queue." — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nSkills\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 52817\nmsn_01m3g55z6qpgdyh9xrq5\nFrom issue #13\nM`
- ✅ proof (API): still a DRAFT (not deleted), queuedAt cleared — `{"id":"msn_01m3g55z6qpgdyh9xrq5","workspaceId":"ws_01m3g521jkk7r1rw0cgs","repositoryId":"repo_01m3g521n1c7zvsn0bpq","title":"Add a dark theme","goal":"GitHub issue #13 in example/hello-site, opened by @sam: https://githu`
- ✅ proof (API): the link says closed
- screenshot: `O4-dequeued.png`
- screenshot: `O4-timeline-closed-upstream.png`
