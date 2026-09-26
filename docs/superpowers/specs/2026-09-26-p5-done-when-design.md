# P5: Done-when ledger (criteria that trace)

Status: design, 2026-09-26. Builds on the gate language (ADR 0004), P1 (handoff contract, feed) and P2 (rounds). Stacked on the Slice 0 fix (`fix: unmeasured checks never pass a preset gate`), whose `testsClause()` and `PresetContext` it keeps.

## Problem

What a person says "done" means does not survive the trip to QA.

- `successCriteria` is a list of strings on the mission. It is pasted into prompts as bullets and never read again.
- A ProductSpec writes its own acceptance criteria (`AC1…`). Nothing checks that they cover what the person asked for.
- A QAReport lists `results[].criterion` as free text. Nothing checks that it names a real criterion, or that it covers every one.
- `qa.acceptance_criteria_coverage` divides by the results QA chose to report. A report that mentions one criterion out of five, and passes it, reads 100 %. The release gate `>= 100` then ships four criteria nobody looked at.
- The mission screen never shows the criteria at all.

## Goal

Every line the person writes under "Done when" becomes a numbered criterion (`U1…Un`). The spec must cover each one with its own criteria (`AC1…`, each saying which `U` ids it covers). QA must verify each spec criterion by id. The daemon traces the chain and measures it. "Shipped" provably means every criterion passed.

The person sees a "Done when" checklist at the top of the mission feed: each criterion, what covers it, and whether QA verified it.

## Not in P5

- Editing, proposing or refining criteria, and a readiness gate before planning → P6 (it adds a `status` column to the same table).
- Criteria per task, and coverage per repository.
- Treating a failed criterion as a blocking QA finding that starts a fix task. A failed criterion fails the QA gate; the task retries and then blocks, as any gate failure does today.

## 1. Concepts

### The ledger

One table, `mission_criteria`, holds every criterion of a mission.

- **User criteria** (`source = 'user'`) come from the mission's Done-when lines at creation, in order: `U1`, `U2`, … They never change in P5.
- **Spec criteria** (`source = 'spec'`) come from the newest ProductSpec's `acceptanceCriteria`, with the ids the spec gave them (`AC1`, …) and the `covers` list of U ids.
- A newer ProductSpec (a retry, a round, a re-check) **supersedes** the previous spec's rows: they get `superseded_at` and stop counting. Keys are unique among live rows only, so the new spec can reuse `AC1`.
- A mission created before migration 011, or with no Done-when lines and no spec, has an empty ledger. Its facts and QA behave exactly as before (legacy mode).

### Results are derived, never stored

A criterion's result is read from the newest QA evaluation at the moment it is asked for, as every other gate fact is:

- A spec criterion takes the result QA gave its id: `PASS`, `FAIL` or `SKIP`; no result is `UNVERIFIED`.
- A result only applies to a criterion that existed when QA reported. A spec rewritten after QA ran is unverified until QA runs again.
- A user criterion covered by spec criteria takes their combined result: every one PASS → PASS; any FAIL → FAIL; any SKIP → SKIP; otherwise UNVERIFIED. A result QA gave the U id directly wins.
- A user criterion no spec criterion covers is **not covered**.

### What counts towards "verified"

The criteria that count are every live spec criterion plus every user criterion nothing covers. Before a spec exists that is every user criterion. So a spec that drops `U2` does not make the mission look finished: `U2` still counts and is unverified until something covers it and QA passes it.

## 2. Contracts (artifact schemas)

- `ProductSpec.acceptanceCriteria[]` gains `covers: string[]` (default `[]`). The template shows `covers: [U1]`.
- `QAReport.results[]` gains `criterionId`. A result must carry `criterionId` or the legacy `criterion`; the legacy field is accepted when its text equals a ledger key. The template shows `criterionId: AC1`.

## 3. Harvest validation

Harvest is where an agent's claim meets the ledger.

