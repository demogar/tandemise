# P3 Implementation Plan — Engine/Service Entry Points

## 1. Planning

**`packages/application/src/services/planning-service.ts`** — `class PlanningServiceImpl implements PlanningService`.

Public surface:
- `plan(id: MissionId): Promise<MissionDetail>` — synchronous entry, calls `#enterPlanning` then `#planFrom`.
- `begin(id: MissionId): Promise<MissionDetail>` — sets PLANNING, runs planning in background (`#inBackground`), returns the projection immediately.
- `resumeInterrupted(): readonly MissionId[]` — re-plans missions stranded in `PLANNING` by a dead daemon.

Flow: `#enterPlanning` guards with `canTransition(status, 'PLANNING')`, cancels pending `plan` approvals, then `#setStatus(…, 'PLANNING', …)`. `#planFrom` resolves the workspace/repository/roles/repositories, then:
1. `#authoredWorkflow(...)` — compiles the team's own workflow (`compileWorkflow`) and materializes it directly (`materializePlan`), skipping the model.
2. Otherwise `findPreset(mission.workflowPreset || DEFAULT_PRESET_ID)` and `#producePlan(...)`, which runs the planner ladder (`#planWith`), up to `MAX_PLANNER_ATTEMPTS = 2`, falling back to the preset on any failure.
3. `materializePlan(outcome.plan, mission.id, clock, repositories, { inferInputs: true })` then `tasks.replaceAll`, `#storePlanDocument`, and `#requestApprovalOrAccept`.

**Planner prompt** — `buildPlannerPrompt(input: PlannerPromptInput): string` in **`packages/application/src/planning/prompt.ts`**. Input carries `mission`, `repository`, `repositories`, `roles`, `preset`, `availableCapabilities`, `repositoryContext`, `connectedApps`. The prompt enumerates roles, artifact types (`ARTIFACT_TYPES`), capabilities, the preset JSON, structural rules, and — key for P3 — a **"Steps that are not an agent"** section describing `"executor": "wait"` and `"executor": "human"`. An intake/"skipped" instruction would be inserted here. `#prompt(...)` in planning-service wraps `buildPlannerPrompt` and, on attempt 2, appends `# Your previous attempt was rejected` with verbatim validator issues.

**Parsing** — **`packages/application/src/planning/parse.ts`**: `parsePlanResponse(response: string): Result<MissionPlan, readonly string[]>`. Zod `plannedTask` schema (with `executor: z.enum(['agent','human','wait']).default('agent')`, `waitFor`, `everyMs`, `timeoutMs`), then maps to `PlannedTask`: wait→`WAIT_ROLE_ID`, human without role→`HUMAN_ROLE_ID`, else `'agent'`; builds `waitPolicy`; forces `executionPolicy.isolation: 'none'` for parked tasks. Also `extractPlanJson` (in prompt.ts) and `describePlan`.

**Validation** — **`packages/domain/src/plan.ts`**: `validateMissionPlan(plan: MissionPlan, ctx: PlanValidationContext): Result<MissionPlan, readonly PlanValidationIssue[]>`. `PlanValidationContext` has `knownRoleIds`, `satisfiableCapabilities`, and **`preexistingArtifacts?: ReadonlySet<ArtifactType>`** — used only in the required-input check: a `required: true` input that is in `preexistingArtifacts` is skipped (`if (!req.required || preexisting.has(req.type)) continue;`). Note: the planning-service **does not currently pass `preexistingArtifacts`** — its `context` object has only `knownRoleIds`, `satisfiableCapabilities`, `knownRepositoryNames`. P3 uploads must thread `preexistingArtifacts` through `#planWith`'s `context` into `validateMissionPlan`. Also exported: `findCycle`, `transitiveDependencies`, `topologicalOrder`, `planLevels`.

**Materialize** — **`packages/application/src/planning/materialize.ts`**: `materializePlan(plan, missionId, clock, repositories = [], options: { inferInputs?: boolean })` → `MissionTask[]`. `fromPlanned` sets `status: dependsOn.length === 0 ? 'READY' : 'PENDING'`, `executor`, `waitPolicy`, `orderHint`. Also `planTitle`, `renderPlanDocument`, `clip`.

