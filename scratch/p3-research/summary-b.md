# Mission/Task Domain Model, Statuses, and Planning Flow

## 1. Task status enum

Defined in `packages/domain/src/entities/task.ts:9-17`:

```
PENDING, READY, RUNNING,
AWAITING_INPUT, AWAITING_HUMAN, AWAITING_EXTERNAL, AWAITING_APPROVAL,
BLOCKED, SUCCEEDED, FAILED, SKIPPED, CANCELLED
```

Meanings (from inline comments):
- **PENDING** — dependencies not yet satisfied
- **READY** — eligible to be scheduled
- **RUNNING** — a worker is on it
- **AWAITING_INPUT** — running, but blocked on a question it asked a human
- **AWAITING_HUMAN** — a person has to do this one (`executor: human`)
- **AWAITING_EXTERNAL** — polling something outside this machine (`executor: wait`)
- **AWAITING_APPROVAL** — waiting on a human approval decision
- **BLOCKED** — needs human intervention or an unmet gate
- **SUCCEEDED / FAILED / SKIPPED / CANCELLED** — terminal

**AWAITING_EXTERNAL exists.** It was added in `packages/persistence/src/migrations/006_task_park_statuses.ts` (alongside `AWAITING_INPUT` and `AWAITING_HUMAN`) as "a step polling something off this machine." It is currently used *only* for `executor: 'wait'` tasks — the scheduler sets it in `packages/application/src/engine/scheduler.ts:344` when a `wait` step begins polling, and re-adopts any `wait` task left `AWAITING_EXTERNAL` by a previous daemon (`scheduler.ts:275-280`).

Three derived sets live beside the enum:
- `ACTIVE_TASK_STATUSES` (`task.ts:20-21`) — READY, RUNNING, and the four "awaiting" states
- `PARKED_TASK_STATUSES` (`task.ts:39-40`) — the four awaiting states; "parked on something that is not this machine's to hurry: a person, or the outside world." The scheduler excludes these from the concurrency ceiling (`scheduler.ts:322-328`).
- `FINISHED_TASK_STATUSES` (`task.ts:46`) — SUCCEEDED, FAILED, SKIPPED, CANCELLED

Note: **AWAITING_EXTERNAL is not currently used for external hand-backs** — only for `wait` polling. The roadmap (`docs/superpowers/specs/2026-09-13-collaboration-roadmap.md:101`) explicitly earmarks it for P3: "‘I'll continue there' parks the task (`AWAITING_EXTERNAL`)."

## 2. Mission/task/run/round/member/artifact model

All entities are in `packages/domain/src/entities/`.

**Mission** (`mission.ts`):
- `MISSION_STATUSES` (`:5-8`): DRAFT, PLANNING, AWAITING_PLAN_APPROVAL, EXECUTING, REVIEWING, QA, READY_TO_SHIP, RELEASED, OBSERVING, COMPLETE, BLOCKED, PAUSED, FAILED, CANCELLED. `TERMINAL_MISSION_STATUSES` = COMPLETE/FAILED/CANCELLED.
- `TRANSITIONS` map (`:22-48`) centralizes legal moves; `COMPLETE → EXECUTING` is allowed for recovery.
- `Mission` fields (`:58-96`): `id, workspaceId, repositoryId, title, goal` (verbatim user intent), `constraints[], successCriteria[], status, autonomy` (supervised/balanced/autonomous), `workflowPreset, workflowInputs` (Record<string,string>), `integrationBranch, baseBranch, statusReason, createdBy, staffing` (per-role `RoleStaffing`), timestamps.
- `MissionDraft` (`:98-110`) is the creation shape.

