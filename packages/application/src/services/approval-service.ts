import type {
  Approval, ApprovalRepositoryPort, Mission, MissionRepositoryPort, MissionTask,
  RoleRepositoryPort, RunRepositoryPort, TaskRepositoryPort,
} from '@tandemise/domain';
import { APPROVE_OPTION, canTransition } from '@tandemise/domain';
import type { ApprovalView, DecideApprovalRequest } from '@tandemise/api-contract';
import type { ApprovalId, Clock, Logger } from '@tandemise/shared';
import { TandemiseError, asId, summarize } from '@tandemise/shared';
import type { ApprovalService } from '../services.js';
import type { SchedulerService } from '../engine/scheduler.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import type { ApprovalWaiter } from '../support/tool-policy.js';
import { toApprovalView } from '../support/approval-view.js';
import { materializePlan } from '../planning/materialize.js';
import { parsePlanResponse } from '../planning/parse.js';

export interface ApprovalDeps {
  readonly approvals: ApprovalRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly runs: RunRepositoryPort;
  readonly roles: RoleRepositoryPort;
  readonly scheduler: SchedulerService;
  readonly waiter: ApprovalWaiter;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
}

/**
 * The human decision point (MVP.md §18).
 *
 * Deciding an approval is never only a status change: something is *waiting* on
 * it, and this service is the only place that knows what. A plan approval
 * releases the mission; a completion approval releases every task downstream of
 * the one it gates; a tool approval unblocks a worker that is still running,
 * mid-call, right now.
 *
 * The awkward case is telling a "may this task start?" approval apart from a
 * "do you accept this task's output?" approval - both are `kind: 'action'` on
 * the same task. Rather than stamping a marker into the card (which would show
 * the user a meaningless row), it is derived from the record: a start approval
 * is created *before* the attempt's run row exists, a completion approval
 * after. The run log already knows; asking it keeps the approval card honest.
 */
export class ApprovalServiceImpl implements ApprovalService {
  constructor(private readonly deps: ApprovalDeps) {}

  list(filter: { workspaceId?: string; missionId?: string; status?: string }): readonly ApprovalView[] {
    const approvals = this.deps.approvals.list({
      ...(filter.workspaceId === undefined ? {} : { workspaceId: asId<'WorkspaceId'>(filter.workspaceId) }),
      ...(filter.missionId === undefined ? {} : { missionId: asId<'MissionId'>(filter.missionId) }),
      ...(filter.status === undefined ? {} : { statuses: [filter.status as Approval['status']] }),
    });
    return approvals.map((a) => toApprovalView(this.deps, a));
  }

  get(id: ApprovalId): ApprovalView {
    return toApprovalView(this.deps, this.#require(id));
  }

  async decide(id: ApprovalId, request: DecideApprovalRequest): Promise<ApprovalView> {
    const approval = this.#require(id);
    if (approval.status !== 'PENDING') {
      throw new TandemiseError('CONFLICT', `Approval '${id}' was already ${approval.status.toLowerCase()}.`, {
        details: { approvalId: id, status: approval.status },
      });
    }
    const option = approval.options.find((o) => o.id === request.optionId);
    if (option === undefined) {
      throw TandemiseError.validation(
        `'${request.optionId}' is not an option on this approval.`,
        { options: approval.options.map((o) => o.id) },
      );
    }

    const approved = option.id === APPROVE_OPTION;
    const decided = this.deps.approvals.update(id, {
      status: approved ? 'APPROVED' : 'REJECTED',
      selectedOptionId: option.id,
      decisionNote: request.note ?? null,
      decidedBy: 'user',
      decidedAt: this.deps.clock.now(),
    });

    const scope = this.#scope(decided);
    if (scope !== null) {
      this.deps.recorder.record(scope, {
        type: 'approval.resolved',
        approvalId: decided.id,
        status: decided.status,
        option: option.id,
      });
    }
    // A worker blocked mid-call gets its answer before anything else happens:
    // it is holding a concurrency slot and a target while it waits.
    this.deps.waiter.settle(decided, approved);

    if (decided.kind === 'plan') this.#resumePlan(decided, approved, request);
    else if (decided.taskId !== null) this.#resumeTask(decided, approved);

    this.deps.recorder.invalidate('approvals', decided.missionId ?? undefined);
    this.deps.scheduler.wake();
    return toApprovalView(this.deps, decided);
  }

  // ------------------------------------------------------------------- resume

  #resumePlan(approval: Approval, approved: boolean, request: DecideApprovalRequest): void {
    const mission = approval.missionId === null ? undefined : this.deps.missions.get(approval.missionId);
    if (mission === undefined) return;
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id };

