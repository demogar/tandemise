# P1 acceptance report

Run: 2026-09-26T14:14:05.209Z · build 7ae5619 · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p0-run-muigvd8o
Result: **ALL PASS** (14/14 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| B13 — Rejected plan: Needs you, "Rejected", Re-plan asks again | PASS | 10/10 |
| B14 — A check for me: Needs you, decided on the card, then gone | PASS | 4/4 |
| B1 — Solo mission opens on a feed of short cards | PASS | 4/4 |
| B2 — Needs you: decide on the card itself | PASS | 5/5 |
| B3 — Full doc: no front matter, handoff first, appendix collapsed | PASS | 3/3 |
| B3a — Full doc: the appendix is collapsed with its word count | PASS | 1/1 |
| B4 — Too long first draft → one tighten pass → short | PASS | 4/4 |
| B5 — Still too long after tightening → accepted, flagged, mission continues | PASS | 4/4 |
| B6 — A missing handoff is named in the retry and then fixed | PASS | 2/2 |
| B7 — Superseded versions are hidden until asked for | PASS | 2/2 |
| B8 — A person's output gets a headline from their own first sentence | PASS | 1/1 |
| B9 — A preview link renders on the card | PASS | 1/1 |
| B10 — Team: a teammate's pending review is not under my Needs you | PASS | 2/2 |
| B12 — Readability audit of done cards (DOM) | PASS | 2/2 |

## B13 — Rejected plan: Needs you, "Rejected", Re-plan asks again

- note: plan options: Approve, Reject
- ✅ the mission is blocked after the rejection — `{"status":"BLOCKED","reason":"The plan was rejected: Too broad, split the design work first. Re-plan or change the mission goal."}`
- ✅ the plan card is under Needs you — `"msn_01m3f103719p2f86dxex\nMissions\np0\nB reject muigz6oq\nB reject muigz6oq\nBlocked\nRe-plan\nResume\nCancel\nThe plan was rejected: Too broad, split the design work first. Re-plan or change the mission goal.\nFeed\n1`
- ✅ the plan card says Rejected, not Approved — `"Plan for B reject muigz6oq\nRejected\njust now\nby\nRuntime\n·\nresponsible\nYou\nFull doc\n\nThe plan was rejected: Too broad, split the design work first. Re-plan or change the mission goal.\n\n8 tasks: product ×2 → d`
- ✅ the card offers Re-plan
- ✅ the reason has no double period — `"The plan was rejected: Too broad, split the design work first. Re-plan or change the mission goal."`
- ✅ clicked Re-plan on the card
- ✅ Re-plan produced a new plan to approve
- ✅ the card now asks for approval again with an inline Approve — `"Plan for B reject muigz6oq\nAwaiting approval\njust now\nby\nRuntime\n·\nresponsible\nYou\nFull doc\n\nExercises staffing, responsibility, reviews and escalation across product, design…\n\n8 tasks: product ×2 → design →`
- ✅ approved the new plan from the card
- ✅ the mission runs
- screenshot: `evidence/B13-rejected.png`
- screenshot: `evidence/B13-replanned.png`

## B14 — A check for me: Needs you, decided on the card, then gone

- note: check "Check architecture when you can" options: Looks good, Needs changes
- ✅ the architecture check is under Needs you — `"msn_01m3f10fx1nk3a0743kr\nMissions\np0\nB check muigzgpn\nB check muigzgpn\nExecuting\nPause\nCancel\nFeed\n2\nPlan\n8\nTimeline\nArtifacts\n6\nChecks & Gates\nMetrics\nDone when\n0 of 1 verified\nU1\nThe acceptance sce`
- ✅ it reads as non-blocking ("Check when you can") — `"ARCHITECT\narchitecture\nDone\njust now\nby\nRuntime\n·\nresponsible\nYou\nFull doc\nRequest changes\n\nArchitecturePlan ready for the hello page\n\nWritten by the scripted acceptance agent\nNo model was called\nCheck w`
- ✅ decided "Looks good" on the card
- ✅ the check left Needs you — `"msn_01m3f10fx1nk3a0743kr\nMissions\np0\nB check muigzgpn\nB check muigzgpn\nExecuting\nPause\nCancel\nFeed\n1\nPlan\n8\nTimeline\nArtifacts\n7\nChecks & Gates\nMetrics\nDone when\n0 of 1 verified\nU1\nThe acceptance sce`
- screenshot: `evidence/B14-check-needs-you.png`
- screenshot: `evidence/B14-check-decided.png`

## B1 — Solo mission opens on a feed of short cards

- ✅ the mission opens on the Feed tab
- ✅ mission completes — `"COMPLETE"`
- ✅ Done cards show headlines, not YAML or ids
- ✅ cards carry "by … · responsible You"
- screenshot: `evidence/B1-needs-plan.png`
- screenshot: `evidence/B1-done.png`

## B2 — Needs you: decide on the card itself

- ✅ the plan waits under Needs you with an inline Approve
- ✅ clicked Approve on the plan card
- ✅ spec review card sits under Needs you with its needs line
- ✅ approved spec from the card
- ✅ spec moved to Done
- screenshot: `evidence/B2-plan-needs-you.png`
- screenshot: `evidence/B2-spec-needs-you.png`

## B3 — Full doc: no front matter, handoff first, appendix collapsed

- ✅ reader shows the headline and points
- ✅ no YAML front matter in the reader
- ✅ ids live behind Details, not in the header text
- screenshot: `evidence/B3-reader.png`

## B3a — Full doc: the appendix is collapsed with its word count

- ✅ an "Appendix (N words)" section exists and starts collapsed — `{"summary":"Appendix (400 words)","open":false}`
- screenshot: `evidence/B3a-reader-appendix.png`

## B4 — Too long first draft → one tighten pass → short

- ✅ exactly one tighten pass — `1`
- ✅ design succeeded without spending an attempt — `{"status":"SUCCEEDED","attempts":1}`
- ✅ the kept artifact is within budget — `{"words":9,"overBudget":false}`
- ✅ timeline shows the tighten request
- screenshot: `evidence/B4-timeline.png`

## B5 — Still too long after tightening → accepted, flagged, mission continues

- ✅ one tighten pass, then an over_budget event
- ✅ design still succeeded — `"SUCCEEDED"`
- ✅ the design card shows an "Over budget" marker
- ✅ the mission kept going — `"RUNNING"`
- screenshot: `evidence/B5-card.png`

## B6 — A missing handoff is named in the retry and then fixed

- ✅ the retry named handoff.headline
- ✅ the next attempt succeeded — `{"status":"SUCCEEDED","attempts":2}`

## B7 — Superseded versions are hidden until asked for

- ✅ one DesignBrief row by default — `1`
- ✅ "Show older versions" reveals v1 under the live version
- screenshot: `evidence/B7-older.png`

## B8 — A person's output gets a headline from their own first sentence

- ✅ docs card headline is the first sentence of the text

## B9 — A preview link renders on the card

- ✅ design card shows "Open preview ↗"

## B10 — Team: a teammate's pending review is not under my Needs you

- ✅ design is not in Needs you
- ✅ design is In progress, "Waiting for Ana Ruiz"
- screenshot: `evidence/B10-team-feed.png`

## B12 — Readability audit of done cards (DOM)

- note: [{"lines":7,"chars":100,"text":"RELEASE MANAGER"},{"lines":7,"chars":90,"text":"QA ENGINEER"},{"lines":7,"chars":93,"text":"DEVELOPER"},{"lines":5,"chars":43,"text":"PRODUCT MANAGER"},{"lines":6,"chars":100,"text":"ARCHITECT"},{"lines":6,"chars":97,"text":"FINANCE ANALYST"},{"lines":6,"chars":95,"text":"PRODUCT DESIGNER"},{"lines":7,"chars":95,"text":"PRODUCT MANAGER"},{"lines":6,"chars":164,"text":"Plan for B solo muigvj2q"}]
- ✅ every done card fits in ≤ 8 visible lines — `[7,7,7,5,6,6,6,7,6]`
- ✅ headline + points ≤ the contract maximum (510 chars) — `[100,90,93,43,100,97,95,95,164]`
