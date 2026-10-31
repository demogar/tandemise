import type { WorkflowDefinition, WorkflowStep } from '@tandemise/domain';
import { CORE_CAPABILITIES } from '@tandemise/domain';
import { QA_CRITERIA_GATE, SPEC_CRITERIA_GATE, testsClause, type PresetContext } from '../presets.js';

/**
 * The three lanes as workflows (#53 §4), plus a type's own (`fix`,
 * `fix-careful`). They replace the presets as what the factory starts from;
 * the presets stay as the last fallback. Gates reuse the presets' clauses and
 * depend on whether the repository declares a test command, so the lanes are
 * built per call. A project file `.tandemise/workflows/<id>.yaml` of the same
 * id overrides a shipped lane.
 *
 * Every code lane ends in the daemon-owned ship step. The release-candidate
 * step is retired here: its job moves to the ship step, which works from
 * measured facts (§4).
 */
export const SHIP_STEP_KEY = 'ship';
const SHIP_OBJECTIVE = 'Open the pull request, wait for CI on its head commit, then merge it or ask for a review, by the project\'s merge policy.';

const READ_ONLY = [CORE_CAPABILITIES.repositoryRead, CORE_CAPABILITIES.filesystemRead, CORE_CAPABILITIES.artifactWrite];
const WRITE_CODE = [...READ_ONLY, CORE_CAPABILITIES.filesystemWrite, CORE_CAPABILITIES.shell, CORE_CAPABILITIES.git, CORE_CAPABILITIES.gitCommit, CORE_CAPABILITIES.testsRun];

type StepIn = Partial<WorkflowStep> & Pick<WorkflowStep, 'key' | 'objective'>;

function step(s: StepIn): WorkflowStep {
  return {
    executor: 'agent', dependsOn: [], capabilities: [], outputs: [], inputs: [], approval: 'none',
    ...s,
  } as WorkflowStep;
}

const ship = (after: string): WorkflowStep => step({
  key: SHIP_STEP_KEY, title: 'Ship', objective: SHIP_OBJECTIVE, executor: 'ship', class: 'ship', dependsOn: [after],
});

function implement(ctx: PresetContext, objective: string, dependsOn: string[] = [], title = 'Implement the change'): WorkflowStep {
  return step({
    key: 'implement', title, class: 'implement', role: 'development', objective, dependsOn,
    isolation: 'worktree', capabilities: WRITE_CODE, outputs: ['ChangeSet'],
    gate: `artifact.ChangeSet.exists && ${testsClause(ctx)}`,
  });
}

const review = (after: string): WorkflowStep => step({
  key: 'review', title: 'Review the change', class: 'review', role: 'review', dependsOn: [after],
  objective: 'Review the diff for correctness, safety, and fit with the surrounding code. Report blocking findings.',
  isolation: 'worktree', capabilities: [...READ_ONLY, CORE_CAPABILITIES.shell], inputs: ['ChangeSet'], outputs: ['ReviewReport'],
  gate: 'artifact.ReviewReport.exists',
});

/** Runs only when the mission has Done-when lines a person gave; the planner drops it otherwise. */
export const VERIFY_STEP_KEY = 'verify';
const verify = (after: string): WorkflowStep => step({
  key: VERIFY_STEP_KEY, title: 'Verify the change', class: 'verify', role: 'qa', dependsOn: [after],
  objective: 'Check every Done-when line against the changed code by running it, and report a result for each one by id.',
  isolation: 'worktree', capabilities: [...READ_ONLY, CORE_CAPABILITIES.shell, CORE_CAPABILITIES.testsRun], inputs: ['ChangeSet'], outputs: ['QAReport'],
  gate: QA_CRITERIA_GATE,
});

const MAKE_CHANGE = 'Make the requested change, following the conventions already present in the code, add or update tests, and run the repository checks.';
const FIX_ROOT_CAUSE = 'Fix the root cause and add a regression test that fails before the fix.';

export function laneWorkflows(ctx: PresetContext = {}): Readonly<Record<string, WorkflowDefinition>> {
  const def = (name: string, description: string, steps: WorkflowStep[]): WorkflowDefinition =>
    ({ name, description, inputs: [], steps });
  return {
    quick: def('Quick lane', 'One step, then a pull request. The tests carry the weight.', [
      implement(ctx, MAKE_CHANGE),
      ship('implement'),
    ]),
    standard: def('Standard lane', 'Implement, an independent review, verification when there are Done-when lines, then a pull request.', [
      implement(ctx, MAKE_CHANGE),
      review('implement'),
      verify('review'),
      ship(VERIFY_STEP_KEY),
    ]),
    careful: def('Careful lane', 'A spec and an architecture first, then implement, review, verify and a pull request that always asks.', [
      step({
        key: 'spec', title: 'Define the problem and the specification', class: 'spec', role: 'product',
        objective: 'Ground the task in the current codebase, scope it down, and write acceptance criteria precise enough to test.',
        capabilities: READ_ONLY, outputs: ['ProblemBrief', 'ProductSpec'], gate: SPEC_CRITERIA_GATE,
      }),
      step({
        key: 'architecture', title: 'Choose the approach and order the work', class: 'architecture', role: 'architecture', dependsOn: ['spec'],
        objective: 'Decide how to build this inside the existing codebase, name the risks, and produce an ordered implementation plan.',
        capabilities: READ_ONLY, inputs: ['ProductSpec'], outputs: ['ArchitecturePlan', 'ImplementationPlan'],
      }),
      implement(ctx, 'Implement the ImplementationPlan, add or update tests, and run the repository checks.', ['architecture'], 'Implement the plan'),
      review('implement'),
      verify('review'),
      ship(VERIFY_STEP_KEY),
    ]),
    fix: def('Fix', 'Fix the root cause with a regression test, an independent review, then a pull request.', [
      implement(ctx, FIX_ROOT_CAUSE, [], 'Fix the defect'),
      review('implement'),
      verify('review'),
      ship(VERIFY_STEP_KEY),
    ]),
    'fix-careful': def('Careful fix', 'Reproduce and diagnose first, then fix, review, verify and a pull request that always asks.', [
      step({
        key: 'investigate', title: 'Reproduce and diagnose', class: 'investigate', role: 'product',
        objective: 'Establish a reliable reproduction, identify the root cause in the code, and define what "fixed" means as testable criteria.',
        isolation: 'worktree', capabilities: [...READ_ONLY, CORE_CAPABILITIES.shell, CORE_CAPABILITIES.testsRun],
        outputs: ['ProblemBrief', 'ProductSpec'], gate: SPEC_CRITERIA_GATE,
      }),
      implement(ctx, FIX_ROOT_CAUSE, ['investigate'], 'Fix the defect'),
      review('implement'),
      verify('review'),
      ship(VERIFY_STEP_KEY),
    ]),
  };
}
