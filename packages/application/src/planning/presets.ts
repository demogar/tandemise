import type { ExecutionPolicy, ApprovalPolicy, RetryPolicy, PlannedTask, MissionPlan } from '@tandemise/domain';
import { CORE_CAPABILITIES, DEFAULT_RETRY_POLICY, NO_APPROVAL } from '@tandemise/domain';

/**
 * Workflow presets (MVP.md §25.1).
 *
 * A preset is a *starting shape*, not a fixed pipeline. The planner adapts it to
 * the mission — dropping a design phase for a backend refactor, adding parallel
 * implementation tasks for independent work. Presets exist so that a user who
 * just wants the standard thing gets a sane plan without the planner having to
 * invent organizational structure from scratch every time, and so a mission can
 * still be planned when no runtime is available to plan it.
 */

const MINUTES = 60_000;

function policy(
  isolation: ExecutionPolicy['isolation'],
  capabilities: readonly string[],
  maxWallTimeMinutes: number,
): ExecutionPolicy {
  return { isolation, capabilities, maxWallTimeMs: maxWallTimeMinutes * MINUTES };
}

const READ_ONLY = [CORE_CAPABILITIES.repositoryRead, CORE_CAPABILITIES.filesystemRead, CORE_CAPABILITIES.artifactWrite];
const WRITE_CODE = [
  ...READ_ONLY, CORE_CAPABILITIES.filesystemWrite, CORE_CAPABILITIES.shell,
  CORE_CAPABILITIES.git, CORE_CAPABILITIES.gitCommit, CORE_CAPABILITIES.testsRun,
];
const QA_CAPS = [...READ_ONLY, CORE_CAPABILITIES.shell, CORE_CAPABILITIES.testsRun, CORE_CAPABILITIES.browser];

const patientRetry: RetryPolicy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 2 };

export interface WorkflowPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Shown in the mission form so the user knows what they are choosing. */
  readonly stages: readonly string[];
  build(context?: PresetContext): MissionPlan;
}

/** What a preset needs to know about the repository it will run against. */
export interface PresetContext {
  /** The repository declares a test command (`RepositoryChecks.test`). */
  readonly hasTestCommand?: boolean;
}

/**
 * The tests clause of a preset gate.
 *
 * `checks.tests != FAIL` is also true when the tests were never measured: a
 * build that never ran its test command passed its gate. So when the
 * repository declares a test command the gate demands a PASS. Only a
 * repository with no test command at all gets the tolerant form, because there
 * nothing can ever be measured and SKIP is the honest answer.
 */
export function testsClause(context: PresetContext = {}): string {
  return context.hasTestCommand === true ? 'checks.tests == PASS' : 'checks.tests != FAIL';
}

/**
 * The Done-when ledger's gates (P5). The spec step must cover every line the
 * person wrote and name no line that does not exist; QA must fail no
 * criterion; the release must leave none unverified. Each reads a count the
 * daemon traced from the ledger and the newest QA report, never a verdict an
 * agent wrote about itself.
 *
 * A gate replaces the "every expected output was produced" rule, so each one
 * also demands its own step's output: a release step that wrote nothing must
 * not pass on QA's facts alone.
 */
export const SPEC_CRITERIA_GATE = 'artifact.ProductSpec.exists && criteria.uncovered_user == 0 && criteria.unknown_covers == 0 && criteria.total >= 1';
export const QA_CRITERIA_GATE = 'artifact.QAReport.exists && review.blocking_findings == 0 && qa.criteria_failed == 0';
const RELEASE_LEDGER_CLAUSE = 'qa.criteria_unverified == 0 && qa.blocking_defects == 0';
export const RELEASE_CRITERIA_GATE = `artifact.ReleaseCandidate.exists && ${RELEASE_LEDGER_CLAUSE}`;

function task(t: Partial<PlannedTask> & Pick<PlannedTask, 'key' | 'title' | 'objective' | 'roleId'>): PlannedTask {
  return {
    dependsOn: [],
    requiredCapabilities: [],
    inputArtifacts: [],
    expectedOutputs: [],
    executionPolicy: policy('none', READ_ONLY, 20),
    approvalPolicy: NO_APPROVAL,
    retryPolicy: patientRetry,
    completionGate: null,
    ...t,
  };
}

