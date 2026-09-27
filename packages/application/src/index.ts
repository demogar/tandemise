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
export * from './planning/refinement-prompt.js';
export * from './planning/parse.js';
export * from './planning/materialize.js';

export { SchedulerService } from './engine/scheduler.js';
export type { SchedulerDeps } from './engine/scheduler.js';
export { McpGatewayProvisioner, NO_TOOL_SURFACE } from './engine/mcp-gateway.js';
export type { RunToolSurface, McpGatewayProvisionerDeps, ProvisionToolSurfaceRequest } from './engine/mcp-gateway.js';
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
export { FeedbackRounds, ROUND_ATTEMPTS, ROUND_START_STATUSES } from './engine/feedback-rounds.js';
export type { DownstreamImpact, FeedbackRoundsDeps, RecordFeedbackInput, ReviewRouting, RoundBegun, StartRoundInput } from './engine/feedback-rounds.js';
export { LIVE_RUN_STATUSES, downstreamConsumers, reviewedTaskOf } from './support/downstream.js';
export type { Consumer, ConsumerFacts } from './support/downstream.js';
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
export { actorRef, actorRefs, toArtifactView } from './support/actors.js';
export { DEFAULT_LOCAL_PERSON_NAME, LocalIdentity, actorFor } from './support/identity.js';
export type { Caller, IdentityPort } from './support/identity.js';
export { assertStaffing, assertTeam, mergeRoleStaffing } from './support/staffing-edit.js';
export type { RoleStaffingEdit } from './support/staffing-edit.js';
export { StaffingResolver, waitingFor, waitingForName } from './engine/staffing-resolver.js';
export {
  POOL_ESCALATED_REASON, REVIEW_EVIDENCE_LABEL, ReviewPipeline, SIGN_OFF_EVIDENCE_LABEL, effectiveReviews, positionOf,
} from './engine/reviews.js';
export type { RequestAddress, ReviewPipelineDeps, RoundPassedInput } from './engine/reviews.js';
export type { StaffingResolverDeps } from './engine/staffing-resolver.js';
export { TeamServiceImpl } from './services/team-service.js';
export { StaffingServiceImpl } from './services/staffing-service.js';
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
export { FeedbackServiceImpl } from './services/feedback-service.js';
export { CriteriaServiceImpl } from './services/criteria-service.js';
export { ReadinessService, assertReadiness } from './services/readiness.js';
export type { ReadinessDeps } from './services/readiness.js';
export { BacklogService, describePull } from './services/backlog-service.js';
export type { BacklogDeps } from './services/backlog-service.js';
export { LimitService } from './services/limit-service.js';
export type { LimitDeps } from './services/limit-service.js';
export { LivenessService } from './services/liveness-service.js';
export type { LivenessDeps } from './services/liveness-service.js';
export { DeskService } from './services/desk-service.js';
export type { DeskDeps } from './services/desk-service.js';
export { NotificationService, itemsFromInbox, NOTIFY_PREFERENCES_KEY, NOTIFY_STATE_KEY } from './services/notification-service.js';
export type { NotificationDeps } from './services/notification-service.js';
export { RoutineService } from './services/routine-service.js';
export { SkillService } from './services/skill-service.js';
export { IssueService } from './services/issue-service.js';
export { ContributionError, ContributionServiceImpl, pickGitCredentialEnv } from './services/contribution-service.js';
export type { ContributionDeps, ContributionErrorCode } from './services/contribution-service.js';
export type { IssueDeps } from './services/issue-service.js';
export type { SkillDeps } from './services/skill-service.js';
export { SkillInstaller, INSTALLED_MARKER } from './engine/skill-installer.js';
export { SetupService } from './services/setup-service.js';
export type { SetupDeps } from './services/setup-service.js';
export * from './setup/codec.js';
export { GIT_CLEAN_FACT } from './engine/checks.js';
export type { RoutineDeps } from './services/routine-service.js';
export { RefinementServiceImpl } from './services/refinement-service.js';
export type { RefinementDeps } from './services/refinement-service.js';
export type { CriteriaServiceDeps } from './services/criteria-service.js';
export type { FeedbackServiceDeps } from './services/feedback-service.js';
export { MAX_DRAFT_CHARS, capDraft, checkRoundHandoff, feedbackEffectFor, renderRoundBrief, roundRequest } from './support/feedback-rules.js';
export type { BriefItem, FeedbackEffect, RoundBrief, RoundContract } from './support/feedback-rules.js';
export { resolveChanges, toFeedbackView, toImpactView } from './support/feedback-view.js';
export { PlanningServiceImpl } from './services/planning-service.js';
export { ProjectionServiceImpl } from './services/projection-service.js';
export { RoleServiceImpl } from './services/role-service.js';
export { RuntimeServiceImpl } from './services/runtime-service.js';
export { SystemServiceImpl } from './services/system-service.js';
export type { DiagnosticsSource } from './services/system-service.js';
export { WorkspaceServiceImpl } from './services/workspace-service.js';

export { MAX_PARKED_MS, RunDeadline, RunDeadlines } from './engine/run-deadline.js';
export { ASK_HUMAN_TOOL, createAskHumanTool } from './tools/ask-human.js';
export type { AskHumanDeps } from './tools/ask-human.js';
export { ConnectFlow, CONNECT_TIMEOUT_MS } from './services/connect-flow.js';
export { IntegrationCredentials } from './support/integration-credentials.js';
export type { OAuthCallback, OAuthCallbackListener, OAuthCallbackPort } from './ports.js';
