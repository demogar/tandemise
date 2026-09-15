# P1 acceptance: proven in the real app

**Final build `434b889`: 15/15 P1 scenarios (48 checks) in one uninterrupted run, B11 on real Claude Code. P0 regression on the same build: see [P0-REGRESSION.md](P0-REGRESSION.md).** Full P1 log: [REPORT.md](REPORT.md).

## How it was run

Same harness as P0 ([2026-09-13-p0](../2026-09-13-p0/README.md)): fresh `TANDEMISE_HOME` and project, the daemon from this branch, Electron driven over CDP, the scripted agent in place of a model except for B11.

`node scratch/acceptance/p0/run-all.mjs --p1` runs the P1 suite; without `--p1` it runs P0. The scripted agent's `SCRIPTED_LONG`, `SCRIPTED_STUBBORN` and `SCRIPTED_NO_HANDOFF_ONCE` modes are switched on per mission through the goal text.

## Scenarios

| # | What a person does | Proven |
|---|---|---|
| B1 | Opens a solo mission | It opens on Feed. The plan waits under Needs you; done cards show headlines, never YAML or ids, with "by … · responsible You". |
| B2 | Decides on the card | Approve on the plan card and on the spec review card; spec moves to Done. |
| B3 / B3a | Opens "Full doc" | No front matter; handoff first; ids behind Details; "Appendix (N words)" starts collapsed. |
| B4 | Gets a too-long first draft | Exactly one tighten pass, no attempt spent, the kept version within budget, the timeline says so. |
| B5 | Gets a draft that stays long | Accepted and flagged "Over budget"; the mission keeps going. |
| B6 | Gets a draft with no handoff | The retry names `handoff.headline`; the second attempt succeeds. |
| B7 | Browses artifacts | One row per output; "Show older versions" reveals v1 under v2. |
| B8 | Writes their own docs step | The card's headline is their first sentence. |
| B9 | Sees a design with a preview | "Open preview ↗" on the card. |
| B10 | Works in a team | Ana's pending review is not under my Needs you; the card says "Waiting for Ana Ruiz". |
| B11 | Runs design on real Claude Code | A valid handoff (headline ≤ 90, ≤ 3 points), 385 words, within budget with no tighten pass; the card and reader read short. |
| B12 | Scans done cards | Every card ≤ 8 visible lines; headline + points ≤ 510 characters. |
| B13 | Rejects a plan | Mission Blocked; the plan card is under Needs you as "Rejected" with Re-plan, and no double period; Re-plan asks again; approving from the card runs the mission. |
| B14 | Has a "check later" review | "Check when you can" under Needs you; "Looks good" on the card; it leaves Needs you. |

## Found only by running the real app, and fixed

- Rejecting a plan left the mission stuck in AWAITING_PLAN_APPROVAL with nothing to answer (missing transition to BLOCKED).
- The plan card said "Approved" for rejected, auto-approved or cancelled plans.
- A repository reached through a symlink (macOS `/tmp` is one): Claude Code refused to read its own repository, then refused to write its artifacts under the linked path. Local targets now run at the resolved path, and linked roots are declared with `--add-dir`. After the fix, 0 permission refusals across all Claude runs.
- "…split the design work first.. Re-plan": a rejection note ending in a period gained a second one.
- Harness-only: missions open on Feed now; Inbox rows carry the output's headline; Done shows the latest five cards, so B1 expands the list.

## Parked

- On Feed, a Blocked mission's banner repeats the rejected plan card's reason.
- The mission banner still uses the blocking-only "waiting on you" rule.
- "Show N more" briefly shows the cap note while loading, and there is no "Show fewer".
- Feed attention treatment for FAILED tasks and BLOCKED tasks without an approval (P2).
