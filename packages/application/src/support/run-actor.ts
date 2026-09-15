import type { MissionTask, RunRepositoryPort } from '@tandemise/domain';
import { RUNTIME_ACTOR } from '@tandemise/domain';
import type { RunId } from '@tandemise/shared';

/**
 * Who is acting when something happens inside a run: the run's agent, or the
 * runtime itself for a run no agent member was put on. The executor stamps
 * every run event this way, and a tool call made from the run - a question, a
 * request for permission - is the same actor asking.
 *
 * The run is looked up by id when the caller has one, otherwise as the live run
 * of the assignment. With no run at all the task's assignee is the best answer.
 */
export function runActorOf(
  runs: Pick<RunRepositoryPort, 'get' | 'listByTask'>,
  where: { readonly runId?: RunId | null; readonly taskId: MissionTask['id']; readonly assignmentId?: string },
  task: MissionTask | undefined,
): string | null {
  const run = where.runId != null
    ? runs.get(where.runId)
    : runs.listByTask(where.taskId).find((r) =>
      (r.status === 'STARTING' || r.status === 'RUNNING') && (where.assignmentId === undefined || r.assignmentId === where.assignmentId));
  if (run !== undefined) return run.agentMemberId ?? RUNTIME_ACTOR;
  return task?.assigneeId ?? null;
}
