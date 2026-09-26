# A release step passes only when it produced its release candidate

Evidence for `fix/release-step-needs-its-artifact` (build 7ae5619).

## The hole

A completion gate replaces the "every expected output was produced" rule
(`decide` in `task-executor.ts`). The feature-delivery `release_candidate`
gate read only QA facts, `qa.criteria_unverified == 0 && qa.blocking_defects == 0`,
so a release run that wrote nothing passed. Found in P10.

## Audit

| Preset / source | Step | Gate demanded its own output before? | Now |
|---|---|---|---|
| feature-delivery | product_spec | yes (`artifact.ProductSpec.exists`) | unchanged |
| feature-delivery | design, architecture | no gate: every expected output is required | unchanged |
| feature-delivery | implement | yes (`artifact.ChangeSet.exists`) | unchanged |
| feature-delivery | review | yes (`artifact.ReviewReport.exists`) | unchanged |
| feature-delivery | qa | yes (`artifact.QAReport.exists`) | unchanged |
| feature-delivery | release_candidate | **no** | `artifact.ReleaseCandidate.exists && …` |
| bug-investigation | investigate, fix, review, verify | yes | unchanged |
| quick-change | implement, review | yes | unchanged |
| planner prompt | gate guidance | did not say | a gate on a task with outputs must include `artifact.<Type>.exists` for one of its own outputs |
| scripted workflow `p5.yaml` | release | **no** | demands `ReleaseCandidate` |
| scripted workflow `p2-chain.yaml` | review | **no** | demands `ReviewReport` |

`RELEASE_CRITERIA_GATE` keeps its name and now composes the artifact clause
with the ledger clause, like `SPEC_CRITERIA_GATE` and `QA_CRITERIA_GATE`.

## Offline checks (failing first)

Before the fix (`gate-facts-check`, `p5-done-when-check`): 7 failures, among
them "a release step with no ReleaseCandidate does not pass on QA facts alone
-> All gate conditions met." After: `GATE FACTS READ THE CURRENT STATE (70 checks)`,
`DONE-WHEN LEDGER TRACES (86 checks)`, and `npm run ci` green.

## Real app (`--skip-claude`, own link and CDP port per suite)

| Suite | Result |
|---|---|
| P1 | ALL PASS 14/14 |
| P2 | ALL PASS 11/11 |
| P5 | ALL PASS 5/5 |
| P6 | ALL PASS 6/6 |
| P7 | ALL PASS 5/5 |
| P8 | ALL PASS 5/5 |
| P9 | ALL PASS 4/4 |

No scripted setup relied on the hole: the scripted agent writes every
declared output, so the new clause holds wherever the release is expected to
pass. P0 s02+ already fail on `main` and were not run. Full reports:
`REPORT-p<N>.md` beside this file.
