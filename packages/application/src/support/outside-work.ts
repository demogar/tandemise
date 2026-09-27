import type { ArtifactType, MissionTask, RunEventRecord } from '@tandemise/domain';

/**
 * Rules for work that happens outside Tandemise (spec A2, A4): a stage an
 * upload already covers, and a step parked while a person continues it in
 * another tool. Kept in one place so the services that act on a step and the
 * projections that show it read the same facts the same way.
 */

/** The reason a SKIPPED placeholder carries (spec A2), which is what marks it as one. */
export const COVERED_PREFIX = 'Covered by your upload:';

/** What a person is told when they try to rerun a stage an upload covers. */
export const COVERED_MESSAGE = 'This step is covered by your upload; replan to run it.';

/** A stage the planner skipped because an upload covers it. */
export function isCoveredPlaceholder(task: Pick<MissionTask, 'status' | 'statusReason'>): boolean {
  return task.status === 'SKIPPED' && (task.statusReason ?? '').startsWith(COVERED_PREFIX);
}

/**
 * Output types a person can carry on in another tool and bring back as a file
 * or a link (spec A4). Research, reviews and reports are read, not continued.
 */
export const LINKABLE_OUTPUT_TYPES: readonly ArtifactType[] = ['DesignBrief', 'ChangeSet', 'ImplementationPlan', 'ProductSpec'];

export function continuedIn(tool: string): string {
  return `Continued in ${tool}`;
}

export function waitingForWorkIn(tool: string): string {
  return `Waiting for your work in ${tool}`;
}

export interface ParkedExternal {
  readonly tool: string;
  /** When it was parked: the time of its newest `task.parked_external`. */
  readonly since: string;
  /** Who parked it, and so whose work it waits for. */
  readonly actorId: string | null;
}

/**
 * Whether an agent step is parked elsewhere right now: it is AWAITING_EXTERNAL
 * and its newest `task.parked_external` came after its newest
 * `task.handed_back`. Read from the log rather than a column, so a wait step
 * (the other AWAITING_EXTERNAL) is never mistaken for one.
 *
 * `events` is the mission's semantic log in sequence order; only this task's
 * park and hand-back events are read from it.
 */
export function parkedExternalOf(
  task: Pick<MissionTask, 'id' | 'status' | 'executor'>,
  events: readonly RunEventRecord[],
): ParkedExternal | null {
  if (task.status !== 'AWAITING_EXTERNAL' || task.executor !== 'agent') return null;
  let parked: RunEventRecord | undefined;
  let handedBackAfter = false;
  for (const event of events) {
    if (event.taskId !== task.id) continue;
    if (event.body.type === 'task.parked_external') {
      parked = event;
      handedBackAfter = false;
    } else if (event.body.type === 'task.handed_back' && parked !== undefined) {
      handedBackAfter = true;
    }
  }
  if (parked === undefined || handedBackAfter || parked.body.type !== 'task.parked_external') return null;
  return { tool: parked.body.tool, since: parked.createdAt, actorId: parked.actorId ?? null };
}
