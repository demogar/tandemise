import type { MissionTask } from './task.js';

/**
 * Replanning the rest of a mission (replan spec): which steps a new plan
 * keeps and which it replaces.
 *
 * Decided from rows, never from what an agent said. A step that has started
 * has a history - runs, outputs, notes, evaluations - that planning must never
 * delete. A re-plan used to rebuild every task with fresh ids, and the cascade
 * took a finished step's runs and evaluations with it.
 */

export interface ReplanSplit {
  /** Started steps: kept as they are, with their ids, keys and history. */
  readonly kept: readonly MissionTask[];
  /** Steps that never started: only ever a promise the new plan supersedes. */
  readonly replaced: readonly MissionTask[];
}

/** Whether a step has any history: an attempt, a start, a run or a later round. */
export function isStarted(task: MissionTask, hasRun: boolean): boolean {
  return task.attempts > 0 || task.startedAt !== null || hasRun || (task.round ?? 1) > 1;
}

export function splitForReplan(tasks: readonly MissionTask[], taskIdsWithRuns: ReadonlySet<string>): ReplanSplit {
  const keep = new Set(tasks.filter((t) => isStarted(t, taskIdsWithRuns.has(t.id))).map((t) => t.key));
  // What a kept step depends on stays too, started or not: an upload's SKIPPED
  // placeholder never ran, but the finished step after it records where its
  // input came from through it.
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const pending = [...keep];
  while (pending.length > 0) {
    for (const dep of byKey.get(pending.pop()!)?.dependsOn ?? []) {
      if (!keep.has(dep) && byKey.has(dep)) { keep.add(dep); pending.push(dep); }
    }
  }
  return { kept: tasks.filter((t) => keep.has(t.key)), replaced: tasks.filter((t) => !keep.has(t.key)) };
}

/**
 * Why the mission cannot be replanned now, or null. A step whose run is live
 * may still finish, fail or ask, so a plan written around it would be written
 * around a moving part.
 */
export function replanRefusal(tasks: readonly MissionTask[], liveTaskIds: ReadonlySet<string>): string | null {
  const busy = tasks.find((t) => liveTaskIds.has(t.id) || t.status === 'RUNNING' || t.status === 'AWAITING_INPUT');
  return busy === undefined ? null : `Wait for '${busy.key}' to finish, or stop it, before planning the rest again.`;
}

/** The kept/replaced/added line on a replan's plan card. */
export function describeReplan(kept: number, replaced: number, added: number): string {
  const steps = (n: number): string => `${n} ${n === 1 ? 'step' : 'steps'}`;
  return `Keeps ${steps(kept)} already started · replaces ${steps(replaced)} not started · adds ${steps(added)}`;
}
