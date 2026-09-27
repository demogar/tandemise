# P3a acceptance report

Run: 2026-09-27T21:20:33.138Z · build 1fbde2a · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p3-run-mukbg0xq
Command: `node scratch/acceptance/p3/run-all.mjs --keep-going`
Result: **FAILED at d1-upload-covers-spec.mjs** (6/8 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| D1 — An uploaded spec covers the spec stage of a real plan | FAIL | 11/12 |
| D2 — Continue elsewhere on a design step: waiting for your work in Figma | PASS | 12/12 |
| D3 — Hand back a GitHub pull request: a human round on that commit, read downstream | PASS | 13/13 |
| D4 — An unreadable link is refused until an export is attached | PASS | 11/11 |
| D5 — A ready next step waits for the hand-back, then runs on the handed-back version | FAIL | 12/13 |
| D6 — A workspace link renders "Open workspace ↗" and resolves to the local path | PASS | 9/9 |
| D7 — A hand-back is by you; the reader shows who recorded it | PASS | 7/7 |
| D8 — A file attached to feedback is an input of the next round | PASS | 9/9 |

## D1 — An uploaded spec covers the spec stage of a real plan

- note: plan cards: ["product (covered by your upload) · covered by your upload","Define flows, states and interaction behaviour","Choose the approach and order the work","Implement the plan","Review the diff independently","Verify the running application","Assemble the release candidate"]
- ✅ the New Mission form shows the upload as a chip — `["hello-spec.md\n137 B"]`
- ✅ the mission carries the upload, pinned as Evidence — `[{"evidenceId":"art_01m3jbf7h0ymh4y9a1sc","filename":"hello-spec.md","mediaType":"text/markdown","refs":[{"kind":"file","value":"sha256:3c434eb0d0aefb5b7a709acb5ac1d085be538b22b2f97360829efc54bcce1fbe","label":"hello-spec.md"}],"intakeArtifactId":"art_01m3jbf92z4gckw7bhj3"}]`
- ✅ intake made a ProductSpec from it (mission-wide, not a task's) — `{"id":"art_01m3jbf92z4gckw7bhj3","type":"ProductSpec","taskId":null,"refs":[{"kind":"file","value":"sha256:3c434eb0d0aefb5b7a709acb5ac1d085be538b22b2f97360829efc54bcce1fbe","label":"hello-spec.md"}]}`
- ✅ intake ran before planning (mission.intake_completed precedes the plan) — `{"intakeAt":9,"planAt":14,"planned":{"type":"note","text":"Planner produced 6 tasks: design → architecture → development → review → qa → release on attempt 1.","level":"info"}}`
- ✅ the plan is the planner's, not the preset fallback — `{"planned":{"type":"note","text":"Planner produced 6 tasks: design → architecture → development → review → qa → release on attempt 1.","level":"info"}}`
- ✅ one SKIPPED placeholder, covered by hello-spec.md, reason "Covered by your upload: hello-spec.md" — `[{"key":"product","title":"product (covered by your upload)","status":"SKIPPED","statusReason":"Covered by your upload: hello-spec.md","coveredBy":{"artifactId":"art_01m3jbf92z4gckw7bhj3","filename":"hello-spec.md"},"outputs":["ProductSpec"]}]`
- ✅ no product task: nothing else is on the product role or writes a ProductSpec — `["product:product:SKIPPED","design:design:PENDING","architecture:architecture:PENDING","implement:development:PENDING","review:review:PENDING","qa:qa:PENDING","release_candidate:release:PENDING"]`
- ✅ the stages that read the spec wait on the placeholder — `["product"]`
- ✅ the Plan tab shows a muted "… · covered by your upload" row naming hello-spec.md — `"product (covered by your upload) · covered by your upload\nhello-spec.md"`
- ❌ the covered row reads "Spec · covered by your upload" (spec A2, A8 D1) — `"product (covered by your upload) · covered by your upload"`
- ✅ the covered row has no status dot
- ✅ the Plan tab lists no other spec or product card — `["product (covered by your upload) · covered by your upload","Define flows, states and interaction behaviour","Choose the approach and order the work","Implement the plan","Review the diff independently","Verify the running application","Assemble the release candidate"]`
- screenshot: `D1-new-mission-with-upload.png`
- screenshot: `D1-plan-covered-row.png`

## D2 — Continue elsewhere on a design step: waiting for your work in Figma

- ✅ the dialog says the agent stops and dependent work waits — `"Continue design elsewhere\n\nThe agent stops, and work that needs this step waits until you hand it back.\n\nWhere you will work on it\nCancel\nContinue elsewhere"`
- ✅ the tool is prefilled with Figma for a design step — `"Figma"`
- ✅ proof (API): the step is AWAITING_EXTERNAL, parked in Figma, "Continued in Figma" — `{"status":"AWAITING_EXTERNAL","parkedExternal":{"tool":"Figma","since":"2026-09-27T21:14:35.986Z"},"statusReason":"Continued in Figma"}`
- ✅ the design card says "Waiting for your work in Figma" — `"PRODUCT DESIGNER\ndesign\nWaiting\njust now\nby\nDesign agent\n·\nresponsible\nYou\nRequest changes\n\nContinued in Figma\n\nWaiting for your work in Figma\nHand back"`
- ✅ the card offers Hand back, and no longer Continue elsewhere — `"PRODUCT DESIGNER\ndesign\nWaiting\njust now\nby\nDesign agent\n·\nresponsible\nYou\nRequest changes\n\nContinued in Figma\n\nWaiting for your work in Figma\nHand back"`
- ✅ the running pass was stopped, and the step is still parked afterwards (not CANCELLED) — `{"runs":["CANCELLED"],"status":"AWAITING_EXTERNAL"}`
- ✅ the timeline shows "Continued in Figma" — `"Designer started\nScripted agent on local:/private/var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p3-run-mukbg0xq/project\n04:14:32 PM\n·\nDesign agent\nProduct Designer task is now Awaiting external\nContinued in Figma\n04:14:35 PM\n·\nYou\nContinued in Figma\n04:1"`
- ✅ the raw log shows task.parked_external {"tool":"Figma"} — `"task.parked_external {\"tool\":\"Figma\"}"`
- ✅ proof (API): the Desk's "needs you" count went up by one — `{"before":0,"after":1}`
- ✅ the Desk's "Needs you" card on Home counts one more — `{"before":"Needs you\n0\nNothing waits on you","after":"Needs you\n1\nDecisions and steps in your inbox"}`
- ✅ the Inbox lists it as "Waiting for your work in Figma", with Hand back — `"Waiting for your work in Figma\ndesign·Hello page, taken to Figma SCRIPTED_SLOW_20S\nHand back\njust now"`
- ✅ build has not started: it waits for the design — `{"status":"PENDING","statusReason":null}`
- screenshot: `D2-continue-dialog.png`
- screenshot: `D2-parked-card.png`
- screenshot: `D2-timeline.png`
- screenshot: `D2-timeline-raw.png`
- screenshot: `D2-desk.png`
- screenshot: `D2-inbox.png`

## D3 — Hand back a GitHub pull request: a human round on that commit, read downstream

- note: the fake gh knows https://github.com/acme/app/pull/7: head hello-from-pr @ ba0c398b518e, a real commit in the acceptance repository
- ✅ the build is parked in GitHub — `{"tool":"GitHub","since":"2026-09-27T21:15:43.255Z"}`
- ✅ the dialog holds the one link and asks nothing about downstream work — `"Hand back build\nWhat did you do in GitHub?\nThe work\nhttps://github.com/acme/app/pull/7\nCancel\nHand back"`
- ✅ proof (API): build is round 2 and SUCCEEDED, "Handed back from GitHub." — `{"status":"SUCCEEDED","round":2,"statusReason":"Handed back from GitHub."}`
- ✅ the Evidence carries the PR's refs: url, github.pr acme/app#7, git.commit <head>, git.branch — `["url=https://github.com/acme/app/pull/7","github.pr=acme/app#7","git.commit=ba0c398b518ed8e06243238c1dc17d0169d642c8","git.branch=hello-from-pr"]`
- ✅ the Evidence is the snapshot: the PR's title, body and diff — `"# Greet the visitor by name\n\nAdds the hello page.\n\n## Diff\n\n```diff\ndiff --git a/hello.html b/hello.html\nnew file mode 100644\nindex 0000000..0be4dec\n--- /dev/null\n+++ b/hello.html\n@@ -0,0 +1 @@\n+<h1>Hello from the pull request</h1>\n```"`
- ✅ a human-authored round-2 ChangeSet: authored and recorded by you, carrying the commit — `{"authorId":"mem_01m3jbf1vx1xmwcn50ec","recordedBy":"mem_01m3jbf1vx1xmwcn50ec","me":"mem_01m3jbf1vx1xmwcn50ec","round":2,"refs":["url=https://github.com/acme/app/pull/7","github.pr=acme/app#7","git.commit=ba0c398b518ed8e06243238c1dc17d0169d642c8","git.branch=hello-from-pr"]}`
- ✅ the daemon read it through gh: pr view and pr diff for that URL — `["pr view https://github.com/acme/app/pull/7","pr diff https://github.com/acme/app/pull/7"]`
- ✅ the build card shows Round 2, by You, with "Pull request #7 ↗" — `"DEVELOPER\nbuild\nDone\nRound 2\njust now\nby\nYou\nPull request #7 ↗\n+1 more doc\nFull doc\nRequest changes\n\nFinished the page in the pull request; it greets the visitor by name."`
- ✅ the review ran and finished — `{"status":"SUCCEEDED","statusReason":null}`
- ✅ the review's run read the handed-back ChangeSet — `{"inputs":["art_01m3jbjpdpn9t70tgkj4"],"changeSet":"art_01m3jbjpdpn9t70tgkj4"}`
- ✅ the review's worktree was cut from the pull request's branch — `{"kind":"worktree","branch":"tandemise/hello-page-finished-in-a-pull-request-scripted-s/hello-page-finished-in-a-pull-request-scripted-s-2s8n7j6m","baseBranch":"hello-from-pr","dir":"/tmp/tdm-p3/home/workspaces/ws_01m3jbf1vwhtdp6gxgbf/missions/msn_01m3jbhqaajj1n0jw45s/worktrees/hello-page-finished-i`
- ✅ the review's branch contains the handed-back commit — `{"sha":"ba0c398b518ed8e06243238c1dc17d0169d642c8","reviewBranch":"tandemise/hello-page-finished-in-a-pull-request-scripted-s/hello-page-finished-in-a-pull-request-scripted-s-2s8n7j6m"}`
- ✅ the review's prompt carries the pull request and its diff — `")\n<<<UNTRUSTED_DATA id=1 label=\"ChangeSet: build\" origin=\"artifact art_01m3jbjpdpn9t70tgkj4\">>>\nFinished the page in the pull request; it greets the visitor by name.\n\n## Handed back from GitHub\n\nFrom pull request acme/app#7 (Evidence art_01m3jbjpdk5fm4as4ek2).\n\n# Greet the visitor by na`
- screenshot: `D3-hand-back-pr-link.png`
- screenshot: `D3-build-round-2-card.png`
- screenshot: `D3-review-after-hand-back.png`

## D4 — An unreadable link is refused until an export is attached

- ✅ a bare link is refused in the dialog: "Nothing here can read that link. Attach an export of it." — `"Hand back design\nWhat did you do in Figma?\nThe work\nhttps://www.figma.com/file/abc123/hello-page\n\n Nothing here can read that link. Attach an export of it.\n\nCancel\nHand back"`
- ✅ proof (API): nothing was written; the design is still parked in Figma — `{"parked":{"tool":"Figma","since":"2026-09-27T21:14:35.986Z"},"round":1,"artifactsBefore":1,"artifactsAfter":1}`
- ✅ the dialog shows the link with its export — `"https://www.figma.com/file/abc123/hello-page\n+ hello-page-export.md"`
- ✅ the refusal cleared once the work changed
- ✅ proof (API): the design is round 2, SUCCEEDED, "Handed back from Figma." — `{"status":"SUCCEEDED","round":2,"statusReason":"Handed back from Figma."}`
- ✅ exactly one Evidence was pinned: the refused attempt left none behind — `[{"id":"art_01m3jbmhf66wssr7fswh","title":"hello-page-export.md","refs":["url=https://www.figma.com/file/abc123/hello-page","file=sha256:be6eb7073564b5e96b447cc5ec51aa12c92a706f5a49eb46bb84faa2b872762e"]}]`
- ✅ the Evidence is the export: its file ref names hello-page-export.md, beside the link's url — `["url=https://www.figma.com/file/abc123/hello-page","file=sha256:be6eb7073564b5e96b447cc5ec51aa12c92a706f5a49eb46bb84faa2b872762e"]`
- ✅ the Evidence's content is the export's bytes — `"# Hello page (Figma export)\n\nThe greeting sits higher on the page and is larger.\n"`
- ✅ the round-2 DesignBrief carries the note and the export's text — `"Moved the greeting up and made it larger, in Figma.\n\n## Handed back from Figma\n\nFrom hello-page-export.md (Evidence art_01m3jbmhf66wssr7fswh).\n\n# Hello page (Figma export)\n\nThe greeting sits higher on the page and is larger.\n"`
- ✅ the design card shows Round 2 with a link back to the Figma file ("Open the link ↗") — `"PRODUCT DESIGNER\ndesign\nDone\nRound 2\njust now\nby\nYou\nOpen the link ↗\n+1 more doc\nFull doc\nRequest changes\n\nMoved the greeting up and made it larger, in Figma."`
- ✅ that link is the Figma URL — `"https://www.figma.com/file/abc123/hello-page"`
- screenshot: `D4-bare-link-refused.png`
- screenshot: `D4-link-with-export.png`
- screenshot: `D4-design-round-2-card.png`

## D5 — A ready next step waits for the hand-back, then runs on the handed-back version

- note: WORKAROUND: the window offered no "Continue elsewhere", so the design was parked through POST /v1/tasks/:id/park { tool: "Figma" } for the rest of the scenario
- ✅ the design finished (round 1) and the build is ready, asking to start — `{"design":"SUCCEEDED","build":"AWAITING_APPROVAL","card":"Start build?"}`
- ❌ the finished design's card offers "Continue elsewhere" while the build only asks to start — `{"card":"PRODUCT DESIGNER\ndesign\nDone\njust now\nby\nDesign agent\n·\nresponsible\nYou\nOpen workspace ↗\nFull doc\nRequest changes\n\nDesignBrief ready for the hello page\n\nWritten by the scripted acceptance agent\nNo model was called","build":{"status":"AWAITING_APPROVAL","runCount":0,"statusRe`
- ✅ the finished design is parked in Figma — `{"status":"AWAITING_EXTERNAL","parkedExternal":{"tool":"Figma","since":"2026-09-27T21:17:45.714Z"}}`
- ✅ proof (API): the build went back to PENDING with "Waiting for 'design' from Figma." — `{"status":"PENDING","statusReason":"Waiting for 'design' from Figma."}`
- ✅ proof (API): its start card was withdrawn — `["Start build?: CANCELLED"]`
- ✅ the window shows the build "Waiting for 'design' from Figma." — `"drawer"`
- ✅ the hand-back holds the file
- ✅ proof (API): design round 2 is SUCCEEDED, and its DesignBrief supersedes round 1 — `{"status":"SUCCEEDED","round2":"art_01m3jbpkeemvn8r264ce","supersedes":"art_01m3jbnr27jyjf8cj78d","round1":"art_01m3jbnr27jyjf8cj78d"}`
- ✅ the build is released and asks to start again — `"Start build?"`
- ✅ the build ran and finished — `{"status":"SUCCEEDED","statusReason":null}`
- ✅ the build ran once, and it read the handed-back DesignBrief (round 2), never round 1 — `{"runs":1,"inputs":["art_01m3jbpkeemvn8r264ce"],"round1":"art_01m3jbnr27jyjf8cj78d","round2":"art_01m3jbpkeemvn8r264ce"}`
- ✅ the build's prompt carries the handed-back work — `"d)\n<<<UNTRUSTED_DATA id=1 label=\"DesignBrief: design\" origin=\"artifact art_01m3jbpkeemvn8r264ce\">>>\nReworked the greeting in Figma: larger, higher, warmer colours.\n\n## Handed back from Figma\n\nFrom hello-design-v2.md (Evidence art_01m3jbpke99a55qd5ax5).\n\n# Hello page, v2\n\nThe greeting `
- ✅ the build card is finished in the window — `"DEVELOPER\nbuild\nDone\njust now\nby\nCoding agent\n·\nresponsible\nYou\nOpen workspace ↗\nFull doc\nContinue elsewhere\nRequest changes\n\nChangeSet ready for the hello page\n\nWritten by the scripted acceptance agent\nNo model was called"`
- screenshot: `D5-finished-design-card.png`
- screenshot: `D5-build-held-drawer.png`
- screenshot: `D5-hand-back-file.png`
- screenshot: `D5-released-after-hand-back.png`
- screenshot: `D5-build-ran-on-hand-back.png`

## D6 — A workspace link renders "Open workspace ↗" and resolves to the local path

- ✅ proof (API): the hand-back's handoff has a workspace link with a path and no url — `{"label":"Open the file","kind":"workspace","path":"blobs/61/612599c5989da30ed0e41be75db62b45cdf174c23374f4775d8e06e370ac7730"}`
- ✅ the design card shows "Open workspace ↗" (its title is the link's path) — `{"shown":"blobs/61/612599c5989da30ed0e41be75db62b45cdf174c23374f4775d8e06e370ac7730","path":"blobs/61/612599c5989da30ed0e41be75db62b45cdf174c23374f4775d8e06e370ac7730"}`
- ✅ clicking it asks the daemon, which resolves it to the Evidence file on disk — `{"resolved":{"request":{"workspaceId":"ws_01m3jbf1vwhtdp6gxgbf","path":"blobs/61/612599c5989da30ed0e41be75db62b45cdf174c23374f4775d8e06e370ac7730"},"status":200,"body":{"path":"/private/var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p3-run-mukbg0xq/home/workspaces/ws_01m3jbf1vwhtdp6gxgbf/artifa`
- ✅ that file is the handed-back export
- ✅ no error flash after the click — `""`
- ✅ the build card shows "Open workspace ↗" for the agent's README.md link — `"README.md"`
- ✅ it resolves to README.md in the project's repository — `{"resolved":{"request":{"workspaceId":"ws_01m3jbf1vwhtdp6gxgbf","path":"README.md"},"status":200,"body":{"path":"/private/var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p3-run-mukbg0xq/project/README.md"}},"readme":"/private/var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p3-run-mukbg0xq/pr`
- ✅ the reader of the handed-back DesignBrief offers "Open workspace" — `"design\ndesign\nby\nYou\nRequest changes\n\nReworked the greeting in Figma: larger, higher, warmer colours.\n\nOpen workspace ↗\nv1\nv2\nCompare with v1\nDesign Brief\nSep 27, 2026, 4:17 PM\nhello-design-v2.md\nDetails\n\nReworked the greeting in Figma: larger, higher, warmer colours.\n\nHanded bac`
- ✅ proof (API): a path out of the project is refused — `{"status":400,"body":{"error":{"code":"VALIDATION","message":"'../../etc/passwd' is not inside this project's repositories or artifacts.","details":{"code":"outside_workspace"},"retryable":false}}}`
- screenshot: `D6-design-card-open-workspace.png`
- screenshot: `D6-build-card-open-workspace.png`
- screenshot: `D6-reader-open-workspace.png`

## D7 — A hand-back is by you; the reader shows who recorded it

- note: added Dana Reyes (member mem_01m3jbrxx87k1n2zz4h2) through the daemon, for this half only
- note: build card: DEVELOPER
build
Done
Round 2
just now
by
Dana Reyes
·
recorded by
You
Open workspace ↗
+1 more doc
Full doc
Continue elsewhere
Request changes

Dana finished the page in her editor; recorded here for her.
- ✅ proof (API): the handed-back DesignBrief is authored and recorded by you — `{"authorId":"mem_01m3jbf1vx1xmwcn50ec","recordedBy":"mem_01m3jbf1vx1xmwcn50ec","responsibleId":"mem_01m3jbf1vx1xmwcn50ec","me":"mem_01m3jbf1vx1xmwcn50ec"}`
- ✅ proof (API): so is its Evidence — `{"authorId":"mem_01m3jbf1vx1xmwcn50ec","recordedBy":"mem_01m3jbf1vx1xmwcn50ec"}`
- ✅ the hand-back card reads "by You", with no "responsible" and no "recorded by" — `"by You"`
- ✅ its reader reads "by You": you did it and recorded it, so the recorder is not repeated — `"by You"`
- ✅ proof (API): the ChangeSet is authored by Dana and recorded by you — `{"authorId":"mem_01m3jbrxx87k1n2zz4h2","recordedBy":"mem_01m3jbf1vx1xmwcn50ec","responsibleId":"mem_01m3jbrxx87k1n2zz4h2","dana":"mem_01m3jbrxx87k1n2zz4h2","me":"mem_01m3jbf1vx1xmwcn50ec"}`
- ✅ the card reads "by Dana Reyes … recorded by You" — `"by Dana Reyes · recorded by You"`
- ✅ the reader shows "recorded by You" — `"by Dana Reyes · recorded by You"`
- screenshot: `D7-card-by-you.png`
- screenshot: `D7-reader-by-you.png`
- screenshot: `D7-hand-back-recording-for.png`
- screenshot: `D7-card-by-dana.png`
- screenshot: `D7-reader-recorded-by.png`

## D8 — A file attached to feedback is an input of the next round

- ✅ the composer shows the attached file — `"Request changes to review\nWhat should change?\nAttach\nhello-colours.md\n70 B\nAdd file\nAdd link\nCancel\nRequest changes"`
- ✅ sent from the composer
- ✅ proof (DB): the note references the file as an artifact, not its bytes — `{"id":"fb_01m3jbtbpb1q8f8qm0nk","text":"Check the page against the colours in the attached file.","attachments":[{"kind":"artifact","artifactId":"art_01m3jbtbp5w7hj52bavv"}]}`
- ✅ proof (API): the file is pinned as Evidence with its content — `{"type":"Evidence","refs":[{"kind":"file","value":"sha256:9fd8802377a36f6b00f859badb7e993cc9efe20391ab00270d56d7b9f8b5743a","label":"hello-colours.md"}],"body":"# Colours to use\n\nBackground #fffaf3, greeting #f6c28b, text #3b2f2a.\n"}`
- ✅ the review's round 2 ran and finished — `{"round":2,"status":"SUCCEEDED","statusReason":null}`
- ✅ the file is among the inputs of that round's run — `{"run":{"id":"run_01m3jbtbsfg6r9hqp607","round":2},"inputs":["art_01m3jbn6re9g35s1dcvh","art_01m3jbtbp5w7hj52bavv"],"file":"art_01m3jbtbp5w7hj52bavv"}`
- ✅ the round's prompt gives the agent the file — `" - \"No model was called\"\nverdict: \"pass\"\nreviewedRef: \"HEAD\"\nfindings: []\n---\n\n# ReviewReport: Scripted work\n\nWritten by the scripted acceptance agent.\n````\n\nFeedback to address:\n1. fb_01m3jbtbpb1q8f8qm0nk (Demostenes Garcia G.): Check the page against the colours in the attached `
- ✅ the review card shows Round 2, answering the note — `"REVIEWER\nreview\nDone\nRound 2\njust now\nby\nReview agent\n·\nresponsible\nYou\n+1 more doc\nFull doc\nRequest changes\n\nReviewReport ready for the hello page\n\nWHAT CHANGED\nApplied: Check the page against the colours in the attached file.\n· You\nWritten by the scripted acceptance agent\nNo m`
- ✅ the mission's Artifacts tab lists the attached file — `"msn_01m3jbg9rzqef0chaabs\nMissions\np2-chain\nHello page, taken to Figma SCRIPTED_SLOW_20S\nHello page, taken to Figma SCRIPTED_SLOW_20S\nComplete\nFeed\nPlan\n3\nTimeline\nArtifacts\n6\nChecks & Gates\nMetrics\nNewest versions\nShow older versions\nREVIEW REPORT\nReviewReport: Scripted work\nv2\nR`
- screenshot: `D8-composer-with-file.png`
- screenshot: `D8-review-next-round.png`
- screenshot: `D8-artifacts-tab.png`

## Findings

Two product findings, both in the desktop. Product code was not changed in this task.

### F1 (D1): the covered stage's row reads "product (covered by your upload) · covered by your upload"

- **Steps.** New Mission in the window: goal "A hello page that greets the visitor by name SCRIPTED_PLAN_SKIP",
  Done when "The page greets the visitor by name", repository acceptance-project, workflow "Feature delivery",
  `hello-spec.md` (with an "Acceptance criteria" section) added with Add file; Plan mission. Open the Plan tab.
- **Expected** (spec A2, A8 D1): a muted row "Spec · covered by your upload" naming the file.
- **Observed.** DOM text of `.taskcard--covered`: `product (covered by your upload) · covered by your upload` /
  `hello-spec.md`. Screenshot `D1-plan-covered-row.png`.
- **API state.** The placeholder task is right: key `product`, title `product (covered by your upload)`, status
  `SKIPPED`, statusReason `Covered by your upload: hello-spec.md`, coveredBy `{ artifactId: <intake ProductSpec>,
  filename: "hello-spec.md" }`, expectedOutputs `["ProductSpec"]`; the design step depends on it.
- **Cause.** `materialize.ts` titles the placeholder `` `${skip.stage} (covered by your upload)` `` and
  `PlanPane.tsx` (`TaskCard`, its `coveredBy` branch) renders `{task.title} · covered by your upload`, so the phrase appears twice, and
  the stage is shown as the planner's raw role id (`product`, which the prompt asks for) rather than the stage's
  name ("Spec").
- Everything else in D1 held: intake ran before planning (`mission.intake_completed` seq 9 < "Planner produced 6
  tasks … on attempt 1." seq 14), the plan was the planner's (no preset fallback), no product task, no status dot.

### F2 (D5): "Continue elsewhere" is not offered on a finished step whose next step waits to start

- **Steps.** Mission on workflow "P3 hold" (design → build with `approval: before`). The design finishes; the
  build is ready and asks "Start build?" (AWAITING_APPROVAL, runCount 0, nothing has read the design).
- **Expected** (spec A4, A8 D5): the design's card offers "Continue elsewhere"; parking it holds the build with
  "Waiting for 'design' from Figma.".
- **Observed.** The design card offers only "Open workspace ↗ · Full doc · Request changes". DOM text:
  `PRODUCT DESIGNER design Done … by Design agent · responsible You Open workspace ↗ Full doc Request changes`.
  Screenshot `D5-finished-design-card.png`. The daemon accepts the park for this very state (`POST
  /v1/tasks/:id/park` → AWAITING_EXTERNAL, the build back to PENDING with "Waiting for 'design' from Figma.", its
  "Start build?" card CANCELLED), so only the window refuses it.
- **Cause.** `FeedPane.tsx` `ranOnOutput` counts a dependent as having used the output when its status is in
  `STARTED`, which includes `AWAITING_APPROVAL`. A step waiting on its *start* approval has not run (runCount 0,
  no run inputs); the daemon's `impactOf` and `#holdReady` (which withdraws start cards) treat it as not started.
- The rest of D5 was observed after parking through the daemon's route (marked as a workaround in D5's notes, not
  counted as proof of the window): the build drawer showed "Waiting for 'design' from Figma." (`D5-build-held-drawer.png`),
  and after the hand-back the build asked to start again, was approved in the Inbox, ran once, and read only the
  round-2 DesignBrief (run inputs), with the handed-back text in its prompt.
