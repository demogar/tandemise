import type { ArtifactManifest, MissionTask, Run, TaskStatus } from '@tandemise/domain';
import type { ArtifactId } from '@tandemise/shared';
import { upstreamTaskIds } from './lineage.js';

export interface ConsumerFacts {
  readonly tasks: readonly MissionTask[];
  /** Every run of the mission. */
  readonly runs: readonly Run[];
  readonly inputs: readonly { readonly runId: string; readonly artifactId: string }[];
  /** Every artifact of the mission, superseded versions included. */
  readonly artifacts: readonly ArtifactManifest[];
}

export interface Consumer {
  readonly task: MissionTask;
  /** The artifact of an upstream task its latest run used. */
  readonly used: ArtifactManifest;
  /** `record` from run_inputs; `inferred` only for a run from before migration 010. */
  readonly via: 'record' | 'inferred';
}

/**
 * Statuses in which a task has a pass in flight on this machine: a run that is
 * still going, or one parked inside `ask_human`. Such a pass will read what it
 * was given when it ends, and must be stopped rather than reset under it.
 */
export const LIVE_RUN_STATUSES: readonly TaskStatus[] = ['RUNNING', 'AWAITING_INPUT'];

/** Statuses in which a task has not consumed anything yet, whatever its run history says. */
const NOT_STARTED: readonly TaskStatus[] = ['PENDING', 'READY', 'SKIPPED', 'CANCELLED'];

/**
 * The tasks whose latest run used an artifact of `source`, and, transitively,
 * the tasks that used theirs (spec §3).
 *
 * Read from `run_inputs`, which the executor writes when a run starts. A run
 * from before migration 010 has no record; its `round` is NULL, and only then
 * is consumption inferred: a dependent that declared the artifact's type as an
 * input and started after that artifact existed. A task that has not started
 * has consumed nothing and is left out, whatever the graph says.
 */
export function downstreamConsumers(source: MissionTask, facts: ConsumerFacts): readonly Consumer[] {
  const latestRun = new Map<string, Run>();
  for (const run of facts.runs) {
    const known = latestRun.get(run.taskId);
    if (known === undefined || run.startedAt > known.startedAt) latestRun.set(run.taskId, run);
  }
  const inputsByRun = new Map<string, Set<string>>();
  for (const { runId, artifactId } of facts.inputs) {
    const set = inputsByRun.get(runId) ?? new Set<string>();
    set.add(artifactId);
    inputsByRun.set(runId, set);
  }
  const outputsOf = new Map<string, ArtifactManifest[]>();
  for (const a of facts.artifacts) {
    if (a.taskId === null) continue;
    outputsOf.set(a.taskId, [...(outputsOf.get(a.taskId) ?? []), a]);
  }

  const found = new Map<string, Consumer>();
  const seen = new Set<string>([source.id]);
  const frontier: MissionTask[] = [source];
  while (frontier.length > 0) {
    const upstream = frontier.shift()!;
    const outputs = outputsOf.get(upstream.id) ?? [];
    if (outputs.length === 0) continue;
    for (const candidate of facts.tasks) {
      if (seen.has(candidate.id) || NOT_STARTED.includes(candidate.status)) continue;
      const run = latestRun.get(candidate.id);
      if (run === undefined) continue;
      const recorded = inputsByRun.get(run.id);
      let used: ArtifactManifest | undefined;
      let via: Consumer['via'] = 'record';
      if (recorded !== undefined) {
        used = outputs.find((a) => recorded.has(a.id));
      } else if ((run.round ?? null) === null && upstreamTaskIds(candidate, facts.tasks).has(upstream.id)) {
        via = 'inferred';
        used = outputs
          .filter((a) => candidate.inputArtifacts.some((r) => r.type === a.type) && a.createdAt <= run.startedAt)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      }
      if (used === undefined) continue;
      seen.add(candidate.id);
      found.set(candidate.id, { task: candidate, used, via });
      frontier.push(candidate);
    }
  }
  return [...found.values()];
}

/**
 * The task a review task reviewed: its one direct dependency with a live
 * ChangeSet, else its one direct dependency with any live output. Null when
 * that is ambiguous, and the findings then keep today's fix-task flow.
 */
export function reviewedTaskOf(
  review: MissionTask,
  tasks: readonly MissionTask[],
  artifacts: readonly ArtifactManifest[],
): MissionTask | null {
  const superseded = new Set(artifacts.map((a) => a.supersedes).filter((id): id is ArtifactId => id !== null));
  const liveTypes = (t: MissionTask) => artifacts.filter((a) => a.taskId === t.id && !superseded.has(a.id)).map((a) => a.type);
  const direct = review.dependsOn.map((key) => tasks.find((t) => t.key === key)).filter((t): t is MissionTask => t !== undefined);
  const changes = direct.filter((t) => liveTypes(t).includes('ChangeSet'));
  if (changes.length > 0) return changes.length === 1 ? changes[0]! : null;
  const producing = direct.filter((t) => liveTypes(t).length > 0);
  return producing.length === 1 ? producing[0]! : null;
}