    if (!approved) {
      this.#setMissionStatus(
        mission, scope, 'BLOCKED',
        `The plan was rejected${request.note === undefined ? '' : `: ${summarize(request.note, 300)}`}. `
        + 'Re-plan or change the mission goal.',
      );
      return;
    }

    if (request.editedPlan !== undefined && request.editedPlan !== null) {
      this.#applyEditedPlan(mission, scope, request.editedPlan);
    }
    this.#setMissionStatus(mission, scope, 'EXECUTING', 'Plan approved; executing.');
    if (mission.startedAt === null) {
      this.deps.missions.update(mission.id, { startedAt: this.deps.clock.now() });
    }
  }

  /**
   * A user-edited plan is validated exactly as a planner's is.
   *
   * "The human wrote it" is not a reason to skip validation: a hand-edited plan
   * with a dependency typo produces a mission that never starts that task, and
   * the failure would surface as silence rather than as an error on the edit.
   */
  #applyEditedPlan(mission: Mission, scope: EventScope, edited: unknown): void {
    const parsed = parsePlanResponse(JSON.stringify(edited));
    if (!parsed.ok) {
      throw TandemiseError.validation(
        `The edited plan is not usable: ${parsed.error.join('; ')}`,
        { issues: parsed.error },
      );
    }
    const tasks = materializePlan(parsed.value, mission.id, this.deps.clock);
    this.deps.tasks.replaceAll(mission.id, tasks);
    this.deps.recorder.note(scope, `The plan was edited before approval: ${tasks.length} tasks.`);
    this.deps.recorder.invalidate('tasks', mission.id);
  }

  #resumeTask(approval: Approval, approved: boolean): void {
    if (approval.taskId === null) return;
    const task = this.deps.tasks.get(approval.taskId);
    if (task === undefined) return;
    const mission = this.deps.missions.get(task.missionId);
    if (mission === undefined) return;

    // A tool approval is answered while its worker is still RUNNING. The waiter
    // has already released it; touching the task status here would yank the
    // task out from under a live run.
    if (task.status !== 'AWAITING_APPROVAL') return;

    const scope: EventScope = {
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      taskId: task.id,
      roleId: task.roleId,
    };

    if (approval.kind === 'intervention') {
      if (!approved) {
        this.#setTaskStatus(task, scope, 'BLOCKED', 'A human declined to retry this task.');
        this.#setMissionStatus(mission, scope, 'BLOCKED', `'${task.key}' was left blocked by a human.`);
        return;
      }
      // "Retry once more" has to mean it: the task already exhausted its budget,
      // so returning it to READY without extending the budget would have it
      // re-fail on the first dispatch without running anything.
      this.deps.tasks.update(task.id, {
        retryPolicy: { ...task.retryPolicy, maxAttempts: task.attempts + 1 },
      });
      this.#setTaskStatus(task, scope, 'READY', 'A human authorized one more attempt.');
      return;
    }

    if (this.#wasStartApproval(approval, task)) {
      if (approved) this.#setTaskStatus(task, scope, 'READY', 'Approved to start.');
      else this.#setTaskStatus(task, scope, 'BLOCKED', 'A human declined to let this task start.');
      return;
    }

    if (approved) {
      this.#setTaskStatus(task, scope, 'SUCCEEDED', null);
      return;
    }
    this.#setTaskStatus(task, scope, 'BLOCKED', 'A human rejected this task\'s output.');
    this.#setMissionStatus(mission, scope, 'BLOCKED', `The output of '${task.key}' was rejected.`);
  }

  /** Created before the attempt's run row existed ⇒ it gated the start. */
  #wasStartApproval(approval: Approval, task: MissionTask): boolean {
    const latest = [...this.deps.runs.listByTask(task.id)]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (latest === undefined) return true;
    return approval.createdAt <= latest.startedAt;
  }

  // -------------------------------------------------------------- transitions

  #setTaskStatus(
    task: MissionTask,
    scope: EventScope,
    status: MissionTask['status'],
    reason: string | null,
  ): void {
    this.deps.tasks.update(task.id, {
      status,
      statusReason: reason,
      ...(status === 'SUCCEEDED' ? { finishedAt: this.deps.clock.now() } : {}),
    });
    this.deps.recorder.record(scope, {
      type: 'task.status',
      from: task.status,
      to: status,
      ...(reason === null ? {} : { reason }),
    });
    this.deps.recorder.invalidate('tasks', task.missionId);
  }

  #setMissionStatus(
    mission: Mission,
    scope: EventScope,
    status: Mission['status'],
    reason: string,
  ): void {
    if (mission.status === status) return;
    if (!canTransition(mission.status, status)) {
      this.deps.log.warn('approval.illegal_mission_transition', {
        missionId: mission.id, from: mission.status, to: status,
      });
      return;
    }
    this.deps.missions.update(mission.id, { status, statusReason: reason });
    this.deps.recorder.record(
      { workspaceId: scope.workspaceId, missionId: scope.missionId },
      { type: 'mission.status', from: mission.status, to: status, reason },
    );
    this.deps.recorder.invalidate('missions', mission.id);
  }

  #scope(approval: Approval): EventScope | null {
    if (approval.missionId === null) return null;
    return {
      workspaceId: approval.workspaceId,
      missionId: approval.missionId,
      taskId: approval.taskId,
    };
  }

  #require(id: ApprovalId): Approval {
    const approval = this.deps.approvals.get(id);
    if (approval === undefined) throw TandemiseError.notFound('Approval', id);
    return approval;
  }
}
