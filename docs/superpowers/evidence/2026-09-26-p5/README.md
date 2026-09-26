# P5 evidence: Done-when ledger

Headline: **5/5 real-app scenarios pass** (E1–E5, 46/46 checks) on a fresh install, built from `feat/p5-done-when-ledger`. Offline: `p5-done-when-check` 84/84; `npm run ci` green (27 offline checks).

## How it was run

```bash
npm run build
node scratch/acceptance/p5/run-all.mjs          # CDP 9340, home /tmp/tdm-p5, scripted agent
# regressions, beside it rather than on /tmp/tdm-p0:
ACCEPTANCE_LINK=/tmp/tdm-p5r CDP_PORT=9340 node scratch/acceptance/p0/run-all.mjs --only=s01 --skip-claude
ACCEPTANCE_LINK=/tmp/tdm-p5r CDP_PORT=9340 node scratch/acceptance/p0/run-all.mjs --p1 --skip-claude
ACCEPTANCE_LINK=/tmp/tdm-p5r CDP_PORT=9340 node scratch/acceptance/p0/run-all.mjs --p2 --skip-claude
```

The suite runs the workflow `P5 done when` (spec → qa → release), whose gates are the preset gates. The QA step leaves out `review.blocking_findings == 0` because the workflow has no review step. Every decision is a click in the window. SQL and the API are read only as proof.

## Scenarios

| # | Scenario | Result |
|---|---|---|
| E1 | Two Done-when lines → U1, U2; spec AC1 "Covers U1, U2", "0 of 1 verified"; after QA "1 of 1 verified"; the AC1 row opens the QA report | PASS 13/13 |
| E2 | `SCRIPTED_SPEC_MISSES_U2`: Inbox card "Not met: criteria.uncovered_user is 1, needs 0" and "Not covered by the spec: U2 (…)"; U2 "Not covered"; the retry prompt names U2 | PASS 10/10 |
| E3 | `SCRIPTED_QA_PARTIAL`: "1 of 3 verified"; release card "qa.criteria_unverified is 2, needs 0"; mission BLOCKED, not COMPLETE | PASS 8/8 |
| E4 | `SCRIPTED_QA_FAIL_AC2`: AC2 "Failed" with QA's evidence; QA card "qa.criteria_failed is 1, needs 0"; release never started | PASS 7/7 |
| E5 | Request changes on the spec: round 2 adds AC3 (Not verified); round 1's AC1/AC2 superseded (SQL); then "3 of 3 verified", COMPLETE | PASS 8/8 |

Full per-check detail is in `REPORT.md` and `E*.json`. The screenshots are `E*-*.png`.

## Offline check

`scratch/p5-done-when-check.mjs` was written before the implementation. Against the base branch it fails at once (`TypeError: D.userCriterionKey is not a function`). With the change it passes 84/84.

## Regressions (`--skip-claude`)

| Suite | Result |
|---|---|
| P0 A1 (`regression-p0/`) | 1/1 |
| P1 (`regression-p1/`) | 14/14 |
| P2 (`regression-p2/`) | 11/11 |

P0 s02–s08 were not run. They already fail on `main` because they use the "Add person" flow that 0.4.0 removed.

## Found and fixed while proving it

- **Card text.** A blocked task's feed card leads with its handoff headline, not the gate failure. The intervention card showed only "criteria.uncovered_user is 1". It now also carries a "Done when" evidence line that names the criteria: "Not covered by the spec: U2 (…)", "Failed in QA: AC2 (…)", "Not verified yet: AC2 (…), AC3 (…)".
- **P1 harness.** The P1 B13/B14 helper `needsSection` split the feed at the first "\nDone". The new "Done when" heading sits above "Needs you", so the split has to match the heading line exactly (`\nDone\n`).
- **rounds-check.** Its migration section asserted "9 → 10 applies only [10]". It now migrates up to 10 only.

## Parked

- A failed criterion fails the QA gate, and the task retries and then blocks. Turning a failed criterion into a fix round (remediation) is follow-up work.
- Spec rows of a *withdrawn* ProductSpec (a Redo that overtook a pass) stay live until the next spec lands.
