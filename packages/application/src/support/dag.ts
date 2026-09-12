import type {
  Capability, MissionTask, PlanValidationIssue, PlannedTask, RoleTemplate,
} from '@tandemise/domain';
import { validateMissionPlan } from '@tandemise/domain';
import { Ok, type Result } from '@tandemise/shared';

/**
 * A `MissionTask` is a `PlannedTask` that has been given an id and a status, so
 * the graph the planner validated and the graph the scheduler runs are the same
 * shape. That is deliberate: it means a *runtime* mutation - a remediation task
 * spliced into a mission that is already executing - can be checked by exactly
 * the validator that accepted the original plan, rather than by a second,
 * weaker set of rules that will drift.
 */
export function asPlannedTasks(tasks: readonly MissionTask[]): readonly PlannedTask[] {
  return tasks;
}

/**
 * Re-validates a mutated task graph.
 *
 * The capability context is the union of what the mission's tasks already
 * require. Those were checked against the machine when the plan was accepted,
 * so re-deriving them here checks the structure - acyclicity, known roles,
 * required inputs produced upstream - without pretending to re-answer a
 * question about the host that nothing in this call knows.
 */
export function validateTaskGraph(
  tasks: readonly MissionTask[],
  roles: readonly RoleTemplate[],
): Result<readonly PlannedTask[], readonly PlanValidationIssue[]> {
  const satisfiable = new Set<Capability>();
  for (const task of tasks) {
    for (const c of task.requiredCapabilities) satisfiable.add(c);
    for (const c of task.executionPolicy.capabilities) satisfiable.add(c);
  }
  const validated = validateMissionPlan(
    { summary: 'mutated mission graph', tasks: asPlannedTasks(tasks) },
    { knownRoleIds: new Set(roles.map((r) => r.id)), satisfiableCapabilities: satisfiable },
  );
  return validated.ok ? Ok(validated.value.tasks) : validated;
}

export function describeIssues(issues: readonly PlanValidationIssue[]): string {
  return issues
    .filter((i) => i.severity === 'error')
    .map((i) => (i.taskKey === null ? i.message : `${i.taskKey}: ${i.message}`))
    .join('; ');
}
