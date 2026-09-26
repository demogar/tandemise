import type {
  ApprovalRepositoryPort, ArtifactRepositoryPort, MemberRepositoryPort, Mission, MissionCriteriaRepositoryPort, MissionRepositoryPort, MissionStatus,
  MissionTask, RepoRepositoryPort, RoleRepositoryPort, RunRepositoryPort, TaskRepositoryPort, UnitOfWork, WorkspaceRepositoryPort,
  ArtifactStorePort,
} from '@tandemise/domain';
import { canTransition, indexTeam, isTaskFinished, isTerminalMissionStatus, responsibleFor } from '@tandemise/domain';
import type {
  ClaimTaskRequest, CompleteTaskRequest, CreateMissionRequest, MissionSummary, TaskView,
} from '@tandemise/api-contract';
import type { Clock, Logger, MissionId, RepositoryId, TaskId } from '@tandemise/shared';
import { TandemiseError, asId, ids, slugify, summarize } from '@tandemise/shared';
import type { FeedbackService, MissionService, PlanningService, ProjectionService } from '../services.js';
import type { SchedulerService } from '../engine/scheduler.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import type { RuntimeOverrides } from '../support/runtime-overrides.js';
import { DEFAULT_PRESET_ID } from '../planning/presets.js';
import { actorFor, requireSeat, type Caller } from '../support/identity.js';
import { supersededBy } from '../support/lineage.js';
import { waitingForName, withoutEscalation } from '../engine/staffing-resolver.js';
import type { ReviewPipeline } from '../engine/reviews.js';
import type { FeedbackRounds } from '../engine/feedback-rounds.js';
import type { ArtifactMeasurePort } from '../ports.js';
import { feedbackEffectFor } from '../support/feedback-rules.js';
import { assertStaffing, mergeRoleStaffing } from '../support/staffing-edit.js';

/** Statuses from which a task may be put back in the queue by hand. */
const RETRYABLE_TASK_STATUSES: readonly MissionTask['status'][] = [
  'FAILED', 'BLOCKED', 'CANCELLED', 'SUCCEEDED', 'SKIPPED', 'AWAITING_APPROVAL',
];

export interface MissionDeps {
  readonly workspaces: WorkspaceRepositoryPort;
  readonly repositories: RepoRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  /** Tells an output card from a start card, which decides whether a retry's note starts a round. */
  readonly runs: Pick<RunRepositoryPort, 'listByTask'>;
  readonly approvals: ApprovalRepositoryPort;
  /** Where a person's completed work is written, in the shape the plan declared. */
  readonly artifactStore: ArtifactStorePort;
  /** Where its manifest is recorded, so gates and downstream tasks can find it. */
  readonly artifacts: ArtifactRepositoryPort;
  /** Gives a person's text the handoff an agent writes for itself. */
  readonly measure: ArtifactMeasurePort;
  /** Who may act, and who a task is assigned to. */
  readonly members: MemberRepositoryPort;
  readonly roles: RoleRepositoryPort;
  /** A person's finished step is reviewed exactly as an agent's round is. */
  readonly reviews: ReviewPipeline;
  readonly planning: PlanningService;
  readonly projections: ProjectionService;
  readonly scheduler: SchedulerService;
  /** A retry with a note is the next round, started the way any note starts one. */
  readonly feedback: FeedbackService;
  /** A person's completed step answers the notes left on it. */
  readonly rounds: FeedbackRounds;
  readonly overrides: RuntimeOverrides;
  readonly unitOfWork: UnitOfWork;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
  /** The Done-when ledger; the person's lines become U1…Un at creation. Optional for older harnesses. */
  readonly criteria?: MissionCriteriaRepositoryPort;
}

