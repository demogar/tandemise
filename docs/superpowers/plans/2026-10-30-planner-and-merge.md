# Planner and Risk-Based Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The factory decides per task how much process it gets (lane, steps, skills, models, approvals), opens the pull request itself, and when CI is green on the head commit either merges it or asks for review, from measured blast radius and the project's policy, never from what an agent says about its own work.

**Architecture:** Pure rules in `@tandemise/domain` (`planner/` for the profile, lanes, modules and routing; `merge/` for the policy and `decideMerge`; `brain/outcomes.ts` for the outcome fold), driven by three YAML files read through a new `FactoryConfigSourcePort`. The local-file implementation reads `.tandemise/factory/*.yaml` from the project's repository, then `$TANDEMISE_HOME/factory/`, then shipped defaults, so this works before the brain (#51) lands. A `PlannerService` becomes the first rung of `PlanningServiceImpl`'s ladder for missions whose workflow is `auto`. Every code plan ends in a daemon-owned `ship` step, run by a `ShipService` the scheduler drives like the `Waiter`: integrate, push, open a non-draft PR through a new `PullRequestPort` (`gh`), wait for CI, measure, decide, then merge with `--match-head-commit` or file a "Review and merge" card. Decisions, plan decisions and outcomes are stored by migration 026, and outcome events (`merge.decided`, `merge.reverted`, `task.outcome`) are recorded for the brain to ingest later.

**Tech Stack:** TypeScript, Node 22, better-sqlite3, zod, `yaml` (already an application dependency), `gh` CLI, React 18, Electron 44. No new third-party dependency: the glob matcher and the Wilson bound are small pure functions in the domain.

**Spec:** `docs/superpowers/specs/2026-10-30-planner-and-merge-design.md` (read it first; this plan argues from it).

## Global Constraints

- Layer rules hold (`npm run check:boundaries`):
  - every rule is pure and lives in `@tandemise/domain` (`planner/*`, `merge/*`, `brain/outcomes.ts`);
  - `@tandemise/application` depends on ports only (`FactoryConfigSourcePort`, `PullRequestPort`, the three repository ports), never on `gh`, `git` or the filesystem;
  - `@tandemise/integration-github` (layer 4) implements `PullRequestPort`; the daemon (`apps/daemon`) implements `FactoryConfigSourcePort` and composes both;
  - the renderer imports `@tandemise/*` as types only.