## 2. Mission service

**`packages/application/src/services/mission-service.ts`** — `class MissionServiceImpl implements MissionService`.

**`create(caller: Caller, request: CreateMissionRequest): Promise<Mission>`** — resolves `actorFor(...)` → `actorId` before writing; resolves repository (defaults to `workspace.defaultRepositoryId`); `mergeRoleStaffing` + `assertStaffing`; `missions.create({ id, workspaceId, repositoryId, title, goal, constraints, successCriteria, autonomy, workflowPreset, workflowInputs, baseBranch, createdBy: actorId, staffing })`; then updates `integrationBranch`; records note. If `request.planNow === true`, calls `planning.begin(id)`. **Uploads would be injected here (or in a new pre-plan step) so they exist as artifacts before `planning.begin` and can seed `preexistingArtifacts`.**

**`completeTask(caller, taskId, request: CompleteTaskRequest): Promise<TaskView>`** — the hand-back template. Order:
1. `#requireTask`/`#require`; guard `task.executor === 'human'` (else `PRECONDITION_FAILED` "runs on a runtime"); guard `task.status === 'AWAITING_HUMAN'`.
2. `actorFor(deps, workspaceId, caller, request.onBehalfOf)` → `{ actorId, recordedBy }`.
3. `#assertMayTake(task, actorId, 'complete')`; `#claimFields` if not already the assignee (`{ assigneeId, responsibleId? }`); `#noteTaken` if reassigned.
4. `handoff = measure.deriveHandoff(request.result)`; for each `task.expectedOutputs`: `supersededBy(task, type, artifacts, tasks)` → `previous`; `artifactStore.write({… taskId, type, title, body: request.result, mediaType: 'text/markdown', summary: handoff.headline, supersedes: previous?.id ?? null })`; then `artifacts.create({ ...manifest, authorId: actorId, recordedBy, responsibleId, handoff, wordCount, overBudget: false, round: task.round ?? 1 })`; record `artifact.created`.
5. `rounds.onPersonCompleted(task, scope)`.
6. `reviews.onRoundPassed({ task: { ...task, ...taken }, mission, workspace, role: roles.get(task.roleId, workspaceId), gate: null, checks: [], scope })` → `outcome` (`Settled`, either `{ kind:'settled', status:'SUCCEEDED'|'AWAITING_APPROVAL', reason }`).
7. `tasks.update(taskId, { ...taken, status: outcome.status, statusReason, finishedAt? })`; record `task.status`; invalidate; `scheduler.wake()`.

Also relevant: `claimTask`, `skipTask`, `retryTask` (with `feedbackEffectFor` round-start logic), `#holdDependents`, `#reviveMission`, `#transition` (via `canTransition`).

## 3. Scheduler

**`packages/application/src/engine/scheduler.ts`** — `class SchedulerService implements LifecycleComponent`.

**`#startWait(mission: Mission, task: MissionTask): void`** (private): if `task.waitPolicy === null` → BLOCKED "names nothing to wait for". Otherwise creates `AbortController`, stores in `#waiting` map, `#setStatus(..., 'AWAITING_EXTERNAL', 'Waiting: <command>')`, resolves repository (task's or mission's), then `waiter.wait(task, policy, repository, controller.signal).then(outcome => …)`: `passed` → SUCCEEDED; else FAILED; `cancelled` → no-op; catch → BLOCKED; finally deletes from `#waiting`.

**Re-adoption** — in `#dispatchFor`, before the ready loop: `for (task of tasks) if (task.status === 'AWAITING_EXTERNAL' && task.executor === 'wait' && !this.#waiting.has(task.id)) this.#startWait(mission, task);`. **A parked non-`wait` task in `AWAITING_EXTERNAL` (e.g. a new "external hand-back" executor) has no such re-adoption path** — the loop only matches `executor === 'wait'`. P3 must either extend this guard or add a parallel re-adoption branch.