/**
 * The mission lifecycle (MVP.md §9.1, §9.4).
 *
 * One rule governs everything here: **the goal and the success criteria are
 * never mutated** (MVP.md §9.4). They are the user's own words and the contract
 * every later role is measured against; a system that quietly rewrites them to
 * match what it managed to build has stopped being accountable. Re-planning
 * replaces tasks, never intent.
 *
 * The second rule is that every transition goes through `canTransition` and
 * emits an event. The scheduler, the approval service and this service all move
 * missions; without one shared table of legal transitions they would each
 * invent their own, and a mission would eventually reach a state none of them
 * could leave.
 */
export class MissionServiceImpl implements MissionService {
  constructor(private readonly deps: MissionDeps) {}

  list(filter: { workspaceId?: string; status?: string; limit?: number }): readonly MissionSummary[] {
    const missions = this.deps.missions.list({
      ...(filter.workspaceId === undefined ? {} : { workspaceId: asId<'WorkspaceId'>(filter.workspaceId) }),
      ...(filter.status === undefined ? {} : { statuses: [filter.status as MissionStatus] }),
      ...(filter.limit === undefined ? {} : { limit: filter.limit }),
    });
    return missions.map((mission) => this.#summary(mission));
  }

  async create(caller: Caller, request: CreateMissionRequest): Promise<Mission> {
    const workspaceId = asId<'WorkspaceId'>(request.workspaceId);
    const workspace = this.deps.workspaces.get(workspaceId);
    if (workspace === undefined) throw TandemiseError.notFound('Workspace', workspaceId);
    // The creator is who plan approvals go to first, so it is resolved before
    // anything is written: a caller with no seat creates nothing.
    const { actorId } = actorFor(this.deps, workspaceId, caller, request.onBehalfOf);

    const repositoryId = request.repositoryId === undefined
      ? workspace.defaultRepositoryId
      : request.repositoryId === null ? null : asId<'RepositoryId'>(request.repositoryId);
    const repository = repositoryId === null ? undefined : this.deps.repositories.get(repositoryId);
    if (repositoryId !== null && repository === undefined) {
      throw TandemiseError.notFound('Repository', repositoryId);
    }

    const id = ids.mission();
    const title = request.title?.trim() || titleFromGoal(request.goal);
    const created = this.deps.unitOfWork.transaction(() => {
      // Validated and stored with the mission, in one transaction, rather than
      // patched on afterwards: with plans approved automatically, a task can
      // become READY - and snapshot its staffing - before a second request lands.
      const { next: staffing, touched } = mergeRoleStaffing({}, request.staffing ?? {});
      if (touched.length > 0) {
        assertStaffing(indexTeam(this.deps.members.listByWorkspace(workspaceId, { includeRemoved: true })), staffing, touched);
      }
      this.deps.missions.create({
        id,
        workspaceId,
        repositoryId: repositoryId as RepositoryId | null,
        title,
        goal: request.goal.trim(),
        constraints: request.constraints ?? [],
        successCriteria: request.successCriteria ?? [],
        autonomy: request.autonomy ?? workspace.defaultAutonomyLevel,
        workflowPreset: request.workflowPreset ?? DEFAULT_PRESET_ID,
        workflowInputs: request.workflowInputs ?? {},
        baseBranch: request.baseBranch ?? repository?.defaultBranch ?? null,
        createdBy: actorId,
        staffing,
      });
      // Numbered in the same transaction as the mission: the ledger is the
      // contract every later role is measured against, so a mission never
      // exists without it.
      this.deps.criteria?.addUserCriteria(id, request.successCriteria ?? []);
      // The integration branch is named at creation rather than at merge time so
      // that every task branch can be cut from a name that already exists in the
      // record, and so the user can see where the work will land before it does.
      return this.deps.missions.update(id, {
        integrationBranch: `tandemise/${slugify(title)}/integration`,
      });
    });

    this.deps.recorder.note(
      { workspaceId, missionId: id, actorId },
      `Mission created: ${summarize(created.goal, 300)}`,
    );
    this.deps.recorder.invalidate('missions', id);

    if (request.planNow === true) {
      // In the background: the caller gets the mission back in PLANNING, not a
      // request held open for as long as a model takes to think.
      await this.deps.planning.begin(id);
      return this.#require(id);
    }
    return created;
  }

  async start(id: MissionId): Promise<Mission> {
    const mission = this.#require(id);
    const tasks = this.deps.tasks.listByMission(id);
    if (tasks.length === 0) {
      throw new TandemiseError('PRECONDITION_FAILED', 'This mission has no plan yet. Plan it first.', {
        details: { missionId: id },
      });
    }
    const pendingPlanApproval = this.deps.approvals
      .list({ missionId: id, statuses: ['PENDING'] })
      .find((a) => a.kind === 'plan');
    if (pendingPlanApproval !== undefined) {
      throw new TandemiseError(
        'APPROVAL_REQUIRED',
        'The plan is waiting for your approval; approving it starts the mission.',
        { details: { approvalId: pendingPlanApproval.id } },
      );
    }

    const started = this.#transition(mission, 'EXECUTING', 'Started.');
    if (started.startedAt === null) {
      this.deps.missions.update(id, { startedAt: this.deps.clock.now() });
    }
    this.deps.scheduler.wake();
    return this.#require(id);
  }

  async pause(id: MissionId): Promise<Mission> {
    const mission = this.#require(id);
    // In-flight runs are allowed to finish. Killing a worker mid-edit to honour
    // a pause would leave a half-written tree, which is a worse outcome than a
    // pause that takes one task to take effect; `cancel` is the hard stop.
    return this.#transition(mission, 'PAUSED', 'Paused by the user. Running tasks will finish.');
  }

  async resume(id: MissionId): Promise<Mission> {
    const mission = this.#require(id);
    if (mission.status !== 'PAUSED' && mission.status !== 'BLOCKED') {
      throw new TandemiseError('PRECONDITION_FAILED', `A mission in ${mission.status} is not paused.`, {
        details: { missionId: id, status: mission.status },
      });
    }
    const resumed = this.#transition(mission, 'EXECUTING', 'Resumed by the user.');
    this.deps.scheduler.wake();
    return resumed;
  }

  async cancel(id: MissionId, reason?: string): Promise<Mission> {
    const mission = this.#require(id);
    const detail = reason?.trim() || 'Cancelled by the user.';
    const scope = scopeOf(mission);

    // Abort first: the transition authorizes the stop, and a worker that is
    // still streaming while the mission reads CANCELLED is exactly the orphan
    // this ordering exists to prevent.
    this.deps.scheduler.cancelMission(id);
    const cancelled = this.#transition(mission, 'CANCELLED', detail);

    for (const task of this.deps.tasks.listByMission(id)) {
      if (isTaskFinished(task.status)) continue;
      this.deps.tasks.update(task.id, {
        status: 'CANCELLED',
        statusReason: detail,
        finishedAt: this.deps.clock.now(),
      });
      this.deps.recorder.record({ ...scope, taskId: task.id, roleId: task.roleId }, {
        type: 'task.status', from: task.status, to: 'CANCELLED', reason: detail,
      });
    }
    for (const approval of this.deps.approvals.list({ missionId: id, statuses: ['PENDING'] })) {
      this.deps.approvals.update(approval.id, {
        status: 'CANCELLED',
        decidedAt: this.deps.clock.now(),
        decisionNote: detail,
      });
    }
    this.deps.missions.update(id, { completedAt: this.deps.clock.now() });
    this.deps.recorder.invalidate('tasks', id);
    this.deps.recorder.invalidate('approvals', id);
    return cancelled;
  }

  async remove(id: MissionId): Promise<void> {
    const mission = this.#require(id);
    if (!isTerminalMissionStatus(mission.status)) {
      this.deps.scheduler.cancelMission(id);
      await this.deps.scheduler.drain();
    }
    this.deps.missions.remove(id);
    this.deps.recorder.invalidate('missions');
  }

  async retryTask(
    caller: Caller,
    taskId: TaskId,
    options: { runtimeProfileId?: string; note?: string; addCapabilities?: readonly string[] },
  ): Promise<TaskView> {
    const task = this.#requireTask(taskId);
    const mission = this.#require(task.missionId);
    requireSeat(this.deps, mission.workspaceId, caller);
    const widening = (options.addCapabilities ?? []).length > 0;
    // A worker parked on a question can be restarted with more access: that is
    // often the question ("I can't do this with my grants").
    const retryable = RETRYABLE_TASK_STATUSES.includes(task.status) || (widening && task.status === 'AWAITING_INPUT');
    if (!retryable) {
      throw new TandemiseError('PRECONDITION_FAILED', `A task in ${task.status} cannot be retried.`, {
        details: { taskId, status: task.status },
      });
    }

    if (options.runtimeProfileId !== undefined) {
      this.deps.overrides.set(taskId, asId<'RuntimeProfileId'>(options.runtimeProfileId));
    }
    // The budget is extended rather than the attempt counter reset: the history
    // of how many times this task has been tried is evidence, and erasing it
    // would let a task that always fails loop forever one manual retry at a time
    // while the timeline showed attempt 1 each round.
    const added = [...new Set(options.addCapabilities ?? [])]
      .filter((c) => !task.executionPolicy.capabilities.includes(c));
    const note = options.note?.trim() ?? '';
    // A note is the person's request, so the retry is the next round framed as
    // one (spec §7, C12), not a gate failure with a remark appended. Only where
    // a note would start a round: from AWAITING_INPUT the run is restarted with
    // more access mid-question, and behind a start card nothing has run yet, so
    // those keep today's framing.
    // A wait step reads no feedback, so its note stays a retry reason.
    const effect = feedbackEffectFor(task, this.deps.approvals.pendingForTask(taskId), this.deps.runs);
    if (note.length > 0 && task.executor !== 'wait' && (effect.kind === 'review' || effect.kind === 'reopen' || effect.kind === 'round_now')) {
      let pending;
      try {
        // One unit with the round, so a round that cannot start leaves the task's access as it was.
        pending = this.deps.recorder.deferred(() => this.deps.unitOfWork.transaction(() => {
          if (added.length > 0) {
            this.deps.tasks.update(taskId, { executionPolicy: { ...task.executionPolicy, capabilities: [...task.executionPolicy.capabilities, ...added] } });
          }
          // A retry cannot show the impact dialog; work that used the old version is kept and flagged when the round lands.
          return this.deps.feedback.beginGive(caller, taskId, { text: note }, { forceDownstream: 'keep' });
        }));
      } catch (error) {
        // The override lives in memory, outside the unit: set before the round so its first dispatch sees it, taken back if it failed.
        if (options.runtimeProfileId !== undefined) this.deps.overrides.clear(taskId);
        throw error;
      }
      // Only now that the unit has committed: the scheduler must find the round when it wakes.
      this.deps.feedback.afterGive(pending);
      return this.#taskView(mission.id, taskId);
    }
    const reason = note
      || `Retried by the user${options.runtimeProfileId === undefined ? '' : ' on a different runtime'}`
        + `${added.length > 0 ? ` with more access: ${added.join(', ')}` : ''}.`;
    if (task.status === 'AWAITING_INPUT') {
      this.deps.scheduler.cancelTask(taskId);
      for (const approval of this.deps.approvals.pendingForTask(taskId)) {
        this.deps.approvals.update(approval.id, {
          status: 'CANCELLED', decidedAt: this.deps.clock.now(), decisionNote: reason,
        });
      }
    }
    this.deps.tasks.update(taskId, {
      ...(added.length > 0
        ? {
          executionPolicy: { ...task.executionPolicy, capabilities: [...task.executionPolicy.capabilities, ...added] },
        }
        : {}),
      status: 'READY',
      statusReason: reason,
      // A retry is a new round: the attention a check asked for was about the
      // last one, and the people an escalation reached were for that wait.
      needsAttention: false,
      ...(task.staffing?.escalatedTo === undefined ? {} : { staffing: withoutEscalation(task.staffing) }),
      // The retry's prompt quotes what the last attempt failed on. A note the
      // person wrote is added to it, never swapped in: "Retried by the user"
      // in its place told the worker nothing about what to do differently.
      retryFeedback: [task.retryFeedback, options.note?.trim() ? `When retrying, the person said: ${options.note.trim()}` : null]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join('\n\n') || null,
      retryPolicy: {
        ...task.retryPolicy,
        maxAttempts: Math.max(task.retryPolicy.maxAttempts, task.attempts + 1),
      },
      finishedAt: null,
    });
    this.deps.recorder.record({ ...scopeOf(mission), taskId, roleId: task.roleId }, {
      type: 'task.status', from: task.status, to: 'READY', reason,
    });
    this.#holdDependents(task, mission);
    this.#reviveMission(mission, `'${task.key}' was retried by the user.`);
    this.deps.recorder.invalidate('tasks', mission.id);
    this.deps.scheduler.wake();
    return this.#taskView(mission.id, taskId);
  }

  /**
   * Sends work downstream of a retried task back to waiting for it.
   *
   * Retrying a task that had succeeded left its dependents where they were, so
   * they kept running on the old result: a release task checked for a pull
   * request while the task that opens it was still re-running, found none, and
   * asked for approval of that. Dependents still in flight or parked go back to
   * PENDING (a running one is stopped); finished ones are left alone - their
   * work is done, and redoing it is the person's call.
   */
  #holdDependents(task: MissionTask, mission: Mission): void {
    const all = this.deps.tasks.listByMission(mission.id);
    const downstream = new Set<string>();
    const stack = [task.key];
    while (stack.length > 0) {
      const key = stack.pop()!;
      for (const t of all) {
        if (t.dependsOn.includes(key) && !downstream.has(t.key)) {
          downstream.add(t.key);
          stack.push(t.key);
        }
      }
    }
    const reason = `Waiting again: '${task.key}' is being retried.`;
    for (const dependent of all.filter((t) => downstream.has(t.key))) {
      if (isTaskFinished(dependent.status) || dependent.status === 'PENDING') continue;
      this.deps.scheduler.cancelTask(dependent.id);
      this.deps.tasks.update(dependent.id, { status: 'PENDING', statusReason: reason });
      for (const approval of this.deps.approvals.pendingForTask(dependent.id)) {
        this.deps.approvals.update(approval.id, {
          status: 'CANCELLED', decidedAt: this.deps.clock.now(), decisionNote: reason,
        });
      }
      this.deps.recorder.record({ ...scopeOf(mission), taskId: dependent.id, roleId: dependent.roleId }, {
        type: 'task.status', from: dependent.status, to: 'PENDING', reason,
      });
    }
    this.deps.recorder.invalidate('approvals', mission.id);
  }

