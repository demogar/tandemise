import { z } from 'zod';
import { ARTIFACT_TYPES } from './entities/artifact.js';
import { ISOLATION_MODES } from './entities/task.js';
import { Err, Ok, type Result } from '@tandemise/shared';
import type { MissionPlan, PlannedTask } from './plan.js';

/**
 * A workflow someone wrote, as opposed to one a model proposed.
 *
 * Tandemise shipped three workflow presets compiled into the binary, which is
 * fine until someone's process is not one of the three - and nobody's process
 * is. A real team's pipeline is specific: which gates, in what order, who
 * approves what, which repository each step lands in, and where a person has to
 * go and do something by hand. That belongs in a file next to the code it
 * describes, versioned with it and reviewable in a diff, not in this repository.
 *
 * The shape is deliberately the shape of a plan. A workflow compiles to exactly
 * the `MissionPlan` a planner would have produced, so it inherits the DAG, the
 * validator, the gates, the approvals and the scheduler unchanged - authoring a
 * workflow is writing a plan by hand, not teaching the engine a second language.
 *
 * What it is *not* is a place to restate the engine's rules. A gate that must
 * not be weakened, a retry limit, an isolated worktree per task: those are
 * enforced in code and stay there. A workflow says what the steps are.
 */

const templateString = z.string().min(1);

const workflowStep = z.object({
  /** Stable key, referenced by `dependsOn`. Lowercase with underscores. */
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9_]*$/, 'must be lowercase alphanumeric with underscores'),
  title: z.string().trim().min(1).optional(),
  /**
   * What the step is for. Templated with `{{ input }}` placeholders.
   *
   * For a person, this is the instruction they read; for an agent it is the
   * objective it is given. Same field because it is the same sentence.
   */
  objective: templateString,
  /**
   * Who carries it out. `agent` is a runtime; `human` is you.
   *
   * A human step is the reason this exists at all: a design that has to be made
   * in Figma, a console someone has to click through, an account that has to be
   * created. Modelling it as a step keeps it inside the dependency graph, so the
   * work that needs it waits rather than failing, and the mission is honest
   * about what it is waiting for.
   */
  executor: z.enum(['agent', 'human']).default('agent'),
  /** Role template id. Ignored for a human step. */
  role: z.string().trim().min(1).optional(),
  dependsOn: z.array(z.string().trim().min(1)).default([]),
  /** Repository name, for a project that has more than one. */
  repository: z.string().trim().min(1).nullish(),
  isolation: z.enum(ISOLATION_MODES).optional(),
  capabilities: z.array(z.string().trim().min(1)).default([]),
  /** Artifact types this step must produce before it counts as done. */
  outputs: z.array(z.enum(ARTIFACT_TYPES)).default([]),
  inputs: z.array(z.enum(ARTIFACT_TYPES)).default([]),
  /** Gate expression, measured after the step runs. */
  gate: z.string().trim().min(1).nullish(),
  approval: z.enum(['none', 'before', 'after']).default('none'),
  maxWallTimeMs: z.number().int().positive().optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

const workflowInput = z.object({
  name: z.string().trim().regex(/^[a-z][a-z0-9_]*$/i, 'must be a simple identifier'),
  description: z.string().trim().min(1).optional(),
  required: z.boolean().default(true),
  default: z.string().optional(),
});

export const workflowDefinition = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).optional(),
  inputs: z.array(workflowInput).default([]),
  steps: z.array(workflowStep).min(1),
});

export type WorkflowDefinition = z.infer<typeof workflowDefinition>;
export type WorkflowStep = z.infer<typeof workflowStep>;
export type WorkflowInput = z.infer<typeof workflowInput>;

export interface WorkflowIssue {
  readonly path: string;
  readonly message: string;
}

/** The role a human step is recorded under, so the UI can say who is waiting. */
export const HUMAN_ROLE_ID = 'human';

const DEFAULT_WALL_TIME_MS = 1_800_000;

/**
 * Reads a workflow file's already-parsed contents.
 *
 * Parsing YAML is the caller's job - this layer never touches a filesystem -
 * but everything that can be wrong *about* a workflow is decided here, so the
 * same answer comes back whether the file arrived from disk, an import, or a
 * test.
 */
export function parseWorkflowDefinition(raw: unknown): Result<WorkflowDefinition, readonly WorkflowIssue[]> {
  const parsed = workflowDefinition.safeParse(raw);
  if (!parsed.success) {
    return Err(parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })));
  }
  return Ok(parsed.data);
}

