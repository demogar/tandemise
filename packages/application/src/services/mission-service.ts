import type {
  ApprovalRepositoryPort, Mission, MissionRepositoryPort, MissionStatus, MissionTask,
  RepoRepositoryPort, TaskRepositoryPort, WorkspaceRepositoryPort,
  ArtifactStorePort,
} from '@tandemise/domain';
import { canTransition, isTaskFinished, isTerminalMissionStatus } from '@tandemise/domain';
import type {
  CompleteTaskRequest, CreateMissionRequest, MissionSummary, TaskView,
} from '@tandemise/api-contract';
import type { Clock, Logger, MissionId, RepositoryId, TaskId } from '@tandemise/shared';
import { TandemiseError, asId, ids, slugify, summarize } from '@tandemise/shared';
import type { MissionService, PlanningService, ProjectionService } from '../services.js';
import type { SchedulerService } from '../engine/scheduler.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import type { RuntimeOverrides } from '../support/runtime-overrides.js';
import { DEFAULT_PRESET_ID } from '../planning/presets.js';

/** Statuses from which a task may be put back in the queue by hand. */
const RETRYABLE_TASK_STATUSES: readonly MissionTask['status'][] = [
  'FAILED', 'BLOCKED', 'CANCELLED', 'SUCCEEDED', 'SKIPPED', 'AWAITING_APPROVAL',
];

export interface MissionDeps {
  readonly workspaces: WorkspaceRepositoryPort;
  readonly repositories: RepoRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly approvals: ApprovalRepositoryPort;
  /** Where a person's completed work is written, in the shape the plan declared. */
  readonly artifactStore: ArtifactStorePort;
  readonly planning: PlanningService;
  readonly projections: ProjectionService;
  readonly scheduler: SchedulerService;
  readonly overrides: RuntimeOverrides;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
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

  async create(request: CreateMissionRequest): Promise<Mission> {
    const workspaceId = asId<'WorkspaceId'>(request.workspaceId);
    const workspace = this.deps.workspaces.get(workspaceId);
    if (workspace === undefined) throw TandemiseError.notFound('Workspace', workspaceId);

    const repositoryId = request.repositoryId === undefined
      ? workspace.defaultRepositoryId
      : request.repositoryId === null ? null : asId<'RepositoryId'>(request.repositoryId);
    const repository = repositoryId === null ? undefined : this.deps.repositories.get(repositoryId);
    if (repositoryId !== null && repository === undefined) {
      throw TandemiseError.notFound('Repository', repositoryId);
    }

    const id = ids.mission();
    const title = request.title?.trim() || titleFromGoal(request.goal);
    const mission = this.deps.missions.create({
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
    });

    // The integration branch is named at creation rather than at merge time so
    // that every task branch can be cut from a name that already exists in the
    // record, and so the user can see where the work will land before it does.
    const withBranch = this.deps.missions.update(id, {
      integrationBranch: `tandemise/${slugify(title)}/integration`,
    });

    this.deps.recorder.note(
      { workspaceId, missionId: id },
      `Mission created: ${summarize(mission.goal, 300)}`,
    );
    this.deps.recorder.invalidate('missions', id);

    if (request.planNow === true) {
      // In the background: the caller gets the mission back in PLANNING, not a
      // request held open for as long as a model takes to think.
      await this.deps.planning.begin(id);
      return this.#require(id);
    }
    return withBranch;
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

  async retryTask(taskId: TaskId, options: { runtimeProfileId?: string; note?: string }): Promise<TaskView> {
    const task = this.#requireTask(taskId);
    const mission = this.#require(task.missionId);
    if (!RETRYABLE_TASK_STATUSES.includes(task.status)) {
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
    const reason = options.note?.trim()
      || `Retried by the user${options.runtimeProfileId === undefined ? '' : ' on a different runtime'}.`;
    this.deps.tasks.update(taskId, {
      status: 'READY',
      statusReason: reason,
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
  async completeTask(taskId: TaskId, request: CompleteTaskRequest): Promise<TaskView> {
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

    const scope = { ...scopeOf(mission), taskId, roleId: task.roleId };
    for (const type of task.expectedOutputs) {
      await this.deps.artifactStore.write({
        workspaceId: mission.workspaceId,
        missionId: mission.id,
        taskId: task.id,
        type,
        title: task.title,
        body: request.result,
        summary: request.note ?? null,
      });
    }

    const reason = request.note?.trim() || 'Completed by you.';
    this.deps.tasks.update(taskId, {
      status: 'SUCCEEDED',
      statusReason: reason,
      finishedAt: this.deps.clock.now(),
    });
    this.deps.recorder.record(scope, { type: 'task.status', from: task.status, to: 'SUCCEEDED', reason });
    this.deps.recorder.invalidate('tasks', mission.id);
    this.deps.recorder.invalidate('artifacts', mission.id);
    return this.#taskView(mission.id, taskId);
  }

  async skipTask(taskId: TaskId): Promise<TaskView> {
    const task = this.#requireTask(taskId);
    const mission = this.#require(task.missionId);
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

  /** A blocked mission that just got a runnable task again goes back to work. */
  #reviveMission(mission: Mission, reason: string): void {
    if (mission.status !== 'BLOCKED' && mission.status !== 'FAILED') return;
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
