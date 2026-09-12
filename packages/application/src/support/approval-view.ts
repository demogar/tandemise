import type {
  Approval, MissionRepositoryPort, MissionTask, RoleRepositoryPort, RunRepositoryPort, TaskRepositoryPort,
} from '@tandemise/domain';
import type { ApprovalView } from '@tandemise/api-contract';

export interface ApprovalViewDeps {
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly roles: RoleRepositoryPort;
  readonly runs: RunRepositoryPort;
}

/**
 * An approval with the three names a human needs to answer it.
 *
 * Shared rather than duplicated because the approval inbox and the mission
 * screen show the same card, and a card that reads "Approve the output of
 * implement?" in one place and names the mission in the other is the kind of
 * inconsistency that makes a user distrust both.
 */
export function toApprovalView(deps: ApprovalViewDeps, approval: Approval): ApprovalView {
  const mission = approval.missionId === null ? undefined : deps.missions.get(approval.missionId);
  const task = approval.taskId === null ? undefined : deps.tasks.get(approval.taskId);
  const role = task === undefined ? undefined : deps.roles.get(task.roleId, approval.workspaceId);
  return {
    approval,
    missionTitle: mission?.title ?? null,
    taskTitle: task?.title ?? null,
    roleName: role?.name ?? task?.roleId ?? null,
    revisable: task !== undefined && isOutputApproval(approval, task, deps.runs),
  };
}

/**
 * Whether this card asks "do you accept this task's output?" - the only kind a
 * rejection with a note turns into a revision.
 *
 * A start approval, a tool approval and an output approval are all `action`
 * cards on the same task. They are told apart from the record rather than by a
 * marker on the card: an output approval is pending while its task waits in
 * AWAITING_APPROVAL, and was created after that task's latest run began (a start
 * approval predates the run). A tool approval is answered while the task is
 * still RUNNING. One rule, used by the service that acts on the decision and by
 * the view that describes it, so the card never promises what will not happen.
 */
export function isOutputApproval(approval: Approval, task: MissionTask, runs: RunRepositoryPort): boolean {
  if (approval.kind !== 'action' && approval.kind !== 'release') return false;
  if (task.status !== 'AWAITING_APPROVAL' && approval.status === 'PENDING') return false;
  return !isStartApproval(approval, task, runs);
}

/** Created before the attempt's run row existed ⇒ it gated the start. */
export function isStartApproval(approval: Approval, task: MissionTask, runs: RunRepositoryPort): boolean {
  const latest = [...runs.listByTask(task.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (latest === undefined) return true;
  return approval.createdAt <= latest.startedAt;
}
