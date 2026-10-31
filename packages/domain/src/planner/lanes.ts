import { evaluateGate, type GateFacts, type GatePredicates } from '../gate.js';
import type { PlannedTask } from '../plan.js';
import type { PlannerConfig } from './config.js';
import { maxSensitivity, type Lane, type StepClass, type TaskProfile, type TaskType } from './types.js';

/** The facts and predicates a lane rule or module reads about a profile. */
export function profileRuleContext(profile: TaskProfile): { facts: GateFacts; predicates: GatePredicates } {
  return {
    facts: {
      'profile.type': profile.type,
      'profile.size': profile.size,
      'profile.risk': profile.risk,
      'profile.max_sensitivity': maxSensitivity(profile.areas),
      'profile.repos': profile.repos.length,
    },
    predicates: {
      'profile.areas_any': (args) => args.some((n) => typeof n === 'string' && profile.areas.some((a) => a.name.toLowerCase() === n.toLowerCase())),
    },
  };
}

/** The lane (#53 §4): a person's Quick or Careful wins; otherwise the first matching rule. */
export function chooseLane(profile: TaskProfile, config: PlannerConfig, person: 'auto' | 'quick' | 'careful'): { lane: Lane; because: string } {
  if (person === 'quick' || person === 'careful') return { lane: person, because: 'you chose it' };
  const { facts, predicates } = profileRuleContext(profile);
  for (const rule of config.lanes) {
    if (rule.when === undefined) return { lane: rule.lane, because: 'the default' };
    if (evaluateGate(rule.when, facts, predicates).passed) return { lane: rule.lane, because: rule.when };
  }
  return { lane: 'standard', because: 'no lane rule matched' };
}

/** The workflow a lane runs for a task type: a type's own workflow first. */
export function laneWorkflowId(lane: Lane, type: TaskType, config: PlannerConfig): string {
  return config.byType[type]?.[lane] ?? config.laneWorkflows[lane];
}

const ROLE_CLASSES: Readonly<Record<string, StepClass>> = {
  development: 'implement',
  review: 'review',
  qa: 'verify',
  product: 'spec',
  design: 'design',
  architecture: 'architecture',
};

/** What a step is for: its explicit class, else from its role, else implement. */
export function stepClassFor(task: Pick<PlannedTask, 'stepClass' | 'roleId' | 'executor'>): StepClass {
  if (task.stepClass !== undefined && task.stepClass !== null) return task.stepClass;
  if (task.executor === 'ship') return 'ship';
  return ROLE_CLASSES[task.roleId] ?? 'implement';
}

/** A lane is stricter than another when it runs more process. */
export function laneStricter(a: Lane, b: Lane): boolean {
  const order: readonly Lane[] = ['quick', 'standard', 'careful'];
  return order.indexOf(a) > order.indexOf(b);
}
