# P10 evidence: the owner's desk

Headline: **3/3 real-app scenarios pass** (K1–K3, 45/45 checks) on a fresh install, built from `feat/p10-owners-desk` (8edafd4 plus the K2 section-parsing fix in the suite). Offline: `p10-desk-check` 66/66; `npm run ci` green (34 offline checks).

## How it was run

```bash
npm run build
node scratch/acceptance/p10/run-all.mjs --keep-going          # CDP 9345, home /tmp/tdm-p10, scripted agent
node scratch/acceptance/p0/run-all.mjs --skip-claude --keep-going
node scratch/acceptance/p0/run-all.mjs --p1 --skip-claude --keep-going
node scratch/acceptance/p0/run-all.mjs --p2 --skip-claude --keep-going
node scratch/acceptance/p5/run-all.mjs --skip-claude --keep-going   # and p6, p7, p8, p9
```

The scripted agent runs with `SCRIPTED_DELAY_MS=1500` on an `ndjson` profile (so `SCRIPTED_USAGE_MIN` is read). Missions use the "P10 desk" workflow (the P5 steps, with a release gate that also needs the ReleaseCandidate). Knobs in the goal: `SCRIPTED_QA_PARTIAL` (spec AC1–AC3, QA passes AC1 only), `SCRIPTED_SPEC_THREE_ACS` (spec AC1–AC3, QA passes all), `SCRIPTED_FAIL_RELEASE` (the release step writes nothing, so its gate fails every attempt), `SCRIPTED_USAGE_MIN=<n>` (K3 brings the month to 25.52 agent minutes).

Every decision is made in the window: the WIP limit (Backlog → 2), plan approvals, "Leave blocked" on B's release card, the monthly limit (Repositories → Limits), "Add to backlog", the desk cards, "Status report", the version switcher and "Compare with v1". API and SQL are read only as proof.

No real-model scenario: the desk and the report are read from rows; no model writes either.

## Scenarios

| # | Scenario | Result |
|---|---|---|
| K1 | WIP 2; B (3 of 3 verified, release left blocked → stalled), A (1 of 3 verified, release card) | PASS 18/18: "Needs you 1", "Working on 2 of 2", "Criteria verified 4 of 6", "Stalled 1"; Stalled card → `/inbox/stalled` with only B's row; Criteria card → missions in progress with "1 of 3 verified" / "3 of 3 verified" |
| K2 | Status report, twice | PASS 18/18: headings, "Criteria: 1 of 3 verified; AC2, AC3 not verified.", "Last gate failure (release): Not met: qa.criteria_unverified is 2, needs 0" (same words as the Inbox card); v2 opens with v1/v2, "v1 → v2: 0 lines added, 0 lines removed"; bodies byte-identical after the front matter, only `asOf` differs |
| K3 | Monthly limit 30, 25.5 used, one mission queued | PASS 9/9: banner "Monthly limit at 85% — only urgent and high work will be pulled. …", card "This month 85% · 25.5 / 30 agent min", WIP banner "Working on 2 of 2 — 1 queued mission waits for a free slot."; the report says "25.5 / 30 agent min (85%)" and lists the queued mission as held |

## Regression

| Suite | Result |
|---|---|
| p0 (--skip-claude) | A1 PASS; stops at s02, which fails on `main` already ("Add person" was removed in 0.4.0; see the P5–P9 handoffs) |
| p1 | ALL PASS 14/14 |
| p2 | ALL PASS 11/11 |
| p5 | ALL PASS 5/5 |
| p6 | ALL PASS 6/6 |
| p7 | ALL PASS 5/5 |
| p8 | ALL PASS 5/5 (H4 now reads the desk's month banner words) |
| p9 | ALL PASS 4/4 |

## Found and fixed while proving it

- A release that writes nothing passes a gate reading only QA facts: the suite uses a workflow whose release gate also needs the ReleaseCandidate (a product observation, not changed here).
- Titles with underscores (`SCRIPTED_FAIL_RELEASE`) rendered in italics in the report: the report escapes Markdown in text from rows and the reader's Markdown honours backslash escapes.
- The Active tab leaves blocked missions to "Needs attention", so the Working on / Criteria cards open a new `/missions/in-progress` view that matches the count.
- The stalled-only Inbox view showed the "Decided" history under it; it is now left out there.

## Parked

- Home's "Active missions" list still leaves out BLOCKED missions (pre-existing), so it can read "0 missions" next to "Working on 2 of 2".
