import type { MemberRepositoryPort, Mission, MissionTask } from '@tandemise/domain';
import { escalationChain, indexTeam } from '@tandemise/domain';
import { TandemiseError, asId } from '@tandemise/shared';

/** What a person is doing when they take a task, as the refusal names it. */
export type TakeAction = 'claim' | 'complete' | 'continue' | 'hand back' | 'take back' | 'hold' | 'release';

/**
 * The assignee may act on their task; on an unassigned one, anyone the
 * staffing made claimable. A task resolved before staffing existed names no
 * one, and stays open to whoever the workspace lets act at all.
 *
 * An agent's step is taken by a person only to continue it elsewhere (spec
 * A4) or to hold it, and nobody can claim it: the person who answers for it
 * may, and so may anyone they answer to, up to the owners.
 *
 * One rule for the mission service and the hold service, so taking a step
 * means the same thing whichever way it is taken.
 */
export function assertMayTake(
  deps: { readonly members: MemberRepositoryPort },
  task: MissionTask,
  mission: Mission,
  actorId: string,
  action: TakeAction,
): void {
  if (task.executor === 'agent') {
    if (task.staffing == null || task.responsibleId == null) return;
    const team = indexTeam(deps.members.listByWorkspace(mission.workspaceId, { includeRemoved: true }));
    if (team.owners.length === 0 || escalationChain(team, task.responsibleId).includes(actorId)) return;
    const what = action === 'continue' ? `continue '${task.title}' elsewhere` : `${action} '${task.title}'`;
    throw new TandemiseError('CONFLICT', `This member cannot ${what}: only the person who answers for it, or someone they answer to, can.`, {
      details: { taskId: task.id, actorId, responsibleId: task.responsibleId },
    });
  }
  const allowed = task.assigneeId != null
    ? task.assigneeId === actorId || reachedByEscalation(task, actorId)
    : task.staffing == null || task.staffing.claimable.includes(actorId);
  if (allowed) return;
  const whose = task.assigneeId != null
    ? `it is assigned to ${deps.members.get(asId<'MemberId'>(task.assigneeId))?.name ?? 'someone else'}`
    : 'they are not one of the people who can take it';
  throw new TandemiseError('CONFLICT', `This member cannot ${action} '${task.title}': ${whose}.`, {
    details: { taskId: task.id, actorId, assigneeId: task.assigneeId ?? null },
  });
}

/**
 * Whether the member was reached by an escalation, and so may take a task
 * from its assignee. Only what `ReviewPipeline#escalatePool` recorded counts:
 * the other people of a pool someone already claimed - two owners of a
 * fallback pool included - came from the staffing, and a claim is not taken twice.
 */
export function reachedByEscalation(task: MissionTask, actorId: string): boolean {
  return task.assigneeId != null && (task.staffing?.escalatedTo ?? []).includes(actorId);
}
