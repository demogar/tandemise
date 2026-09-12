import type { MissionId, Clock } from '@tandemise/shared';
import { ids } from '@tandemise/shared';
import type { MissionPlan, MissionTask, PlannedTask } from '@tandemise/domain';

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
): readonly MissionTask[] {
  const now = clock.now();
  return plan.tasks.map((task, index) => fromPlanned(task, missionId, index, now));
}

function fromPlanned(
  task: PlannedTask,
  missionId: MissionId,
  index: number,
  now: string,
): MissionTask {
  return {
    id: ids.task(),
    missionId,
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
export function renderPlanDocument(plan: MissionPlan, missionTitle: string): string {
  const lines: string[] = [
    '---',
    'type: MissionPlan',
    'schemaVersion: 1',
    `title: ${JSON.stringify(`Plan for ${missionTitle}`)}`,
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