**Task** (`task.ts`): the `MissionTask` interface (`:104-194`) carries `id, missionId, repositoryId|null, executor` (`agent|human|wait`, `TASK_EXECUTORS` at `:7`), `waitPolicy|null` (`WaitPolicy { command, everyMs, timeoutMs }` at `:51-58`), `key` (stable plan-author key, unique per mission), `title, objective, roleId, dependsOn[]` (keys), `requiredCapabilities[], inputArtifacts[]` (`ArtifactRequirement { type, required }`), `expectedOutputs[]` (artifact types), `executionPolicy` (`{ isolation: none|worktree|docker|browser, maxWallTimeMs, capabilities }`), `approvalPolicy` (`{ beforeStart, onCompletion, reason? }`), `retryPolicy` (`{ maxAttempts, backoffMs, onExhausted: block|fail }`), `completionGate` (`GateExpression|null`), `status, statusReason, retryFeedback, staffing` (snapshot), `staffingOverride, assigneeId, responsibleId, needsAttention, round, attempts, remediatesTaskId, orderHint`, timestamps.

**Run** (`run.ts`): `RUN_STATUSES` (`:5-11`) = STARTING, RUNNING, SUCCEEDED, FAILED, CANCELLED, INTERRUPTED, RESUMABLE. `Run` has `missionId, taskId, assignmentId, attempt, round, purpose` (`RUN_PURPOSES` in `feedback.ts:12` = `round|tighten|feedback|retry`), `externalSessionId` (opaque runtime session handle enabling resume), `pid, exitCode, errorCode, errorMessage, usage`, timestamps, `agentMemberId`. `Checkpoint` (`:69-76`) is a durable restart point.

**Round** — there is *no* `round` entity/table. "Round" is a plain integer column (`round?: number`) on Task, Run, Artifact, and FeedbackItem, added in migration 010. Round 1 is the first pass; feedback and tightening happen *within* a round rather than starting a new one.

**Member** (`member.ts`): `Person` (workspace-independent identity, `handles` for external ids) vs `Member` (a seat in one workspace's org chart, kind `person|agent`, `personId|null` for agents, `reportsTo`, `access` `owner|admin|member|guest`, `oversight` `delegate_owns|both_sign_off`, `roleIds, runtimeProfileIds, integrationIds`). `SYSTEM_ACTOR='system'` and `RUNTIME_ACTOR='system:runtime'` (`:30-34`). Agents act on their owner's authority (NIP-AA), so `access: null`.

**Role** (`role.ts`): a `RoleTemplate` is an organizational responsibility (not a runtime/persona): `name, summary, instructions, defaultCapabilities, producesArtifacts[], consumesArtifacts[], defaultIsolation, outputContract`. Built-in ids: `product, design, architecture, development, review, qa, release, finance`.

**Artifact** (`artifact.ts`): `ARTIFACT_TYPES` (`:9-15`) = ProblemBrief, ProductSpec, DesignBrief, ArchitecturePlan, ImplementationPlan, ChangeSet, ReviewReport, QAPlan, QAReport, ReleaseCandidate, DecisionRecord, FinanceReport, Evidence, MissionPlan. `ArtifactHandoff` (`{ headline, points, needs, changed[], links[] }` with `HANDOFF_LINK_KINDS` workspace/preview/pr/doc/other). `ExternalRef` (`:65-69`) points at `git.commit|git.branch|github.pr|github.issue|url|file`. `ArtifactManifest` has `contentRef` (workspace-relative path or `sha256:` ref), `mediaType, sha256, byteSize, sourceRefs[], supersedes, handoff, wordCount, overBudget, round, withdrawnAt`, and attribution (`authorId, responsibleId, recordedBy`). A `file` ExternalRef kind already exists — the only current file-pointer concept.

## 3. Planning: production and materialization

Four files in `packages/application/src/planning/` plus `packages/domain/src/plan.ts`.

- **`presets.ts`** — three built-in `WorkflowPreset`s (`feature-delivery`, `bug-investigation`, `quick-change`), each a `build(): MissionPlan`. A preset is a "starting shape, not a fixed pipeline" — the planner adapts it.
- **`prompt.ts`** — `buildPlannerPrompt` hands the model: the mission goal/constraints/successCriteria, the repository (name, path, default branch), the list of *other* repositories (a task may name any of them), the role catalogue, the exact `ARTIFACT_TYPES` vocabulary, available capabilities, connected apps, and the preset JSON as a starting point. **It explicitly tells the planner it may skip a stage:** "Drop a phase that this mission genuinely does not need… say so by omitting it rather than creating a token task" (`prompt.ts`, "The starting shape" section). It also documents `executor: wait` and `executor: human` ("what they paste becomes the step's `expectedOutputs` artifact").
- **`parse.ts`** — `parsePlanResponse` does shape validation via zod (`plannedTask`/`missionPlan` schemas). `executor` defaults to `agent`; `wait` requires `waitFor`; `human`/`wait` get `isolation: none` and their placeholder role ids. Unknown keys are stripped, not rejected.
- **`materialize.ts`** — `materializePlan` turns the accepted plan into `MissionTask` rows: tasks with no deps start `READY`, the rest `PENDING`; `orderHint` preserves planner order. **Repository resolution** (`resolveRepository`, `:56-63`) matches the task's `repository` *name* case-insensitively against project repositories, else null (inherits mission's). `inferInputs` (default-on for model plans) makes a task with no declared inputs read its direct dependencies' outputs.
- **`plan.ts`** (`validateMissionPlan`) — the coherence layer: acyclic DAG, every required input produced by a transitive dependency, every role known, capabilities satisfiable, gates parse, repository names known. Errors reject wholesale; warnings (orphan outputs) don't. `preexistingArtifacts` lets validation accept inputs already produced in a prior run.

