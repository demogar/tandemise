import type {
  MemberRepositoryPort, MissionRepositoryPort, MissionTask, RoleStaffing, StaffingPatch, TaskRepositoryPort, UnitOfWork,
  WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { indexTeam, isTaskFinished, validateStaffing } from '@tandemise/domain';
import type { StaffingPreviewView, TaskView } from '@tandemise/api-contract';
import type { Clock, MissionId, TaskId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError } from '@tandemise/shared';
import type { ProjectionService, StaffingService } from '../services.js';
import { waitingReason, type StaffingResolver } from '../engine/staffing-resolver.js';
import type { EventRecorder } from '../support/event-recorder.js';
import { requireSeat, type Caller } from '../support/identity.js';
import { actorRef, actorRefs } from '../support/actors.js';
import { assertStaffing, mergeRoleStaffing, type RoleStaffingEdit } from '../support/staffing-edit.js';

export interface StaffingServiceDeps {
  readonly workspaces: WorkspaceRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly members: MemberRepositoryPort;
  readonly resolver: StaffingResolver;
  readonly projections: ProjectionService;
  readonly unitOfWork: UnitOfWork;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
}

/**
 * Who does each role's work, at the workspace, mission and task level.
 *
 * Edits apply to tasks that have not become READY yet: a task snapshots its
 * staffing when it does, so changing the team mid-mission never re-routes work
 * that is already under way.
 */
export class StaffingServiceImpl implements StaffingService {
  constructor(private readonly deps: StaffingServiceDeps) {}

  workspace(workspaceId: WorkspaceId): RoleStaffing {
    return this.#requireWorkspace(workspaceId).staffing ?? {};
  }

  patchWorkspace(caller: Caller, workspaceId: WorkspaceId, patch: RoleStaffingEdit): RoleStaffing {
    return this.deps.unitOfWork.transaction(() => {
      const workspace = this.#requireWorkspace(workspaceId);
      requireSeat(this.deps, workspaceId, caller);
      const { next, touched } = mergeRoleStaffing(workspace.staffing ?? {}, patch);
      assertStaffing(this.#team(workspaceId), next, touched);
      return this.deps.workspaces.update(workspaceId, { staffing: next, updatedAt: this.deps.clock.now() }).staffing ?? next;
    });
  }

  patchMission(caller: Caller, missionId: MissionId, patch: RoleStaffingEdit): RoleStaffing {
    return this.deps.unitOfWork.transaction(() => {
      const mission = this.deps.missions.get(missionId);
      if (mission === undefined) throw TandemiseError.notFound('Mission', missionId);
      requireSeat(this.deps, mission.workspaceId, caller);
      const { next, touched } = mergeRoleStaffing(mission.staffing ?? {}, patch);
      assertStaffing(this.#team(mission.workspaceId), next, touched);
      return this.deps.missions.update(missionId, { staffing: next, updatedAt: this.deps.clock.now() }).staffing ?? next;
    });
  }

  patchTask(caller: Caller, taskId: TaskId, patch: StaffingPatch | null): TaskView {
    this.deps.unitOfWork.transaction(() => {
      const task = this.deps.tasks.get(taskId);
      if (task === undefined) throw TandemiseError.notFound('Task', taskId);
      const mission = this.deps.missions.get(task.missionId);
      if (mission === undefined) throw TandemiseError.notFound('Mission', task.missionId);
      requireSeat(this.deps, mission.workspaceId, caller);
      // Editable until the task starts running (spec, "Resolution"). A task
      // that ran once has had its worker decided, whatever status it is
      // waiting in now - an output approval, a block after a failed run.
      const started = task.startedAt !== null || task.attempts > 0;
      if (started || task.status === 'RUNNING' || task.status === 'AWAITING_INPUT' || isTaskFinished(task.status)) {
        throw new TandemiseError('CONFLICT', `Task '${task.title}' has already started; its staffing can no longer change.`, {
          details: { taskId, status: task.status },
        });
      }
      if (patch !== null) {
        const issues = validateStaffing(this.#team(mission.workspaceId), patch);
        if (issues.length > 0) throw TandemiseError.validation(issues.join(' '), { issues });
      }
      const updated = this.deps.tasks.update(taskId, { staffingOverride: patch, updatedAt: this.deps.clock.now() });
      // PENDING resolves when it becomes READY. Past that the task has a
      // snapshot, and its own override still re-routes it: the snapshot exists
      // so that *other* levels stop moving it, not this one. A fresh snapshot
      // records no escalation - the people it reached were for the old staffing.
      if (updated.status === 'PENDING') return;
      const snapshot = this.deps.resolver.snapshot(updated);
      if (snapshot === null) return;
      if (updated.status !== 'AWAITING_HUMAN') {
        this.deps.tasks.update(taskId, snapshot);
        return;
      }
      // A person's wait is re-addressed: to someone else, or back to READY when an agent now does it.
      const status = snapshot.executor === 'agent' ? 'READY' : 'AWAITING_HUMAN';
      const reason = status === 'READY' ? null : waitingReason(this.deps.members, { roleId: updated.roleId, ...snapshot });
      this.deps.tasks.update(taskId, { ...snapshot, status, statusReason: reason });
      this.deps.recorder.record(
        { workspaceId: mission.workspaceId, missionId: mission.id, taskId, roleId: updated.roleId },
        { type: 'task.status', from: updated.status, to: status, ...(reason === null ? {} : { reason }) },
      );
    });
    const view = this.deps.projections.taskView(taskId);
    this.deps.recorder.invalidate('tasks', view.missionId);
    return view;
  }

  preview(taskId: TaskId): StaffingPreviewView {
    const task = this.deps.tasks.get(taskId);
    if (task === undefined) throw TandemiseError.notFound('Task', taskId);
    try {
      return this.#preview(task);
    } catch (e) {
      if (e instanceof TandemiseError) throw e;
      // Resolution needs someone to answer for the work; a workspace whose
      // every owner has left has nobody, which is a state to fix, not a crash.
      const mission = this.deps.missions.get(task.missionId);
      const team = mission === undefined ? undefined : this.#team(mission.workspaceId);
      if (team !== undefined && team.owners.length === 0) {
        throw new TandemiseError('PRECONDITION_FAILED', 'This workspace has no active owner, so nobody can be responsible for this task. Make someone an owner first.', {
          details: { taskId, workspaceId: mission!.workspaceId },
        });
      }
      throw e;
    }
  }

  #preview(task: MissionTask): StaffingPreviewView {
    const taskId = task.id;
    const refs = { members: this.deps.members };
    // Past PENDING the task's staffing is decided; showing a fresh resolution
    // would claim a later edit had moved work that it did not.
    const snapshot = task.status === 'PENDING' ? null : task.staffing ?? null;
    if (snapshot !== null) {
      const responsibleId = task.responsibleId ?? this.deps.resolver.resolve(task).responsibleId;
      return {
        taskId,
        resolved: {
          executor: snapshot.executor,
          assignee: actorRef(refs, task.assigneeId ?? snapshot.agentCandidateIds[0] ?? null),
          responsible: actorRef(refs, responsibleId)!,
          claimable: actorRefs(refs, snapshot.claimable),
          agentCandidates: actorRefs(refs, snapshot.agentCandidateIds),
        },
        staffing: snapshot.staffing,
        escalation: actorRefs(refs, this.deps.resolver.chain({ ...task, responsibleId })),
      };
    }
    const resolved = this.deps.resolver.resolve(task);
    const assigneeId = resolved.assigneeId ?? resolved.agentCandidates[0]?.id ?? null;
    return {
      taskId,
      resolved: {
        executor: resolved.executor,
        assignee: actorRef(refs, assigneeId),
        responsible: actorRef(refs, resolved.responsibleId)!,
        claimable: actorRefs(refs, resolved.claimable),
        agentCandidates: actorRefs(refs, resolved.agentCandidates.map((m) => m.id)),
      },
      staffing: resolved.staffing,
      // The would-be responsible person, not a stale snapshot: this is a preview.
      escalation: actorRefs(refs, this.deps.resolver.chain({ ...task, responsibleId: resolved.responsibleId })),
    };
  }

  #team(workspaceId: WorkspaceId) {
    return indexTeam(this.deps.members.listByWorkspace(workspaceId, { includeRemoved: true }));
  }

  #requireWorkspace(id: WorkspaceId) {
    const workspace = this.deps.workspaces.get(id);
    if (workspace === undefined) throw TandemiseError.notFound('Workspace', id);
    return workspace;
  }
}