  /**
   * A person reports that they have finished a `human` task.
   *
   * What they bring back is written as the artifact the step declared, so the
   * work downstream consumes it the same way it consumes an agent's output.
   * That is the whole trick: a design made in Figma and a design written by a
   * model arrive at the next task in the same shape, and nothing after this
   * point needs to care which it was.
   */
  async completeTask(caller: Caller, taskId: TaskId, request: CompleteTaskRequest): Promise<TaskView> {
    const task = this.#requireTask(taskId);
    const mission = this.#require(task.missionId);

    if (task.executor !== 'human') {
      throw new TandemiseError('PRECONDITION_FAILED',
        `Task '${task.key}' runs on a runtime; it is not yours to complete.`,
        { details: { taskId, executor: task.executor } });
    }
    if (task.status !== 'AWAITING_HUMAN') {
      throw new TandemiseError('PRECONDITION_FAILED',
        `A task in ${task.status} is not waiting for you.`,
        { details: { taskId, status: task.status } });
    }
    const { actorId, recordedBy } = actorFor(this.deps, mission.workspaceId, caller, request.onBehalfOf);
    this.#assertMayTake(task, actorId, 'complete');
    // Completing an unclaimed pool task is claiming it: whoever did the work is
    // its assignee, and answers for it unless someone was named responsible.
    const taken: { assigneeId?: string; responsibleId?: string } = task.assigneeId !== actorId
      ? this.#claimFields(task, mission, actorId) : {};
    const responsibleId = taken.responsibleId ?? task.responsibleId ?? null;

    const scope: EventScope = { ...scopeOf(mission), taskId, roleId: task.roleId, actorId };
    // Taking it from its assignee (an escalation reached them) is said, as a claim would say it.
    if (task.assigneeId != null && task.assigneeId !== actorId) this.#noteTaken(scope, task, actorId);
    // People are not made to fill in YAML: their first sentence is the headline.
    const handoff = this.deps.measure.deriveHandoff(request.result);
    for (const type of task.expectedOutputs) {
      // A re-completed task replaces what it brought back last time, exactly as
      // an agent's retry does; otherwise both answers stay live and the next
      // task reads the stale one too. The repository sets the back-pointer.
      const previous = supersededBy(task, type, this.deps.artifacts, this.deps.tasks);
      const manifest = await this.deps.artifactStore.write({
        workspaceId: mission.workspaceId,
        missionId: mission.id,
        taskId: task.id,
        type,
        title: task.title,
        body: request.result,
        // What a person types is text, whatever the output type: Evidence
        // defaults to a binary blob, which the reader cannot show.
        mediaType: 'text/markdown',
        summary: handoff.headline,
        supersedes: previous?.id ?? null,
      });
      // Recorded, not only stored: gates and the next task read the manifest
      // table, and a person's output has to arrive the way an agent's does.
      // Measured so the reader can show its length, but never held to a budget:
      // what a person brings back is theirs to size.
      const recorded = this.deps.artifacts.create({
        ...manifest, authorId: actorId, recordedBy, responsibleId,
        handoff, wordCount: this.deps.measure.measure(type, request.result).mainWords, overBudget: false,
        round: task.round ?? 1,
      });
      this.deps.recorder.record(scope, { type: 'artifact.created', artifactId: recorded.id });
    }
    // A person's text cites no ids, so bringing the step back answers every note on it (plan ruling 1).
    this.deps.rounds.onPersonCompleted(task, scope);

    // The step passed its round: the reviews its staffing names - a blocking
    // look, the lead's sign-off, an after-the-fact check - apply to a person's
    // work exactly as they do to an agent's. A person's step has no gate and
    // no checks of its own.
    const workspace = this.deps.workspaces.get(mission.workspaceId);
    if (workspace === undefined) throw TandemiseError.notFound('Workspace', mission.workspaceId);
    const outcome = this.deps.reviews.onRoundPassed({
      task: { ...task, ...taken },
      mission,
      workspace,
      role: this.deps.roles.get(task.roleId, mission.workspaceId),
      gate: null,
      checks: [],
      scope,
    });
    const reason = outcome.status === 'SUCCEEDED' ? request.note?.trim() || 'Completed by you.' : outcome.reason;
    this.deps.tasks.update(taskId, {
      ...taken,
      status: outcome.status,
      statusReason: reason,
      ...(outcome.status === 'SUCCEEDED' ? { finishedAt: this.deps.clock.now() } : {}),
    });
    this.deps.recorder.record(scope, {
      type: 'task.status', from: task.status, to: outcome.status, ...(reason === null ? {} : { reason }),
    });
    this.deps.recorder.invalidate('tasks', mission.id);
    this.deps.recorder.invalidate('artifacts', mission.id);
    this.deps.scheduler.wake();
    return this.#taskView(mission.id, taskId);
  }

