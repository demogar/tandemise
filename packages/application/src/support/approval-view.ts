import type {
  Approval, MissionRepositoryPort, RoleRepositoryPort, TaskRepositoryPort,
} from '@tandemise/domain';
import type { ApprovalView } from '@tandemise/api-contract';

export interface ApprovalViewDeps {
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly roles: RoleRepositoryPort;
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
  };
}