/** The MVP.md §24 reference mission, as a plan. */
const featureDelivery: WorkflowPreset = {
  id: 'feature-delivery',
  name: 'Feature delivery',
  description: 'Full pipeline: product spec, design, architecture, implementation, review, QA, release candidate.',
  stages: ['Product', 'Design', 'Architecture', 'Implementation', 'Review', 'QA', 'Release'],
  build: (context) => ({
    summary: 'Standard feature delivery pipeline.',
    tasks: [
      task({
        key: 'product_spec', title: 'Define the problem and the specification', roleId: 'product',
        objective: 'Ground the mission in the current codebase, scope it down, and write acceptance criteria precise enough to test.',
        expectedOutputs: ['ProblemBrief', 'ProductSpec'],
        requiredCapabilities: READ_ONLY,
        completionGate: SPEC_CRITERIA_GATE,
      }),
      task({
        key: 'design', title: 'Define flows, states and interaction behaviour', roleId: 'design',
        objective: 'Specify the user-facing experience: flow, every state, real copy, and accessibility requirements.',
        dependsOn: ['product_spec'],
        inputArtifacts: [{ type: 'ProductSpec', required: true }],
        expectedOutputs: ['DesignBrief'],
        requiredCapabilities: READ_ONLY,
      }),
      task({
        key: 'architecture', title: 'Choose the approach and order the work', roleId: 'architecture',
        objective: 'Decide how to build this inside the existing codebase, name the risks, and produce an ordered implementation plan.',
        dependsOn: ['product_spec', 'design'],
        inputArtifacts: [{ type: 'ProductSpec', required: true }, { type: 'DesignBrief', required: false }],
        expectedOutputs: ['ArchitecturePlan', 'ImplementationPlan'],
        requiredCapabilities: READ_ONLY,
      }),
      task({
        key: 'implement', title: 'Implement the plan', roleId: 'development',
        objective: 'Implement the ImplementationPlan in an isolated worktree, add or update tests, and run the repository checks.',
        dependsOn: ['architecture'],
        inputArtifacts: [
          { type: 'ProductSpec', required: true }, { type: 'ArchitecturePlan', required: true },
          { type: 'ImplementationPlan', required: true }, { type: 'DesignBrief', required: false },
        ],
        expectedOutputs: ['ChangeSet'],
        executionPolicy: policy('worktree', WRITE_CODE, 45),
        requiredCapabilities: WRITE_CODE,
        // Deterministic evidence, measured by Tandemise - not the developer's
        // own assessment of its work (MVP.md §17.3).
        completionGate: `artifact.ChangeSet.exists && checks.typecheck != FAIL && ${testsClause(context)}`,
      }),
      task({
        key: 'review', title: 'Review the diff independently', roleId: 'review',
        objective: 'Review the actual diff against the spec, the architecture plan, and the codebase standards. Verify the ChangeSet claims.',
        dependsOn: ['implement'],
        inputArtifacts: [
          { type: 'ChangeSet', required: true }, { type: 'ProductSpec', required: true },
          { type: 'ArchitecturePlan', required: true },
        ],
        expectedOutputs: ['ReviewReport'],
        executionPolicy: policy('worktree', [...READ_ONLY, CORE_CAPABILITIES.shell], 30),
        requiredCapabilities: READ_ONLY,
        completionGate: 'artifact.ReviewReport.exists',
      }),
      task({
        key: 'qa', title: 'Verify the running application', roleId: 'qa',
        objective: 'Write a test matrix against the acceptance criteria, execute it against the running application, and capture evidence for each criterion.',
        dependsOn: ['review'],
        inputArtifacts: [
          { type: 'ProductSpec', required: true }, { type: 'ChangeSet', required: true },
          { type: 'ReviewReport', required: true }, { type: 'DesignBrief', required: false },
        ],
        expectedOutputs: ['QAPlan', 'QAReport'],
        executionPolicy: policy('worktree', QA_CAPS, 40),
        requiredCapabilities: QA_CAPS,
        completionGate: QA_CRITERIA_GATE,
      }),
      task({
        key: 'release_candidate', title: 'Assemble the release candidate', roleId: 'release',
        objective: 'Confirm every gate against evidence, write release notes and the rollback procedure, and state the unresolved risks.',
        dependsOn: ['qa'],
        inputArtifacts: [
          { type: 'QAReport', required: true }, { type: 'ChangeSet', required: true },
          { type: 'ReviewReport', required: true },
        ],
        expectedOutputs: ['ReleaseCandidate'],
        executionPolicy: policy('none', [...READ_ONLY, CORE_CAPABILITIES.shell, CORE_CAPABILITIES.git], 20),
        requiredCapabilities: READ_ONLY,
        // Shipping is always a human decision (MVP.md §18.2).
        approvalPolicy: { beforeStart: false, onCompletion: true, reason: 'Release candidates require explicit human authorization before shipping.' },
        completionGate: RELEASE_CRITERIA_GATE,
      }),
    ],
  }),
};

