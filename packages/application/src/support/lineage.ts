import type { ArtifactManifest, ArtifactRepositoryPort, ArtifactType, MissionTask, TaskRepositoryPort } from '@tandemise/domain';

/** Ids of every task `task` depends on, directly or transitively. */
export function upstreamTaskIds(task: MissionTask, tasks: readonly MissionTask[]): ReadonlySet<string> {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const seen = new Set<string>();
  const stack = [...task.dependsOn];
  while (stack.length > 0) {
    const dependency = byKey.get(stack.pop()!);
    if (dependency === undefined || seen.has(dependency.id)) continue;
    seen.add(dependency.id);
    stack.push(...dependency.dependsOn);
  }
  return seen;
}

/** The live (not superseded) artifacts of a type on a mission, newest first. */
export function liveArtifacts(
  artifacts: ArtifactRepositoryPort,
  missionId: MissionTask['missionId'],
  type: ArtifactType,
): readonly ArtifactManifest[] {
  const all = artifacts.listByMission(missionId);
  const superseded = new Set(all.map((a) => a.supersedes).filter((id) => id !== null));
  return all.filter((a) => a.type === type && !superseded.has(a.id));
}

/**
 * Which live artifact a new one of the same type replaces, if any.
 *
 * Only this task's own earlier output, or output from a task upstream of it: a
 * retry replaces its failed attempt, a revision replaces what it revises, a fix
 * replaces the change it fixes. Two parallel tasks producing the same type are
 * not upstream of each other, so both stay live. Superseding mission-wide made
 * the web research brief silently replace the mobile one, and the product
 * document was written without the mobile research.
 */
export function supersededBy(
  task: MissionTask,
  type: ArtifactType,
  artifacts: ArtifactRepositoryPort,
  tasks: TaskRepositoryPort,
): ArtifactManifest | undefined {
  const upstream = upstreamTaskIds(task, tasks.listByMission(task.missionId));
  return liveArtifacts(artifacts, task.missionId, type)
    .find((a) => a.taskId === task.id || (a.taskId !== null && upstream.has(a.taskId)));
}

/**
 * What a person's step was handed: the artifacts an agent in its place would
 * have been given, from the mission's artifacts (superseded versions included).
 *
 * Per declared input, the live artifacts of that type from upstream tasks, or
 * the newest live one when nothing upstream made it, as the executor reads
 * them. A person step planned without declared inputs gets the live outputs
 * of the steps it directly depends on: an agent would at least know what
 * those found, and a person should too.
 */
export function handedTo(
  task: MissionTask,
  tasks: readonly MissionTask[],
  all: readonly ArtifactManifest[],
): readonly ArtifactManifest[] {
  const superseded = new Set(all.map((a) => a.supersedes).filter((id) => id !== null));
  const live = all.filter((a) => !superseded.has(a.id));
  if (task.inputArtifacts.length === 0) {
    const direct = new Set(tasks.filter((t) => task.dependsOn.includes(t.key)).map((t) => t.id));
    return live.filter((a) => a.taskId !== null && direct.has(a.taskId));
  }
  const upstream = upstreamTaskIds(task, tasks);
  const handed: ArtifactManifest[] = [];
  for (const requirement of task.inputArtifacts) {
    const ofType = live.filter((a) => a.type === requirement.type);
    const fromUpstream = ofType.filter((a) => a.taskId !== null && upstream.has(a.taskId));
    const newest = [...ofType].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    for (const artifact of fromUpstream.length > 0 ? fromUpstream : newest === undefined ? [] : [newest]) {
      if (!handed.some((h) => h.id === artifact.id)) handed.push(artifact);
    }
  }
  return handed;
}