- **Migration number is 026, and only 026.** `assertOrdered` (`packages/persistence/src/migrations/index.ts`) refuses a gap, so the PR carrying it can't merge until 022 (#50 hold), 023 (#51 brain), 024 (#52 intake) and 025 (#54 relay) are on `main`. Build on top of them; never renumber. Every table this sub-project needs goes into 026 (in Task 3), not one migration per phase as the spec suggests, because the coordination ruling assigns one number.
- **Don't modify brain code** (#51 owns the brain repository's `factory/` layout and the ledger). This plan only emits events and writes local tables; Task 20 connects them to the brain after #51 merges.
- **Shared files get minimal, additive edits:** `packages/application/src/tokens.ts`, `packages/application/src/engine/task-executor.ts` (this plan doesn't touch it at all), `packages/application/src/services/planning-service.ts` (three insertion points, Task 5), `apps/desktop/src/renderer/src/screens/mission/TaskDetail.tsx` (one ship-card slot, Task 14). New behaviour goes in new files.
- **Compatibility:** the planner runs only for missions whose `workflowPreset` is `auto` (`FACTORY_WORKFLOW_ID`). The API's default stays `DEFAULT_PRESET_ID`, so every existing mission, offline check and preset path behaves as today. The desktop's New mission form and the Plan menu default to `auto`.
- Persist the transition before the side effect: `recorder.deferred(() => unitOfWork.transaction(...))`, then push, `gh`, merge and wake after the commit. A `merge_decisions` row is written before any merge call.
- Mission status changes only through `canTransition`. Task status reasons are sentences built in the domain or daemon.
- Unmeasured is `undefined`/`null`, never 0, and never satisfies a rule, a gate, a `requires` or a `never` clause.
- Eval trials (`isTrialMission`) are never factory-planned, never shipped, write no outcomes and are excluded from routing stats.
- UI copy says "you", uses plain verbs, never shows raw enums, model-tool names or YAML keys. Colours come only from `palette.css`/`theme.css`, no `var()` fallbacks, BEM classes, state in `data-*`.
- Refusals are `TandemiseError('CONFLICT' | 'PRECONDITION_FAILED', <sentence>)` and the UI shows the daemon's own words.
- Repo artifacts in English. PR titles are Conventional Commits with a lowercase subject. Run `npm run ci` before each PR.

## Review Focus

1. **Modules and tailoring only add.** A careful-lane plan the model tailored is put back through `applyModules`; no step, gate clause, approval or skill can disappear, and `gateImplies(before, after)` holds for every step. Pinned in Task 2 (property test) and Task 5.
2. **No self-report reaches the merge decision.** `MergeFacts` has no field sourced from an artifact body or PR text; a ChangeSet saying "no risk" changes nothing; unmeasured facts fail `requires` and `never`; `ci.state == PASS` is enforced by code even if `merge.yaml` omits it. Pinned in Task 12.
3. **A merge is bound to the decided head SHA.** Every merge call carries `--match-head-commit <sha>`; a push after the decision voids it and a new decision is made; the kill switch re-decides every waiting PR as ask. Pinned in Tasks 16 and 15.
4. **Ceremony is removed only for `auto` missions in the quick and standard lanes.** Readiness, the planner run and plan approval stay exactly as today for every other mission, so the existing offline checks pass unchanged. Pinned in Task 5.
5. **A crash between decide and merge.** The decision row exists before `gh pr merge`; on restart the ship step re-reads the PR and either records the merge it finds or decides again on the current head. It never merges twice or merges an undecided SHA. Pinned in Tasks 13 and 16.

---

## PR 1: Profile, lanes and "why" (spec phase 1)

### Task 1: The gate language gains predicates, sums, and the plan and ship facts

**Files:**
- Modify: `packages/domain/src/gate.ts`. Additive grammar:
  - `sum := primary (('+' | '-') primary)*`, and `cmp` compares sums;
  - `primary` gains `call := path '(' (literal (',' literal)*)? ')'`;
  - `evaluateGate(expression, facts, predicates?: GatePredicates)`. A call with no predicate of that name evaluates to `undefined` (not measured). `+`/`-` with a non-number operand is `undefined`.
  - `gateDependencies` returns a call as its name plus `()`, e.g. `item.keywords_any()`.
  - `render` (failure explanation) says `item.keywords_any("typo") is not measured` for a missing predicate.
- Modify: `packages/domain/src/gate-facts.ts`:
  - `FactScope` gains `'plan' | 'ship'`; `FactDefinition.type` gains `'string' | 'predicate'`;
  - add the facts listed under Interfaces to `GATE_FACT_VOCABULARY`;
  - `stepFacts()` stays step-only.
- Modify: `packages/domain/src/gate-lint.ts`:
  - `GateProblemCode` gains `'not_rule_scope'`;
  - `lintGate` refuses a call or a plan/ship fact in a step gate with `not_step_scope`;
  - new `lintRule(expression, scope)` for factory rules.
- Modify: `scripts/gate-facts-doc.mjs`. Add `plan: 'planning rule'` and `ship: 'merge rule'` to `SCOPE`, `'string'` and `'predicate'` to `TYPE`, and a third table "Facts for factory rules". Regenerate `docs/WORKFLOWS.md` with `node scripts/gate-facts-doc.mjs --write`.
- Test: `scratch/planner-check.mjs` (new), "gate language" section, added to `OFFLINE_CHECKS` in `scripts/run-checks.mjs`.

**Interfaces:**
- Produces:
  - `type GatePredicates = Readonly<Record<string, (args: readonly GateValue[]) => GateValue>>`
  - `evaluateGate(expression: GateExpression, facts: GateFacts, predicates?: GatePredicates): GateOutcome`
  - `lintRule(expression: string, scope: 'plan' | 'ship'): readonly GateProblem[]`
  - `SHIP_READS_STEP_FACTS = ['checks.tests', 'review.blocking_findings', 'review.major_findings', 'review.independent'] as const`: step facts a ship rule may also read, measured on the last code step.
  - Plan-scope facts:
    - strings: `item.type`, `item.prefix`, `profile.type`, `profile.size`, `profile.risk`, `profile.max_sensitivity`;
    - numbers: `item.criteria`, `profile.repos`;
    - predicates: `item.keywords_any()`, `item.labels_any()`, `item.source_any()`, `profile.areas_any()`.
  - Ship-scope facts:
    - numbers: `change.files`, `change.lines_added`, `change.lines_removed`, `change.repos`, `change.binary_files`, `change.deleted_files`, `change.tests_touched`, `coverage.changed_lines`, `criteria.unverified`, `process.steps_skipped`, `process.holds`, `process.changes_requested`, `process.escalations`, `process.gate_retries`, `process.person_commits`, `history.area_reverts_90d`;
    - booleans: `change.dependencies_changed`, `change.lockfile_only`, `ci.required_present`, `github.review_required`, `criteria.implicit`, `process.lightened_by_person`, `history.area_recent_revert`;
    - strings/outcomes: `change.max_sensitivity`, `ci.state`, `process.lane`;
    - predicates: `change.areas_any()`, `change.paths_matching()`.

- [ ] **Step 1:** Write the "gate language" section of `scratch/planner-check.mjs`, in the shape of `scratch/replan-check.mjs` (`check()`, `section()`, imports from `dist`). Assertions:
  - `D.evaluateGate('change.lines_added + change.lines_removed > 400', { 'change.lines_added': 300, 'change.lines_removed': 101 }).passed === true`; with `100` it is `false`; with `change.lines_removed` missing it is `false`.
  - `D.evaluateGate('item.keywords_any("typo", "rename")', {}, { 'item.keywords_any': (a) => a.includes('typo') }).passed === true`.
  - The same expression with no predicates is `passed:false`, and `detail` contains `is not measured`.
  - `D.gateDependencies('profile.areas_any("auth") && profile.risk == "high"')` deep-equals `['profile.areas_any()', 'profile.risk']`.
  - `D.lintGate('profile.risk == "high"', { stepKey: 'implement', outputs: [], independentOf: false })[0].code === 'not_step_scope'`.
  - `D.lintRule('item.keywords_any("typo")', 'plan')` is `[]`; `D.lintRule('change.files > 3', 'plan')[0].code === 'not_rule_scope'`; `D.lintRule('ci.state == PASS && checks.tests != FAIL', 'ship')` is `[]`; `D.lintRule('checks.tests == PASS', 'plan')[0].code === 'not_rule_scope'`.
  - `D.factDefinition('change.files').scope === 'ship'` and `D.factDefinition('item.prefix').scope === 'plan'`.
  - Every existing preset gate (`SPEC_CRITERIA_GATE`, `QA_CRITERIA_GATE`, `RELEASE_CRITERIA_GATE` from `@tandemise/application`) still has `D.lintGate(...)` equal to `[]` for its own step.
- [ ] **Step 2:** `npm run build && node scratch/planner-check.mjs`. Expected: FAIL (`lintRule` is not a function).
- [ ] **Step 3:** Implement the grammar, the vocabulary entries (each with a one-line `description`, an `example` and `measuredIn: 'planner'` or `'ship step'`), the lint rules and the doc script; regenerate `docs/WORKFLOWS.md`.
- [ ] **Step 4:** Rerun. Expected: the section passes. Also run `node scripts/run-checks.mjs gate-facts-check workflow-check p15-setup-check planner-steps-check` and expect all to pass.
- [ ] **Step 5:** Commit: `feat: predicates, sums and factory facts in the gate language`.

### Task 2: Domain, the task profile, lanes and modules

**Files:**
- Create: `packages/domain/src/planner/glob.ts`: `matchGlob(pattern, path)` with `**`, `*`, `?` and `{a,b}`; paths are `/`-separated and relative.
- Create: `packages/domain/src/planner/config.ts`: zod schema of `planner.yaml` and `parsePlannerConfig`.
- Create: `packages/domain/src/planner/profile.ts`: `profileTask`, `tiebreakReason`, `matchAreas`.
- Create: `packages/domain/src/planner/lanes.ts`: `chooseLane`, `laneWorkflowId`, `stepClassFor`.
- Create: `packages/domain/src/planner/modules.ts`: `applyModules`, `gateImplies`.
- Create: `packages/domain/src/planner/index.ts` and export it from `packages/domain/src/index.ts`.
- Modify: `packages/domain/src/workflow.ts`:
  - `workflowStep.executor` gains `'ship'`; `workflowStep` gains `class: z.enum(STEP_CLASSES).optional()`;
  - `compileWorkflow`: a `ship` step needs no role, gets `roleId: SHIP_ROLE_ID` (`'ship'`), isolation `none`, `maxAttempts: 1`; it refuses a second ship step with `"A workflow has at most one ship step; '<key>' is the second."`;
  - `toPlannedTask` sets `stepClass` from `class` when given.
- Modify: `packages/domain/src/entities/task.ts`. `TASK_EXECUTORS` gains `'ship'`; `MissionTask` gains `readonly stepClass?: StepClass | null`.
- Modify: `packages/domain/src/plan.ts`. `PlannedTask` gains `readonly stepClass?: StepClass`.
- Modify: `packages/domain/src/entities/criteria.ts`. `CRITERION_SOURCES` gains `'implicit'`; add `IMPLICIT_CRITERION_KEY = 'I1'` and `IMPLICIT_CRITERION = 'The task as written in the tracker is done.'`.
- Modify: `packages/domain/src/entities/models.ts`. `ModelPolicy` gains `readonly reason?: string`; `normalizeModelPolicy` keeps it; `resolveModel` R4 returns `reason ?? 'step override'`.
- Modify: `packages/domain/src/entities/mission.ts`. `Mission` gains `readonly laneRequest?: 'quick' | 'careful' | null`; export `FACTORY_WORKFLOW_ID = 'auto'`.
- Modify: `packages/application/src/planning/parse.ts`, `services/mission-service.ts`, `services/feedback-service.ts`: where they test `executor === 'wait'` to mean "not an agent", also accept `'ship'` (use the new `isAgentExecutor`).
- Test: `scratch/planner-check.mjs`, sections "profiles", "lanes", "modules only add".

**Interfaces:**
- Produces:
  - `TASK_TYPES = ['fix','feature','refactor','chore','docs','deps','test','security','unknown']`, `TASK_SIZES = ['xs','s','m','l']`, `RISK_LEVELS = ['low','medium','high']`, `SENSITIVITIES = ['none','sensitive','critical']`, `LANES = ['quick','standard','careful']`, `STEP_CLASSES = ['implement','review','verify','spec','design','architecture','investigate','resolve_conflicts','ship']`.
  - `TaskProfile` and `ProfileSignal` exactly as the spec's §2 block.
  - `ProfileInput`:
    ```ts
    { item: { title: string; description: string; trackerType: string | null; labels: readonly string[];
              sources: readonly string[]; criteria: number };
      paths: readonly string[]; repos: readonly string[]; projectRepos: number;
      history: { medianSize: TaskSize; revertRate: number; holdRate: number; n: number } | null;
      person: 'auto' | 'quick' | 'careful';
      tiebreak: { type: TaskType; size: TaskSize; areas: readonly string[]; why: string } | null;
      basis: 'predicted' | 'measured' }
    ```
  - `profileTask(input: ProfileInput, config: PlannerConfig): TaskProfile`. Order: Conventional-Commit title prefix (`fix`→fix, `feat`→feature, `docs`→docs, `chore`→chore, `refactor`→refactor, `test`→test, `build`→deps) → tracker type map → label map → source kinds → `profile.rules` (first match per field) → areas from paths → criteria count (`≤1 → s`, `2–4 → m`, `≥5 → l`, unless a rule set it) → repos (`>1 → at least m`) → history (`revertRate ≥ 0.2` or `holdRate ≥ 0.4` raises risk one level) → tiebreak (fills only `unknown`/unset fields and adds areas) → **sensitivity floor last** (any `critical` → `high`; any `sensitive` → at least `medium`). Base risk is `low`. Each contribution is one `ProfileSignal`, e.g. `{ name: 'tracker type', value: 'Bug', effect: 'type fix' }` and `{ name: 'sensitivity floor', value: 'payments: critical', effect: 'risk high' }`.
  - `CONSERVATIVE_PROFILE = { type: 'unknown', size: 'm', risk: 'medium' }`, used for fields the tiebreak couldn't fill when it failed.
  - `tiebreakReason(input, profile): 'type_unknown' | 'rules_disagree' | 'no_paths_many_repos' | null`.
  - `PlannerConfig` (parsed `planner.yaml`): `{ version: 1; areas: Area[]; trackerTypes: Record<string, TaskType>; labels: Record<string, TaskType>; profile: { rules: ProfileRule[] }; lanes: LaneRule[]; laneWorkflows: Record<Lane, string>; byType: Partial<Record<TaskType, Partial<Record<Lane, string>>>>; modules: PlannerModule[]; holdApproval: { minTasks: number; rate: number }; tiebreak: 'on' | 'off' }`. `trackerTypes` and `labels` stand in for #52's `tracker.yaml` until it exists.
  - `parsePlannerConfig(raw: unknown): { config: PlannerConfig; problems: readonly { path: string; message: string }[] }`. A rule whose `when` fails `lintRule(…, 'plan')` is dropped and reported; the rest still load. An unreadable file yields the shipped default plus one problem.
  - `chooseLane(profile, config, person): { lane: Lane; because: string }`. A person's `quick`/`careful` wins (`because: 'you chose it'`); otherwise the first matching `lanes` rule (`because: <its when>`).
  - `laneWorkflowId(lane, type, config): string`: `byType[type][lane] ?? laneWorkflows[lane]`.
  - `stepClassFor(task: Pick<PlannedTask, 'stepClass' | 'roleId' | 'executor'>): StepClass`: explicit class, else `development → implement`, `review → review`, `qa → verify`, `product → spec`, `design → design`, `architecture → architecture`, `ship` executor → `ship`, anything else → `implement`.
  - `applyModules(plan: MissionPlan, modules: readonly PlannerModule[], facts: GateFacts, predicates: GatePredicates): { plan: MissionPlan; applied: readonly string[]; dropped: readonly { name: string; why: string }[] }`. Insert `after: X` → the new step depends on `X`, and every step that depended on `X` also depends on the new step. A gate clause becomes `(<gate>) && <clause>`, or `<clause>` when the gate was null.
  - `gateImplies(before: string | null, after: string | null): boolean`: true when `before` is null, `after === before`, or `after` starts with `(<before>) && `.
  - `isAgentExecutor(e: TaskExecutor): boolean`.

- [ ] **Step 1:** Write the sections. The "profiles" table, against the shipped default config from Task 4 (until then, an inline copy of the spec's §3 YAML as an object):

  | Input | type | size | risk | lane |
  |---|---|---|---|---|
  | title `docs: fix the install steps`, 0 criteria | `docs` | `xs` | `low` | `quick` |
  | tracker type `Bug`, title `Fix typo in settings title` | `fix` | `xs` | `low` | `quick` |
  | tracker type `Feature`, path `apps/web/src/billing/page.tsx`, 3 criteria | `feature` | `m` | `high` | `careful` |
  | label `dependencies`, path `package-lock.json` | `deps` | `s` | `medium` | `standard` |
  | title `Migrate users table`, 2 criteria | `unknown` | `m` | `high` | `careful` |
  | row 3 with `person: 'quick'` | `feature` | `m` | `high` | `quick` |
  | row 2 with a tiebreak answering `{ type:'fix', size:'xs', areas:['payments'] }` | `fix` | `xs` | `high` | `careful` |
  | row 2 naming repos `web` and `api` | `fix` | `m` | `low` | `standard` |

  Also:
  - Row 6 carries a signal with `name === 'sensitivity floor'`.
  - `tiebreakReason` is `'type_unknown'` for row 5, `null` for row 2, and `'no_paths_many_repos'` for a row with no paths, 2 project repos and tracker type `Bug`.
  - `laneWorkflowId('standard', 'fix', cfg) === 'fix'`, `laneWorkflowId('careful', 'fix', cfg) === 'fix-careful'`, `laneWorkflowId('quick', 'docs', cfg) === 'quick'`.
  - `parsePlannerConfig` with one rule `when: 'item.keywords_any("x"'` reports a problem at `profile.rules.0.when` and still applies the other rules.
  - `D.matchGlob('**/migrations/**', 'db/migrations/0042_add_index.sql') === true`, `D.matchGlob('**/*.tf', 'infra/main.tf') === true`, `D.matchGlob('docs/**', 'src/docs.ts') === false`.
  - "Modules only add": 200 random plans from a seeded PRNG (`mulberry32(53)`), 1–6 tasks each, with random module subsets drawn from the default modules plus generated ones. For every original task key:
    - it is still present;
    - `gateImplies(before, after)` holds;
    - `approvalPolicy.beforeStart` and `onCompletion` never go from `true` to `false`;
    - `skillRefs` is a superset;
    - `retryPolicy.maxAttempts` never decreases.
  - The `security-review` module on a plan `implement → ship` yields `implement → security_review → ship`.
  - A workflow with two `executor: ship` steps fails to compile with the exact sentence above.
  - `resolveModel({ step: { model: 'sonnet', reason: 'routed: sonnet passed 23 of 25' }, … attempt: 1 }).reason === 'routed: sonnet passed 23 of 25'`.
- [ ] **Step 2:** Run it and expect FAIL.
- [ ] **Step 3:** Implement the files listed.
- [ ] **Step 4:** Rerun and expect PASS. Run `node scripts/run-checks.mjs p12-models-check p5-done-when-check workflow-check` to show models, criteria and workflows are unchanged.
- [ ] **Step 5:** Commit: `feat: task profiles, lanes and additive modules in the domain`.

### Task 3: Persistence, migration 026 and three repositories

**Files:**
- Create: `packages/persistence/src/migrations/026_planner_and_merge.ts`.
- Modify: `packages/persistence/src/migrations/index.ts`.
- Create: `packages/persistence/src/repositories/plan-decision-repository.ts`, `merge-decision-repository.ts`, `outcome-repository.ts`, following `plan-proposal-repository.ts`.
- Modify: `packages/persistence/src/repositories/task-repository.ts` (`step_class`) and `mission-repository.ts` (`lane_request`).
- Modify: `packages/persistence/src/tokens.ts` and the persistence module, adding `PLAN_DECISION_REPOSITORY`, `MERGE_DECISION_REPOSITORY`, `OUTCOME_REPOSITORY`.
- Modify: `packages/domain/src/ports/repositories.ts`, adding the three ports.
- Modify: `packages/application/src/tokens.ts`. Add the three tokens with the same export names, so `aliasPorts` binds them by name.
- Create: `packages/domain/src/planner/decision.ts` (`PlanDecision`), `packages/domain/src/merge/types.ts` (`MergeDecisionRecord`), `packages/domain/src/brain/outcomes.ts` (the `OutcomeEvent` type only; the fold comes in Task 9).
- Test: `scratch/planner-check.mjs`, "persistence" section.

**Interfaces:**
- Migration 026 (`name: 'planner_and_merge'`):
  - `ALTER TABLE missions ADD COLUMN lane_request TEXT CHECK (lane_request IN ('quick','careful'))`.
  - `ALTER TABLE mission_tasks ADD COLUMN step_class TEXT`. `executor` has no CHECK (migration 003), so `ship` needs no schema edit; the check proves it.
  - Widen `mission_criteria.source` in place on `sqlite_master` exactly like `006_task_park_statuses.ts` (unsafe mode, `writable_schema`, post-condition assert): replace `` `source IN ('user','spec')` `` with `` `source IN ('user','spec','implicit')` ``.
  - `plan_decisions (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE, policy_ref TEXT NOT NULL, basis TEXT NOT NULL CHECK (basis IN ('predicted','measured')), profile TEXT NOT NULL, lane TEXT NOT NULL CHECK (lane IN ('quick','standard','careful')), lane_because TEXT NOT NULL, workflow_id TEXT NOT NULL, modules TEXT NOT NULL, dropped TEXT NOT NULL, steps TEXT NOT NULL, approvals TEXT NOT NULL, skipped TEXT NOT NULL, tiebreak TEXT, created_at TEXT NOT NULL)`, index on `(mission_id, created_at)`.
  - `merge_decisions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE, repo TEXT NOT NULL, pr_number INTEGER NOT NULL, head_sha TEXT NOT NULL, policy_ref TEXT NOT NULL, verdict TEXT NOT NULL CHECK (verdict IN ('merge','ask')), score INTEGER NOT NULL, allowed INTEGER, factors TEXT NOT NULL, facts TEXT NOT NULL, decided_at TEXT NOT NULL, voided_at TEXT, comment_id INTEGER, merged_at TEXT, merged_by TEXT, merge_sha TEXT)`, indexes on `(workspace_id, decided_at)` and `(mission_id, repo)`.
  - `outcomes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT, at TEXT NOT NULL, body TEXT NOT NULL)`, index on `(workspace_id, at)`. No foreign key: stats outlive deleted missions.
- Ports (synchronous, like the others):
  - `PlanDecisionRepositoryPort { create(d: PlanDecision): void; latest(missionId): PlanDecision | undefined; listByMission(missionId): readonly PlanDecision[] }`
  - `MergeDecisionRepositoryPort { create(d: MergeDecisionRecord): void; get(id): MergeDecisionRecord | undefined; latestFor(missionId, repo): MergeDecisionRecord | undefined; listByMission(missionId): readonly MergeDecisionRecord[]; listByWorkspace(workspaceId, sinceIso: string): readonly MergeDecisionRecord[]; update(id, patch: Pick<Partial<MergeDecisionRecord>, 'voidedAt' | 'commentId' | 'mergedAt' | 'mergedBy' | 'mergeSha'>): void }`. Only those five fields are ever updated: the row is otherwise append-only.
  - `OutcomeRepositoryPort { append(o: OutcomeEvent & { workspaceId: WorkspaceId }): void; listByWorkspace(workspaceId, sinceIso: string): readonly OutcomeEvent[] }`
- `OutcomeEvent` is the spec's §9.1 `outcome` op, verbatim, with `id: OutcomeId` (branded, prefix `out`).
- `PlanDecisionId` (`pld`) and `MergeDecisionId` (`mrg`): branded ids added in `@tandemise/shared` next to the others.

- [ ] **Step 0:** Confirm migrations 022–025 are on `main` and rebase onto it. If one isn't, base this branch on the newest of the #50/#51/#52/#54 branches that carries it, and don't merge the PR until `main` has all four.
- [ ] **Step 1:** Write the "persistence" section. It opens a fresh DB through `persistenceModule({ path })` and asserts:
  1. `schemaVersion === 26`.
  2. `missions.lane_request = 'quick'` writes; `'fast'` throws `SQLITE_CONSTRAINT_CHECK`.
  3. A criterion with source `implicit` writes, and `sqlite_master` for `mission_criteria` contains `'implicit'`.
  4. A task with `executor: 'ship'` and `stepClass: 'ship'` round-trips through `TaskRepository`.
  5. `planDecisions.create` then `latest(missionId)` deep-equals the input.
  6. `mergeDecisions.update(id, { mergeSha: 'abc' })` keeps every other field; `listByWorkspace(ws, '1970-01-01')` is ordered by `decidedAt` ascending.
  7. Three `outcomes.append` calls come back in `at` order, and still come back after the mission is deleted.
- [ ] **Step 2:** Run it and expect FAIL.
- [ ] **Step 3:** Implement the migration (its `up` holds the DDL; its `transform` does the criteria CHECK edit), the repositories, ports and tokens.
- [ ] **Step 4:** Run it and expect PASS. Then `node scripts/run-checks.mjs persistence-check schema-constraint-check p5-done-when-check`.
- [ ] **Step 5:** Commit: `feat: store plan decisions, merge decisions and outcomes`.

### Task 4: The factory config source, shipped defaults and lane workflows

**Files:**
- Modify: `packages/application/src/ports.ts`. Add `FactoryConfigSourcePort` and its types.
- Modify: `packages/application/src/tokens.ts`. Add `FACTORY_CONFIG_SOURCE`.
- Create: `packages/application/src/planning/defaults/planner.ts`, `routing.ts`, `merge.ts`: the shipped defaults as plain objects (`SHIPPED_PLANNER`, `SHIPPED_ROUTING`, `SHIPPED_MERGE`).
  - `SHIPPED_PLANNER` is the spec's §3 file minus the project-specific `desktop-ui` area and the `ui-look` module, plus `trackerTypes: { Bug: fix, Feature: feature, Task: chore, Chore: chore, Docs: docs, Security: security }` and `labels: { bug: fix, enhancement: feature, dependencies: deps, documentation: docs, security: security }`.
  - `SHIPPED_ROUTING` is `{ version: 1, target: 0.8, minSamples: 8, probeEvery: 10, classes: {} }`.
  - `SHIPPED_MERGE` is the spec's §8.3 file verbatim plus `revertAutoMerge: 'on'`.
- Create: `packages/application/src/planning/defaults/lanes.ts`. The lane workflows as `WorkflowDefinition` objects, with ids `quick`, `standard`, `careful`, `fix` and `fix-careful`, reusing `testsClause`, `SPEC_CRITERIA_GATE` and `QA_CRITERIA_GATE` from `presets.ts`:
  - `quick`: `implement` (class implement, role development, gate `artifact.ChangeSet.exists && ${testsClause(ctx)}`) → `ship`. The gates are built in code, so the module exports `laneWorkflows(ctx: PresetContext): Readonly<Record<string, WorkflowDefinition>>` rather than constants;
  - `standard`: `implement` → `review` (role review, `independentOf: implement`) → `verify` (role qa, only when the mission has user criteria: the planner drops it otherwise) → `ship`;
  - `careful`: `spec` → `architecture` → `implement` → `review` → `verify` → `ship`;
  - `fix`: `standard` with the objective "Fix the root cause and add a regression test that fails before the fix.";
  - `fix-careful`: `investigate` → `fix` → `review` → `verify` → `ship`.
  
  A project file in `.tandemise/workflows/<id>.yaml` (the existing `WorkflowSourcePort`) overrides a shipped lane of the same id.
- Create: `apps/daemon/src/factory-config-source.ts`: `FileFactoryConfigSource`.
- Modify: `packages/application/src/module.ts`. Bind a default source that always returns the shipped objects, as `WORKFLOW_SOURCE` has one that finds nothing.
- Modify: `apps/daemon/src/bootstrap.ts`. `container.rebind(FACTORY_CONFIG_SOURCE, …)` beside `WORKFLOW_SOURCE`, with `join(config.home, 'factory')` as the home folder.
- Test: `scratch/planner-check.mjs`, "factory source" section.

**Interfaces:**
- Produces:
  ```ts
  export const FACTORY_FILES = ['planner', 'routing', 'merge'] as const;
  export type FactoryFileName = (typeof FACTORY_FILES)[number];
  export interface LoadedFactoryFile {
    readonly name: FactoryFileName;
    readonly origin: 'project' | 'home' | 'shipped';
    readonly path: string | null;     // null for shipped
    readonly raw: unknown;            // parsed YAML, or the shipped object
    readonly error: string | null;    // a YAML parse error; raw is then null
    readonly ref: string;             // 'shipped', or 'sha256:<first 12 hex>' of the text
  }
  export interface FactoryConfigSourcePort {
    read(name: FactoryFileName, repositoryPaths: readonly string[]): Promise<LoadedFactoryFile>;
    /** A person's edit (Task 15) or "Write the defaults": writes <repo>/.tandemise/factory/<name>.yaml. */
    write(name: FactoryFileName, repositoryPath: string, raw: unknown): Promise<{ readonly path: string; readonly ref: string }>;
  }
  ```
- Precedence: each repository in order (the workspace's default repository first), `<repo>/.tandemise/factory/<name>.yaml` then `.yml`; then `<TANDEMISE_HOME>/factory/<name>.yaml`; then shipped.
- The P15 setup folder only reads the patterns in `apps/daemon/src/setup-folder.ts` `READ`, so `.tandemise/factory/` never shows up in a setup import. That's intended: these files belong to the brain (Task 20), not to setup as code.
- `FactoryConfig = { planner: PlannerConfig; routing: RoutingConfig; merge: MergePolicy | { error: string }; problems: readonly { file: FactoryFileName; path: string; message: string }[]; refs: Record<FactoryFileName, string> }`, assembled by `loadFactoryConfig(source, repositoryPaths)` in `packages/application/src/planning/factory-config.ts`. A malformed `merge.yaml` keeps its error; it never falls back to a policy that could merge.

- [ ] **Step 1:** Write the "factory source" section. It uses `apps/daemon/dist/factory-config-source.js` over a temp repository and a temp home:
  - With nothing on disk: `origin === 'shipped'`, `ref === 'shipped'`.
  - With `<home>/factory/planner.yaml`: `origin === 'home'`.
  - With both a home file and `<repo>/.tandemise/factory/planner.yaml`: `origin === 'project'`, and `ref` matches `/^sha256:[0-9a-f]{12}$/`.
  - A `merge.yaml` that is not YAML: `error` is set, and `loadFactoryConfig(...).merge` is `{ error }`, not the shipped policy.
  - `write('merge', repo, { version: 1, autoMerge: 'off' })` creates `<repo>/.tandemise/factory/merge.yaml`, and a following `read` returns it.
  - Every shipped lane compiles with `D.compileWorkflow(...)` with `isolationForRole` from the built-in roles, and passes `D.validateMissionPlan` against the built-in role ids.
  - `SHIPPED_PLANNER` parses with `parsePlannerConfig` with zero problems.
- [ ] **Step 2:** Run it and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it and expect PASS. Run `npm run check:boundaries`.
- [ ] **Step 5:** Commit: `feat: a factory config source with shipped defaults and lane workflows`.

### Task 5: PlannerService, the first rung of the planning ladder

**Files:**
- Create: `packages/application/src/planning/planner-service.ts`: `PlannerService`.
- Create: `packages/application/src/planning/signals.ts`: `gatherSignals(mission, deps)`. It builds `ProfileInput` from:
  - the mission's title and goal;
  - criteria from `MissionCriteriaRepositoryPort.listActive`;
  - the P14 issue's labels and title prefix when `issueLinkId` is set;
  - file paths found in the goal text (`/(?:^|\s|`)([\w.-]+\/[\w./-]+\.\w+)/g`);
  - `laneRequest`;
  - the project's repositories.
  
  #52's tracker item plugs in here when it lands.
- Create: `packages/application/src/planning/tiebreak.ts`: `runTiebreak(input, runtime)`, which asks the planner role's `economyModel` (P12) through `RuntimeManager` with a fixed prompt and validates the reply with zod. Timeout `TIEBREAK_TIMEOUT_MS = 30_000`.
- Modify: `packages/application/src/services/planning-service.ts`, at four insertion points only:
  1. **`#enterPlanning`:** the readiness line becomes "assert ready unless `deps.planner?.skipsReadiness(mission)` is true".
  2. **`#planWithin`:** right after the replan branch, `if (mission.workflowPreset === FACTORY_WORKFLOW_ID && deps.planner !== undefined)` → `const outcome = await deps.planner.plan(planning, ctx)`. When it returns a plan, materialize it as the authored branch does, with `source: 'factory'`.
  3. **`#requestApprovalOrAccept`:** a `factory` outcome takes the lane's approval rule (`careful` → ask; otherwise accept and start).
  4. **`#storePlanDocument`:** an optional `front: { lane; profile }` argument passed through to `renderPlanDocument`.
  
  `PlanOutcome.source` gains `'factory'`, and `PlanOutcome` gains `lane?: Lane`. `PlanningDeps` gains `planner?: PlannerService` and `wake?: () => void`.
- Modify: `packages/application/src/module.ts` and `services.ts`. Construct `PlannerService` and pass it to planning.
- Modify: `packages/application/src/planning/materialize.ts` `renderPlanDocument(plan, missionTitle, handoff, front?)`. Add `lane` and `profile` (`"fix · tiny · low risk"`) front-matter lines when `front` is given, so a plan read on its own says how it was chosen.
- Test: `scratch/planner-check.mjs`, sections "ceremony", "speed", "tiebreak". Use an `engineHarness` copied from `replan-check.mjs`, with `FACTORY_CONFIG_SOURCE` bound to an in-memory source and the generic fake runtime.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  ```ts
  class PlannerService {
    skipsReadiness(mission: Mission): boolean;       // rules-only predicted lane is quick or standard, and the mission is `auto`, not a trial
    plan(mission: Mission, ctx: { roles; repositories; workspace; scope }): Promise<FactoryPlan | null>; // null → today's ladder
    predict(mission: Mission): Promise<{ profile: TaskProfile; lane: Lane; because: string }>;
  }
  interface FactoryPlan { plan: MissionPlan; lane: Lane; decision: PlanDecision; implicitCriterion: boolean }
  ```
- Constants: `QUICK_PLAN_BUDGET_MS = 200`, `TIEBREAK_TIMEOUT_MS = 30_000`.
- The plan sequence is spec §5 steps 1–9:
  - **Routing:** until Task 10 lands, it writes no model, so each step uses its role's.
  - **Validation:** an invalid result drops modules one at a time (last applied first), then falls back to the bare lane workflow, then returns `null`, so today's ladder runs. Each drop is recorded in `decision.dropped` with its validator issue.
  - **Careful lane:** hand the compiled plan to `#producePlan` as its preset (a `WorkflowPreset` adapter whose `build()` returns it), then put the result back through modules, pinning and validation.
- **Readiness and the tiebreak:** `skipsReadiness` decides from the rules-only profile, because `#enterPlanning` is synchronous. If the tiebreak later moves the lane to careful, readiness is not re-imposed (the implicit criterion stays and reads "Not independently verified"), but the planner run and plan approval still apply, and the careful lane always asks at merge.
- **Implicit criterion:** in quick and standard lanes, when the mission has no active user criteria, write `{ key: 'I1', statement: IMPLICIT_CRITERION, source: 'implicit' }` once.
- **Starting:** a quick or standard factory plan is accepted with the note `"Plan chosen by the factory (<description>): <lane> lane."`. The mission goes PLANNING → EXECUTING with reason `"Planned: <description>. Running."`, `startedAt` is set, and `deps.wake?.()` runs after the transaction.
- **Recording:** one `plan_decisions` row per pass, and the event `{ type: 'plan.decided'; lane; workflowId; modules: string[]; policyRef }`, added to `OrchestrationEvent` and the semantic list.

- [ ] **Step 1:** Write the sections:
  - **ceremony:**
    - An `auto` DRAFT mission titled `fix: typo in the settings title`, with no criteria, calls `planning.plan(id)` without throwing. Then:
      - the mission is `EXECUTING`;
      - there is no pending `plan` approval;
      - its tasks are `[implement, ship]` with `ship.executor === 'ship'`;
      - its criteria are exactly one, with source `implicit` and statement `IMPLICIT_CRITERION`;
      - the fake runtime saw zero planner calls (count via `SCRIPTED`-style call log, or a counter on the fake adapter).
    - The same mission with `laneRequest: 'careful'` and no criteria: `planning.plan(id)` throws `PRECONDITION_FAILED` with the readiness message.
    - With one user criterion added, it ends `AWAITING_PLAN_APPROVAL`, and the planner was called once.
    - A non-`auto` mission (`workflowPreset: 'quick-change'`) with no criteria still throws the readiness error (Review Focus 4).
  - **speed:** for the first mission, measure from the `planning.plan(id)` call until `scheduler.tick()` has made `implement` READY. Assert it is `< QUICK_PLAN_BUDGET_MS`. Run 3 times, warm, and use the median.
  - **tiebreak:**
    - It runs for "Migrate users table" (type unknown), and the fake runtime saw one call on the economy model.
    - A fake reply `"not json"` gives `profile.type === 'unknown'`, `size === 'm'`, `risk === 'high'` (the keyword rule; the floor is untouched), with a signal `effect` containing `conservative default`. Planning still succeeds.
    - `decision.tiebreak.costUsd` equals the fake's reported cost, or is `null` when the fake reports none.
    - It does not run for `fix: typo in the settings title`.
- [ ] **Step 2:** Run it and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it and expect PASS. Then run `node scripts/run-checks.mjs replan-check planner-steps-check p6-ready-check p7-backlog-check plan-fit-check` (Review Focus 4).
- [ ] **Step 5:** Commit: `feat: the factory plans auto missions by lane with no ceremony for small work`.

### Task 6: Ship step, part 1: integrate, push and open a non-draft pull request

**Files:**
- Modify: `packages/domain/src/ports/snapshot.ts`. Add `PullRequestPort` beside `PullRequestSnapshotPort`.
- Create: `packages/integration-github/src/pull-request-flow.ts`: `GhPullRequestFlow implements PullRequestPort`, through `gh()`/`ghJson()` from `gh.ts`. Export it from `index.ts`.
- Create: `packages/application/src/engine/ship.ts`: `ShipService`, part 1.
- Modify: `packages/application/src/engine/scheduler.ts`:
  - `#dispatchFor` handles `task.executor === 'ship'` like a wait (outside the ceiling) through a new `#startShip`;
  - `#finish` skips `integration.integrate` when the mission has a ship task, because the ship step integrated already;
  - `SchedulerDeps` gains optional `ship?: ShipService`.
- Modify: `packages/application/src/tokens.ts`, `module.ts`. Add `PULL_REQUEST_FLOW` and `SHIP_SERVICE`.
- Modify: `apps/daemon/src/bootstrap.ts`. Rebind `PULL_REQUEST_FLOW` to `GhPullRequestFlow(TOOL_COMMAND_EXECUTOR)`, and give the ship service `GIT_CREDENTIAL_ENV` for its push, as `ContributionService` gets it.
- Modify: `scratch/fake-gh.mjs`. Add a `pr` group and helpers, without changing the issue commands:
  - `gh pr list --head B --state all --json …`
  - `gh pr create --title T --body-file F --head B --base main`, which records `isDraft:false` unless `--draft` is passed
  - `gh pr view N --json …`
  - helpers `putPullRequest(dir, repo, pr)`, `setChecks(dir, repo, sha, checks)`, `pullRequests(dir, repo)`
- Test: `scratch/merge-check.mjs` (new), "ship opens" section, added to `OFFLINE_CHECKS`. It uses a bare repository as `origin` and the fake `gh` on `PATH`.

**Interfaces:**
- Produces:
  ```ts
  interface PullRequestRef { repo: string; number: number; url: string; headSha: string; headBranch: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; isDraft: boolean }
  interface PullRequestPort {
    open(input: { cwd: string; repo: string; head: string; base: string; title: string; body: string }): Promise<PullRequestRef & { created: boolean }>; // idempotent by head
    view(cwd: string, repo: string, number: number): Promise<PullRequestRef>;
    // Task 13 adds: checks, protection, comment, merge, updateBranch, reviews
  }
  class ShipService {
    run(mission: Mission, task: MissionTask, signal: AbortSignal): Promise<ShipOutcome>;
  }
  type ShipOutcome = { kind: 'opened'; prs: readonly PullRequestRef[] } | { kind: 'conflict'; taskKey: string } | { kind: 'blocked'; reason: string } | { kind: 'cancelled' };
  ```
- `prTitle(profile, title): string`: `<type>: <lowercased first letter of title>`, where type maps `fix→fix`, `feature→feat`, `docs→docs`, `deps→build`, `refactor→refactor`, `test→test`, `security→fix`, `chore`/`unknown→chore`; already-prefixed titles are kept. Lives in `packages/domain/src/merge/pr-text.ts`.
- `prBody(input): string`: the tracker or issue link (or none), the Done-when table (`| Id | Done when | Verified |`), and the plan's "why" lines from the plan decision. No agent-written text.
- Order, each transition persisted first:
  1. **Integrate.** When two or more task branches succeeded: `BranchIntegrationService.integrate`. A conflict leaves the ship task `PENDING` behind the new `resolve_conflicts_N` task, which is added to its `dependsOn`.
  2. **Push.** `git push origin <branch>` from the integration (or single task) worktree, with credential env.
  3. **Open.** `open(...)`.
  4. **Record.** `{ type: 'ship.pr_opened'; repo; number; url; headSha }`.
- **No GitHub remote:** a mission whose repository has no GitHub `origin` (`githubRepoFromRemote` returns null) ends the ship task `SKIPPED` with `"There is no GitHub remote, so there is no pull request to open; the work is on branch <branch>."`. It never fails the mission.
- **Phase 1 end state:** the ship task is `SUCCEEDED` with reason `"Pull request opened: <url>"`. Task 13 replaces this with CI wait and decide.

- [ ] **Step 1:** Write "ship opens". A real git repository with a bare `origin`, an `auto` mission `fix: typo in the settings title` with the fake runtime writing one file:
  - The fake gh log has exactly one `pr create` whose args contain `--title` `fix: typo in the settings title`, `--head` the task branch, and no `--draft`.
  - The bare repo has the branch, with the commit.
  - The ship task is `SUCCEEDED` with the reason above, and the mission is `COMPLETE`.
  - Running ship again (re-dispatch after a forced `READY`) calls `pr list` and no second `pr create`.
  - `prTitle` table: (`fix`, `fix: typo in the settings title`) → `fix: typo in the settings title`; (`fix`, `Typo in settings title`) → `fix: typo in settings title`; (`feature`, `feat: add export`) → `feat: add export`; (`deps`, `Bump lodash`) → `build: bump lodash`.
  - After promotion the ship task's `executor` is still `ship`: `StaffingResolver` keeps a non-agent, non-human executor as it keeps `wait` (`staffing-resolver.ts:86`).
  - The PR body contains no text from the ChangeSet artifact. Write the ChangeSet with a sentinel `ZZ-AGENT-SAYS` and assert it's absent.
- [ ] **Step 2:** Run it and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it and expect PASS. Also run `node scripts/run-checks.mjs multirepo-check concurrency-check p14-issues-check`.
- [ ] **Step 5:** Commit: `feat: a ship step that opens the pull request itself`.

### Task 7: Escalating the lane mid-mission, and the lane switch

**Files:**
- Modify: `packages/application/src/planning/planner-service.ts`:
  - `afterCodeStep(mission, task)` re-profiles from the task worktree's `git diff --name-only <base>...HEAD` (through `ExecutionTargetManager`'s target path and the `CommandExecutor`);
  - `switchLane(missionId, lane, caller)`.
- Modify: `packages/application/src/engine/scheduler.ts` `#settled`. Once a task whose `stepClassFor` is `implement` or `resolve_conflicts` settles `SUCCEEDED`, call `deps.planner?.afterCodeStep(mission, settledTask)` inside a try (logged, never fails the pass). This is one added line plus the dep.
- Modify: `packages/application/src/support/replan.ts`. Add `spliceSteps(missionId, steps: PlannedTask[], rewire)`, which inserts additive steps the way the replan-the-rest machinery writes approved proposals (`#applyEditedPlan`'s path), without a plan card.
- Test: `scratch/planner-check.mjs`, "mid-mission escalation" section.

**Interfaces:**
- `afterCodeStep`:
  - a measured profile whose lane is stricter, or that matches a module the plan lacks, adds the missing steps and gate clauses before `ship`;
  - it records a `plan_decisions` row with `basis: 'measured'`;
  - it notes on the feed: `"It touched <first path>, so I added <module step title, lowercased>."`;
  - a lighter measured lane changes nothing.
- `switchLane(missionId, 'careful' | 'quick', caller)`:
  - **`careful`** adds steps (as above) and sets `laneRequest`.
  - **`quick`** files the existing replan card listing the steps it would remove, and sets `laneRequest: 'quick'` and the plan decision's `lightenedByPerson: true` only when that card is approved.
  - **Refusals:** a ship step already `RUNNING` or later → `"The pull request is already on its way; the lane can't change now."` (CONFLICT); a non-`auto` mission → `"Only missions the factory planned have a lane."`.

- [ ] **Step 1:** Write the section:
  - A quick-lane `auto` mission whose fake implement step writes `src/auth/session.ts`. After it settles:
    - a `security_review` task exists between `implement` and `ship`, and `ship.dependsOn` contains it;
    - there is no pending approval;
    - a note reads exactly `It touched src/auth/session.ts, so I added a security review.`;
    - the latest plan decision has `basis === 'measured'`.
  - A careful-predicted mission whose diff touches only `docs/readme.md` keeps its tasks unchanged.
  - `switchLane(id, 'quick')` files a plan card and removes nothing until it's approved.
  - `switchLane` after ship started throws the exact sentence above.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS; also `node scripts/run-checks.mjs replan-check rounds-check`.
- [ ] **Step 5:** Commit: `feat: add steps when a change turns out riskier, and switch lanes`.

### Task 8: API and desktop for "Why these steps", Plan quick or careful, and the opened PR

**Files:**
- Create: `packages/api-contract/src/factory.ts`, following `setup.ts`, and export it from `index.ts`:
  - `PlanDecisionView`;
  - `setLaneRequest = z.object({ lane: z.enum(['quick','careful']) })`;
  - `ShipView` (part 1: PRs only).
- Modify: `packages/api-contract/src/requests.ts`. `createMissionRequest` gains `lane: z.enum(['quick','careful']).optional()`; the plan route body gains `lane` optional.
- Modify: `packages/application/src/services.ts`. Add `services.factory` with `planDecision(missionId)`, `setLane(missionId, lane, caller)` and `ship(missionId)`.
- Modify: `apps/daemon/src/routes.ts`. Next to `/v1/missions/:id/plan`:
  - `GET /v1/missions/:id/plan-decision`
  - `POST /v1/missions/:id/lane`
  - `GET /v1/missions/:id/ship`
- Modify: `packages/domain/src/ports/event-bus.ts`. `ProjectionTopic` gains `'ship'`; desktop `lib/queries.ts` `TOPIC_KEYS.ship = [['mission'], ['inbox']]`.
- Create: `apps/desktop/src/renderer/src/screens/mission/WhyTheseSteps.tsx` + `.css`. It shows:
  - the chips (`"Fix · small · low risk"`, each opening its signals as sentences);
  - the lane line;
  - skipped ceremony in words;
  - the modules applied;
  - per step, "Implement · role model" (Task 10 fills in routed models);
  - **Make it careful** / **Make it quick**.
- Modify: `apps/desktop/src/renderer/src/screens/mission/PlanPane.tsx`. Render `WhyTheseSteps` above the graph when a plan decision exists.
- Modify: `apps/desktop/src/renderer/src/screens/mission/MissionDetail.tsx` `actionsFor('DRAFT')`. **Plan** gains a small menu with **Plan quick** and **Plan careful**, which pass `lane`.
- Modify: `apps/desktop/src/renderer/src/screens/NewMission.tsx`. The workflow picker gains "Let the factory decide" (`auto`) as the default.
- Create: `apps/desktop/src/renderer/src/components/ShipCard.tsx` + `.css`, part 1: "Opening the pull request" → "Pull request opened" with **Open in GitHub**.
- Modify: `apps/desktop/src/renderer/src/lib/daemon.ts`. Add `planDecision(id)`, `setLane(id, lane)` and `ship(id)`.
- Create: `scratch/acceptance/planner/run-all.mjs`, `common.mjs`, `suite/pm01.mjs`, `pm06.mjs`, `pm07.mjs`. Reuse `scratch/acceptance/p0` `setup.mjs` and `lib/`, as `scratch/acceptance/p14/run-all.mjs` does, with `CDP_PORT=9353`, `ACCEPTANCE_LINK=/tmp/tdm-planner`, a bare repo as `origin`, and the fake `gh` first on the daemon's PATH.
- Modify: `scratch/acceptance/p0/scripted-agent.mjs`. A goal containing `SCRIPTED_TOUCH=<path>` (repeatable) makes the implement step create or append to that file in its worktree.

- [ ] **Step 1:** Write PM1, PM6 and PM7 (spec Acceptance table), each asserting on DOM text and on `GET /v1/missions/:id/ship`:
  - **PM1:** `fix: typo in the settings title`, no criteria, Plan.
    - No "Approve the plan" card.
    - The Plan header reads `Fix · tiny · low risk` and `Quick lane: one step, then a pull request.`
    - The ship card reaches `Pull request opened`.
    - Fake gh saw `pr create` without `--draft`.
  - **PM6:** goal `SCRIPTED_TOUCH=src/auth/session.ts`. The feed shows `It touched src/auth/session.ts, so I added a security review.`, and a `Security review` step runs.
  - **PM7:** Plan careful on a mission with no criteria. Refinement opens (the "Get ready" panel). After adding one Done-when line and planning, the plan card is shown with the lane line `Careful lane`.
- [ ] **Step 2:** `npm run build && node scratch/acceptance/planner/run-all.mjs --keep-going --only=pm01,pm06,pm07`. Expected: FAIL (no plan header).
- [ ] **Step 3:** Implement the API and UI. The size words are `xs → tiny`, `s → small`, `m → medium`, `l → large`, in a `profileChips(profile)` helper in `packages/domain/src/planner/words.ts`, so the daemon builds the sentences and the renderer only shows them.
- [ ] **Step 4:** Rerun and expect PASS. Run `npm run ci`. Save evidence to `docs/superpowers/evidence/2026-10-30-planner/` (REPORT.md and screenshots).
- [ ] **Step 5:** Commit: `feat: show why the factory chose these steps and let you change the lane`. Open PR 1 titled `feat: plan tasks by lane and open the pull request from the daemon`, with a body that refs #53.

---

## PR 2: Routing (spec phase 2)

### Task 9: Outcomes, the fold and outcome events

**Files:**
- Modify: `packages/domain/src/brain/outcomes.ts`. Add `foldOutcomes`, `bucketOf` and `stepSuccess`.
- Create: `packages/application/src/engine/outcomes.ts`: `OutcomeRecorder`. It writes to `OUTCOME_REPOSITORY` and records the `task.outcome` event.
- Modify: `packages/domain/src/event.ts`. Add to `OrchestrationEvent` and `SEMANTIC_EVENT_TYPES`:
  - `{ type: 'task.outcome'; outcomeId; kind; stepClass: string | null; model: string | null }`
  - `{ type: 'merge.decided'; decisionId; verdict; score; repo; number; headSha }`
  - `{ type: 'merge.merged'; decisionId; mergeSha; by: string }`
  - `{ type: 'merge.asked'; decisionId; reasons: string[] }`
  - `{ type: 'merge.reverted'; decisionId; revertPr: string | null; by: string }`
  - `{ type: 'ship.pr_opened'; … }` (Task 6) and `{ type: 'plan.decided'; … }` (Task 5)
- Modify: `packages/application/src/engine/scheduler.ts` `#settled`. Before the early returns, for a non-trial mission, call `deps.outcomes?.stepSettled(mission, task)` when the attempt finished (`SUCCEEDED`, `FAILED` or `BLOCKED`). It reads the run's `RunScore` (model, attempt, gatePassed, costUsd, wallTimeMs) and appends a `step_result`.
- Modify: `packages/application/src/engine/feedback-rounds.ts` `beginRound`. After the round is written, call `deps.outcomes?.changesRequested(task)` (one added line plus an optional dep).
- Modify: `packages/application/src/services/hold-service.ts` (from #50). On a hold ending `continued` or `released`, call `outcomes.held(task, hold)`. #50 merges before this PR (its migration 022 must be on `main`, see Global Constraints).
- Test: `scratch/routing-check.mjs` (new), "fold" section, added to `OFFLINE_CHECKS`.

**Interfaces:**
- `bucketOf(o: OutcomeEvent): string`: `` `${step.class}|${lane}|${maxSensitivity(profile.areas)}` ``.
- `stepSuccess(stepOutcomes, laterOutcomes)`: gate passed on attempt 1, and the same task has no `held`, no `changes_requested`, and (for implement) no `reverted` or `broke_main`.
- `foldOutcomes(events: readonly OutcomeEvent[]): OutcomeStats`:
  ```ts
  interface OutcomeStats {
    readonly buckets: Readonly<Record<string, Readonly<Record<string /* model, '' for none */, BucketModelStats>>>>;
    readonly areas: Readonly<Record<string, { reverts90d: number; lastRevertAt: string | null; holds: number; changesRequested: number; tasks: number }>>;
  }
  interface BucketModelStats { n: number; firstPass: number; success: number; holds: number; changesRequested: number; reverts: number;
                               medianCostUsd: number | null; medianWallTimeMs: number | null }
  ```
  It sorts by `(at, id)` before folding, so input order never matters. Trials never reach it: the recorder refuses trial missions.
- `OutcomeRecorder` methods: `stepSettled`, `held`, `changesRequested`, `merged(decision, by)`, `reverted(decision, by)`, `brokeMain(decision)`, `closedUnmerged(...)`, `mergedClean(decision)`. Each writes one row and records `task.outcome`.

- [ ] **Step 1:** Write the "fold" section:
  - 40 generated outcome events, shuffled 100 times with `mulberry32(51)`: `JSON.stringify(foldOutcomes(shuffled))` is identical every time.
  - The same events split across writers `A` and `B` fold to the same stats.
  - For bucket `implement|quick|none` and model `sonnet`, with 5 step results (4 passed first attempt, one later held): `n === 5`, `firstPass === 4`, `success === 3`, `holds === 1`.
  - `medianCostUsd` is `null` when every cost is `null`, never `0`.
  - Engine: a settled fake implement step appends one `step_result` row with `step.model` equal to the run's model; a trial mission appends none.
  - `beginRound` appends one `changes_requested` row.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS; also `node scripts/run-checks.mjs rounds-check p3-evals-check`.
- [ ] **Step 5:** Commit: `feat: record task outcomes and fold them into routing stats`.

### Task 10: Rung choice, escalation, and plan-time approvals from holds

**Files:**
- Create: `packages/domain/src/planner/routing.ts`: the `routing.yaml` schema, `wilsonLowerBound`, `chooseRung`.
- Modify: `packages/application/src/planning/planner-service.ts`. Route each step (spec §5 step 5), writing `modelPolicy.{model, escalate, independentOf, reason}`, and add §5.3 approvals.
- Modify: `packages/application/src/engine/feedback-rounds.ts` `beginRound`. For a task whose `stepClassFor` is `implement` and whose `modelPolicy.reason` starts with `routed:`, move `model` one rung up the remaining `escalate` and set `reason` to `"moved up after changes were requested"`. A model the person pinned (no `routed:` reason) is left alone.
- Test: `scratch/routing-check.mjs`, sections "rung choice", "bounds", "escalation"; `scratch/planner-check.mjs`, section "plan-time approvals from holds".

**Interfaces:**
- `RoutingConfig = { version: 1; target: number; minSamples: number; probeEvery: number; classes: Partial<Record<StepClass, { ladder: string[]; default: string; independentOf?: string }>> }`. Validation: `default` must be on `ladder`; `ladder` length 1..`MAX_LADDER`; every name passes `modelProblem`.
- `wilsonLowerBound(successes: number, n: number, z = WILSON_Z): number`, with `WILSON_Z = 1.96`. `n === 0` → `0`.
- `chooseRung(input: { cls: StepClass; bucket: string; risk: RiskLevel; config: RoutingConfig; stats: OutcomeStats; taskOrdinal: number }): { model: string; escalate: string[]; reason: string; probe: boolean } | null`. Null means the class has no ladder, so the role's model applies. The rules are spec §6.2:
  - under `minSamples` → `default`, reason `"default: only <n> similar tasks measured"`;
  - else the cheapest rung with `wilsonLowerBound ≥ target`, reason `"routed: <model> passed <s> of <n> similar <class> steps first time"`;
  - else the best measured rung;
  - a probe, only when `risk === 'low'` and `taskOrdinal % probeEvery === 0` and `probeEvery > 0`, goes one rung cheaper, reason `"Trying <model>: it hasn't been measured on enough similar work"`.
  
  `escalate` is the ladder above the chosen rung.
- **Plan-time approvals (§5.3):** for each step, when the area stats for `(class, any matching area)` over the last `holdApproval.minTasks` tasks have `(holds + changesRequested) / tasks ≥ holdApproval.rate`, set `approvalPolicy.onCompletion = true`, with reason `"People stepped in on <k> of the last <n> <area> <class> steps, so you'll look at this one before it moves on."`.

- [ ] **Step 1:** Write the sections:
  - **rung choice:**
    - With 7 samples → `default`.
    - With 25 samples where haiku succeeds 24/25 and sonnet 25/25, and `target: 0.8` → `haiku` (Wilson LB of 24/25 ≈ 0.805).
    - Haiku at 18/25 → `sonnet`.
    - Probe on ordinal 10 with `probeEvery: 10`, risk low, chose sonnet → `haiku` and `probe: true`; risk high → no probe.
  - **bounds:** 500 random stats tables never yield a model off the ladder.
  - **escalation:**
    - `resolveModel` with `escalate` from `chooseRung` at attempt 2 gives the next rung.
    - A `beginRound` on a routed implement task moves `model` up one rung.
    - A task with `modelPolicy.model` and no `routed:` reason is unchanged.
    - With pressure 85% and a role economy model, `resolveModel` returns source `economy`.
    - A `continued` hold appends `held` and doesn't change `model`.
  - **plan-time approvals from holds:**
    - Five outcomes on `implement|desktop-ui`, three of them held, then a new desktop-ui feature task: its implement step has `approvalPolicy.onCompletion === true` with the exact reason for `3 of the last 5`.
    - A docs task gets none.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS; also `node scripts/run-checks.mjs p12-models-check routing-overcommit-check`.
- [ ] **Step 5:** Commit: `feat: route each step to the cheapest proven model and escalate on failure`.

### Task 11: The Routing view

**Files:**
- Modify: `packages/api-contract/src/factory.ts`. Add `RoutingView` (per class, per bucket, per model: `n`, first-pass rate, success, the current starting rung, `null` costs shown as "not reported") and `FactoryView` (the three files' origin, path, ref and problems).
- Modify: `apps/daemon/src/routes.ts`. Add `GET /v1/workspaces/:id/routing` and `GET /v1/workspaces/:id/factory`, plus `POST /v1/workspaces/:id/factory/defaults`, which writes the shipped files through `FactoryConfigSourcePort.write` into the default repository.
- Create: `apps/desktop/src/renderer/src/screens/project/Factory.tsx` + `.css`:
  - Project settings → **Factory**: where each file came from ("From this project's repository", "From this computer", "Built in");
  - rules that don't parse, in the daemon's words;
  - **Write the defaults into the repository**;
  - **Routing**: a table per step class.
  
  This sits in Project settings until the brain's screen exists (Task 20 moves it).
- Modify: `apps/desktop/src/renderer/src/screens/Project.tsx`. Mount `<Factory />` beside `<Limits />`.
- Modify: `apps/desktop/src/renderer/src/screens/mission/WhyTheseSteps.tsx`. Per step: "Implement · sonnet · passed 23 of 25 similar fixes first time · if it fails, opus"; tiebreak line "Couldn't tell from the tracker whether this is a fix or a feature; asked haiku (0.2¢): fix."
- Create: `scratch/acceptance/planner/suite/pm10.mjs`.

- [ ] **Step 1:** Write PM10. Hold (#50) the implement step of three desktop-ui tasks (`SCRIPTED_TOUCH=apps/desktop/src/renderer/x.tsx`), continue each, then start a fourth. Its Plan header shows `You'll look at this one before it moves on`. Also, Project → Factory shows `Built in` for all three files and a Routing row for `implement`.
- [ ] **Step 2:** Run `--only=pm10` and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun and expect PASS. Run `npm run ci`. Add the screenshots to the evidence folder.
- [ ] **Step 5:** Commit: `feat: show routing and factory files in project settings`. Open PR 2 titled `feat: route models by measured outcome`, refs #53.

---

## PR 3: Ship and decide, asking only (spec phase 3)

### Task 12: Domain, the merge policy and `decideMerge`

**Files:**
- Create: `packages/domain/src/merge/policy.ts`: the zod schema of `merge.yaml` and `parseMergePolicy`.
- Create: `packages/domain/src/merge/decide.ts`: `MergeFacts`, `decideMerge`, `mergeFactsToGate`.
- Create: `packages/domain/src/merge/words.ts`: `decisionComment(decision, ctx)`, `squashTrailers(decision, ctx)`, `askReasonWords(factor)`.
- Modify: `packages/domain/src/merge/types.ts`. Add `MergeDecision` and `MergeFactor`.
- Test: `scratch/merge-check.mjs`, sections "decision table", "hard rules", "no self-report".

**Interfaces:**
- `MergePolicy = { version: 1; autoMerge: 'off' | 'on'; method: 'squash' | 'merge' | 'rebase'; reviewers: string[]; tests: string[]; never: NeverRule[]; requires: string[]; score: ScoreRule[]; autoMergeAtMost: number; revertAutoMerge: 'off' | 'on' }`
  - `NeverRule = { paths: string[] } | { areas: string[] } | { when: string }`
  - `ScoreRule = { when: string; points: number; why: string }`
  - Every `when` and `requires` entry must pass `lintRule(…, 'ship')`, else the whole file is `{ error }`. A merge policy is never partially loaded.
- `MergeFacts` (typed, flat, every field measured by the daemon; there is no `string` field fed from an artifact or PR body):
  ```ts
  { changedPaths: readonly string[]; deletedPaths: readonly string[]; files: number; linesAdded: number; linesRemoved: number;
    binaryFiles: number; repos: number; areas: readonly { name: string; sensitivity: Sensitivity }[];
    testsTouched: number; dependenciesChanged: boolean; lockfileOnly: boolean; coverageChangedLines: number | null;
    ci: { state: 'PASS' | 'FAIL' | 'PENDING' | 'NONE'; requiredPresent: boolean | null }; reviewRequired: boolean | null;
    checksTests: 'PASS' | 'FAIL' | 'SKIP' | null; review: { blocking: number | null; major: number | null; independent: boolean | null };
    criteria: { unverified: number; implicit: boolean }; process: { lane: Lane; lightenedByPerson: boolean; stepsSkipped: number;
    holds: number; changesRequested: number; escalations: number; gateRetries: number; personCommits: number };
    history: { areaReverts90d: number | null; areaRecentRevert: boolean | null } }
  ```
- `MERGE_FACT_ORIGINS: Readonly<Record<keyof MergeFacts, 'git' | 'github' | 'daemon' | 'ledger'>>`: the origin of every top-level field, for the no-self-report assertion.
- `decideMerge(facts: MergeFacts, policy: MergePolicy | { error: string }): MergeDecision`, the spec's §8.3 steps 1–7 in that order, where:
  ```ts
  MergeDecision = { verdict: 'merge' | 'ask'; score: number; allowed: number | null; wouldMerge: boolean;
                    factors: readonly MergeFactor[]; reasons: readonly string[] }
  MergeFactor = { rule: string; kind: 'hard' | 'never' | 'requires' | 'score'; matched: boolean; points: number;
                  unmeasured: readonly string[]; paths: readonly string[] }
  ```
  - `wouldMerge` is the verdict the policy would give with `autoMerge: 'on'`, which "what would have happened" needs.
  - The fixed sentences are:
    - `AUTO_MERGE_OFF = 'Auto-merge is off for this project.'`
    - `NO_CI = 'This repository has no CI checks, so Tandemise never merges it on its own.'`
    - `CI_NOT_GREEN = 'CI is not green on this commit.'`
    - `REVIEW_REQUIRED = 'This repository requires an approving review, so Tandemise can\'t merge it on its own.'`
    - `MALFORMED = 'The merge policy can\'t be read (<error>), so every pull request asks.'`
    - a `never` match: `"Touches <first path> — never merged on its own in this project."`;
    - a score over the limit: `"Risk score <s> of <allowed> allowed: <why1>, <why2>."`.

- [ ] **Step 1:** Write the sections:
  - **decision table:** start from a base fact set that merges under the default policy with `autoMerge: 'on'` at score 0: 1 file `apps/web/src/pages/settings.tsx`, 10 lines added, 2 removed, 1 test file touched, no deletions, `ci.state: 'PASS'`, `requiredPresent: true`, `reviewRequired: false`, `checksTests: 'PASS'`, an independent review with 0 blocking findings, 0 unverified user criteria, lane `quick`, no holds, rounds, escalations or person commits, and no history. (The implicit criterion isn't a user criterion, so it never counts in `criteria.unverified`.) Then, for each default `never` rule, each `requires` and each score line, a variant that triggers just that rule. Expected verdict and reason:
    - `db/migrations/0042_add_index.sql` → ask, `Touches db/migrations/0042_add_index.sql — never merged on its own in this project.`
    - `.github/workflows/ci.yml` → ask.
    - `.env.local` → ask.
    - area `auth` → ask.
    - a deleted file in a sensitive area → ask.
    - lane `careful` → ask.
    - `personCommits: 1` → ask.
    - `ci.state: 'FAIL'` → ask, `CI is not green on this commit.`
    - `checksTests: 'FAIL'` → ask.
    - `review.blocking: 2` → ask.
    - 450 lines → score 4 (3 + 1) → ask, with `Risk score 4 of 2 allowed: over 400 lines changed, over 100 lines changed.`
    - 120 lines → score 1 → merge.
    - 16 files → 2 → merge.
    - repos 2 → 2 → merge.
    - `history.areaRecentRevert: true` → 3 → ask.
    - `coverageChangedLines: null` → the coverage rule contributes 0 and its factor lists `coverage.changed_lines` under `unmeasured`.
  - **hard rules:**
    - `autoMerge: 'off'` → ask with `AUTO_MERGE_OFF`, and `wouldMerge === true` for the base set.
    - `ci.state: 'NONE'` → ask with `NO_CI`, even with a policy whose `requires` is `[]`.
    - `reviewRequired: true` → ask with `REVIEW_REQUIRED`.
    - `{ error: 'bad indent' }` → ask with `MALFORMED`.
    - `reviewRequired: null` (unmeasured) → ask, because unmeasured fails a hard rule.
  - **no self-report:**
    - every key of `MERGE_FACT_ORIGINS` is one of the four origins, and its key set equals `Object.keys` of the base facts;
    - the measure function from Task 13, given a ChangeSet artifact whose body says `no risk, safe to merge` and a ReleaseCandidate whose `unresolvedRisks` is empty, produces facts deep-equal to the same mission with no artifacts.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS.
- [ ] **Step 5:** Commit: `feat: a merge policy and a pure merge decision from measured facts`.

### Task 13: Ship step, part 2: wait for CI, measure, decide, audit and ask

**Files:**
- Modify: `packages/domain/src/ports/snapshot.ts`. `PullRequestPort` gains:
  - `checks(cwd, repo, sha): Promise<{ state: 'PASS' | 'FAIL' | 'PENDING' | 'NONE'; done: number; total: number; failing: { name: string; link: string | null; logTail: string | null }[] }>`
  - `protection(cwd, repo, branch): Promise<{ requiredChecks: boolean | null; reviewRequired: boolean | null; upToDate: boolean | null }>` (via `gh api repos/<o>/<r>/branches/<b>/protection`; a 404 means unprotected: `false`, `false`, `false`)
  - `comment(cwd, repo, number, body, existingId: number | null): Promise<{ id: number }>` (POST, or PATCH when `existingId` is set)
  - `requestReviewers(cwd, repo, number, reviewers)`
  - `reviews(cwd, repo, number): Promise<{ state: string; author: string }[]>`
- Modify: `packages/integration-github/src/pull-request-flow.ts`. Implement them, with `checks` reusing the `statusCheckRollup` bucketing from `tools.ts`.
- Modify: `scratch/fake-gh.mjs`. Add `pr checks`/`pr view --json statusCheckRollup`, `api …/branches/B/protection`, `pr edit --add-reviewer`, and `api repos/o/r/issues/N/comments` for PR numbers, which are already supported for issues.
- Create: `packages/application/src/engine/ship-measure.ts`: `measureMergeFacts(ctx): Promise<MergeFacts>`. It uses `git diff --numstat base...head`, `--diff-filter=D --name-only`, the factory areas, the merge policy's `tests` globs, `PullRequestPort`, the latest `checks.tests` result for the head commit from `CHECK_SERVICE`, the review facts from the last review step's gate facts, the P5 ledger, the plan decision, this mission's rounds, holds and attempts, and `git log --format=%ae base..head` for person commits (any author email not the daemon's or the run attribution's).
- Modify: `packages/application/src/engine/ship.ts`. Part 2, the states after "opened":
  - **Wait for CI.** Poll `checks` with the `Waiter`'s backoff (`SHIP_CI_POLL_MS = 30_000`, up to `SHIP_CI_TIMEOUT_MS = 3_600_000`); the task is `AWAITING_EXTERNAL`, reason `"Waiting for CI (<done> of <total> checks done)"`.
  - **Failing check.** `FeedbackRounds.beginRound` on the implement task, note = `"CI failed: <check name>\n\n<last 40 lines of its log>"`, up to the implement step's `retryPolicy.maxAttempts`. After that the ship task is `BLOCKED` with `"CI kept failing on <check name>."`.
  - **Measure, then decide** with `AUTO_MERGE_SHIPPED = false` forcing `autoMerge: 'off'` for this phase.
  - **In one transaction:** write `merge_decisions` and record `merge.decided`. After commit: post or edit the PR comment (store `commentId`).
  - **Ask:**
    - request the reviewers from the policy;
    - file one `release` approval with options `merge` ("Merge") and `leave` ("I'll merge it in GitHub"), title `"Review and merge <PR title>"`, and the reasons as evidence text;
    - record `merge.asked`; the task is `AWAITING_APPROVAL`.
  - **On each scheduler pass** for a ship task waiting: `view` the PR.
    - `MERGED` (by a person) → record `mergedAt`, `mergedBy` (the GitHub login), `mergeSha`, task `SUCCEEDED`, outcome `merged_by_person`.
    - `CLOSED` → task `BLOCKED` with `"The pull request was closed without merging."`, outcome `closed_unmerged`.
    - A head SHA different from the decision's → void it (`voidedAt`), note `"The pull request changed after it was checked; checking again."`, back to the CI wait.
- Modify: `packages/application/src/services/approval-service.ts` `decide`. Inside the transaction, a ship card (`isShipCard`: kind `release`, a `merge` option, and a ship task) skips `#resumeTask`. After the commit, call `deps.ship?.personDecided(approval)`:
  - `merge` runs Task 16's merge as the person (until Task 16, it records the choice and leaves the PR for GitHub);
  - `leave` moves the ship task to `AWAITING_EXTERNAL` with `"Waiting for you to merge it in GitHub."`, and the pass keeps watching the PR.
  
  One added branch plus an optional dep.
- Modify: `packages/application/src/engine/recovery.ts`. A ship task in `AWAITING_EXTERNAL` or `AWAITING_APPROVAL` is left as is; the scheduler re-adopts it, as it does waits.
- Test: `scratch/merge-check.mjs`, sections "ship decides", "audit", "crash between decide and merge".

**Interfaces:**
- `ShipService.personDecided(approval: Approval): Promise<void>`
- `ShipService.adopt(mission, task): void`, re-adoption after a restart.
- `isShipCard(a: Pick<Approval, 'kind' | 'options' | 'taskId'>, task: MissionTask | undefined): boolean` in `packages/domain/src/entities/approval.ts`.
- Constants: `SHIP_CI_POLL_MS = 30_000`, `SHIP_CI_TIMEOUT_MS = 3_600_000`, `SHIP_LOG_TAIL_LINES = 40`, `AUTO_MERGE_SHIPPED = false`.

- [ ] **Step 1:** Write the sections, with the fake `gh` (checks pending → success via `setChecks`):
  - **ship decides:**
    - After the PR opens, the ship task is `AWAITING_EXTERNAL` with `Waiting for CI (0 of 2 checks done)`.
    - Checks go green → one `merge_decisions` row, `verdict: 'ask'`, reason list containing `Auto-merge is off for this project.`, `wouldMerge: true`.
    - One pending `release` approval titled `Review and merge fix: typo in the settings title`.
    - The fake gh saw `pr edit --add-reviewer` only when `reviewers` is non-empty.
    - A failing check `unit` with a log starts round 2 on `implement`, and its note starts with `CI failed: unit`.
  - **audit:**
    - The row's `facts` JSON parses and has every `MergeFacts` key.
    - Exactly one PR comment exists after two decisions on two SHAs: the second is a `PATCH` to the same comment id. Its text contains `Tandemise asks for a review` and the head SHA's first 7 characters.
  - **person merge:** setting the fake PR to `MERGED` with `mergedBy: 'sam'` makes the ship task `SUCCEEDED`, the mission `COMPLETE`, and a `merged_by_person` outcome.
  - **closed:** setting it to `CLOSED` makes the ship task `BLOCKED` with the exact sentence.
  - **crash between decide and merge (Review Focus 5):** write a decision row, kill the harness before any merge call, restart it. The ship task is re-adopted, there's no second decision on the same SHA, and no `pr merge` appears in the call log.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS; also `node scripts/run-checks.mjs rounds-check resume-check feedback-loop-check p14-issues-check`.
- [ ] **Step 5:** Commit: `feat: the ship step waits for ci, decides and asks for review`.

### Task 14: Desktop, the ship card and the review row

**Files:**
- Modify: `packages/api-contract/src/factory.ts`. `ShipView` gains, per PR:
  - CI progress;
  - the latest decision: verdict, score, allowed, factors as sentences, `wouldMerge` and the policy ref;
  - the card id.
- Modify: `apps/desktop/src/renderer/src/components/ShipCard.tsx`. The states:
  - "Opening the pull request";
  - "Waiting for CI (3 of 5 checks done)";
  - "Waiting for your review", with the reasons, **Open in GitHub**, **Merge**, and "What would have happened with auto-merge on: would have merged (score 0 of 2)".
- Modify: `apps/desktop/src/renderer/src/screens/mission/TaskDetail.tsx`. For `task.executor === 'ship'`, render `<ShipCard />` in place of the run section. One conditional only.
- Modify: `apps/desktop/src/renderer/src/screens/mission/FeedPane.tsx`. Show the `merge.decided` and `merge.asked` lines as "Asked for a review: touches a migration".
- Modify: `apps/desktop/src/renderer/src/screens/approvals/ApprovalCard.tsx`. For a ship card, the primary button reads **Merge**.
- Create: `scratch/acceptance/planner/suite/pm02.mjs`, `pm05.mjs`.

- [ ] **Step 1:** Write the scenarios:
  - **PM2:** the PM1 mission with green checks; the card says `Waiting for your review`, `Auto-merge is off for this project.` and `would have merged: score 0 of 2`; the Inbox has `Review and merge`.
  - **PM5:** `SCRIPTED_TOUCH=db/migrations/0042_add_index.sql`; the card says `Touches db/migrations/0042_add_index.sql — never merged on its own in this project.`; fake gh saw no `pr merge`.
- [ ] **Step 2:** Run them and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun and expect PASS; run `npm run ci`; add the evidence.
- [ ] **Step 5:** Commit: `feat: a ship card that shows the merge decision and asks for review`. Open PR 3 titled `feat: decide merges from blast radius and ask for review`, refs #53.

---

## PR 4: Auto-merge (spec phase 4)

### Task 15: Merge settings, the backtest and the switch

**Files:**
- Create: `packages/domain/src/merge/backtest.ts`: `backtest(rows, current, candidate, outcomes)`.
- Create: `packages/application/src/services/merge-policy-service.ts`: `MergePolicyService` with `get`, `update`, `backtest` and `stop`.
- Modify: `packages/api-contract/src/factory.ts`. Add `updateMergePolicyRequest`, `backtestRequest` and `BacktestView`.
- Modify: `apps/daemon/src/routes.ts`. Add `GET/PUT /v1/workspaces/:id/merge-policy`, `POST /v1/workspaces/:id/merge-policy/backtest` and `POST /v1/workspaces/:id/merge-policy/stop`.
- Create: `apps/desktop/src/renderer/src/screens/project/Merge.tsx` + `.css`. Project settings → **Merge**:
  - the switch, with the backtest beside it, shown before saving;
  - the `never` list in words;
  - the score table;
  - **Stop auto-merging**.
- Modify: `apps/desktop/src/renderer/src/screens/Project.tsx`. Mount `<Merge />`.
- Modify: `packages/application/src/engine/ship.ts`. Remove `AUTO_MERGE_SHIPPED`.
- Test: `scratch/merge-check.mjs`, sections "backtest" and "switch".

**Interfaces:**
- `backtest(rows: readonly MergeDecisionRecord[], current: MergePolicy, candidate: MergePolicy, outcomes: readonly OutcomeEvent[]): { window: { from: string; to: string }; total: number; mergedCurrent: number; mergedCandidate: number; changed: { decisionId: string; pr: string; from: Verdict; to: Verdict; revertedOrBroke: boolean }[]; changedThenReverted: number }`. It replays `decideMerge` over each row's stored `facts` with `autoMerge` forced `'on'` on both sides. `BACKTEST_WINDOW_DAYS = 90`.
- `MergePolicyService.update(workspaceId, policy, caller)`:
  - validates with `parseMergePolicy`;
  - writes through `FactoryConfigSourcePort.write('merge', defaultRepositoryPath, policy)`;
  - when `autoMerge` goes `off → on`, records a `Decision` (`DecisionRepositoryPort.create`) with title `"Auto-merge low-risk pull requests in <project name>"`, `owner = caller`, `status: 'accepted'`, and the backtest summary as `rationale`.
  
  Only a person caller may call it: a runtime or agent caller is refused with `"Only a person can change the merge policy."`.
- `stop(workspaceId, caller)`: writes `autoMerge: 'off'` (a human edit), then re-decides every ship task waiting in this workspace with the new policy, which is ask by construction.

- [ ] **Step 1:** Write the sections:
  - **backtest:** 6 stored rows (3 with scores 0–2, one later `reverted`, 3 with scores 3–5) with candidate `autoMergeAtMost: 4`: `mergedCurrent === 3`, `mergedCandidate === 5`, `changed.length === 2`, `changedThenReverted` equal to the count among those two that have a `reverted` outcome.
  - **switch:**
    - `update` with `autoMerge: 'on'` writes `<repo>/.tandemise/factory/merge.yaml` containing `autoMerge: on`, and one `Decision` row with the exact title.
    - The same call as a runtime caller is refused.
    - `stop` writes `autoMerge: off`, and a ship task in `AWAITING_EXTERNAL` gets a new decision with verdict `ask` and reason `AUTO_MERGE_OFF`.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS.
- [ ] **Step 5:** Commit: `feat: turn auto-merge on per project with a backtest and a kill switch`.

### Task 16: Merging the reviewed commit

**Files:**
- Modify: `packages/domain/src/ports/snapshot.ts`. `PullRequestPort` gains:
  - `merge(cwd, repo, number, opts: { method; matchHeadCommit: string; auto: boolean; subject: string; body: string }): Promise<{ merged: boolean; queued: boolean }>`
  - `updateBranch(cwd, repo, number): Promise<void>`
  - `repoSettings(cwd, repo): Promise<{ allowAutoMerge: boolean }>`
- Modify: `packages/integration-github/src/pull-request-flow.ts` and `scratch/fake-gh.mjs`:
  - `gh pr merge N --squash|--merge|--rebase --match-head-commit SHA [--auto] --subject S --body B`;
  - the fake refuses with GitHub's message `Head branch was modified` when SHA ≠ head;
  - `gh pr update-branch N`;
  - `gh repo view --json autoMergeAllowed`.
- Modify: `packages/application/src/engine/ship.ts`. On `verdict: 'merge'`:
  - **Update first if needed:** when protection says `upToDate: false` and up-to-date is required, call `updateBranch`, then go back to the CI wait (a new head SHA).
  - **Merge:** call `merge` with `matchHeadCommit` = the decision's `headSha`, `auto: allowAutoMerge`, subject `<PR title> (#<n>)`, and body = `squashTrailers`:
    ```
    Tandemise-Merge: auto; score <s>/<allowed>
    Tandemise-Policy: <policyRef>
    Tandemise-Mission: <issue or mission id>
    ```
  - **"Head branch was modified":** void the decision and go back to the CI wait.
  - **Merged:** record `merge.merged`, update `merged_*`, the task `SUCCEEDED`, outcome `merged` (Task 9; `merged_clean` comes later from the watcher).
  - **A person's Merge on the card (Task 13):** the same call, with `mergedBy` = the member id.
- Test: `scratch/merge-check.mjs`, section "reviewed commit".

- [ ] **Step 1:** Write the section, with `autoMerge: 'on'` and a tiny change:
  - **The merge call:** the fake gh saw `pr merge 1 --squash --match-head-commit <decided sha>`, and the `--body` contains `Tandemise-Merge: auto; score 0/2`.
  - **The audit row:** `mergeSha` is set; the ship task is `SUCCEEDED`; the mission is `COMPLETE`.
  - **A push in between (Review Focus 3):** a push to the PR branch between decide and merge (the fake's head moves before `pr merge`) gets the fake's refusal. Then:
    - the first decision has `voidedAt` set;
    - a second decision row has the new SHA;
    - the second merge call carries the new SHA.
  - **`allowAutoMerge: true`:** the merge call includes `--auto`.
  - **Every merge call:** across the whole check run, every `pr merge` call in the log contains `--match-head-commit`.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS.
- [ ] **Step 5:** Commit: `feat: merge only the commit that was decided`.

### Task 17: Revert, and watching main

**Files:**
- Create: `packages/application/src/engine/merge-watch.ts`: `MergeWatch.sweep()`. It's called from `Scheduler#pass` through an optional `watchMerges?: () => void` dep, throttled to once per `MERGE_WATCH_EVERY_MS = 300_000`, in the background like `#syncIssues`.
- Modify: `packages/application/src/services/merge-policy-service.ts`, or a new `ship-actions.ts`. Add `revert(decisionId, caller)`.
- Modify: `apps/daemon/src/routes.ts`. Add `POST /v1/ship/:decisionId/merge` and `POST /v1/ship/:decisionId/revert`.
- Modify: `apps/desktop/src/renderer/src/components/ShipCard.tsx`. "Merged on its own (score 1 of 2)", with factors, the policy ref and **Revert**.
- Create: `scratch/acceptance/planner/suite/pm03.mjs`, `pm04.mjs`, `pm08.mjs`, `pm09.mjs`.
- Test: `scratch/merge-check.mjs`, section "revert and watch".

**Interfaces:**
- **`revert(decisionId, caller)`:**
  - creates a revert mission (`workflowPreset: 'auto'`, title `revert: <original title>`, `laneRequest: null`, the same issue link) whose plan is a single `ship` step over branch `revert/<mergeSha>`, made by `git revert --no-edit <mergeSha>` in a fresh worktree;
  - the revert PR goes through the ship step like any change;
  - its decision adds the fact `process.revert_of_auto: true`, and `decideMerge` treats `revertAutoMerge: 'on'` as `autoMerge: 'on'` for it. `never` rules still apply, so a migration revert asks;
  - records `merge.reverted` and the outcome `reverted` on the original.
- **`MergeWatch.sweep()`:** for each decision with `mergedAt` within `MAIN_WATCH_MS = 86_400_000`, read the check runs on `mergeSha`.
  - **Failure:** record `broke_main` once, and file a `release` card on the original ship task with options `revert` ("Revert") and `leave` ("Leave it"), title `"Main is failing after <PR title> merged"`. Never revert on its own.
  - **Reverts by others:** for merges within 90 days, a base-branch commit whose subject is `Revert "<title>"` records `reverted`, once.
  - **Clean:** after `CLEAN_AFTER_MS = 7 * 86_400_000` with neither, record `merged_clean`.

- [ ] **Step 1:** Write the section and the scenarios:
  - **revert and watch:**
    - `revert` opens PR `revert: fix: typo in the settings title`, and it auto-merges with `--match-head-commit`.
    - A revert touching `db/migrations/x.sql` asks.
    - A failing check on `mergeSha` within 24 h makes one `broke_main` outcome and one card, with no `pr merge` and no `git revert` in the logs. A second sweep adds nothing.
    - A `Revert "fix: …"` commit on `main` records `reverted` once.
    - With the clock moved 8 days (`TANDEMISE_CLOCK_OFFSET_MS` / the test clock), `merged_clean` is recorded once.
  - **PM3:** Project → Merge. Turning the switch on shows `Over the last 90 days this would have merged` before the confirm; after saving, the repository has `.tandemise/factory/merge.yaml` with `autoMerge: on`, and there is a Decision.
  - **PM4:** a tiny fix with CI green. The card reads `Merged on its own`; fake gh saw `pr merge … --squash --match-head-commit <sha>`; the PR comment contains `Tandemise merged this on its own: risk score 0 of 2 allowed`.
  - **PM8:** after the merge decision, the fake `gh` moves the head before `pr merge`. The feed shows `The pull request changed after it was checked; checking again.` and the second decision is on the new SHA.
  - **PM9:** Revert on PM4's card opens and merges a revert PR; the mission's feed shows both.
- [ ] **Step 2:** Run `node scripts/run-checks.mjs merge-check` and `node scratch/acceptance/planner/run-all.mjs --only=pm03,pm04,pm08,pm09`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun both and expect PASS. Run `npm run ci`; add the evidence.
- [ ] **Step 5:** Commit: `feat: revert a merge in one action and watch main after merging`. Open PR 4 titled `feat: auto-merge low-risk pull requests when the owner turns it on`, refs #53.

---

## PR 5: Learning proposals (spec phase 5)

### Task 18: `history.*` facts and the proposal drafter

**Files:**
- Modify: `packages/application/src/engine/ship-measure.ts`. Fill `history.areaReverts90d` and `history.areaRecentRevert` (a revert or `broke_main` in a touched area within `RECENT_REVERT_DAYS = 14`) from `foldOutcomes`.
- Create: `packages/domain/src/brain/proposals.ts`: `draftProposals(stats, current: { planner; routing; merge }, prior: ProposalHistory): Proposal[]`. Pure and code-only.
- Create: `packages/application/src/services/proposal-service.ts`: `ProposalService.sweep()`. Once a day, through the scheduler's background slot, it opens each new proposal as a PR to the **project repository** on branch `tandemise/promote/<id>`, editing `.tandemise/factory/<file>.yaml`, with the evidence (outcomes and their missions as links) and, for merge proposals, the `backtest` from Task 15 computed by the daemon. Task 20 redirects these to the brain repository.
- Test: `scratch/merge-check.mjs`, section "learning never loosens".

**Interfaces:**
- `Proposal = { id: string; file: FactoryFileName; edit: { path: string; from: unknown; to: unknown }; kind: 'tighten' | 'loosen'; evidence: { outcomeIds: string[]; missions: string[] }; title: string }`.
- `draftProposals` rules, from spec §9.2:
  - **Reverts:** at least `PROPOSE_NEVER_AFTER_REVERTS = 2` reverts in an area within 90 days, and the area not already in `never` → add `{ areas: [<area>] }` to `never` (`tighten`).
  - **Holds:** the §5.3 evidence holding across `PROMOTION_MIN_MISSIONS = 3` missions → add `approval: after` to that lane workflow step through a module (`tighten`).
  - **Ladder:** a rung on a ladder with `n ≥ minSamples` and Wilson lower bound `< target / 2` → a proposal to remove it from the ladder (`tighten`).
  
  The drafter never emits `loosen`. Loosening is only a person's edit. A closed-unmerged proposal is not drafted again until its evidence count doubles.
- No code path except `FactoryConfigSourcePort.write` (a person, through `MergePolicyService` or "Write the defaults") and the proposal branch writes a factory file.

- [ ] **Step 1:** Write "learning never loosens":
  - **Reverts:** two `reverted` outcomes in area `payments-ui` → one proposal, `kind: 'tighten'`, adding `{ areas: ['payments-ui'] }` to `never`. Fake gh saw `pr create --head tandemise/promote/<id>` with a body containing both mission links and `Backtest:`.
  - **Random stats:** across 300 random stats tables, no proposal has `kind: 'loosen'`, none raises `autoMergeAtMost`, and none lowers a score's points.
  - **Writes:** a grep-style assertion over `packages/application/dist/**/*.js`. The only call sites of `.write(` on the factory source are in `merge-policy-service.js`, `proposal-service.js` and the factory-defaults route handler.
  - **Re-drafting:** a proposal whose PR was closed unmerged isn't drafted again with the same evidence count, and is drafted again at double the count.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS. Then run `npm run ci`.
- [ ] **Step 5:** Commit: `feat: propose tighter factory rules from outcomes as pull requests`.

### Task 19: Docs and closing out

**Files:**
- Modify: `README.md` and `docs/QUICKSTART.md`. Add short "How much process a task gets" and "Merging" paragraphs.
- Create: `docs/FACTORY.md`. The three files, every key, the shipped defaults, the precedence (project repository → this computer → built in), and the gate facts for rules. Link it from `docs/WORKFLOWS.md`.
- Modify: `AGENTS.md`, the repo-shape list, if a line is warranted (`.tandemise/factory/` until the brain lands).

- [ ] **Step 1:** Update the docs. Run `npm run ci`, and run every acceptance scenario PM1–PM10 once more: `node scratch/acceptance/planner/run-all.mjs`. With `claude` on PATH and no `--skip-claude`, PM1, PM4 and PM6 also run against real Claude Code. Save `docs/superpowers/evidence/2026-10-30-planner/REPORT.md`.
- [ ] **Step 2:** Commit: `docs: the planner and risk-based merge`. Open PR 5 titled `feat: learn from outcomes through reviewed factory proposals`, refs #53 and the evidence. Move #53 on the board when it merges.

---

## Follow-up

### Task 20 (after #51 merges): the brain-backed factory source, outcomes into the ledger, and the Factory screen

**Files** (named against #51's plan; read its merged code before starting):
- Create: `packages/application/src/brain/brain-factory-config-source.ts`, implementing `FactoryConfigSourcePort` over #51's `BrainService`:
  - reads `factory/planner.yaml`, `factory/routing.yaml`, `factory/merge.yaml` at the attempt's pinned brain SHA, with `ref` = that SHA;
  - `write` makes a human-edit commit through #51's `humanEdits` path.
- Modify: #51's codec item kinds. Add `planner`, `routing` and `merge`, structural under #51 §8, carried byte for byte like `tracker.yaml`.
- Modify: `apps/daemon/src/bootstrap.ts`. Bind `FACTORY_CONFIG_SOURCE` to a source that prefers the linked brain, then falls back to `FileFactoryConfigSource`, so a project with no brain keeps working.
- Create: an outcome sink that appends `OutcomeRecorder`'s rows to #51's ledger as the `outcome` op (spec §9.1), and backfills the local `outcomes` table once, idempotent by `OutcomeId`. `foldOutcomes` reads the ledger's fold when a brain is linked.
- Modify: `ProposalService`. Proposals go through #51 §8's promotion path (branch `tandemise/promote/<id>` in the brain repository, structural classification, fate read on sync) instead of the project repository.
- Modify: `packages/domain/src/entities/workspace.ts` handling, per spec §4. A project that links a brain with a `planner.yaml` gets `planApproval: 'auto'` as its default for factory missions. Existing settings are kept.
- Move: `screens/project/Factory.tsx` and `Merge.tsx` into #51's Brain screen ("Factory" part), keeping Project settings → Merge as a link to it.
- Test: extend `scratch/planner-check.mjs` and `scratch/merge-check.mjs` with a "brain source" section over #51's fake brain harness:
  - the same planning and decision results as from the local files;
  - `ref` equals the brain SHA;
  - an outcome appears once in the ledger after a restart.

- [ ] **Step 1:** Write the "brain source" sections and see them fail.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run `npm run ci` and the planner acceptance with a linked brain.
- [ ] **Step 4:** Commit: `feat: read the factory from the brain and write outcomes to its ledger`. Open the PR with the same title, refs #53 and #51.