/**
 * Turns a workflow and its inputs into the plan the scheduler runs.
 *
 * Everything structural is checked here rather than left to the plan validator,
 * because a workflow author wants to hear "step 'build' depends on 'desgin',
 * which does not exist" and not a failure three tasks into a mission.
 */
export function compileWorkflow(
  definition: WorkflowDefinition,
  inputs: Readonly<Record<string, string>>,
): Result<MissionPlan, readonly WorkflowIssue[]> {
  const issues: WorkflowIssue[] = [];
  const resolved = resolveInputs(definition, inputs, issues);

  const keys = new Set<string>();
  for (const [index, step] of definition.steps.entries()) {
    if (keys.has(step.key)) issues.push({ path: `steps.${index}.key`, message: `Duplicate step key '${step.key}'.` });
    keys.add(step.key);
  }
  for (const [index, step] of definition.steps.entries()) {
    for (const dep of step.dependsOn) {
      if (dep === step.key) issues.push({ path: `steps.${index}.dependsOn`, message: `Step '${step.key}' depends on itself.` });
      else if (!keys.has(dep)) {
        issues.push({ path: `steps.${index}.dependsOn`, message: `Step '${step.key}' depends on '${dep}', which is not a step in this workflow.` });
      }
    }
    if (step.executor === 'agent' && step.role === undefined) {
      issues.push({ path: `steps.${index}.role`, message: `Step '${step.key}' runs on an agent, so it needs a role.` });
    }
  }

  if (issues.length > 0) return Err(issues);

  const tasks = definition.steps.map((step) => toPlannedTask(step, resolved, issues));
  if (issues.length > 0) return Err(issues);

  return Ok({
    summary: definition.description ?? `Runs the "${definition.name}" workflow.`,
    tasks,
  });
}

function resolveInputs(
  definition: WorkflowDefinition,
  provided: Readonly<Record<string, string>>,
  issues: WorkflowIssue[],
): Readonly<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const input of definition.inputs) {
    const value = provided[input.name] ?? input.default;
    if (value === undefined || value === '') {
      if (input.required) issues.push({ path: `inputs.${input.name}`, message: `Input '${input.name}' is required.` });
      continue;
    }
    resolved[input.name] = value;
  }
  return resolved;
}

/**
 * Substitutes `{{ name }}`.
 *
 * Deliberately the whole templating language. A workflow that needs conditions
 * and loops is a program, and the moment this grows an expression evaluator it
 * becomes one nobody can debug - the DAG is where branching belongs.
 */
export function applyTemplate(
  text: string,
  values: Readonly<Record<string, string>>,
  onUnknown: (name: string) => void,
): string {
  return text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      onUnknown(name);
      return `{{ ${name} }}`;
    }
    return value;
  });
}

function toPlannedTask(
  step: WorkflowStep,
  values: Readonly<Record<string, string>>,
  issues: WorkflowIssue[],
): PlannedTask {
  const objective = applyTemplate(step.objective, values, (name) => {
    issues.push({ path: `steps.${step.key}.objective`, message: `Uses {{ ${name} }}, which this workflow does not declare as an input.` });
  });
  const human = step.executor === 'human';

  return {
    key: step.key,
    title: step.title ?? step.key.replace(/_/g, ' '),
    objective,
    roleId: human ? HUMAN_ROLE_ID : step.role ?? HUMAN_ROLE_ID,
    executor: step.executor,
    repository: step.repository ?? null,
    dependsOn: step.dependsOn,
    requiredCapabilities: step.capabilities,
    inputArtifacts: step.inputs.map((type) => ({ type, required: true })),
    expectedOutputs: step.outputs,
    executionPolicy: {
      // A person is not sandboxed. Asking for a worktree on their behalf would
      // cut one nobody ever opens.
      isolation: human ? 'none' : step.isolation ?? 'none',
      maxWallTimeMs: step.maxWallTimeMs ?? DEFAULT_WALL_TIME_MS,
      capabilities: step.capabilities,
    },
    approvalPolicy: {
      beforeStart: step.approval === 'before',
      // A human step is its own approval: waiting for someone to do the work
      // and then asking them to approve it is one interruption too many.
      onCompletion: !human && step.approval === 'after',
    },
    retryPolicy: {
      maxAttempts: human ? 1 : step.maxAttempts ?? 2,
      backoffMs: 5_000,
      onExhausted: 'block',
    },
    completionGate: step.gate ?? null,
  };
}