**Workflow files** (`packages/domain/src/workflow.ts`) are the authored alternative: a YAML workflow compiles via `compileWorkflow` to the *same* `MissionPlan` shape (steps declare `key, objective, executor: agent|human|wait, waitFor, role, dependsOn, repository, isolation, capabilities, outputs, inputs, gate, approval, maxWallTimeMs, maxAttempts`), inheriting the DAG/validator/scheduler unchanged. Inputs are `{{ placeholder }}`-templated strings.

## 4. How external input reaches a mission/task today

**Mission creation** — `createMissionRequest` in `packages/api-contract/src/requests.ts:72-96`: `workspaceId, repositoryId, goal` (the single natural-language sentence, 3–8000 chars), `title, constraints[] (max 50), successCriteria[] (max 50), autonomy, workflowPreset, workflowInputs (Record<string,string>), baseBranch, planNow, onBehalfOf, staffing`. **There are no upload/attachment/file fields.** Input is text-only.

**Human task completion** — `MissionService.completeTask` (`packages/application/src/services/mission-service.ts:396-490`): only for `executor: 'human'` tasks in `AWAITING_HUMAN`. The person's typed `request.result` is written as an artifact (one per `expectedOutputs` type, `mediaType: text/markdown`), with a derived handoff ("People are not made to fill in YAML: their first sentence is the headline"). No file/link attachment path — only free text.

**`ask_human`** (`packages/application/src/tools/ask-human.ts`) — a running agent can park itself (`AWAITING_INPUT`) to ask a question; the person answers in text, and the run unpauses.

**Attachments** — the only "attachment" concept is `FeedbackAttachment` in `packages/domain/src/entities/feedback.ts:13`, literally commented **"Reserved for P3 (uploads, hand-backs); always empty in P2"** and typed as `Readonly<Record<string, unknown>>`. Feedback items always have `attachments: []` today (`feedback-rounds.ts:128`). No upload/file handling exists in `apps/desktop` or `packages/application` (grep for `upload`/`attach`/`file` returns only unrelated uses like "attach" feedback effect kinds and "file" ExternalRef kinds).

## 5. Existing "intake" / "hand-back" concept

There is **no implemented intake or hand-back**. The concept exists only as forward-looking design:

- `docs/superpowers/specs/2026-09-13-collaboration-roadmap.md` (the agreed direction):
  - Scenario #2/#3 (`:36-37`): "brings their own work… Uploads, skipping stages that are already covered, continuing in their own tool and handing back"; "hand-backs via links or PRs."
  - Principle 2 (`:52-53`): "Agent rounds, human rounds, uploads, external hand-backs and feedback all use the same handoff contract. Each carries an author."
  - Principle 5 (`:57-59`): "Tandemise owns the state (ADR 0001). When work happens in an external tool, handing it back pins a snapshot."
  - Decisions (`:95-105`): "**Uploads** are accepted at mission creation, on feedback, and as hand-backs. An intake task turns them into typed artifacts. The planner may skip a stage that an upload already covers, but it has to say so in the plan." And "**External hand-back.** 'I'll continue there' parks the task (`AWAITING_EXTERNAL`). Handing back a link or file creates a human-authored round. The integration snapshots the referenced version into Evidence. If no integration can read the link, an attached export is required."
  - P3 = "Outside contributions: uploads, hand-backs with snapshots", depends on P0+P2 (`:175`).
- `docs/superpowers/specs/2026-09-14-p1-handoff-feed-design.md:22`: "Hand-backs, uploads and snapshots → P3."
- `docs/superpowers/specs/2026-09-14-p2-feedback-rounds-design.md:27`: "Uploads, hand-backs from external tools, and snapshots → P3. The feedback shape reserves `attachments` for them."
- `docs/superpowers/specs/2026-09-13-p0-members-responsibility-design.md:20`: "Take-over and hand-back → P3."

So P3's hooks already exist (reserved `attachments`, `AWAITING_EXTERNAL`, `file` ExternalRef kind, `Evidence` artifact type, `preexistingArtifacts` validation), but nothing is built.

---

## Implications for P3

1. **AWAITING_EXTERNAL is ready to reuse but currently means "polling a `wait` command."** P3's "I'll continue elsewhere" hand-back must extend its meaning beyond `executor: 'wait'` (which has a `waitPolicy` and a poller). The scheduler's `#startWait` adoption logic (`scheduler.ts:275-280`) keys off `executor === 'wait'`, so a hand-back that sets `AWAITING_EXTERNAL` on a non-wait task needs a distinct re-adoption path. Consider a new `executor` value or a hand-back-specific mechanism rather than overloading `wait`.

2. **"Intake task" and "skip a stage" are already supported primitives.** The planner can omit phases (prompt + validation tolerate it), and `preexistingArtifacts` in `validateMissionPlan` (`plan.ts`) already lets a required input be satisfied by something that exists before planning — exactly what an uploaded/typed artifact would be. P3 needs to (a) feed uploaded artifacts into `preexistingArtifacts`, and (b) get the planner to *say* it skipped a stage (a new prompt instruction + likely a plan field/artifact annotation).

3. **Uploads need a first-class ingestion path that doesn't exist.** Today `completeTask` and `createMissionRequest` accept text only. The natural seam is `FeedbackAttachment` (already reserved) and the `ArtifactWriteRequest`/`ExternalRef.kind: 'file'`. An "intake task" would be a normal task (probably `executor: 'human'` or a new executor) that turns an uploaded blob/link into typed artifacts via `ArtifactStore.write`, reusing the manifest/attribution (`authorId/recordedBy/responsibleId`) model — note the roadmap's rule that uploads "carry an author."

4. **Hand-back = a human-authored round + a snapshot.** Rounds are just integer fields today (no round entity); the roadmap says a hand-back "creates a human-authored round." P3 must decide how a link/file handed back becomes an artifact (`Evidence` per principle 5), likely reusing the `HANDOFF_LINK_KINDS` `workspace`/`preview`/`pr` kinds and `ExternalRef`. Snapshotting needs an integration to read the external tool and pin a version into `Evidence` — an integration capability that does not exist yet.

5. **Attribution is already modeled but must extend to external actors.** `ActorId` supports `system:runtime`/`system`; an external human without a seat needs a `Person`/`Member` (possibly a `guest`) or an on-behalf-of (`onBehalfOf` is already threaded through creation and completion). The `recordedBy` field on artifacts (`artifact.ts:90`) is explicitly designed for "a person uploads for an agent."
