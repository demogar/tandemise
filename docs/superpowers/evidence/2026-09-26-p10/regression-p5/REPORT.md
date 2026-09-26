# P5 acceptance report

Run: 2026-09-26T13:28:50.398Z · build 8edafd4 · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p5-run-muif8hm1
Result: **ALL PASS** (5/5 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| E1 — Done-when lines trace from the request to QA | PASS | 13/13 |
| E2 — A spec that misses a Done-when line cannot pass | PASS | 10/10 |
| E3 — Unverified criteria keep the release shut | PASS | 8/8 |
| E4 — A failed criterion shows as Failed and stops QA | PASS | 7/7 |
| E5 — A revised spec replaces its criteria | PASS | 8/8 |

## E1 — Done-when lines trace from the request to QA

- note: mission msn_01m3ey6y0k7cjwpn55xc
- ✅ the feed opens with "Done when" listing U1 and U2 in the person's words — `"Done when\n0 of 2 verified\nU1\nThe page greets the visitor by name\nThe spec will cover this\nNot verified\nU2\nThe page works offline\nThe spec will cover this\nNot verified"`
- ✅ before a spec both lines count: "0 of 2 verified" — `"Done when\n0 of 2 verified\nU1\nThe page greets the visitor by name\nThe spec will cover this\nNot verified\nU2\nThe page works offline\nThe spec will cover this\nNot verified"`
- ✅ each reads "Not verified" and "The spec will cover this" — `"U2 The page works offline The spec will cover this Not verified"`
- ✅ after the spec the header reads "0 of 1 verified" — `"Done when\n0 of 1 verified\nU1\nThe page greets the visitor by name\nCovered by AC1\nNot verified\nU2\nThe page works offline\nCovered by AC1\nNot verified\nAC1\nScripted criterion 1: the hello page greets the visitor b`
- ✅ AC1 "Covers U1, U2" and is "Not verified", waiting for QA — `"AC1 Scripted criterion 1: the hello page greets the visitor by name. Covers U1, U2 · Waiting for QA Not verified"`
- ✅ U1 and U2 each say "Covered by AC1" — `["U1 The page greets the visitor by name Covered by AC1 Not verified","U2 The page works offline Covered by AC1 Not verified"]`
- ✅ after QA the header reads "1 of 1 verified" — `"Done when\n1 of 1 verified\nU1\nThe page greets the visitor by name\nCovered by AC1\nVerified\nU2\nThe page works offline\nCovered by AC1\nVerified\nAC1\nScripted criterion 1: the hello page greets the visitor by name.\`
- ✅ every row reads "Verified" — `["U1 The page greets the visitor by name Covered by AC1 Verified","U2 The page works offline Covered by AC1 Verified","AC1 Scripted criterion 1: the hello page greets the visitor by name. Covers U1, U2 · Scripted check f`
- ✅ AC1 shows QA's evidence — `"AC1 Scripted criterion 1: the hello page greets the visitor by name. Covers U1, U2 · Scripted check for AC1 passed Verified"`
- ✅ clicking AC1 opens the QA report that verified it — `"QA report\nQAReport: Scripted work\nby\nRuntime\n·\nresponsible\nYou\nRequest changes\n\nQAReport ready for the hello page\n\nWritten by the scripted acceptance agent\nNo model was called\nQAReport\nSep 26, 2026, 8:24 A`
- ✅ proof (API): U1, U2, AC1 all PASS; AC1 carries the QA report id — `[{"key":"U1","result":"PASS","covers":[],"coveredBy":["AC1"]},{"key":"U2","result":"PASS","covers":[],"coveredBy":["AC1"]},{"key":"AC1","result":"PASS","covers":["U1","U2"],"coveredBy":[]}]`
- ✅ the mission completes — `"COMPLETE"`
- ✅ proof: the release gate read qa.criteria_unverified 0 — `{"status":"SUCCEEDED","reason":null}`
- screenshot: `E1-ledger-at-creation.png`
- screenshot: `E1-spec-covers-both.png`
- screenshot: `E1-all-verified.png`
- screenshot: `E1-qa-report-from-row.png`

## E2 — A spec that misses a Done-when line cannot pass

- note: mission msn_01m3ey8f5w8twaxqx4jn
- ✅ the spec task blocks after its attempts — `{"status":"BLOCKED","attempts":2}`
- ✅ the Inbox card for spec reads "Not met: criteria.uncovered_user is 1, needs 0" and names U2 — `"Inbox\nWhat is waiting on a person.\nspec exhausted its retries\nProductSpec ready for the hello page\nFor you·E2 SCRIPTED_SPEC_MISSES_U2 muif9n5i\nIntervention\njust now\nRead only\nspec exhausted its retries\nInterven`
- ✅ U2 reads "Not covered": nothing in the spec covers it yet — `"U2 The page works offline Nothing in the spec covers this yet Not covered"`
- ✅ U1 is covered by AC1 — `"U1 The page greets the visitor by name Covered by AC1 Not verified"`
- ✅ U2 still counts: "0 of 2 verified" (AC1 and U2) — `"Done when\n0 of 2 verified\nU1\nThe page greets the visitor by name\nCovered by AC1\nNot verified\nU2\nThe page works offline\nNothing in the spec covers this yet\nNot covered\nAC1\nScripted criterion 1: the hello page `
- ✅ the spec ran twice — `2`
- ✅ the first prompt lists the ledger and says which lines to cover — `"Done when (criteria ledger; cite these ids):\n- U1: The page greets the visitor by name\n- U2: The page works offline\nAutonomy: balanced\n\n## Your task\nKey: spec\nTitle: spec\n\nObjective:\nWrite the spec for the hel`
- ✅ the retry prompt quotes the gate and names U2 with its words — `"Tandemise measured: Not met: criteria.uncovered_user is 1, needs 0 The ProductSpec leaves U2 uncovered (\"The page works offline\"). Add U2 to `covers` on the acceptance criterion that proves it, or add a criterion for `
- ✅ proof (SQL): each attempt's spec was stored, covering only U1; the first superseded by the second — `[{"key":"AC1","covers":"[\"U1\"]","superseded":1},{"key":"AC1","covers":"[\"U1\"]","superseded":0}]`
- ✅ an intervention card asks you what to do — `["spec exhausted its retries"]`
- screenshot: `E2-inbox-card-not-met.png`
- screenshot: `E2-u2-not-covered.png`

## E3 — Unverified criteria keep the release shut

- note: mission msn_01m3eya0sqt67y8q15c0
- ✅ QA passes its own gate: a skipped criterion is not a failed one — `{"status":"SUCCEEDED","reason":null}`
- ✅ the release blocks after its attempts — `{"status":"BLOCKED","attempts":2,"reason":"Not met: qa.criteria_unverified is 2, needs 0"}`
- ✅ the checklist reads "1 of 3 verified" — `"Done when\n1 of 3 verified\nU1\nThe page greets the visitor by name\nCovered by AC1, AC2, AC3 · QA could not verify it\nNot verified\nU2\nThe page works offline\nCovered by AC1, AC2, AC3 · QA could not verify it\nNot ve`
- ✅ AC1 Verified; AC2 and AC3 Not verified, and say QA could not verify them — `["AC1 Scripted criterion 1: the hello page greets the visitor by name. Covers U1, U2 · Scripted check for AC1 passed Verified","AC2 Scripted criterion 2: the hello page works offline. Covers U1, U2 · QA could not verify `
- ✅ U1 and U2 are not verified either: not everything covering them passed — `["U1 The page greets the visitor by name Covered by AC1, AC2, AC3 · QA could not verify it Not verified","U2 The page works offline Covered by AC1, AC2, AC3 · QA could not verify it Not verified"]`
- ✅ the Inbox card for release reads "qa.criteria_unverified is 2, needs 0" and names AC2 and AC3 — `"Inbox\nWhat is waiting on a person.\nrelease exhausted its retries\nReleaseCandidate ready for the hello page\nFor you·E3 SCRIPTED_QA_PARTIAL muifaqd1\nIntervention\njust now\nRead only\nrelease exhausted its retries\nI`
- ✅ the mission is not COMPLETE — `"BLOCKED"`
- ✅ proof (event log): the last gate evaluation names qa.criteria_unverified — `"{\"type\":\"gate.evaluated\",\"gate\":\"qa.criteria_unverified == 0 && qa.blocking_defects == 0\",\"passed\":false,\"detail\":\"Not met: qa.criteria_unverified is 2, needs 0\"}"`
- screenshot: `E3-one-of-three.png`
- screenshot: `E3-inbox-card-unverified.png`

## E4 — A failed criterion shows as Failed and stops QA

- note: mission msn_01m3eybp92fqk58wqsj3
- ✅ QA blocks: a failed criterion fails its gate — `{"status":"BLOCKED","reason":"Not met: qa.criteria_failed is 1, needs 0"}`
- ✅ AC2 reads "Failed" with QA's evidence — `"AC2 Scripted criterion 2: the hello page works offline. Covers U1, U2 · The scripted check for AC2 failed Failed"`
- ✅ AC1 reads "Verified"; the header reads "1 of 2 verified" — `"Done when\n1 of 2 verified\nU1\nThe page greets the visitor by name\nCovered by AC1, AC2\nFailed\nU2\nThe page works offline\nCovered by AC1, AC2\nFailed\nAC1\nScripted criterion 1: the hello page greets the visitor by `
- ✅ the user lines AC2 covers read "Failed" too — `"U1 The page greets the visitor by name Covered by AC1, AC2 Failed"`
- ✅ clicking AC2 opens the QA report that failed it — `"QA report\nQAReport: Scripted work\nby\nRuntime\n·\nresponsible\nYou\nRequest changes\n\nQAReport ready for the hello page\n\nWritten by the scripted acceptance agent\nNo model was called\nv1\nv2\nCompare with v1\nQARep`
- ✅ the Inbox card for qa reads "qa.criteria_failed is 1, needs 0" and names AC2 — `"Inbox\nWhat is waiting on a person.\nqa exhausted its retries\nQAReport ready for the hello page\nFor you·E4 SCRIPTED_QA_FAIL_AC2 muifbwm5\nIntervention\njust now\nRead only\nqa exhausted its retries\nIntervention\napr_`
- ✅ the release never started — `{"status":"PENDING","attempts":0}`
- screenshot: `E4-ac2-failed.png`
- screenshot: `E4-qa-report-ac2.png`
- screenshot: `E4-inbox-card-failed.png`

## E5 — A revised spec replaces its criteria

- note: mission msn_01m3eydawvpa846gyaw4
- ✅ round 1: AC1 and AC2, "0 of 2 verified", no AC3 — `"Done when\n0 of 2 verified\nU1\nThe page greets the visitor by name\nCovered by AC1, AC2\nNot verified\nU2\nThe page works offline\nCovered by AC1, AC2\nNot verified\nAC1\nScripted criterion 1: the hello page greets the`
- ✅ round 2 adds AC3, which reads "Not verified" — `"AC3 Scripted criterion 3: the hello page loads in under a second. Covers U1, U2 · Waiting for QA Not verified"`
- ✅ the header now reads "0 of 3 verified" — `"Done when\n0 of 3 verified\nU1\nThe page greets the visitor by name\nCovered by AC1, AC2, AC3\nNot verified\nU2\nThe page works offline\nCovered by AC1, AC2, AC3\nNot verified\nAC1\nScripted criterion 1: the hello page `
- ✅ proof (SQL): round 1's AC1 and AC2 are superseded — `[{"key":"AC1","superseded":1,"spec":"art_01m3eydfjqytdrq0xjhr"},{"key":"AC2","superseded":1,"spec":"art_01m3eydfjqytdrq0xjhr"},{"key":"AC1","superseded":0,"spec":"art_01m3eydph1jfh8b374vx"},{"key":"AC2","superseded":0,"s`
- ✅ proof (SQL): AC1, AC2, AC3 are live, from the round-2 spec — `[{"key":"AC1","superseded":0,"spec":"art_01m3eydph1jfh8b374vx"},{"key":"AC2","superseded":0,"spec":"art_01m3eydph1jfh8b374vx"},{"key":"AC3","superseded":0,"spec":"art_01m3eydph1jfh8b374vx"}]`
- ✅ the checklist shows only the live criteria — `["U1","U2","AC1","AC2","AC3"]`
- ✅ after QA: "3 of 3 verified" — `"Done when\n3 of 3 verified\nU1\nThe page greets the visitor by name\nCovered by AC1, AC2, AC3\nVerified\nU2\nThe page works offline\nCovered by AC1, AC2, AC3\nVerified\nAC1\nScripted criterion 1: the hello page greets t`
- ✅ the mission completes — `"COMPLETE"`
- screenshot: `E5-round-1-two-criteria.png`
- screenshot: `E5-round-2-ac3.png`
- screenshot: `E5-three-of-three.png`