const bugInvestigation: WorkflowPreset = {
  id: 'bug-investigation',
  name: 'Bug investigation and fix',
  description: 'Reproduce, diagnose, fix, review, and verify a defect.',
  stages: ['Reproduce', 'Fix', 'Review', 'QA'],
  build: (context) => ({
    summary: 'Reproduce and fix a defect, then verify the fix.',
    tasks: [
      task({
        key: 'investigate', title: 'Reproduce and diagnose', roleId: 'product',
        objective: 'Establish a reliable reproduction, identify the root cause in the code, and define what "fixed" means as testable criteria.',
        expectedOutputs: ['ProblemBrief', 'ProductSpec'],
        executionPolicy: policy('worktree', [...READ_ONLY, CORE_CAPABILITIES.shell, CORE_CAPABILITIES.testsRun], 30),
        requiredCapabilities: READ_ONLY,
        completionGate: SPEC_CRITERIA_GATE,
      }),
      task({
        key: 'fix', title: 'Fix the defect', roleId: 'development',
        objective: 'Fix the root cause, not the symptom. Add a regression test that fails before the fix and passes after it.',
        dependsOn: ['investigate'],
        inputArtifacts: [{ type: 'ProductSpec', required: true }, { type: 'ProblemBrief', required: true }],
        expectedOutputs: ['ChangeSet'],
        executionPolicy: policy('worktree', WRITE_CODE, 40),
        requiredCapabilities: WRITE_CODE,
        completionGate: `artifact.ChangeSet.exists && ${testsClause(context)}`,
      }),
      task({
        key: 'review', title: 'Review the fix', roleId: 'review',
        objective: 'Confirm the fix addresses the root cause and that the regression test genuinely covers it.',
        dependsOn: ['fix'],
        inputArtifacts: [{ type: 'ChangeSet', required: true }, { type: 'ProductSpec', required: true }],
        expectedOutputs: ['ReviewReport'],
        executionPolicy: policy('worktree', [...READ_ONLY, CORE_CAPABILITIES.shell], 25),
        requiredCapabilities: READ_ONLY,
        completionGate: 'artifact.ReviewReport.exists',
      }),
      task({
        key: 'verify', title: 'Verify the fix', roleId: 'qa',
        objective: 'Verify the original reproduction no longer occurs and that nothing adjacent regressed.',
        dependsOn: ['review'],
        inputArtifacts: [{ type: 'ProductSpec', required: true }, { type: 'ChangeSet', required: true }, { type: 'ReviewReport', required: true }],
        expectedOutputs: ['QAReport'],
        executionPolicy: policy('worktree', QA_CAPS, 30),
        requiredCapabilities: QA_CAPS,
        completionGate: QA_CRITERIA_GATE,
      }),
    ],
  }),
};

const quickChange: WorkflowPreset = {
  id: 'quick-change',
  name: 'Quick change',
  description: 'Implement, review and verify a small, well-understood change. No design or architecture phase.',
  stages: ['Implementation', 'Review', 'QA'],
  build: () => ({
    summary: 'Small change with an independent review, verified against what done means.',
    tasks: [
      task({
        key: 'implement', title: 'Implement the change', roleId: 'development',
        objective: 'Make the requested change, following the conventions already present in the code, and run the repository checks.',
        expectedOutputs: ['ChangeSet'],
        executionPolicy: policy('worktree', WRITE_CODE, 30),
        requiredCapabilities: WRITE_CODE,
        completionGate: 'artifact.ChangeSet.exists && checks.typecheck != FAIL',
      }),
      task({
        key: 'review', title: 'Review the change', roleId: 'review',
        objective: 'Review the diff for correctness, safety, and fit with the surrounding code.',
        dependsOn: ['implement'],
        inputArtifacts: [{ type: 'ChangeSet', required: true }],
        expectedOutputs: ['ReviewReport'],
        executionPolicy: policy('worktree', [...READ_ONLY, CORE_CAPABILITIES.shell], 20),
        requiredCapabilities: READ_ONLY,
        completionGate: 'artifact.ReviewReport.exists',
      }),
      // Planning needs a Done-when line, and only a QAReport verifies one: without
      // this step a quick change finished "0 of 3 verified" on a real mission.
      task({
        key: 'verify', title: 'Verify the change', roleId: 'qa',
        objective: 'Check every Done-when line against the changed code by running it, and report a result for each one by id.',
        dependsOn: ['review'],
        inputArtifacts: [{ type: 'ChangeSet', required: true }, { type: 'ReviewReport', required: true }],
        expectedOutputs: ['QAReport'],
        executionPolicy: policy('worktree', QA_CAPS, 20),
        requiredCapabilities: QA_CAPS,
        completionGate: QA_CRITERIA_GATE,
      }),
    ],
  }),
};

export const WORKFLOW_PRESETS: readonly WorkflowPreset[] = [featureDelivery, bugInvestigation, quickChange];
export const DEFAULT_PRESET_ID = featureDelivery.id;

export function findPreset(id: string): WorkflowPreset {
  return WORKFLOW_PRESETS.find((p) => p.id === id) ?? featureDelivery;
}