  /**
   * Takes an unassigned human task, for the caller or the member named.
   *
   * Only someone the staffing made claimable may take it, and a task already
   * taken by someone else is not taken twice: two people doing the same work
   * without knowing it is the failure this exists to prevent.
   */
  async claimTask(caller: Caller, taskId: TaskId, request: ClaimTaskRequest): Promise<TaskView> {
    const task = this.#requireTask(taskId);
    const mission = this.#require(task.missionId);
    if (task.executor !== 'human' || task.status !== 'AWAITING_HUMAN') {
      throw new TandemiseError('PRECONDITION_FAILED',
        `Task '${task.key}' is not waiting for a person to take it.`,
        { details: { taskId, executor: task.executor, status: task.status } });
    }
    const { actorId } = actorFor(this.deps, mission.workspaceId, caller, request.onBehalfOf);
    if (task.assigneeId === actorId) return this.#taskView(mission.id, taskId);
    this.#assertMayTake(task, actorId, 'claim');

    const fields = this.#claimFields(task, mission, actorId);
    const name = this.#nameOf(actorId);
    this.deps.tasks.update(taskId, { ...fields, statusReason: waitingForName(name) });
    this.#noteTaken({ ...scopeOf(mission), taskId, roleId: task.roleId, actorId }, task, actorId);
    this.deps.recorder.invalidate('tasks', mission.id);
    return this.#taskView(mission.id, taskId);
  }

