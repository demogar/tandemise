# Application Layer Design

The mission engine. This is the part of Tandemise that actually runs an
organization, so its contracts are specified here rather than left to
implementation taste.

## The artifact hand-off protocol (central design decision)

Roles must produce typed artifacts, and this has to work with **any** runtime,
including one that has no tool-calling and no MCP. So the protocol is the
filesystem:

> A worker writes its outputs as Markdown files into `.tandemise/out/` inside
> its working directory, named `<ArtifactType>.md` (e.g. `.tandemise/out/ProductSpec.md`).

The compiled prompt states this explicitly and includes the exact template for
each expected output. After the run ends, `ArtifactHarvester` scans that
directory, parses and validates each file, stores it via `ArtifactStorePort`,
and records the manifest.

Why this and not tool calls: it is runtime-agnostic (the whole thesis), it
survives a crashed run (the file is already on disk), it is inspectable by the
user in Finder, and it needs no protocol negotiation. The cost is that a worker
can forget to write a file — which is exactly what the completion gate
`artifact.X.exists` catches, turning a soft failure into a hard, retryable one.

`.tandemise/` is added to the worktree's `.git/info/exclude` so agent outputs
never pollute the diff.

## Task lifecycle

`TaskExecutor.execute(task)` runs one attempt:

1. **Admission** — acquire a concurrency slot; acquire any required
   `ResourceLease` (the repository branch, an exclusive app). Contention means
   "try again next tick", not an error.
2. **Routing** — `RuntimeManager.select(workspace.routing[roleId], task.requiredCapabilities)`.
   No healthy candidate ⇒ task goes `BLOCKED` with a reason naming what was
   missing. Never silently substitute a runtime the routing policy excluded.
3. **Target** — `ExecutionTargetManager.provision({ kind: task.executionPolicy.isolation, ... })`.
4. **Grants** — `GrantBuilder.build(role, task, workspace, target)`. Least
   privilege; scoped to the target working directory and the mission artifact root.
5. **Assignment** — persist a `WorkerAssignment` binding role+runtime+target+grants.
6. **Context** — `ContextCompiler.compile(...)` with the dependency artifacts,
   accepted decisions, and the output templates. Untrusted content is delimited.
7. **Run** — create the `Run` row, then consume `adapter.start(request)`.
   Every event is normalized, persisted through `EventRepositoryPort`, and
   published on the `EventBusPort`. `checkpoint` events update the run's
   `externalSessionId` immediately — that is what makes resume possible.
8. **Harvest** — collect artifacts from `.tandemise/out/`.
9. **Commit** — for a worktree task, commit anything the worker left uncommitted
   with an attributable message, and record branch/commit as `ExternalRef`s on
   the ChangeSet.
10. **Check** — run the repository's configured checks in the target; each
    becomes a `CheckResult`.
11. **Gate** — build `GateFacts`, evaluate `task.completionGate`.
    - pass ⇒ `SUCCEEDED`
    - fail and attempts remain ⇒ retry with the gate's `detail` fed back into the
      next attempt's prompt (this is the single highest-value feedback loop in
      the system — the worker is told exactly which condition it failed)
    - fail and attempts exhausted ⇒ `retryPolicy.onExhausted`
12. **Approval** — if `approvalPolicy.onCompletion`, create the approval and hold
    the task in `AWAITING_APPROVAL` until it is decided.
13. **Release** — release leases and, for a worktree, leave the branch intact
    (it is the reviewable artifact). Never discard uncommitted work silently.

## Loopback: findings become work

`RemediationPlanner` runs after any task that produced a `ReviewReport` or
`QAReport`:

- Blocking review findings ⇒ insert a `development` task keyed
  `fix_<source>_<n>`, depending on the review task, with `remediatesTaskId` set,
  whose objective enumerates the findings verbatim. Then insert a re-review task
  depending on the fix. Downstream tasks (QA, release) are re-pointed to depend
  on the re-review.
- Blocking QA defects ⇒ the same shape, back to development then re-QA.
- A loop guard: at most 3 remediation cycles per source task, then the mission
  goes `BLOCKED` with an intervention approval. Endless fix/review ping-pong is
  a real failure mode and must be bounded.

Dynamic insertion must keep the DAG acyclic — validate after every mutation.

## Integration branch (MVP.md §11.3)

When more than one worktree task succeeds, `IntegrationService` merges task
branches into the mission integration branch in `topologicalOrder`. A conflict
does NOT get auto-resolved: it creates a `development` task whose objective is
the conflict, with the conflicted paths listed.

## Recovery (MVP.md §21.2)

`RecoveryService.run()` at daemon startup, before the scheduler starts:

1. Verify migrations.
2. Acquire the single-instance lock.
3. Find runs in `STARTING`/`RUNNING`.
4. For each, check whether the pid is alive. Alive and adoptable ⇒ leave it.
   Otherwise: if the adapter supports resume and the run has an
   `externalSessionId` ⇒ `RESUMABLE`; else ⇒ `INTERRUPTED`.
5. Interrupted/resumable runs put their task back to `READY` (attempt preserved)
   so the scheduler picks it up under the normal retry policy.
6. Release leases whose holder run is not alive. Verify before releasing.
7. Mark orphaned `PROVISIONING` targets `FAILED`.
8. Rebuild projections and emit a `note` event on each affected mission so the
   user can see in the timeline that a recovery happened.

## Idempotency (MVP.md §21.3)

Any integration write that can create a duplicate external object records the
external id immediately. Before retrying a create, `verify-before-retry`:
look for the object first. The GitHub PR creation path must do this.

## Services to build

| Service | Responsibility |
|---|---|
| `WorkspaceService` | create/update workspaces, add repositories (with probing), seed built-in roles |
| `MissionService` | create, plan, start, pause, resume, cancel, delete; status transitions via `canTransition` |
| `PlanningService` | run the planner role, parse+validate, fall back to the preset when planning fails, create the plan-approval |
| `SchedulerService` | the tick loop; admission, dispatch, and lifecycle bookkeeping |
| `TaskExecutor` | one attempt, per the lifecycle above |
| `ArtifactHarvester` | collect + validate + store `.tandemise/out/` |
| `CheckService` | run repository checks in a target, produce `CheckResult`s |
| `GateService` | build facts, evaluate task + named gates |
| `RemediationPlanner` | findings ⇒ tasks |
| `IntegrationService` | merge task branches into the integration branch |
| `ApprovalService` | create, list, decide; resume whatever was waiting |
| `RecoveryService` | startup recovery |
| `RuntimeService` | discovery, profile CRUD, health |
| `ProjectionService` | assemble the `api-contract` view models |
| `MetricsService` | compute `MissionMetrics` |

## Rules

- Services take their dependencies through the constructor, resolved from the
  container. No service reaches for a global.
- The scheduler must be **crash-safe at every await**: persist the state
  transition *before* the side effect it authorizes, never after.
- Never mutate a mission's goal or acceptance criteria (MVP.md §9.4).
- Every status transition emits an `OrchestrationEvent` so the timeline is a
  complete causal record.
