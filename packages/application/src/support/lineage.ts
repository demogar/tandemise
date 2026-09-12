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
