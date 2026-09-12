/**
 * `@tandemise/application` - the mission engine.
 *
 * Everything the composition root needs is here: the service interfaces the
 * HTTP layer projects, the tokens the engine resolves its ports by, the module
 * that binds it all, and `createServices` to pull the assembled API out.
 */
export * from './services.js';
export * from './ports.js';
export * from './tokens.js';
export * from './module.js';

export * from './roles/built-in.js';
export * from './planning/presets.js';
export * from './planning/prompt.js';
export * from './planning/parse.js';
export * from './planning/materialize.js';

export { SchedulerService } from './engine/scheduler.js';
export type { SchedulerDeps } from './engine/scheduler.js';
export { TaskExecutor } from './engine/task-executor.js';
export type { TaskAttemptOutcome, TaskExecutorDeps } from './engine/task-executor.js';
export { ARTIFACT_OUT_DIR, ArtifactHarvester } from './engine/harvester.js';
export type { HarvestRequest, HarvestResult } from './engine/harvester.js';
export { CheckService } from './engine/checks.js';
export type { CheckRequest } from './engine/checks.js';
export { GateService } from './engine/gates.js';
export { MetricsService } from './engine/metrics.js';
export { RecoveryService } from './engine/recovery.js';
export type { RecoveryReport } from './engine/recovery.js';
export { MAX_REMEDIATION_CYCLES, RemediationPlanner } from './engine/remediation.js';
export type { RemediationOutcome } from './engine/remediation.js';
export { BranchIntegrationService } from './engine/branch-integration.js';
export type { IntegrationOutcome, MergedBranch } from './engine/branch-integration.js';
export { evaluationFrom } from './engine/evaluations.js';
export type { EvaluationSource } from './engine/evaluations.js';

export { EventRecorder } from './support/event-recorder.js';
export type { EventScope } from './support/event-recorder.js';
export { RepositoryProber } from './support/repository-prober.js';
export { RuntimeOverrides } from './support/runtime-overrides.js';
export { ApprovalWaiter, createApprovalGate, createPolicyEngineToolGate } from './support/tool-policy.js';
export type { ApprovalGateDeps, PolicyGateDeps } from './support/tool-policy.js';
export { toApprovalView } from './support/approval-view.js';
export { runtimeCapabilitiesFor, runtimeCapabilityFor, satisfiableCapabilities } from './support/capabilities.js';
export { asPlannedTasks, describeIssues, validateTaskGraph } from './support/dag.js';
export {
  createMemorySettingsStore, describeEnvironment, osProcessLiveness,
} from './support/defaults.js';
export type { EnvironmentOverrides } from './support/defaults.js';

export { ApprovalServiceImpl } from './services/approval-service.js';
export { ArtifactServiceImpl } from './services/artifact-service.js';
export { IntegrationServiceImpl } from './services/integration-service.js';
export { MissionServiceImpl } from './services/mission-service.js';
export { PlanningServiceImpl } from './services/planning-service.js';
export { ProjectionServiceImpl } from './services/projection-service.js';
export { RoleServiceImpl } from './services/role-service.js';
export { RuntimeServiceImpl } from './services/runtime-service.js';
export { SystemServiceImpl } from './services/system-service.js';
export type { DiagnosticsSource } from './services/system-service.js';
export { WorkspaceServiceImpl } from './services/workspace-service.js';