Dispatch ordering in `#dispatchFor`: human tasks → `#setStatus(…, 'AWAITING_HUMAN', waitingReason(…))`; wait tasks → `#startWait`; agent tasks → concurrency ceiling (`#occupiedSlots` vs `workspace.concurrency.maxTotalWorkers`) then `#dispatch` → `executor.execute(taskId, signal)`.

Also: `#promoteReady` (PENDING→READY/BLOCKED, resolving staffing via `#resolveStaffing` → `staffing.snapshot`), `#settled` (ReviewReport/QAReport loopback → `rounds.fromReviewFindings` → `remediation.plan`), `#reconcile`/`#finish` (integration via `integration.integrate`, then COMPLETE). Statuses: `ACTIVE_TASK_STATUSES = ['READY','RUNNING','AWAITING_INPUT','AWAITING_HUMAN','AWAITING_EXTERNAL','AWAITING_APPROVAL']`; `PARKED_TASK_STATUSES` (isTaskParked) in `packages/domain/src/entities/task.ts`.

## 4. Harvesting & artifact writes

**`packages/application/src/engine/harvester.ts`** — `class ArtifactHarvester`.

`harvest(request: HarvestRequest): Promise<HarvestResult>` iterates `outDirFor(task)` then `ARTIFACT_OUT_DIR` (`.tandemise/out`), collecting `*.md` files whose basename is a recognized `ArtifactType`, calling `#collectOne`. **The exact write function is `#collectOne(request, type, path)`** (private async): reads file → `parser.parse` → `roundContract` check (`checkRoundHandoff`) → `measure.measure` → `#unchanged` check → computes `supersededBy(request.task, type, artifacts, tasks)` (or `artifacts.latest` if no tasks port) → `store.write({ workspaceId, missionId, taskId, createdByRunId: request.runId, type, title, body: source, sourceRefs, supersedes: previous?.id ?? null, summary })` → **`artifacts.create({ ...manifest, authorId: request.authorId ?? RUNTIME_ACTOR, responsibleId: request.task.responsibleId ?? null, recordedBy: SYSTEM_ACTOR, handoff, wordCount, overBudget, round: request.task.round ?? 1 })`** → optional `evaluations.createEvaluation` → record `artifact.created`.

`HarvestRequest` fields: `mission, task, target, runId, roleId, scope, sourceRefs, authorId?`, `revising?`, `roundContract?`. `HarvestResult`: `manifests, missing, issues, unanswered, filesChanged?, overBudget`. Also `outDirFor(task)`, `prepare(target, scope, task)` (clears task dir, writes `.tandemise/.gitignore`, excludes from git).

**`packages/application/src/engine/task-executor.ts`** — `class TaskExecutor`. `execute(taskId, signal): Promise<TaskAttemptOutcome>`; `#run` → routing/`runtimeManager.select` → `#runRouted` → grants/`#vet` → assignment → MCP provision → `harvester.prepare` → `rounds.openRound(running)` → `#compilePrompt` → `#drive` → `#commit` → **`harvester.harvest({ mission, task, target, runId, roleId, scope, sourceRefs: refs, authorId: agent?.id ?? RUNTIME_ACTOR, roundContract })`** → `checks.run` → `#assess`/`#judge` (gate + `reviews.onRoundPassed`) → tighten pass via `#tighten` (re-harvests with `revising`). `rounds.onRoundLanded(running, final.manifests, scope)` on pass. An **intake task** (if modeled as an `agent`/new executor) would flow through `#runRouted`'s harvest path; a person's intake flows through `completeTask` (§2).

## 5. Feedback rounds & service

**`packages/application/src/engine/feedback-rounds.ts`** — `class FeedbackRounds`.