  async skipTask(caller: Caller, taskId: TaskId): Promise<TaskView> {
    const task = this.#requireTask(taskId);
    const mission = this.#require(task.missionId);
    requireSeat(this.deps, mission.workspaceId, caller);
    if (isTaskFinished(task.status) && task.status !== 'FAILED') {
      throw new TandemiseError('PRECONDITION_FAILED', `A task in ${task.status} cannot be skipped.`, {
        details: { taskId, status: task.status },
      });
    }
    this.deps.scheduler.cancelTask(taskId);

    const reason = 'Skipped by the user.';
    this.deps.tasks.update(taskId, {
      status: 'SKIPPED',
      statusReason: reason,
      finishedAt: this.deps.clock.now(),
    });
    this.deps.recorder.record({ ...scopeOf(mission), taskId, roleId: task.roleId }, {
      type: 'task.status', from: task.status, to: 'SKIPPED', reason,
    });
    // A skipped task has nothing left to decide, so its open cards are
    // withdrawn - otherwise an intervention for work nobody is doing anymore
    // stays in the inbox asking to retry it.
    for (const approval of this.deps.approvals.pendingForTask(taskId)) {
      this.deps.approvals.update(approval.id, {
        status: 'CANCELLED', decidedAt: this.deps.clock.now(), decisionNote: reason,
      });
    }
    this.deps.recorder.invalidate('approvals', mission.id);
    // A skipped task counts as satisfied for its dependents, so downstream work
    // that was waiting on it can proceed - that is the point of skipping.
    this.#reviveMission(mission, `'${task.key}' was skipped by the user.`);
    this.deps.recorder.invalidate('tasks', mission.id);
    this.deps.scheduler.wake();
    return this.#taskView(mission.id, taskId);
  }

