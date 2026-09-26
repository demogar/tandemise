# P2 acceptance report

Run: 2026-09-26T14:24:24.904Z · build 7ae5619 · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p0-run-muih0imk
Result: **ALL PASS** (11/11 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| C1 — Tweak a finished doc: round 2 continues the session and cites the note | PASS | 12/12 |
| C2 — Tweak with dependents: the impact dialog, Redo and Keep | PASS | 26/26 |
| C3 — Review → Request changes: same task, round 2, no revision task | PASS | 11/11 |
| C4 — Note while running: queued, delivered at the end of the pass, same round | PASS | 11/11 |
| C5 — Several notes: both go into one round and are cited | PASS | 15/15 |
| C6 — Missing citation: the retry names the missing id, then succeeds | PASS | 5/5 |
| C7 — AI reviewer: findings become notes, round 2 starts by itself, the review passes | PASS | 11/11 |
| C8 — Your own step: the note shows on your card, completing it addresses the note | PASS | 16/16 |
| C9 — Decline: "Declined" on the card and in the reader, linked to the note | PASS | 9/9 |
| C11 — Beyond docs: a code round edits the same branch and the review reruns | PASS | 12/12 |
| C12 — Retry from blocked: the note reaches the agent as a request | PASS | 12/12 |

## C1 — Tweak a finished doc: round 2 continues the session and cites the note

- note: mission msn_01m3f12592pghaz83g8c
- ✅ solo workspace: you are the only person — `["Demostenes Garcia G."]`
- ✅ round 1 ran on the fake runtime — `{"profile":"rt_01m3f123679zvrj50nw8","round":1}`
- ✅ the done card offers Request changes — `"PRODUCT MANAGER\ndoc\nDone\njust now\nby\nC1 writer\n·\nresponsible\nYou\nFull doc\nRequest changes\n\nA hello page with a long intro\n\nWritten by the fake runtime"`
- ✅ no "Recording for" on screen (composer)
- ✅ the composer asks "What should change?" and has no About for a single output — `"Request changes to doc\nWhat should change?\nCancel\nRequest changes"`
- ✅ no dependents: no impact dialog, the flash says "Round 2 started" — `"Round 2 started"`
- ✅ the note is addressed in round 2 — `[{"id":"fb_01m3f12dp6vaysct0fpb","taskId":"tsk_01m3f1259p7c00wky0y8","artifactId":null,"author":{"id":"mem_01m3f11zsymjdzfz2x66","name":"Demostenes Garcia G.","kind":"person"},"recordedBy":null,"text":"Shorter intro","st`
- ✅ round 2 ran on the same session — `[{"id":"run_01m3f128bc91yc4byzrx","attempt":1,"status":"SUCCEEDED","round":1,"purpose":"round","sessionId":"c1-session","profileId":"rt_01m3f123679zvrj50nw8","startedAt":"2026-09-26T14:14:19.803Z","errorCode":null,"error`
- ✅ both rounds are runs on the same fake profile and session — `[{"id":"run_01m3f128bc91yc4byzrx","attempt":1,"status":"SUCCEEDED","round":1,"purpose":"round","sessionId":"c1-session","profileId":"rt_01m3f123679zvrj50nw8","startedAt":"2026-09-26T14:14:19.803Z","errorCode":null,"error`
- ✅ the round-2 run resumed the session rather than starting a new one — `["session.resumed","session.init"]`
- ✅ the card shows Round 2 and What changed citing the note's author, with no ids — `"PRODUCT MANAGER\ndoc\nDone\nRound 2\njust now\nby\nC1 writer\n·\nresponsible\nYou\nFull doc\nRequest changes\n\nA hello page with a short intro\n\nWHAT CHANGED\nShortened the intro\n· You\nWritten by the fake runtime"`
- ✅ no "Recording for" on screen (feed)
- screenshot: `evidence/C1-card-done.png`
- screenshot: `evidence/C1-composer.png`
- screenshot: `evidence/C1-flash.png`
- screenshot: `evidence/C1-card-round-2.png`

## C2 — Tweak with dependents: the impact dialog, Redo and Keep

- note: redo: mission msn_01m3f13g54dfk7jpjwm7
- note: keep: mission msn_01m3f14cadtjfbcq19f9
- ✅ solo workspace: you are the only person — `["Demostenes Garcia G."]`
- ✅ no "Recording for" on screen (redo composer)
- ✅ redo: the dialog opens as "Round 2 of design" — `"Round 2 of design\n\nBuild (done), Review (done) used Design v1.\n\nRedo them after the new version\nKeep their work\nThey are flagged when the new version lands.\nNot now\nStart round 2"`
- ✅ redo: it lists Build (done) and says it used Design v1 — `"Round 2 of design\n\nBuild (done), Review (done) used Design v1.\n\nRedo them after the new version\nKeep their work\nThey are flagged when the new version lands.\nNot now\nStart round 2"`
- ✅ redo: it offers Redo and Keep, Start round 2 and Not now
- ✅ redo: chose "Redo them after the new version"
- ✅ redo: each dependent has its checkbox, ticked — `"Round 2 of design\n\nBuild (done), Review (done) used Design v1.\n\nRedo them after the new version\nbuild\nreview\nKeep their work\nThey are flagged when the new version lands.\nNot now\nStart round 2"`
- ✅ redo: clicked Start round 2
- ✅ redo: build goes back to PENDING, "Redone after design round 2" — `{"status":"PENDING","reason":"Redone after design round 2"}`
- ✅ redo: build reran and its new run used design v2 — `{"inputs":[{"id":"art_01m3f14022nscsk5xkea","taskId":"tsk_01m3f13g5qve5cea7ys3","round":2,"type":"DesignBrief"}],"designArts":[{"id":"art_01m3f13mvj9ntpak49e9","round":1},{"id":"art_01m3f14022nscsk5xkea","round":2}]}`
- ✅ redo: build was not flagged for attention
- ✅ redo: review reran (its run count increased) and succeeded — `{"before":1,"after":2,"status":"SUCCEEDED"}`
- ✅ redo: the feed shows design as Round 2 — `"PRODUCT DESIGNER\ndesign\nDone\nRound 2\njust now\nby\nDesign agent\n·\nresponsible\nYou\nFull doc\nRequest changes\n\nDesignBrief ready for the hello page\n\nWHAT CHANGED\nApplied: Make the greeting larger\n· You\nWrit`
- ✅ redo: the timeline says "Round 2 started" and "Redone: build" — `"msn_01m3f13g54dfk7jpjwm7\nMissions\np2-chain\nC2 redo muih1krf\nC2 redo muih1krf\nComplete\nFeed\nPlan\n3\nTimeline\nArtifacts\n4\nChecks & Gates\nMetrics\n65 events · latest just now\nFollowing\nRaw log\nMission create`
- ✅ no "Recording for" on screen (redo feed)
- ✅ no "Recording for" on screen (keep composer)
- ✅ keep: the dialog lists Build (done) and says it used Design v1 — `"Round 2 of design\n\nBuild (done), Review (done) used Design v1.\n\nRedo them after the new version\nKeep their work\nThey are flagged when the new version lands.\nNot now\nStart round 2"`
- ✅ keep: chose "Keep their work"
- ✅ keep: clicked Start round 2
- ✅ keep: build stays SUCCEEDED right after
- ✅ keep: build is still SUCCEEDED on its first run, and flagged once design round 2 lands — `{"status":"SUCCEEDED","needsAttention":true}`
- ✅ keep: the timeline says build was built against design v1 and v2 is out — `"msn_01m3f14cadtjfbcq19f9\nMissions\np2-chain\nC2 keep muih270i\nC2 keep muih270i\nComplete\nFeed\nPlan\n3\nTimeline\nArtifacts\n4\nChecks & Gates\nMetrics\n47 events · latest just now\nFollowing\nRaw log\nMission create`
- ✅ keep: the timeline titles it "Built on an older version of design", not "needs changes" — `"msn_01m3f14cadtjfbcq19f9\nMissions\np2-chain\nC2 keep muih270i\nC2 keep muih270i\nComplete\nFeed\nPlan\n3\nTimeline\nArtifacts\n4\nChecks & Gates\nMetrics\n47 events · latest just now\nFollowing\nRaw log\nMission create`
- ✅ keep: the flag is recorded by Tandemise as stale input — `{"actor":"system","body":{"type":"task.attention","taskId":"tsk_01m3f14cayhjwrp94fs2","note":"Built against design v1; v2 is out.","kind":"stale_input","upstream":"design"}}`
- ✅ keep: the Plan card reads "Built on an older version of design", with no "Changes requested after the fact" — `"msn_01m3f14cadtjfbcq19f9\nMissions\np2-chain\nC2 keep muih270i\nC2 keep muih270i\nComplete\nFeed\nPlan\n3\nTimeline\nArtifacts\n4\nChecks & Gates\nMetrics\nA design, a build that uses it, and an independent review of th`
- ✅ Plan tab: task cards show no raw tsk_ ids and the plan strip no art_ id until Details — `null`
- screenshot: `evidence/C2-dialog.png`
- screenshot: `evidence/C2-dialog-redo.png`
- screenshot: `evidence/C2-redo-feed.png`
- screenshot: `evidence/C2-redo-timeline.png`
- screenshot: `evidence/C2-dialog-keep.png`
- screenshot: `evidence/C2-keep-timeline.png`
- screenshot: `evidence/C2-keep-flag.png`

## C3 — Review → Request changes: same task, round 2, no revision task

- note: mission msn_01m3f1606897dg6f1z9v
- ✅ solo workspace: you are the only person — `["Demostenes Garcia G."]`
- ✅ a review card is open on doc for you — `["mem_01m3f11zsymjdzfz2x66"]`
- ✅ the card offers Approve, Request changes, Reject without changes — `["Approve","Request changes","Reject without changes"]`
- ✅ the Inbox card shows the three options — `"Inbox\nWhat is waiting on a person.\nApprove the output of doc?\nProductSpec ready for the hello page\nFor you·C3 review muih3c03\nAction\njust now\nReversible\nApprove the output of doc?\nAction\napr_01m3f164vbyeym019v`
- ✅ no "Recording for" on screen (Inbox card)
- ✅ the card is decided as Request changes (REJECTED, request_changes), by you, with the note — `{"status":"REJECTED","option":"request_changes","note":"Name the page title in the first sentence."}`
- ✅ same task id, now in round 2 — `{"id":"tsk_01m3f160716hhen8f1t3","round":2,"status":"AWAITING_APPROVAL"}`
- ✅ the plan has no _revision_ task — `["doc"]`
- ✅ a second review card opens for round 2 — `"Approve the output of doc?"`
- ✅ the note is on the thread, addressed in round 2 — `[{"status":"addressed","round":2,"text":"Name the page title in the first sentence."}]`
- ✅ the feed card is back In review as Round 2 with What changed — `"PRODUCT MANAGER\ndoc\nIn review\nRound 2\njust now\nby\nRuntime\n·\nresponsible\nYou\nFull doc\n\nProductSpec ready for the hello page\n\nWHAT CHANGED\nApplied: Name the page title in the first sentence.\n· You\nWritten`
- screenshot: `evidence/C3-inbox-three-options.png`
- screenshot: `evidence/C3-round-2-in-review.png`
- screenshot: `evidence/C3-inbox-after.png`

## C4 — Note while running: queued, delivered at the end of the pass, same round

- note: mission msn_01m3f17hk57ex638ndtw
- ✅ solo workspace: you are the only person — `["Demostenes Garcia G."]`
- ✅ no "Recording for" on screen (composer)
- ✅ the flash says the note waits for the pass — `"Queued: delivered when the current pass ends"`
- ✅ sent while the first pass was still running — `{"stillRunning":true,"ms":4163}`
- ✅ right after sending, the card shows "1 note pending" with the note, and no Start round — `"PRODUCT MANAGER\ndoc\nRunning\njust now\nresponsible\nYou\nRequest changes\n1 note pending\nMention the pricing page"`
- ✅ the item is queued — `[{"id":"fb_01m3f17qthscfmwmtg7z","taskId":"tsk_01m3f17hkjq84esxx346","artifactId":null,"author":{"id":"mem_01m3f11zsymjdzfz2x66","name":"Demostenes Garcia G.","kind":"person"},"recordedBy":null,"text":"Mention the pricin`
- ✅ attempts unchanged and still round 1 — `{"attempts":1,"round":1}`
- ✅ exactly two runs: the pass, then a feedback pass — `[{"purpose":"round","round":1,"status":"SUCCEEDED","attempt":1},{"purpose":"feedback","round":1,"status":"SUCCEEDED","attempt":2}]`
- ✅ the note is addressed in round 1 — `[{"id":"fb_01m3f17qthscfmwmtg7z","taskId":"tsk_01m3f17hkjq84esxx346","artifactId":null,"author":{"id":"mem_01m3f11zsymjdzfz2x66","name":"Demostenes Garcia G.","kind":"person"},"recordedBy":null,"text":"Mention the pricin`
- ✅ the last prompt the agent got carries the note's id — `{"prompts":2}`
- ✅ the done card has no pending note and no round badge — `"PRODUCT MANAGER\ndoc\nDone\njust now\nby\nRuntime\n·\nresponsible\nYou\nFull doc\nRequest changes\n\nProductSpec ready for the hello page\n\nWHAT CHANGED\nApplied: Mention the pricing page\n· You\nWritten by the scripte`
- screenshot: `evidence/C4-composer-running.png`
- screenshot: `evidence/C4-running-card-note-pending.png`
- screenshot: `evidence/C4-done-card.png`

## C5 — Several notes: both go into one round and are cited

- note: mission msn_01m3f19da5t7ed2g640t
- note: card while waiting: PRODUCT MANAGER | doc | Queued | Round 2 | just now | by | Runtime | · | responsible | You | Full doc | Request changes |  | Round 2: changes requested |  | 2 notes for round 2 | Add a link to the pricing page
- ✅ solo workspace: you are the only person — `["Demostenes Garcia G."]`
- ✅ paused from the header while doc runs — `"PAUSED"`
- ✅ the mission stays paused after doc finishes
- ✅ no "Recording for" on screen (first composer)
- ✅ first note: "Round 2 started" — `"Round 2 started"`
- ✅ second note joins the waiting round: "Added to the task" — `"Added to the task"`
- ✅ both notes are in round 2 before it runs — `{"status":"READY","round":2,"items":[["in_round",2],["open",2]]}`
- ✅ the card counts both notes for the round that has not run: "2 notes for round 2", with no Start round — `"PRODUCT MANAGER\ndoc\nQueued\nRound 2\njust now\nby\nRuntime\n·\nresponsible\nYou\nFull doc\nRequest changes\n\nRound 2: changes requested\n\n2 notes for round 2\nAdd a link to the pricing page"`
- ✅ the card names no one in the round line — `"PRODUCT MANAGER\ndoc\nQueued\nRound 2\njust now\nby\nRuntime\n·\nresponsible\nYou\nFull doc\nRequest changes\n\nRound 2: changes requested\n\n2 notes for round 2\nAdd a link to the pricing page"`
- ✅ the drawer thread lists both notes — `"doc\nReady\nProduct Manager\nScripted agent\nc5-notes-scripted-omit-citation-once-scripted-sl-doc\nnone isolation\nDone by\nScripted agent\n·\nResponsible\nYou\nRound 2: changes requested\nOBJECTIVE\nWrite a short spec `
- ✅ both notes sit under "Round 2"; the second "Joins this round"; nothing waits for a round and there is no Start round — `"doc\nReady\nProduct Manager\nScripted agent\nc5-notes-scripted-omit-citation-once-scripted-sl-doc\nnone isolation\nDone by\nScripted agent\n·\nResponsible\nYou\nRound 2: changes requested\nOBJECTIVE\nWrite a short spec `
- ✅ the drawer shows the round reason plainly, not as a warning, and with no personal name — `{"warns":0}`
- ✅ no "Recording for" on screen (drawer)
- ✅ C5: both notes addressed in round 2 — `[["Say who the page is for","addressed",2],["Add a link to the pricing page","addressed",2]]`
- ✅ C5: the reader's "Changes in v2" links both notes — `"doc\nProductSpec: Scripted work\nby\nRuntime\n·\nresponsible\nYou\nRequest changes\n\nProductSpec ready for the hello page\n\nWritten by the scripted acceptance agent\nNo model was called\nCHANGES IN V2\nApplied: Say wh`
- screenshot: `evidence/C5-card-two-notes.png`
- screenshot: `evidence/C5-drawer-two-notes.png`
- screenshot: `evidence/C5-reader-changes-v2.png`

## C6 — Missing citation: the retry names the missing id, then succeeds

- ✅ round 2 took two passes: the round, then a retry — `[{"purpose":"round","status":"SUCCEEDED","attempt":2,"error":null},{"purpose":"retry","status":"SUCCEEDED","attempt":3,"error":null}]`
- ✅ the retry prompt names the second note's id: "must cite <id>" — `["- Your previous attempt did not satisfy this task's completion gate. Tandemise measured: `.tandemise/out/tsk_01m3f19dah3h6622p399/ProductSpec.md` does not answer the feedback for round 2: handoff.changed must cite fb_0`
- ✅ the task succeeded in round 2
- ✅ the retry reads "Round 2 left 1 note unanswered; trying again." on the timeline — `{"type":"task.status","from":"RUNNING","to":"READY","reason":"Round 2 left 1 note unanswered; trying again."}`
- ✅ the timeline shows no raw feedback id and no "Missing expected artifacts" — `null`
- screenshot: `evidence/C6-timeline-retry.png`

## C7 — AI reviewer: findings become notes, round 2 starts by itself, the review passes

- note: mission msn_01m3f1cj20be6jrn5feh
- ✅ solo workspace: you are the only person — `["Demostenes Garcia G."]`
- ✅ build's thread holds a note authored by "Review agent", recorded by Tandemise — `[{"author":{"id":"mem_01m3f13e2pkfbg0gekxy","name":"Review agent","kind":"agent"},"recordedBy":{"id":"system","name":"Tandemise","kind":"system"},"status":"addressed","round":2,"text":"The greeting ignores the visitor na`
- ✅ the note is the finding, addressed in round 2 — `{"id":"fb_01m3f1cwk8a9wvczfyxc","taskId":"tsk_01m3f1cj2jjay5e1y6bc","artifactId":null,"author":{"id":"mem_01m3f13e2pkfbg0gekxy","name":"Review agent","kind":"agent"},"recordedBy":{"id":"system","name":"Tandemise","kind":`
- ✅ build round 2 started without a person — `{"round":2,"actor":"mem_01m3f13e2pkfbg0gekxy","downstream":"redo"}`
- ✅ review ran twice — `[{"purpose":"round","status":"SUCCEEDED","round":1},{"purpose":"retry","status":"SUCCEEDED","round":1}]`
- ✅ the first ReviewReport failed and the last one passes — `{"reports":2,"first":"verdict: \"fail\"","last":"verdict: \"pass\""}`
- ✅ no fix_ or recheck task was planned — `["design","build","review"]`
- ✅ the mission completes — `{"status":"COMPLETE","reason":"Every task succeeded."}`
- ✅ the build card shows Round 2 and What changed with the Review agent's name — `"DEVELOPER\nbuild\nDone\nRound 2\njust now\nby\nRuntime\n·\nresponsible\nYou\nFull doc\nRequest changes\n\nChangeSet ready for the hello page\n\nWHAT CHANGED\nApplied: The greeting ignores the visitor name (hello.txt)\n·`
- ✅ no "Recording for" on screen (feed)
- ✅ the build drawer thread shows the Review agent's note under Round 2 — `"build\nRetry with more access\nSucceeded\nDeveloper\nScripted agent\nc7-reviewer-scripted-review-blocking-muih7xtl-build\nworktree isolation\nDone by\nScripted agent\n·\nResponsible\nYou\nOBJECTIVE\nBuild the hello page`
- screenshot: `evidence/C7-feed-after-loop.png`
- screenshot: `evidence/C7-build-drawer-thread.png`

## C8 — Your own step: the note shows on your card, completing it addresses the note

- note: mission msn_01m3f1e7v9chjcqnbxrg
- ✅ solo workspace: you are the only person — `["Demostenes Garcia G."]`
- ✅ docs is yours — `{"id":"mem_01m3f11zsymjdzfz2x66","name":"Demostenes Garcia G.","kind":"person"}`
- ✅ the drawer footer has Request changes
- ✅ no "Recording for" on screen (composer over the drawer)
- ✅ the flash says the note was added to the task — `"Added to the task"`
- ✅ the drawer is still open and its thread shows the note — `"docs\nThis one is yours\n\nWrite the README paragraph for the hello page yourself.\n\nAwaiting human\nProduct Manager\nnone isolation\nDone by\nYou\nChange\nWaiting for you.\nOBJECTIVE\nWrite the README paragraph for th`
- ✅ the note is "For this step", not waiting for a round, with no Start round — `"docs\nThis one is yours\n\nWrite the README paragraph for the hello page yourself.\n\nAwaiting human\nProduct Manager\nnone isolation\nDone by\nYou\nChange\nWaiting for you.\nOBJECTIVE\nWrite the README paragraph for th`
- ✅ no "Recording for" on screen (drawer)
- ✅ the item is on the task, open in round 1, by you — `[{"id":"fb_01m3f1efssyk4nfbc376","taskId":"tsk_01m3f1e7vqh2ns2e956m","artifactId":null,"author":{"id":"mem_01m3f11zsymjdzfz2x66","name":"Demostenes Garcia G.","kind":"person"},"recordedBy":null,"text":"Mention the pricin`
- ✅ your card shows "1 note pending" with the note — `"PRODUCT MANAGER\ndocs\nPerson step\njust now\nby\nYou\n\nWrite the README paragraph for the hello page yourself.\n\n1 note pending\nMention the pricing page\nNeeds You to do this step and mark it done.\nDo it"`
- ✅ no "Recording for" on screen (feed)
- ✅ after completion the note is addressed in round 1 — `[{"id":"fb_01m3f1efssyk4nfbc376","taskId":"tsk_01m3f1e7vqh2ns2e956m","artifactId":null,"author":{"id":"mem_01m3f11zsymjdzfz2x66","name":"Demostenes Garcia G.","kind":"person"},"recordedBy":null,"text":"Mention the pricin`
- ✅ the artifact is round 1, authored by you — `[{"id":"art_01m3f1eqzz11trvz49rx","round":1,"authorId":"mem_01m3f11zsymjdzfz2x66","type":"Evidence"}]`
- ✅ the task stays in round 1
- ✅ the timeline records the note as answered
- ✅ the done card no longer shows the note as pending — `"PRODUCT MANAGER\ndocs\nDone\njust now\nby\nYou\nFull doc\nRequest changes\n\nREADME: the hello page greets visitors by name."`
- screenshot: `evidence/C8-composer.png`
- screenshot: `evidence/C8-drawer-note.png`
- screenshot: `evidence/C8-card-with-note.png`
- screenshot: `evidence/C8-card-done.png`

## C9 — Decline: "Declined" on the card and in the reader, linked to the note

- note: mission msn_01m3f1ftkh6p09wz53gw
- ✅ solo workspace: you are the only person — `["Demostenes Garcia G."]`
- ✅ no "Recording for" on screen (composer)
- ✅ the flash says "Round 2 started" — `"Round 2 started"`
- ✅ the note is closed in round 2 (declined notes still count as answered) — `[{"id":"fb_01m3f1g242kgkskxaaqa","taskId":"tsk_01m3f1ftks7wc6377r5c","artifactId":null,"author":{"id":"mem_01m3f11zsymjdzfz2x66","name":"Demostenes Garcia G.","kind":"person"},"recordedBy":null,"text":"Add a dark mode to`
- ✅ the card's What changed shows a Declined chip, the reason without the "Declined:" prefix, and the note's author — `"PRODUCT MANAGER\ndoc\nDone\nRound 2\njust now\nby\nRuntime\n·\nresponsible\nYou\nFull doc\nRequest changes\n\nProductSpec ready for the hello page\n\nWHAT CHANGED\nDeclined\nthe scripted agent keeps the page as it is\n·`
- ✅ the Declined chip is its own element — `"Declined"`
- ✅ the reader's "Changes in v2" marks it Declined and links it to the note text and author — `"doc\nProductSpec: Scripted work\nby\nRuntime\n·\nresponsible\nYou\nRequest changes\n\nProductSpec ready for the hello page\n\nWritten by the scripted acceptance agent\nNo model was called\nCHANGES IN V2\nDeclined\nthe s`
- ✅ event feedback.addressed carries declined: true — `{"type":"feedback.addressed","feedbackId":"fb_01m3f1g242kgkskxaaqa","round":2,"declined":true}`
- ✅ the timeline reads "Round 2 declined a note"
- screenshot: `evidence/C9-card-declined.png`
- screenshot: `evidence/C9-reader-declined.png`

## C11 — Beyond docs: a code round edits the same branch and the review reruns

- note: mission msn_01m3f1hn3yhkhk4gq0z7
- note: round 1 source refs: [{"kind":"git.branch","value":"tandemise/c11-code-muihbinp/c11-code-muihbinp-build-mjeyq0z8","label":"build branch"},{"kind":"git.commit","value":"28a0ff655ff4eac3b6e775f3de47b9f9bce16c72","label":"build HEAD"}]
- note: round 2 source refs: [{"kind":"git.branch","value":"tandemise/c11-code-muihbinp/c11-code-muihbinp-build-mjeyq0z8","label":"build branch"},{"kind":"git.commit","value":"cb58931cb576e78768e49f97b288195f074c2670","label":"build HEAD"}]
- ✅ solo workspace: you are the only person — `["Demostenes Garcia G."]`
- ✅ a review card is open on build for you — `"Approve the output of build?"`
- ✅ no "Recording for" on screen (Inbox card)
- ✅ the build card is decided Request changes — `{"status":"REJECTED","option":"request_changes"}`
- ✅ same build task, now round 2, back in review — `{"round":2,"status":"AWAITING_APPROVAL"}`
- ✅ a new build review card appears (the review pipeline reran) — `"Approve the output of build?"`
- ✅ the round-2 ChangeSet is on the same branch as round 1 — `{"r1":"tandemise/c11-code-muihbinp/c11-code-muihbinp-build-mjeyq0z8","r2":"tandemise/c11-code-muihbinp/c11-code-muihbinp-build-mjeyq0z8"}`
- ✅ with a different commit — `{"r1":"28a0ff655ff4eac3b6e775f3de47b9f9bce16c72","r2":"cb58931cb576e78768e49f97b288195f074c2670"}`
- ✅ the branch has a second commit touching hello.txt, from the round — `{"log":"cb58931 build: build\n28a0ff6 build: build\n","hello":"round first\nround fb_01m3f1j3fx5q4y6wkdvq\n"}`
- ✅ the note is addressed in round 2 — `[{"id":"fb_01m3f1j3fx5q4y6wkdvq","taskId":"tsk_01m3f1hn47wmmjeyq0z8","artifactId":null,"author":{"id":"mem_01m3f11zsymjdzfz2x66","name":"Demostenes Garcia G.","kind":"person"},"recordedBy":null,"text":"Escape the visitor`
- ✅ the Inbox shows the second review card with the three options
- ✅ the feed card shows Round 2 in review with What changed — `"DEVELOPER\nbuild\nIn review\nRound 2\njust now\nby\nRuntime\n·\nresponsible\nYou\nFull doc\n\nChangeSet ready for the hello page\n\nWHAT CHANGED\nApplied: Escape the visitor name\n· You\nWritten by the scripted acceptan`
- screenshot: `evidence/C11-first-review-card.png`
- screenshot: `evidence/C11-second-review-card.png`
- screenshot: `evidence/C11-feed-round-2.png`

## C12 — Retry from blocked: the note reaches the agent as a request

- note: mission msn_01m3f1ka5cd0psb1bg46
- ✅ solo workspace: you are the only person — `["Demostenes Garcia G."]`
- ✅ doc is BLOCKED after its attempts — `{"status":"BLOCKED","reason":"Missing expected artifacts: ProductSpec.","attempts":2}`
- ✅ the drawer shows the reason and "Retry task" under it — `"doc\nRetry with more access\nBlocked\nProduct Manager\nScripted agent\nc12-blocked-scripted-fail-until-note-muihcokg-doc\nnone isolation\nDone by\nScripted agent\n·\nResponsible\nYou\nMissing expected artifacts: Product`
- ✅ with a note the button reads "Retry with this note" — `"doc\nRetry with more access\nBlocked\nProduct Manager\nScripted agent\nc12-blocked-scripted-fail-until-note-muihcokg-doc\nnone isolation\nDone by\nScripted agent\n·\nResponsible\nYou\nMissing expected artifacts: Product`
- ✅ no "Recording for" on screen (drawer)
- ✅ clicked "Retry with this note"
- ✅ the task succeeded in round 2 — `{"status":"SUCCEEDED","round":2,"reason":null}`
- ✅ the note became an item, addressed in round 2, by you — `[{"id":"fb_01m3f1kph59hnb0hv2gf","taskId":"tsk_01m3f1ka5pmjr6n3bxwm","artifactId":null,"author":{"id":"mem_01m3f11zsymjdzfz2x66","name":"Demostenes Garcia G.","kind":"person"},"recordedBy":null,"text":"Write it even if s`
- ✅ the last prompt carries "Feedback to address" with the note — `{"prompts":3}`
- ✅ and is not framed as a gate failure — `null`
- ✅ the open drawer now shows the note under Round 2 — `"doc\nRetry with more access\nSucceeded\nProduct Manager\nScripted agent\nc12-blocked-scripted-fail-until-note-muihcokg-doc\nnone isolation\nDone by\nScripted agent\n·\nResponsible\nYou\nOBJECTIVE\nWrite a short spec for`
- ✅ the mission completes — `"COMPLETE"`
- screenshot: `evidence/C12-drawer-retry-note.png`
- screenshot: `evidence/C12-drawer-after-round-2.png`
