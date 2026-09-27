import type { ArtifactType } from './entities/artifact.js';
import type { IsolationMode } from './entities/task.js';
import { concreteFactNames, factDefinition } from './gate-facts.js';
import { gateDependencies, validateGate } from './gate.js';

/**
 * Refuses a gate that could never pass, when it is written.
 *
 * A gate is read only after its step has run. One that reads a fact the daemon
 * never measures inside a step - a typo, a mission-wide number, a fact that
 * needs a condition the step does not have - fails as "not measured" on every
 * attempt, and the person finds out on an intervention card an hour later.
 * Everything that can be known about that from the gate and its step alone is
 * decided here, once, for every place a gate is written: a workflow file, a
 * planner's plan, a materialized plan and an import.
 *
 * The vocabulary's `scope` is the single source of truth: a fact is readable in
 * a step gate exactly when it is step-scoped (and its `requires` holds).
 */
export type GateProblemCode =
  | 'syntax'
  | 'unknown_fact'
  | 'not_step_scope'
  | 'needs_independent_of'
  | 'needs_worktree'
  | 'needs_changeset'
  | 'own_output';

export interface GateProblem {
  readonly code: GateProblemCode;
  /** The fact the problem is about; null for syntax and a missing output check. */
  readonly fact: string | null;
  /** One sentence, shown to the person verbatim. */
  readonly message: string;
}

/** What the validator needs to know about the step a gate belongs to. */
export interface GateSubject {
  readonly stepKey: string;
  readonly outputs: readonly ArtifactType[];
  /** The step names `independentOf`, so `review.independent` is measured on it. */
  readonly independentOf: boolean;
  /** Its isolation, when known. Unknown (a workflow step inheriting its role's) skips the worktree rule. */
  readonly isolation?: IsolationMode;
}

export function lintGate(expression: string, subject: GateSubject): readonly GateProblem[] {
  const on = `The gate on '${subject.stepKey}'`;
  const parsed = validateGate(expression);
  if (!parsed.ok) return [{ code: 'syntax', fact: null, message: `${on} cannot be read: ${parsed.error}.` }];

  const problems: GateProblem[] = [];
  const facts = gateDependencies(expression);
  for (const fact of facts) {
    const definition = factDefinition(fact);
    if (definition === undefined) {
      const near = nearest(fact);
      problems.push({
        code: 'unknown_fact',
        fact,
        message: `${on} reads ${fact}, which Tandemise never measures.${near === null ? '' : ` Did you mean ${near}?`}`,
      });
      continue;
    }
    if (definition.scope !== 'step') {
      const whole = definition.scope === 'mission' ? 'the whole mission' : 'the whole project';
      problems.push({
        code: 'not_step_scope',
        fact,
        message: `${on} reads ${fact}, which is only known for ${whole}, not inside a step.`,
      });
      continue;
    }
    if (definition.requires === 'independentOf' && !subject.independentOf) {
      problems.push({
        code: 'needs_independent_of',
        fact,
        message: `${on} reads ${fact}, which is only measured on a step with independentOf.`,
      });
    }
    if (definition.requires === 'worktree' && subject.isolation !== undefined && subject.isolation !== 'worktree') {
      problems.push({
        code: 'needs_worktree',
        fact,
        message: `${on} reads ${fact}, which is only measured on a step that works in its own worktree.`,
      });
    }
    if (definition.requires === 'changeset' && !subject.outputs.includes('ChangeSet')) {
      problems.push({
        code: 'needs_changeset',
        fact,
        message: `${on} reads ${fact}, which is only measured from the step's own ChangeSet, and '${subject.stepKey}' does not produce one.`,
      });
    }
  }

  // PR #14's rule, for every gate and not only the presets: a gate replaces the
  // "did it write its outputs" check, so one that never reads its own output
  // passes a run that wrote nothing on facts other steps produced.
  if (subject.outputs.length > 0) {
    const own = subject.outputs.map((type) => `artifact.${type}.exists`);
    if (!own.some((name) => facts.includes(name))) {
      problems.push({
        code: 'own_output',
        fact: null,
        message: `${on} never checks that the step wrote its output: add ${own.join(' or ')}, so a run that writes nothing cannot pass.`,
      });
    }
  }
  return problems;
}

/** The closest known fact name, when it is close enough to be a typo. */
function nearest(fact: string): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of concreteFactNames()) {
    const d = distance(fact.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  // A third of the name, at most 4 edits: "checks.test" → "checks.tests", not
  // "foo.bar" → "task.role".
  return bestDistance <= Math.min(4, Math.floor(fact.length / 3)) ? best : null;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/**
 * Every problem with the gates of a plan's tasks, in task order. The same rules
 * `validateMissionPlan` applies, for callers that hold a plan someone already
 * accepted: materializing one with a gate that can never pass is refused.
 */
export function planGateProblems(tasks: readonly {
  readonly key: string;
  readonly completionGate: string | null;
  readonly expectedOutputs: readonly ArtifactType[];
  readonly executionPolicy: { readonly isolation: IsolationMode };
  readonly modelPolicy?: { readonly independentOf?: string } | null;
}[]): readonly GateProblem[] {
  return tasks.flatMap((task) => task.completionGate === null || task.completionGate === ''
    ? []
    : lintGate(task.completionGate, {
      stepKey: task.key,
      outputs: task.expectedOutputs,
      independentOf: task.modelPolicy?.independentOf !== undefined,
      isolation: task.executionPolicy.isolation,
    }));
}
