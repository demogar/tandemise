# P6 evidence: ready before planning

Headline: **7/7 real-app scenarios pass** (F1–F7, 49/49 checks) on a fresh install, built from `feat/p6-ready-before-planning`, F7 on the real Claude Code runtime. Offline: `p6-ready-check` 75/75; `npm run ci` green (28 offline checks).

## How it was run

```bash
npm run build
node scratch/acceptance/p6/run-all.mjs                    # CDP 9341, home /tmp/tdm-p6, scripted agent; F7 on Claude Code
node scratch/acceptance/p0/run-all.mjs --only=s01 --skip-claude
node scratch/acceptance/p0/run-all.mjs --p1 --skip-claude
node scratch/acceptance/p0/run-all.mjs --p2 --skip-claude --keep-going
node scratch/acceptance/p5/run-all.mjs
```

Missions are created from New mission with the goal only ("Create and refine"), on the default Feature delivery preset, so F3's plan goes through the planner prompt. Every decision (Refine, Accept, Reject, answering, Plan) is a click in the window. The API and SQL are read only as proof, except F2's deliberate bypass attempts and F7's runtime setup.

## Scenarios

| # | Scenario | Result |
|---|---|---|
| F1 | Goal only → "Create and refine" → DRAFT on "Get it ready"; Plan reads "Add at least one Done-when criterion to plan"; Refine → P1–P3 each with Accept/Reject/Edit, Q1 with why and options; Plan reads "Answer 1 question and decide 3 criteria to plan" | PASS 11/11 |
| F2 | Plan disabled; clicking it anyway does nothing; `POST /plan` → 412 "Not ready to plan: answer 1 question and decide 3 criteria first. (Not met: …)"; `planNow` without a line → 412 and no mission written; SQL DRAFT, no tasks | PASS 7/7 |
| F3 | Accept P1, P2 (→ U1, U2), reject P3, answer Q1 by option → Plan enabled → "Planning"; planner prompt has the answer and `- U1: …`, `- U2: …`, not the rejected statement | PASS 11/11 |
| F4 | Accept P1, Refine again → P2, P3 "Replaced by a newer proposal", new P4–P6, U1 kept, Q1 replaced by Q2 | PASS 6/6 |
| F5 | Autonomous mission → every proposal "Accepted automatically" (U1–U3); Plan still "Answer 1 question to plan" | PASS 5/5 |
| F6 | Inbox "Refinement: 4 to decide · 3 criteria to decide and 1 question to answer"; the row opens the mission; after deciding, the row is gone | PASS 4/4 |
| F7 | Real Claude Code refines "Make the README useful for someone new to this project": parsed within limits, on screen with Accept/Reject | PASS 5/5 |

Full per-check detail is in `REPORT.md` and `F*.json`; screenshots are `F*-*.png`.

### What the real product agent proposed (F7)

Recorded as notes in `F7.json`, for a person to judge the product-owner quality:

- P1 Someone who has never seen the repo can say, after reading only the README's opening paragraph, what the project is for and that it is not a real product.
- P2 The README lists every workflow in `.tandemise/workflows` by name, with one sentence each, and the list matches the folder.
- P3 Following the README's setup steps on a fresh clone, a newcomer runs `npm test` and `npm run build` successfully, and the README says both are placeholders.
- P4 The README states that the "hello page" the workflows refer to does not exist yet.
- Q1 Who is the newcomer the README is for? *Why:* if they will run the workflows, the README must explain how to start one; if they only need orientation, that section is dropped. *Options:* someone who will run the workflows / someone who only needs to understand the repo.

Each criterion is observable and checkable without reading code, and the one question changes the criteria.

## Offline check

`scratch/p6-ready-check.mjs` was written before the implementation. Against the base branch it fails at once (`TypeError: D.evaluateReadiness is not a function`). With the change it passes 75/75. It runs a real daemon in process with a generic-cli runtime running the scripted agent, and tests the API bypass over HTTP (`POST /v1/missions/:id/plan`, `planNow`).

## Regressions

| Suite | Result |
|---|---|
| P0 A1 (`regression-p0/`) | 1/1 |
| P1 (`regression-p1/`) | 14/14 |
| P2 (`regression-p2/`) | 11/11 |
| P5 (`regression-p5/`) | 5/5 |

P0 s02–s08 were not run: they already fail on `main` (the "Add person" flow was removed in 0.4.0).

## Found and fixed while proving it

- **Every planned mission now has a Done-when line**, so the acceptance helper `createMission` fills one ("The acceptance scenario finishes its steps"), and P2 C1's fake-runtime ProductSpec now `covers: [U1]`: a spec in a gateless task that leaves a user criterion uncovered fails, as P5 made it.
- **Offline checks that plan a draft** (handoff, staffing, e2e-daemon, application) now give it a Done-when line; the P5 check reads the ledger's first ten columns and schema ≥ 11.
- **A late refinement.** A pass that finishes after the mission left DRAFT records nothing and says so on the timeline.
- **F3 cancelled while planning** let the planner raise a plan approval on the cancelled mission (a pre-existing race, below); the scenario now cancels once planning has settled.

## Parked

- Pre-existing: cancelling a mission while it is PLANNING does not stop the planner, which then raises a plan approval on the cancelled mission.
- P2 C5/C6 failed two UI checks once (reader and timeline text) and passed on the rerun and in the full run recorded here.