| Artifact | Condition | What happens |
|---|---|---|
| ProductSpec | two criteria share an id, or an id is a user key (`U1`) | refused, not stored; the issue names the ids and goes to the retry prompt |
| ProductSpec | a user criterion is left uncovered | stored; ledger updated; issue "leaves U2 uncovered: '<statement>'. Add U2 to the covers list of the criterion that proves it" in the retry prompt; gate fails on `criteria.uncovered_user` |
| ProductSpec | `covers` names an id that is not a user criterion | stored; issue names it; gate fails on `criteria.unknown_covers` |
| QAReport | a result names no ledger id (ledger non-empty) | refused, not stored; the issue lists the unknown ids and every valid id |
| QAReport | empty ledger | accepted as before |

An issue on a stored artifact does not fail a gated task by itself: the gate decides, and the issue rides along in the retry feedback that names what to fix. A task with no gate fails on any issue, as today.

## 4. Facts

Added to `GATE_FACT_VOCABULARY` and built by `GateFactBuilder.withCriteria` from the ledger:

| Fact | Meaning |
|---|---|
| `criteria.total` | live criteria, user plus spec |
| `criteria.user_total` | Done-when lines |
| `criteria.uncovered_user` | user criteria no live spec criterion covers |
| `criteria.unknown_covers` | `covers` entries naming no user criterion |
| `qa.criteria_verified` | counted criteria whose result is PASS |
| `qa.criteria_failed` | counted criteria whose result is FAIL |
| `qa.criteria_unverified` | counted criteria that are neither (SKIP, no result, not covered) |

`qa.acceptance_criteria_coverage` is recomputed against the ledger (verified ÷ counted × 100) whenever the ledger is non-empty. That is the coverage bug fix. With an empty ledger it keeps its old meaning.

The qa facts are always measured when the ledger is non-empty, even before any QA ran: "nothing verified yet" is a measurement.

## 5. Preset gates