  // ------------------------------------------------------------------ internals

  #nameOf(memberId: string): string {
    return this.deps.members.get(asId<'MemberId'>(memberId))?.name ?? 'someone';
  }

  /** "Ana took 'Design review'." - the audit line for someone taking a task. */
  #noteTaken(scope: EventScope, task: MissionTask, actorId: string): void {
    this.deps.recorder.note(scope, `${this.#nameOf(actorId)} took '${task.title}'.`);
  }

  /**
   * The assignee may act on their task; on an unassigned one, anyone the
   * staffing made claimable. A task resolved before staffing existed names no
   * one, and stays open to whoever the workspace lets act at all.
   */
  #assertMayTake(task: MissionTask, actorId: string, action: 'claim' | 'complete'): void {
    const allowed = task.assigneeId != null
      ? task.assigneeId === actorId || reachedByEscalation(task, actorId)
      : task.staffing == null || task.staffing.claimable.includes(actorId);
    if (allowed) return;
    const whose = task.assigneeId != null
      ? `it is assigned to ${this.deps.members.get(asId<'MemberId'>(task.assigneeId))?.name ?? 'someone else'}`
      : 'they are not one of the people who can take it';
    throw new TandemiseError('CONFLICT', `This member cannot ${action} '${task.title}': ${whose}.`, {
      details: { taskId: task.id, actorId, assigneeId: task.assigneeId ?? null },
    });
  }

  /** The assignment a person taking a task gets, with responsibility re-derived for them. */
  #claimFields(task: MissionTask, mission: Mission, actorId: string): { assigneeId: string; responsibleId?: string } {
    if (task.staffing == null) return { assigneeId: actorId };
    const team = indexTeam(this.deps.members.listByWorkspace(mission.workspaceId, { includeRemoved: true }));
    if (team.owners.length === 0) return { assigneeId: actorId };
    return { assigneeId: actorId, responsibleId: responsibleFor(team, task.staffing.staffing, actorId) };
  }

  /** A blocked mission that just got a runnable task again goes back to work. */
  #reviveMission(mission: Mission, reason: string): void {
    if (mission.status !== 'BLOCKED' && mission.status !== 'FAILED' && mission.status !== 'COMPLETE') return;
    this.#transition(mission, 'EXECUTING', reason);
  }

  #transition(mission: Mission, status: MissionStatus, reason: string): Mission {
    if (mission.status === status) return mission;
    if (!canTransition(mission.status, status)) {
      throw new TandemiseError(
        'PRECONDITION_FAILED',
        `A mission in ${mission.status} cannot move to ${status}.`,
        { details: { missionId: mission.id, from: mission.status, to: status } },
      );
    }
    const updated = this.deps.missions.update(mission.id, { status, statusReason: reason });
    this.deps.recorder.record(scopeOf(mission), {
      type: 'mission.status', from: mission.status, to: status, reason,
    });
    this.deps.recorder.invalidate('missions', mission.id);
    return updated;
  }

  #summary(mission: Mission): MissionSummary {
    const tasks = this.deps.tasks.listByMission(mission.id);
    const running = tasks.find((t) => t.status === 'RUNNING');
    return {
      mission,
      progress: this.deps.missions.progress(mission.id),
      repositoryName: mission.repositoryId === null
        ? null
        : this.deps.repositories.get(mission.repositoryId)?.name ?? null,
      currentActivity: running?.title ?? mission.statusReason,
      lastEventAt: null,
    };
  }

  async #taskView(missionId: MissionId, taskId: TaskId): Promise<TaskView> {
    const views = await this.deps.projections.missionTasks(missionId);
    const view = views.find((v) => v.id === taskId);
    if (view === undefined) throw TandemiseError.notFound('Task', taskId);
    return view;
  }

  #require(id: MissionId): Mission {
    const mission = this.deps.missions.get(id);
    if (mission === undefined) throw TandemiseError.notFound('Mission', id);
    return mission;
  }

  #requireTask(id: TaskId): MissionTask {
    const task = this.deps.tasks.get(id);
    if (task === undefined) throw TandemiseError.notFound('Task', id);
    return task;
  }
}

function scopeOf(mission: Mission): EventScope {
  return { workspaceId: mission.workspaceId, missionId: mission.id };
}

/**
 * A title from the goal, for the common case where the user typed one sentence
 * and nothing else. Deliberately dumb: a title is a label, and spending a model
 * call on one would make creating a mission slower than typing the title.
 */
function titleFromGoal(goal: string): string {
  const firstSentence = goal.trim().split(/(?<=[.!?])\s/)[0] ?? goal.trim();
  const trimmed = firstSentence.replace(/[.!?]+$/, '').trim();
  return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 77).trimEnd()}…`;
}

/**
 * Whether the member was reached by an escalation, and so may take a task
 * from its assignee. Only what `ReviewPipeline#escalatePool` recorded counts:
 * the other people of a pool someone already claimed - two owners of a
 * fallback pool included - came from the staffing, and a claim is not taken twice.
 */
function reachedByEscalation(task: MissionTask, actorId: string): boolean {
  return task.assigneeId != null && (task.staffing?.escalatedTo ?? []).includes(actorId);
}
