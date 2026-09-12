import { token, type Token } from '@tandemise/kernel';
import type {
  ApprovalRepositoryPort, ArtifactRepositoryPort, ArtifactStorePort, AssignmentRepositoryPort,
  CheckpointRepositoryPort, DecisionRepositoryPort, EvaluationRepositoryPort, EventBusPort,
  EventRepositoryPort, ExecutionTargetRepositoryPort, IntegrationRepositoryPort,
  LeaseRepositoryPort, MissionRepositoryPort, ProjectionBusPort, RepoRepositoryPort,
  RoleRepositoryPort, RunRepositoryPort, RuntimeProfileRepositoryPort, SecretStorePort,
  TaskRepositoryPort, UnitOfWork, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import type { ArtifactParserPort, ArtifactTemplatePort, ProcessLivenessPort, SettingsStorePort, SystemEnvironmentPort, WorkflowSourcePort, OAuthCallbackPort } from './ports.js';
import type {
  ApprovalService, ArtifactService, IntegrationService, MissionService, PlanningService,
  ProjectionService, RoleService, RuntimeService, SystemService, TandemiseServices,
  WorkspaceService,
  WorkflowService,
} from './services.js';
import type { ArtifactHarvester } from './engine/harvester.js';
import type { BranchIntegrationService } from './engine/branch-integration.js';
import type { CheckService } from './engine/checks.js';
import type { GateService } from './engine/gates.js';
import type { MetricsService } from './engine/metrics.js';
import type { RecoveryService } from './engine/recovery.js';
import type { RemediationPlanner } from './engine/remediation.js';
import type { SchedulerService } from './engine/scheduler.js';
import type { ApprovalWaiter } from './support/tool-policy.js';
import type { RunDeadlines } from './engine/run-deadline.js';
import type { ConnectFlow } from './services/connect-flow.js';
import type { IntegrationCredentials } from './support/integration-credentials.js';
import type { RuntimeOverrides } from './support/runtime-overrides.js';
import type { TaskExecutor } from './engine/task-executor.js';
import type { EventRecorder } from './support/event-recorder.js';
import type { RepositoryProber } from './support/repository-prober.js';

/**
 * Port tokens the mission engine resolves.
 *
 * `@tandemise/application` sits above `@tandemise/persistence` and
 * `@tandemise/artifacts` in the dependency graph and therefore cannot import
 * their token modules. Declaring the tokens here - against the *domain* port
 * types - is what keeps that boundary intact: the engine names a contract, the
 * composition root decides what satisfies it.
 *
 * The exported names mirror `@tandemise/persistence/tokens.ts` exactly, so the
 * daemon's aliasing is mechanical:
 *
 * ```ts
 * for (const name of [...]) container.bind(app[name], (r) => r.resolve(sqlite[name]));
 * ```
 *
 * The descriptions deliberately differ (`port.` rather than `persistence.`):
 * two tokens are two identities, and diagnostics that showed them under one
 * name would hide the alias rather than document it.
 */

export const UNIT_OF_WORK = token<UnitOfWork>('port.UnitOfWork');

export const WORKSPACE_REPOSITORY = token<WorkspaceRepositoryPort>('port.WorkspaceRepository');
export const REPO_REPOSITORY = token<RepoRepositoryPort>('port.RepoRepository');
export const MISSION_REPOSITORY = token<MissionRepositoryPort>('port.MissionRepository');
export const TASK_REPOSITORY = token<TaskRepositoryPort>('port.TaskRepository');
export const RUN_REPOSITORY = token<RunRepositoryPort>('port.RunRepository');
export const EVENT_REPOSITORY = token<EventRepositoryPort>('port.EventRepository');
export const ARTIFACT_REPOSITORY = token<ArtifactRepositoryPort>('port.ArtifactRepository');
export const APPROVAL_REPOSITORY = token<ApprovalRepositoryPort>('port.ApprovalRepository');
export const ROLE_REPOSITORY = token<RoleRepositoryPort>('port.RoleRepository');
export const RUNTIME_PROFILE_REPOSITORY = token<RuntimeProfileRepositoryPort>('port.RuntimeProfileRepository');
export const EXECUTION_TARGET_REPOSITORY = token<ExecutionTargetRepositoryPort>('port.ExecutionTargetRepository');
export const INTEGRATION_REPOSITORY = token<IntegrationRepositoryPort>('port.IntegrationRepository');
export const ASSIGNMENT_REPOSITORY = token<AssignmentRepositoryPort>('port.AssignmentRepository');
export const DECISION_REPOSITORY = token<DecisionRepositoryPort>('port.DecisionRepository');
export const EVALUATION_REPOSITORY = token<EvaluationRepositoryPort>('port.EvaluationRepository');
export const CHECKPOINT_REPOSITORY = token<CheckpointRepositoryPort>('port.CheckpointRepository');
export const LEASE_REPOSITORY = token<LeaseRepositoryPort>('port.LeaseRepository');

export const ARTIFACT_STORE = token<ArtifactStorePort>('port.ArtifactStore');
/** Workflow files, read from the project's repositories. */
export const WORKFLOW_SOURCE = token<WorkflowSourcePort>('port.WorkflowSource');
export const WORKFLOW_SERVICE = token<WorkflowService>('service.Workflow');
export const EVENT_BUS = token<EventBusPort>('port.EventBus');
export const PROJECTION_BUS = token<ProjectionBusPort>('port.ProjectionBus');
export const SECRET_STORE = token<SecretStorePort>('port.SecretStore');

/**
 * Bound to `renderArtifactTemplate` / `parseArtifact` from
 * `@tandemise/artifacts`. The artifact *hand-off protocol* is an application
 * concern - the prompt has to state it and the harvester has to enforce it -
 * but the schemas and templates that give it teeth live one layer down.
 */
export const ARTIFACT_TEMPLATES = token<ArtifactTemplatePort>('port.ArtifactTemplates');
export const ARTIFACT_PARSER = token<ArtifactParserPort>('port.ArtifactParser');

export const SETTINGS_STORE = token<SettingsStorePort>('port.SettingsStore');
export const SYSTEM_ENVIRONMENT = token<SystemEnvironmentPort>('port.SystemEnvironment');
export const PROCESS_LIVENESS = token<ProcessLivenessPort>('port.ProcessLiveness');

// ------------------------------------------------------------ engine services

export const EVENT_RECORDER = token<EventRecorder>('application.EventRecorder');
export const REPOSITORY_PROBER = token<RepositoryProber>('application.RepositoryProber');
export const GATE_SERVICE = token<GateService>('application.GateService');
export const CHECK_SERVICE = token<CheckService>('application.CheckService');
export const ARTIFACT_HARVESTER = token<ArtifactHarvester>('application.ArtifactHarvester');
export const TASK_EXECUTOR = token<TaskExecutor>('application.TaskExecutor');
export const REMEDIATION_PLANNER = token<RemediationPlanner>('application.RemediationPlanner');
export const BRANCH_INTEGRATION_SERVICE = token<BranchIntegrationService>('application.BranchIntegrationService');
/**
 * The tick loop, as a `LifecycleComponent`. The composition root registers it
 * with its `LifecycleHost` so that shutdown stops the scheduler before the
 * processes it supervises are reaped (MVP.md §7.3).
 */
export const SCHEDULER = token<SchedulerService>('application.Scheduler');
export const RECOVERY_SERVICE = token<RecoveryService>('application.RecoveryService');
export const METRICS_SERVICE = token<MetricsService>('application.MetricsService');
export const RUNTIME_OVERRIDES = token<RuntimeOverrides>('application.RuntimeOverrides');
export const APPROVAL_WAITER = token<ApprovalWaiter>('application.ApprovalWaiter');
/** Live run budgets, shared by the executor that owns them and `ask_human`, which pauses them. */
export const RUN_DEADLINES = token<RunDeadlines>('application.RunDeadlines');
/** Access tokens for connected integrations; also bound to integrations-core's credential source. */
export const INTEGRATION_CREDENTIAL_STORE = token<IntegrationCredentials>('application.IntegrationCredentials');
export const CONNECT_FLOW = token<ConnectFlow>('application.ConnectFlow');
/** The loopback redirect listener. Bound by the daemon; absent in headless compositions. */
export const OAUTH_CALLBACK = token<OAuthCallbackPort>('port.OAuthCallback');

// --------------------------------------------------------------- API services

export const SYSTEM_SERVICE = token<SystemService>('application.SystemService');
export const WORKSPACE_SERVICE = token<WorkspaceService>('application.WorkspaceService');
export const MISSION_SERVICE = token<MissionService>('application.MissionService');
export const PLANNING_SERVICE = token<PlanningService>('application.PlanningService');
export const APPROVAL_SERVICE = token<ApprovalService>('application.ApprovalService');
export const ARTIFACT_SERVICE = token<ArtifactService>('application.ArtifactService');
export const RUNTIME_SERVICE = token<RuntimeService>('application.RuntimeService');
export const ROLE_SERVICE = token<RoleService>('application.RoleService');
export const INTEGRATION_SERVICE = token<IntegrationService>('application.IntegrationService');
export const PROJECTION_SERVICE = token<ProjectionService>('application.ProjectionService');

export const TANDEMISE_SERVICES = token<TandemiseServices>('application.TandemiseServices');

/**
 * Every persistence port the engine needs, by the name `@tandemise/persistence`
 * uses for it. Exported so the composition root can alias the whole set in one
 * loop instead of eighteen hand-written lines that can drift.
 */
export const PERSISTENCE_PORT_TOKENS = {
  UNIT_OF_WORK,
  WORKSPACE_REPOSITORY,
  REPO_REPOSITORY,
  MISSION_REPOSITORY,
  TASK_REPOSITORY,
  RUN_REPOSITORY,
  EVENT_REPOSITORY,
  ARTIFACT_REPOSITORY,
  APPROVAL_REPOSITORY,
  ROLE_REPOSITORY,
  RUNTIME_PROFILE_REPOSITORY,
  EXECUTION_TARGET_REPOSITORY,
  INTEGRATION_REPOSITORY,
  ASSIGNMENT_REPOSITORY,
  DECISION_REPOSITORY,
  EVALUATION_REPOSITORY,
  CHECKPOINT_REPOSITORY,
  LEASE_REPOSITORY,
} as const satisfies Readonly<Record<string, Token<unknown>>>;