Feature delivery (the same clauses on bug-investigation's `investigate` and `verify`):

- `product_spec`: `artifact.ProductSpec.exists && criteria.uncovered_user == 0 && criteria.unknown_covers == 0 && criteria.total >= 1`
- `qa`: `artifact.QAReport.exists && review.blocking_findings == 0 && qa.criteria_failed == 0`
- `release_candidate`: `qa.criteria_unverified == 0 && qa.blocking_defects == 0`

`implement` and `fix` keep Slice 0's `testsClause(context)`.

## 6. Prompts

- The Mission section lists the ledger as `Done when (criteria ledger):` with one `- <key>: <statement>` line per live criterion (spec lines add `(covers U1, U2)`). With an empty ledger it stays "Success criteria".
- A task that writes a ProductSpec is told to cover every user id in `covers`, and which ids those are.
- A task that writes a QAReport is told to give one result per criterion with `criterionId`, and which ids count.

## 7. Data (migration 011)

```sql
CREATE TABLE mission_criteria (
  id, mission_id → missions ON DELETE CASCADE, key, statement,
  source CHECK IN ('user','spec'), covers JSON DEFAULT '[]',
  spec_artifact_id → artifacts ON DELETE SET NULL, position, superseded_at NULL, created_at);
CREATE UNIQUE INDEX … (mission_id, key) WHERE superseded_at IS NULL;
```

Additive. Nothing is backfilled: missions in flight keep the legacy behaviour their tasks' gates were written for.

## 8. API

`GET /v1/missions/:id/criteria` → an array, in ledger order (user first, then spec):

```ts
{ id, key, statement, source: 'user'|'spec', covers, coveredBy, result: 'PASS'|'FAIL'|'SKIP'|'UNVERIFIED',
  evidence, qaArtifactId, specArtifactId, counted, uncovered, createdAt }
```

A new projection topic `criteria` is invalidated whenever the ledger changes; artifact changes already refresh the mission's queries.

## 9. Desktop

- **New mission.** "Success criteria" moves out of "More options" and becomes **"Done when (one per line)"**, hint: "Each line becomes a numbered criterion (U1, U2, …). The spec must cover every one and QA must verify it before the mission can ship."
- **Feed.** A "Done when" section above "Needs you". Header meta "`N of M verified`". One row per criterion: the key, the statement, a line saying what traces it ("Covered by AC1", "Covers U1, U2", "Nothing in the spec covers this yet", QA's evidence), and a status badge:
  - **Verified** (succeeded tone), **Failed** (failed tone), **Not covered** (blocked tone), **Not verified** (pending tone).
  - A row QA reported on opens the QAReport; a spec row QA has not reached opens the ProductSpec.
- Hidden when the ledger is empty.

## Testing

**Offline:** `scratch/p5-done-when-check.mjs`, added to OFFLINE_CHECKS. Written first, seen failing. It covers: migration 011 and the partial unique index; seeding U rows on mission create; spec supersede; trace rules (derived, direct, not covered, stale QA); facts and the coverage fix (one PASS of five reads 20, not 100); preset gates; harvest refusals and issues; QA legacy `criterion`; the criteria view.

**Real app** (`scratch/acceptance/p5/`, CDP 9340, home `/tmp/tdm-p5`, scripted agent):

| # | Scenario | Must observe in the window |
|---|---|---|
| E1 | Two Done-when lines; spec → QA → release | "Done when" lists U1, U2; after the spec, AC1 "Covers U1, U2" and "0 of 1 verified"; after QA "1 of 1 verified" and every row Verified |
| E2 | `SCRIPTED_SPEC_MISSES_U2` | spec card "Not met: criteria.uncovered_user is 1, needs 0"; U2 "Not covered"; the retry prompt names U2 |
| E3 | `SCRIPTED_QA_PARTIAL` (3 ACs, 1 PASS) | "1 of 3 verified"; release card "qa.criteria_unverified is 2, needs 0"; mission not COMPLETE |
| E4 | `SCRIPTED_QA_FAIL_AC2` | AC2 "Failed"; QA card "qa.criteria_failed is 1, needs 0" |
| E5 | Request changes on the spec adds AC3 | old rows superseded (SQL), AC3 "Not verified", then "3 of 3 verified" after QA |

## Rulings

1. **Keys.** User keys are `U1…`; spec keys are whatever the spec wrote, and the template and scripted agent use `AC1…` (the existing template's form, not `AC-1`).
2. **Uniqueness among live rows.** `UNIQUE(mission_id, key)` is a partial unique index over live rows, because a superseding spec reuses `AC1`.
3. **`position` column.** Added so the ledger reads in the order the person and the spec wrote it; `created_at` ties inside one batch.
4. **Extra fact `criteria.unknown_covers`.** The roadmap asks that a spec referencing an unknown id fail the gate "with a named reason"; no listed fact measures that, so one is added and the spec gate reads it.
5. **What counts.** Live spec criteria plus uncovered user criteria (§1). The roadmap's E1 "0 of 1 verified" (two U lines, one AC) follows from it.
6. **Stale QA.** A result applies only to a criterion that existed when QA reported.
7. **QA with an unknown id is refused, not stored.** The harvester's rule for malformed artifacts: storing it would let `artifact.QAReport.exists` pass on a report that verifies nothing the ledger knows.
8. **No backfill.** Missions created before 011 keep legacy facts.
9. **Bug-investigation** gets the same spec and QA clauses: it writes a ProductSpec and a QAReport too.
10. **Scenario workflow.** The real-app suite runs a three-step workflow file (spec → qa → release) carrying exactly the preset gates, because the scripted agent does not produce planner output. The preset gates themselves are asserted offline.
11. **A failed criterion is not a blocking finding.** It fails the QA gate, so the task retries and blocks with an intervention card. Turning it into a fix round is follow-up work.