- `record(input: RecordFeedbackInput): FeedbackItem` — writes feedback (`ids.feedback()`, statuses `open`/`queued`), records `feedback.given`.
- `impactOf(task): DownstreamImpact` — consumers via `downstreamConsumers`.
- `beginRound(input: StartRoundInput): RoundBegun` — guards `ROUND_START_STATUSES` and `missionTakesRounds`; validates `feedbackIds` open; computes `redoSet`; one transaction that sets `round`, status `READY`, `retryPolicy.maxAttempts = attempts + ROUND_ATTEMPTS`, withdraws pending approvals, `#redo`/`#holdReady`, `#revive`. `StartRoundInput`: `{ task, feedbackIds, downstream: 'redo'|'keep'|'none', redoTaskIds?, actorId, keepCardId?, alsoRedo? }`.
- `startRound(input)` = `beginRound` + `stopOvertaken(begun)`.
- `openRound(task): Promise<RoundBrief | null>` — promotes open→`in_round`, builds brief (previous artifacts + notes).
- `onRoundLanded(task, manifests, scope): void` — cited notes → `addressed` (declined detection), `#flagKeptConsumers`.
- `onPersonCompleted(task, scope): void` — every `open`/`in_round` note → `addressed` (declined: false); flags kept consumers.
- Others: `promoteQueued`, `requeue`, `releaseStranded`, `roundContract(task, brief): RoundContract`, `fromReviewFindings(review, mission): ReviewRouting`, `decideReviewCard`.

**`packages/application/src/services/feedback-service.ts`** — `class FeedbackServiceImpl`. `give(caller, taskId, request, options)`, `beginGive(...): PendingFeedback` (resolves `actorFor`, `feedbackEffectFor`, may `record` only or `beginRound`), `afterGive(pending)`, `startRound(caller, taskId, request): TaskView`, `list`, `dismiss`. **A hand-back can be modeled as a human-authored round: `record` + `beginRound` (or `onPersonCompleted` for completion semantics) using the same `FeedbackRounds` primitives.**

## 6. Identity

**`packages/application/src/support/identity.ts`**:

- `interface Caller { readonly personId: PersonId }`.
- `requireSeat(deps: { members }, workspaceId, caller): Member` — `members.findPersonMember`, throws `PERMISSION_DENIED` if absent/inactive.
- `actorFor(deps: { members }, workspaceId, caller, onBehalfOf?): { actorId: MemberId; recordedBy: MemberId }` — principal = `requireSeat`; if no `onBehalfOf` (or equals principal) returns `{ actorId: principal.id, recordedBy: principal.id }`; else validates subject is an active person member of the workspace and returns `{ actorId: subject.id, recordedBy: principal.id }`.
- `class LocalIdentity implements IdentityPort` — `localPerson(): Person` (first person, or mints one). `DEFAULT_LOCAL_PERSON_NAME = 'You'`.

Actor constants (`packages/domain/src/entities/member.ts`): `SYSTEM_ACTOR = 'system'`, `RUNTIME_ACTOR = 'system:runtime'`. These are what `authorId`/`recordedBy` fall back to for engine/runtime-initiated writes (harvester uses `recordedBy: SYSTEM_ACTOR`, `authorId: authorId ?? RUNTIME_ACTOR`; planning document uses `authorId: RUNTIME_ACTOR`, `responsibleId: mission.createdBy`).

## Key takeaways for P3

- **Uploads → artifacts**: write via `artifactStore.write` + `artifacts.create` (see harvester `#collectOne` / mission-service `completeTask`), then surface as `preexistingArtifacts` to `validateMissionPlan` (currently unthreaded in `#planWith`).
- **Intake instruction** belongs in `buildPlannerPrompt` (prompt.ts), alongside the existing "Steps that are not an agent" section; "skipped" maps to `skipTask` / `SKIPPED` status (counts as satisfied for dependents).
- **Hand-back** generalizes `completeTask` (guard `executor`, `actorFor`, `artifacts.create`, `rounds.onPersonCompleted`, `reviews.onRoundPassed`, status write, `scheduler.wake`) — a new executor (or reusing `human`) must be re-adopted in `#dispatchFor` and parked without a worker slot (cf. `#startWait` and the `AWAITING_EXTERNAL` re-adoption loop, which currently only matches `executor === 'wait'`).
