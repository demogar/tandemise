# Replan the rest: Implementation plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax.

**Goal:** A person can ask for a new plan for what is left of a mission.
Started steps are kept untouched, the planner sees what they found, and no
path through planning deletes a started step again.

**Spec:** [2026-10-09-replan-the-rest-design.md](../specs/2026-10-09-replan-the-rest-design.md)

**Architecture:**
- Pure split `splitForReplan(tasks, runs)` in `@tandemise/domain`: kept
  (started) and replaceable (unstarted) steps, and the live-run refusal.
- `PlanningService.replan(missionId, { note, fromApprovalId })`: refuses a
  busy mission, enters PLANNING with a "Planning the rest" reason, builds the
  planner prompt with an **Already done** section, validates the combined
  graph, materialises only new steps (renamed on collision), stores the plan,
  and always files a plan card with the kept/replaced/added counts.
- `#planWithin` routes to the replan path whenever started steps exist, so
  the old `POST /plan` can never `replaceAll` them away.
- Approval: approve writes kept + new and returns to EXECUTING; reject
  restores the unstarted steps it would have replaced.
- Plan-fit card: a fourth option `replan_rest`.
- Desktop: the option on the plan-fit decision, and **Plan the rest again**
  on the mission header.

## Global constraints

- `npm run ci` green; boundaries (renderer imports types only) and design
  tokens respected.
- No migration unless a column is unavoidable: replaced steps are restored
  from the plan card's evidence, not a new table.
- One concern per commit; Conventional Commits; comments say why.

## File map

| File | Responsibility | |
|---|---|---|
| `packages/domain/src/entities/replan.ts` | `splitForReplan`, `isStarted`, `replanRefusal` | create |
| `packages/domain/src/entities/mission.ts` | EXECUTING → PLANNING | modify |
| `packages/domain/src/entities/approval.ts` | `REPLAN_REST_OPTION`, plan-fit options | modify |
| `packages/application/src/planning/prompt.ts` | **Already done** section | modify |
| `packages/application/src/planning/materialize.ts` | materialise new steps beside kept ones | modify |
| `packages/application/src/services/planning-service.ts` | `replan`, route old re-plan through it | modify |
| `packages/application/src/services/approval-service.ts` | approve/reject a replan; `replan_rest` on plan fit | modify |
| `packages/application/src/engine/plan-fit.ts` | fourth option on the card | modify |
| `packages/api-contract/src/*` | `replanMissionRequest`, card option | modify |
| `apps/daemon/src/routes.ts` | `POST /v1/missions/:id/replan` | modify |
| `apps/desktop/src/renderer/src/components/Decision.tsx`, `screens/mission/MissionDetail.tsx`, `lib/daemon.ts` | option, header action, client call | modify |
| `scratch/acceptance/p0/scripted-agent.mjs` | `SCRIPTED_REPLAN` planner mode | modify |
| `scratch/replan-check.mjs` + `scripts/run-checks.mjs` | offline check | create / modify |
| `scratch/acceptance/replan/` | R1–R4 in the window | create |
| `docs/guides/replan.md`, `docs/KNOWN_LIMITATIONS.md`, `README.md` | user docs | create / modify |

## Tasks

### Task 1: Offline check first
- [ ] `scratch/replan-check.mjs` over the engine harness (as `plan-fit-check.mjs`):
  split rules (started by attempts, startedAt, run; SKIPPED before start is
  replaceable), refusal while a run is live, the old `POST /plan` path keeps a
  SUCCEEDED step with its run, artifact and evaluation ids, key collision
  renamed with dependencies following, combined-graph validation errors,
  reject restores the replaced steps.
- [ ] Register in `OFFLINE_CHECKS`. It fails until Tasks 2–5 land.

### Task 2: Domain
- [ ] `entities/replan.ts` with the pure split and refusal; export it.
- [ ] Allow EXECUTING → PLANNING in `TRANSITIONS`; the guard lives in the service.
- [ ] `REPLAN_REST_OPTION` beside the plan-fit options.

### Task 3: Planner prompt and materialise
- [ ] `PlannerPromptInput.alreadyDone` and the **Already done** section,
  with the reason (note or `stop` sentence).
- [ ] Kept outputs passed as `preexistingArtifacts` to `validateMissionPlan`.
- [ ] `materializeRest(kept, planned)`: rename collisions via `uniqueKey`,
  fresh ids, `orderHint` after the last kept step, READY when every
  dependency is finished.

### Task 4: PlanningService.replan
- [ ] Refuse a busy mission with the spec's reason.
- [ ] Enter PLANNING from EXECUTING/BLOCKED/PAUSED/FAILED with "Planning the
  rest: N steps done."
- [ ] `#planWithin` takes the replan path whenever a started step exists; an
  authored workflow is offered as reference instead of recompiled.
- [ ] Always file the plan card; evidence "Keeps N · replaces M · adds K";
  the replaced steps' snapshot goes in the card's evidence for a reject.
- [ ] Eval trials never replan.

### Task 5: Approval
- [ ] Approve: kept + new via `replaceAll`, back to EXECUTING.
- [ ] Reject: restore the replaced steps from the card, mission back to the
  status it had, plan-fit card untouched.
- [ ] Plan-fit `replan_rest`: decide the card, call `replan` with the note.

### Task 6: Daemon and contract
- [ ] `POST /v1/missions/:id/replan { note? }`; `POST /plan` unchanged in
  shape, now safe.

### Task 7: Desktop
- [ ] Plan-fit decision: **Plan the rest again** with an optional note.
- [ ] Mission header: **Plan the rest again** for BLOCKED/PAUSED/FAILED with
  started steps; **Re-plan** unchanged when nothing started.
- [ ] Plan card shows the kept/replaced/added line.

### Task 8: Scripted planner
- [ ] `SCRIPTED_REPLAN`: when the prompt has **Already done**, emit only new
  steps that depend on the kept keys.

### Task 9: Real-app acceptance
- [ ] `scratch/acceptance/replan/` R1–R4 with the scripted agent, fresh
  install, CDP, evidence under `docs/superpowers/evidence/2026-10-09-replan/`.
- [ ] R5 with Claude Code in the window; evidence in the PR.

### Task 10: Docs
- [ ] `docs/guides/replan.md`; README loop link; KNOWN_LIMITATIONS entry
  removed for "re-plan rather than corrected in place" where it now applies.
