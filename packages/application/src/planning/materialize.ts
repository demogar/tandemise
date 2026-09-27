import type { MissionId, Clock, RepositoryId } from '@tandemise/shared';
import { ids } from '@tandemise/shared';
import type { ArtifactHandoff, MissionPlan, MissionTask, PlannedTask, Repository, SkillPin } from '@tandemise/domain';

/**
 * Turns an accepted plan into the task rows the scheduler runs.
 *
 * A task with no dependencies starts READY and everything else starts PENDING,
 * so the DAG's entry points are a property of the data rather than something
 * the first tick has to work out. `orderHint` preserves the planner's own
 * ordering, which is the tie-break the UI and the dispatcher both use - without
 * it two independent tasks would render in a different order on every refresh.
 */
export function materializePlan(
  plan: MissionPlan,
  missionId: MissionId,
  clock: Clock,
  repositories: readonly Repository[] = [],
  options: MaterializeOptions = {},
): readonly MissionTask[] {
  const now = clock.now();
  // Matched case-insensitively: a plan author writing `Beveloce-Web` means the
  // same repository as `beveloce-web`, and failing over capitalisation would be
  // a needless way to lose a plan.
  const byName = new Map(repositories.map((r) => [r.name.toLowerCase(), r.id]));
  const tasks = options.inferInputs === true ? withInferredInputs(plan.tasks) : plan.tasks;
  return tasks.map((task, index) => {
    const made = fromPlanned(task, missionId, index, now, byName);
    // P13: the pins are resolved now, so `latest` means the newest version when the task was created.
    return options.skills === undefined ? made : { ...made, skills: options.skills(task) };
  });
}

export interface MaterializeOptions {
  /**
   * For a model's plan: a task that names no inputs reads what its direct
   * dependencies produce. A planner often leaves `inputArtifacts` out, and a
   * task given none is shown none of that work and records no run inputs, so a
   * later round of the work it built on could not tell it had used it (spec §3).
   * A workflow file is left as its author wrote it.
   */
  readonly inferInputs?: boolean;
  /**
   * The skills each task gets (P13): its role's pins and its step's refs,
   * resolved to concrete versions. Absent: tasks are created unresolved, and
   * resolve their role's pins on their first run.
   */
  readonly skills?: (task: PlannedTask) => readonly SkillPin[];
}

function withInferredInputs(tasks: readonly PlannedTask[]): readonly PlannedTask[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  return tasks.map((task) => {
    if (task.inputArtifacts.length > 0 || task.dependsOn.length === 0) return task;
    const types = [...new Set(task.dependsOn.flatMap((key) => byKey.get(key)?.expectedOutputs ?? []))];
    // Not required: the planner never asked for them, so a dependency that writes nothing is no warning.
    return types.length === 0 ? task : { ...task, inputArtifacts: types.map((type) => ({ type, required: false })) };
  });
}

/**
 * The repository a planned task names, or null to inherit the mission's.
 *
 * An unknown name resolves to null rather than throwing: plan validation is
 * where a bad name is reported, and a task that falls back to the mission's own
 * repository is a great deal better than a mission that cannot be materialized.
 */
function resolveRepository(
  task: PlannedTask,
  byName: ReadonlyMap<string, RepositoryId>,
): RepositoryId | null {
  const name = task.repository?.trim();
  if (name === undefined || name === '') return null;
  return byName.get(name.toLowerCase()) ?? null;
}

function fromPlanned(
  task: PlannedTask,
  missionId: MissionId,
  index: number,
  now: string,
  byName: ReadonlyMap<string, RepositoryId>,
): MissionTask {
  return {
    id: ids.task(),
    missionId,
    repositoryId: resolveRepository(task, byName),
    executor: task.executor ?? 'agent',
    waitPolicy: task.waitPolicy ?? null,
    key: task.key,
    title: task.title,
    objective: task.objective,
    roleId: task.roleId,
    dependsOn: task.dependsOn,
    requiredCapabilities: task.requiredCapabilities,
    inputArtifacts: task.inputArtifacts,
    expectedOutputs: task.expectedOutputs,
    executionPolicy: task.executionPolicy,
    approvalPolicy: task.approvalPolicy,
    retryPolicy: task.retryPolicy,
    completionGate: task.completionGate,
    modelPolicy: task.modelPolicy ?? null,
    status: task.dependsOn.length === 0 ? 'READY' : 'PENDING',
    statusReason: null,
    attempts: 0,
    remediatesTaskId: null,
    orderHint: index,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * The plan as a readable document, stored as the `MissionPlan` artifact.
 *
 * Plan approval has to point at something a human can read, and "here is the
 * JSON we sent to the validator" is not that. It is also the only durable
 * record of the planner's *reasoning* - the task rows keep the decisions but
 * not the summary that explains them.
 */
/** The MissionPlan's title, within the 60 characters every artifact title is held to. */
export function planTitle(missionTitle: string): string {
  return clip(`Plan for ${missionTitle}`, 60);
}

/**
 * The Refinement's title. The daemon names the note after its mission rather
 * than trusting the title line the agent wrote, so every refinement reads the
 * same way in the Artifacts list and the reader.
 */
export function refinementTitle(missionTitle: string): string {
  return clip(`Refinement: ${missionTitle}`, 60);
}

/** Cuts text to `max` characters, marking the cut. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export function renderPlanDocument(plan: MissionPlan, missionTitle: string, handoff: ArtifactHandoff): string {
  // JSON strings are valid YAML scalars, so any title or summary is quoted safely.
  const lines: string[] = [
    '---',
    'type: MissionPlan',
    'schemaVersion: 1',
    `title: ${JSON.stringify(planTitle(missionTitle))}`,
    'handoff:',
    `  headline: ${JSON.stringify(handoff.headline)}`,
    ...(handoff.points.length === 0 ? ['  points: []'] : ['  points:', ...handoff.points.map((p) => `    - ${JSON.stringify(p)}`)]),
    ...(handoff.needs === null ? [] : [`  needs: ${JSON.stringify(handoff.needs)}`]),
    '---',
    '',
    `# Plan for ${missionTitle}`,
    '',
    plan.summary.trim().length > 0 ? plan.summary.trim() : `${plan.tasks.length} tasks.`,
    '',
  ];

  for (const task of plan.tasks) {
    lines.push(
      `## ${task.key} — ${task.title}`,
      '',
      `- Role: \`${task.roleId}\``,
      `- Depends on: ${task.dependsOn.length === 0 ? '(nothing)' : task.dependsOn.map((d) => `\`${d}\``).join(', ')}`,
      `- Produces: ${task.expectedOutputs.length === 0 ? '(no artifact)' : task.expectedOutputs.join(', ')}`,
      `- Isolation: ${task.executionPolicy.isolation}`,
      `- Completion gate: ${task.completionGate === null ? '(none)' : `\`${task.completionGate}\``}`,
      ...(task.approvalPolicy.beforeStart || task.approvalPolicy.onCompletion
        ? [`- Approval: ${task.approvalPolicy.beforeStart ? 'before start' : ''}${
          task.approvalPolicy.beforeStart && task.approvalPolicy.onCompletion ? ' and ' : ''
        }${task.approvalPolicy.onCompletion ? 'on completion' : ''}`]
        : []),
      '',
      task.objective.trim(),
      '',
    );
  }
  return lines.join('\n');
}
