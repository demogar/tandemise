import { defineModule, type Container, type Resolver, type TandemiseModule } from '@tandemise/kernel';
import type { Clock, Logger, TandemisePaths } from '@tandemise/shared';
import { asId, createPaths, nullLogger, systemClock } from '@tandemise/shared';
import { APPROVAL_FACTORY, GRANT_BUILDER, POLICY_ENGINE } from '@tandemise/policy';
import { CONTEXT_COMPILER } from '@tandemise/context';
import { RUNTIME_MANAGER, RUNTIME_REGISTRY } from '@tandemise/runtimes-core';
import {
  CLOCK as EXECUTION_CLOCK, EXECUTION_TARGET_MANAGER, LOGGER as EXECUTION_LOGGER,
  PATHS as EXECUTION_PATHS, PROCESS_SUPERVISOR,
} from '@tandemise/execution-core';
import {
  APPROVAL_GATE, BUILT_IN_TOOLS, INTEGRATION_CREDENTIALS, INTEGRATION_PROVIDER_REGISTRY, INTEGRATION_SOURCE, TOOL_BROKER,
  TOOL_POLICY_GATE,
  COMMAND_EXECUTOR as INTEGRATION_COMMAND_EXECUTOR,
} from '@tandemise/integrations-core';

import type { TandemiseServices } from './services.js';
import * as t from './tokens.js';
import { ArtifactHarvester } from './engine/harvester.js';
import { BranchIntegrationService } from './engine/branch-integration.js';
import { CheckService } from './engine/checks.js';
import { GateService } from './engine/gates.js';
import { MetricsService } from './engine/metrics.js';
import { RecoveryService } from './engine/recovery.js';
import { RemediationPlanner } from './engine/remediation.js';
import { FeedbackRounds } from './engine/feedback-rounds.js';
import { SchedulerService } from './engine/scheduler.js';
import { McpGatewayProvisioner } from './engine/mcp-gateway.js';
import { TaskExecutor } from './engine/task-executor.js';
import { EventRecorder } from './support/event-recorder.js';
import { RepositoryProber } from './support/repository-prober.js';
import { RuntimeOverrides } from './support/runtime-overrides.js';
import { ApprovalWaiter, createApprovalGate, createPolicyEngineToolGate } from './support/tool-policy.js';
import { createAskHumanTool } from './tools/ask-human.js';
import { RunDeadlines } from './engine/run-deadline.js';
import { ConnectFlow } from './services/connect-flow.js';
import { IntegrationCredentials } from './support/integration-credentials.js';
import { ApprovalServiceImpl } from './services/approval-service.js';
import { ReviewPipeline } from './engine/reviews.js';
import { ArtifactServiceImpl } from './services/artifact-service.js';
import { WorkflowServiceImpl } from './services/workflow-service.js';
import { Waiter } from './engine/waiter.js';
import { IntegrationServiceImpl } from './services/integration-service.js';
import { MissionServiceImpl } from './services/mission-service.js';
import { FeedbackServiceImpl } from './services/feedback-service.js';
import { CriteriaServiceImpl } from './services/criteria-service.js';
import { PlanningServiceImpl } from './services/planning-service.js';
import { ProjectionServiceImpl } from './services/projection-service.js';
import { RoleServiceImpl } from './services/role-service.js';
import { RuntimeServiceImpl } from './services/runtime-service.js';
import { SystemServiceImpl } from './services/system-service.js';
import { WorkspaceServiceImpl } from './services/workspace-service.js';
import { TeamServiceImpl } from './services/team-service.js';
import { StaffingServiceImpl } from './services/staffing-service.js';
import { StaffingResolver } from './engine/staffing-resolver.js';
import { DEFAULT_LOCAL_PERSON_NAME, LocalIdentity } from './support/identity.js';

const SOURCE = 'application';

export interface ApplicationModuleOptions {
  /** Scheduler tick interval. The daemon passes its configured value. */
  readonly tickIntervalMs?: number;
  /**
   * The name given to the local person if none exists yet. The daemon passes
   * `git config user.name`; this layer may not run processes to find it.
   */
  readonly localPersonName?: string;
}

/**
 * The mission engine's bindings.
 *
 * Every dependency is resolved by token, and the tokens for the ports this
 * layer cannot import (`persistence`, `artifacts`, the platform adapters) are
 * declared in `tokens.ts` and aliased by the composition root. That indirection
 * is the whole reason the engine can be composed against an in-memory double as
 * easily as against SQLite.
 *
 * Three cross-cutting tokens - clock, logger, paths - are resolved through
 * `@tandemise/execution-core`, which owns them today, and fall back to sane
 * defaults when the composition root has not bound them. They fall back rather
 * than throwing because a half-composed engine that cannot tell the time is a
 * worse diagnostic than one that logs nowhere.
 */
export function createApplicationModule(options: ApplicationModuleOptions = {}): TandemiseModule {
  return defineModule(SOURCE, (container: Container) => {
    const bind = container.bind.bind(container);

    // --------------------------------------------------------------- support

    bind(t.RUNTIME_OVERRIDES, () => new RuntimeOverrides(), { source: SOURCE });
    bind(t.APPROVAL_WAITER, () => new ApprovalWaiter(), { source: SOURCE });
    bind(t.RUN_DEADLINES, () => new RunDeadlines(), { source: SOURCE });

    bind(t.EVENT_RECORDER, (r) => new EventRecorder(
      r.resolve(t.EVENT_REPOSITORY),
      r.resolve(t.EVENT_BUS),
      r.resolve(t.PROJECTION_BUS),
      clock(r),
    ), { source: SOURCE });

    bind(t.IDENTITY, (r) => new LocalIdentity(
      r.resolve(t.PERSON_REPOSITORY),
      options.localPersonName ?? DEFAULT_LOCAL_PERSON_NAME,
    ), { source: SOURCE });

    bind(t.STAFFING_RESOLVER, (r) => new StaffingResolver({
      members: r.resolve(t.MEMBER_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
    }), { source: SOURCE });

    bind(t.REPOSITORY_PROBER, (r) => new RepositoryProber(r.resolve(PROCESS_SUPERVISOR)), { source: SOURCE });

    // ------------------------------------------------- the tool path's policy

    // Bound over the `denyAllPolicyGate` default in `integrations-core`. This is
    // the binding that gives `POLICY_ENGINE` a caller on the execution path.
    bind(TOOL_POLICY_GATE, (r) => createPolicyEngineToolGate({
      policy: r.resolve(POLICY_ENGINE),
      assignments: r.resolve(t.ASSIGNMENT_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      recorder: r.resolve(t.EVENT_RECORDER),
      log: log(r).child({ component: 'tool-policy' }),
    }), { source: SOURCE });

    bind(APPROVAL_GATE, (r) => createApprovalGate({
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      approvalFactory: r.resolve(APPROVAL_FACTORY),
      assignments: r.resolve(t.ASSIGNMENT_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      waiter: r.resolve(t.APPROVAL_WAITER),
      recorder: r.resolve(t.EVENT_RECORDER),
      runs: r.resolve(t.RUN_REPOSITORY),
      // Resolved per card: the pipeline reads the team as it is when the tool asks.
      clock: clock(r),
      address: (task, workspaceId) => r.resolve(t.REVIEW_PIPELINE).addressFor(task, workspaceId),
    }), { source: SOURCE });

    // Asking the supervising human a question is a capability every worker has,
    // so it is contributed rather than configured: there is no vendor behind it
    // and no workspace that should be able to switch it off.
    container.contribute(BUILT_IN_TOOLS, (r) => createAskHumanTool({
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      approvalFactory: r.resolve(APPROVAL_FACTORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      address: (task, workspaceId) => r.resolve(t.REVIEW_PIPELINE).questionAddressFor(task, workspaceId),
      waiter: r.resolve(t.APPROVAL_WAITER),
      deadlines: r.resolve(t.RUN_DEADLINES),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
    }), { source: SOURCE });

    // The tool catalog is built from the workspace's enabled integrations, and
    // it is a thunk so that enabling one takes effect without a rebuild.
    bind(INTEGRATION_SOURCE, (r) => () => {
      const workspaces = r.resolve(t.WORKSPACE_REPOSITORY);
      const integrations = r.resolve(t.INTEGRATION_REPOSITORY);
      return workspaces.list().flatMap((w) => integrations.listByWorkspace(w.id)).filter((i) => i.enabled);
    }, { source: SOURCE });

    // ---------------------------------------------------------------- engine

    bind(t.GATE_SERVICE, (r) => new GateService(
      r.resolve(t.TASK_REPOSITORY),
      r.resolve(t.ARTIFACT_REPOSITORY),
      r.resolve(t.EVALUATION_REPOSITORY),
      r.resolve(t.APPROVAL_REPOSITORY),
      r.resolve(t.MISSION_REPOSITORY),
      r.resolve(t.MISSION_CRITERIA_REPOSITORY),
    ), { source: SOURCE });

    bind(t.REVIEW_PIPELINE, (r) => new ReviewPipeline({
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      approvalFactory: r.resolve(APPROVAL_FACTORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      roles: r.resolve(t.ROLE_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      gates: r.resolve(t.GATE_SERVICE),
      staffing: r.resolve(t.STAFFING_RESOLVER),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
      log: log(r).child({ component: 'reviews' }),
    }), { source: SOURCE });

    bind(t.CHECK_SERVICE, (r) => new CheckService(
      r.resolve(t.EVALUATION_REPOSITORY),
      r.resolve(t.EVENT_RECORDER),
      clock(r),
    ), { source: SOURCE });

    bind(t.ARTIFACT_HARVESTER, (r) => new ArtifactHarvester(
      r.resolve(t.ARTIFACT_STORE),
      r.resolve(t.ARTIFACT_REPOSITORY),
      r.resolve(t.EVALUATION_REPOSITORY),
      r.resolve(t.ARTIFACT_PARSER),
      r.resolve(t.ARTIFACT_MEASURE),
      r.resolve(t.EVENT_RECORDER),
      clock(r),
      r.resolve(t.TASK_REPOSITORY),
      r.resolve(t.MISSION_CRITERIA_REPOSITORY),
    ), { source: SOURCE });

    bind(t.METRICS_SERVICE, (r) => new MetricsService(
      r.resolve(t.TASK_REPOSITORY),
      r.resolve(t.RUN_REPOSITORY),
      r.resolve(t.EVENT_REPOSITORY),
      r.resolve(t.APPROVAL_REPOSITORY),
      r.resolve(t.ARTIFACT_REPOSITORY),
      r.resolve(t.EVALUATION_REPOSITORY),
      clock(r),
    ), { source: SOURCE });

    bind(t.TASK_EXECUTOR, (r) => new TaskExecutor({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      repositories: r.resolve(t.REPO_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      assignments: r.resolve(t.ASSIGNMENT_REPOSITORY),
      targets: r.resolve(t.EXECUTION_TARGET_REPOSITORY),
      leases: r.resolve(t.LEASE_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      artifactStore: r.resolve(t.ARTIFACT_STORE),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      roles: r.resolve(t.ROLE_REPOSITORY),
      runtimeProfiles: r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      decisions: r.resolve(t.DECISION_REPOSITORY),
      checkpoints: r.resolve(t.CHECKPOINT_REPOSITORY),
      runtimeManager: r.resolve(RUNTIME_MANAGER),
      targetManager: r.resolve(EXECUTION_TARGET_MANAGER),
      contextCompiler: r.resolve(CONTEXT_COMPILER),
      grantBuilder: r.resolve(GRANT_BUILDER),
      policy: r.resolve(POLICY_ENGINE),
      approvalFactory: r.resolve(APPROVAL_FACTORY),
      mcpGateway: new McpGatewayProvisioner({
        broker: r.tryResolve(TOOL_BROKER) ?? null,
        exec: () => r.resolve(INTEGRATION_COMMAND_EXECUTOR),
        paths: paths(r),
        clock: clock(r),
        log: log(r).child({ component: 'mcp-gateway' }),
      }),
      toolBroker: r.tryResolve(TOOL_BROKER) ?? null,
      overrides: r.resolve(t.RUNTIME_OVERRIDES),
      templates: r.resolve(t.ARTIFACT_TEMPLATES),
      measure: r.resolve(t.ARTIFACT_MEASURE),
      events: r.resolve(t.EVENT_REPOSITORY),
      harvester: r.resolve(t.ARTIFACT_HARVESTER),
      checks: r.resolve(t.CHECK_SERVICE),
      gates: r.resolve(t.GATE_SERVICE),
      reviews: r.resolve(t.REVIEW_PIPELINE),
      rounds: r.resolve(t.FEEDBACK_ROUNDS),
      runInputs: r.resolve(t.RUN_INPUT_REPOSITORY),
      recorder: r.resolve(t.EVENT_RECORDER),
      deadlines: r.resolve(t.RUN_DEADLINES),
      paths: paths(r),
      clock: clock(r),
      log: log(r).child({ component: 'executor' }),
    }), { source: SOURCE });

    bind(t.REMEDIATION_PLANNER, (r) => new RemediationPlanner(
      r.resolve(t.MISSION_REPOSITORY),
      r.resolve(t.TASK_REPOSITORY),
      r.resolve(t.EVALUATION_REPOSITORY),
      r.resolve(t.ROLE_REPOSITORY),
      r.resolve(t.APPROVAL_REPOSITORY),
      r.resolve(APPROVAL_FACTORY),
      r.resolve(t.EVENT_RECORDER),
      clock(r),
      (task, workspaceId) => r.resolve(t.REVIEW_PIPELINE).addressFor(task, workspaceId),
    ), { source: SOURCE });

    bind(t.BRANCH_INTEGRATION_SERVICE, (r) => new BranchIntegrationService(
      r.resolve(t.TASK_REPOSITORY),
      r.resolve(t.REPO_REPOSITORY),
      r.resolve(t.EXECUTION_TARGET_REPOSITORY),
      r.resolve(t.ROLE_REPOSITORY),
      r.resolve(EXECUTION_TARGET_MANAGER),
      r.resolve(t.EVENT_RECORDER),
      clock(r),
    ), { source: SOURCE });

    bind(t.FEEDBACK_ROUNDS, (r) => new FeedbackRounds({
      missions: r.resolve(t.MISSION_REPOSITORY), tasks: r.resolve(t.TASK_REPOSITORY), runs: r.resolve(t.RUN_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY), artifactStore: r.resolve(t.ARTIFACT_STORE), approvals: r.resolve(t.APPROVAL_REPOSITORY),
      evaluations: r.resolve(t.EVALUATION_REPOSITORY), feedback: r.resolve(t.FEEDBACK_REPOSITORY), runInputs: r.resolve(t.RUN_INPUT_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY), events: r.resolve(t.EVENT_REPOSITORY), unitOfWork: r.resolve(t.UNIT_OF_WORK),
      recorder: r.resolve(t.EVENT_RECORDER), clock: clock(r),
      cancelTask: (taskId) => r.resolve(t.SCHEDULER).cancelTask(taskId),
    }), { source: SOURCE });

    bind(t.SCHEDULER, (r) => new SchedulerService({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      executor: r.resolve(t.TASK_EXECUTOR),
      repositories: r.resolve(t.REPO_REPOSITORY),
      waiter: new Waiter({
        exec: () => r.resolve(INTEGRATION_COMMAND_EXECUTOR),
        clock: clock(r),
        log: log(r).child({ component: 'waiter' }),
      }),
      remediation: r.resolve(t.REMEDIATION_PLANNER),
      integration: r.resolve(t.BRANCH_INTEGRATION_SERVICE),
      recorder: r.resolve(t.EVENT_RECORDER),
      staffing: r.resolve(t.STAFFING_RESOLVER),
      members: r.resolve(t.MEMBER_REPOSITORY),
      reviews: r.resolve(t.REVIEW_PIPELINE),
      rounds: r.resolve(t.FEEDBACK_ROUNDS),
      clock: clock(r),
      log: log(r).child({ component: 'scheduler' }),
      ...(options.tickIntervalMs === undefined ? {} : { tickIntervalMs: options.tickIntervalMs }),
    }), { source: SOURCE, dispose: (s) => s.stop() });

    bind(t.RECOVERY_SERVICE, (r) => new RecoveryService(
      r.resolve(t.MISSION_REPOSITORY),
      r.resolve(t.TASK_REPOSITORY),
      r.resolve(t.RUN_REPOSITORY),
      r.resolve(t.EXECUTION_TARGET_REPOSITORY),
      r.resolve(t.LEASE_REPOSITORY),
      r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      r.resolve(RUNTIME_REGISTRY),
      r.resolve(t.PROCESS_LIVENESS),
      r.resolve(t.EVENT_RECORDER),
      clock(r),
      log(r).child({ component: 'recovery' }),
      r.resolve(t.APPROVAL_REPOSITORY),
    ), { source: SOURCE });

    // ---------------------------------------------------------- API services

    bind(t.SYSTEM_SERVICE, (r) => new SystemServiceImpl(
      r.resolve(t.SYSTEM_ENVIRONMENT),
      r.resolve(t.SETTINGS_STORE),
      {
        bindings: () => container.describe(),
        runtimeAdapters: () => r.resolve(RUNTIME_REGISTRY).ids(),
        targetKinds: () => r.resolve(EXECUTION_TARGET_MANAGER).kinds(),
        integrationProviders: () => r.resolve(INTEGRATION_PROVIDER_REGISTRY).ids(),
        artifactRoot: () => paths(r).root,
      },
    ), { source: SOURCE });

    bind(t.WORKSPACE_SERVICE, (r) => new WorkspaceServiceImpl(
      r.resolve(t.WORKSPACE_REPOSITORY),
      r.resolve(t.REPO_REPOSITORY),
      r.resolve(t.ROLE_REPOSITORY),
      r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      r.resolve(t.REPOSITORY_PROBER),
      clock(r),
      {
        people: r.resolve(t.PERSON_REPOSITORY),
        members: r.resolve(t.MEMBER_REPOSITORY),
        unitOfWork: r.resolve(t.UNIT_OF_WORK),
      },
    ), { source: SOURCE });

    bind(t.TEAM_SERVICE, (r) => new TeamServiceImpl({
      people: r.resolve(t.PERSON_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      clock: clock(r),
    }), { source: SOURCE });

    bind(t.STAFFING_SERVICE, (r) => new StaffingServiceImpl({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      resolver: r.resolve(t.STAFFING_RESOLVER),
      projections: r.resolve(t.PROJECTION_SERVICE),
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
    }), { source: SOURCE });

    bind(t.ROLE_SERVICE, (r) => new RoleServiceImpl(r.resolve(t.ROLE_REPOSITORY), clock(r)), { source: SOURCE });

    bind(t.ARTIFACT_SERVICE, (r) => new ArtifactServiceImpl(
      r.resolve(t.ARTIFACT_REPOSITORY),
      r.resolve(t.ARTIFACT_STORE),
      r.resolve(t.WORKSPACE_REPOSITORY),
      r.resolve(t.MEMBER_REPOSITORY),
      r.resolve(t.ARTIFACT_MEASURE),
      {
        missions: r.resolve(t.MISSION_REPOSITORY),
        tasks: r.resolve(t.TASK_REPOSITORY),
        approvals: r.resolve(t.APPROVAL_REPOSITORY),
        feedback: r.resolve(t.FEEDBACK_REPOSITORY),
      },
    ), { source: SOURCE });

    bind(t.RUNTIME_SERVICE, (r) => new RuntimeServiceImpl(
      r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      r.resolve(t.WORKSPACE_REPOSITORY),
      r.resolve(RUNTIME_MANAGER),
      clock(r),
    ), { source: SOURCE });

    bind(t.INTEGRATION_CREDENTIAL_STORE, (r) => new IntegrationCredentials({
      secrets: r.resolve(t.SECRET_STORE),
      integrations: r.resolve(t.INTEGRATION_REPOSITORY),
      providers: r.resolve(INTEGRATION_PROVIDER_REGISTRY),
      clock: clock(r),
      log: log(r).child({ component: 'integration-credentials' }),
    }), { source: SOURCE });
    // Providers resolve this core token; they never see the store behind it.
    bind(INTEGRATION_CREDENTIALS, (r) => r.resolve(t.INTEGRATION_CREDENTIAL_STORE), { source: SOURCE });

    bind(t.CONNECT_FLOW, (r) => new ConnectFlow({
      integrations: r.resolve(t.INTEGRATION_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      providers: r.resolve(INTEGRATION_PROVIDER_REGISTRY),
      credentials: r.resolve(t.INTEGRATION_CREDENTIAL_STORE),
      callbacks: r.resolve(t.OAUTH_CALLBACK),
      // Resolved at call time: the service depends on this flow, so resolving
      // it while constructing the flow would be a cycle.
      checkHealth: (id) => r.resolve(t.INTEGRATION_SERVICE).checkHealth(id),
      clock: clock(r),
      log: log(r).child({ component: 'connect' }),
    }), { source: SOURCE });

    bind(t.INTEGRATION_SERVICE, (r) => new IntegrationServiceImpl({
      integrations: r.resolve(t.INTEGRATION_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      providers: r.resolve(INTEGRATION_PROVIDER_REGISTRY),
      secrets: r.resolve(t.SECRET_STORE),
      exec: r.tryResolve(INTEGRATION_COMMAND_EXECUTOR) ?? null,
      connect: r.has(t.OAUTH_CALLBACK) ? r.resolve(t.CONNECT_FLOW) : null,
      credentials: r.resolve(t.INTEGRATION_CREDENTIAL_STORE),
      clock: clock(r),
      log: log(r).child({ component: 'integrations' }),
    }), { source: SOURCE });

    bind(t.PROJECTION_SERVICE, (r) => new ProjectionServiceImpl({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      repositories: r.resolve(t.REPO_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      events: r.resolve(t.EVENT_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      decisions: r.resolve(t.DECISION_REPOSITORY),
      evaluations: r.resolve(t.EVALUATION_REPOSITORY),
      targets: r.resolve(t.EXECUTION_TARGET_REPOSITORY),
      roles: r.resolve(t.ROLE_REPOSITORY),
      runtimeProfiles: r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      runtimes: r.resolve(t.RUNTIME_SERVICE),
      gates: r.resolve(t.GATE_SERVICE),
      metrics: r.resolve(t.METRICS_SERVICE),
      members: r.resolve(t.MEMBER_REPOSITORY),
      staffing: r.resolve(t.STAFFING_RESOLVER),
      feedback: r.resolve(t.FEEDBACK_REPOSITORY),
    }), { source: SOURCE });

    // Default: this installation has no workflow files. A composition root that
    // can read the filesystem rebinds it; one that cannot - a test, an embedder
    // - still gets the built-in presets rather than an unresolved token.
    bind(t.WORKFLOW_SOURCE, () => ({ list: async () => [] }), { source: SOURCE });

    bind(t.WORKFLOW_SERVICE, (r) => new WorkflowServiceImpl(
      r.resolve(t.WORKFLOW_SOURCE),
      r.resolve(t.REPO_REPOSITORY),
    ), { source: SOURCE });

    bind(t.PLANNING_SERVICE, (r) => new PlanningServiceImpl({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      repositories: r.resolve(t.REPO_REPOSITORY),
      workflows: r.resolve(t.WORKFLOW_SOURCE),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      roles: r.resolve(t.ROLE_REPOSITORY),
      runtimeProfiles: r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      approvalFactory: r.resolve(APPROVAL_FACTORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      artifactStore: r.resolve(t.ARTIFACT_STORE),
      measure: r.resolve(t.ARTIFACT_MEASURE),
      runtimeManager: r.resolve(RUNTIME_MANAGER),
      targetManager: r.resolve(EXECUTION_TARGET_MANAGER),
      projections: r.resolve(t.PROJECTION_SERVICE),
      recorder: r.resolve(t.EVENT_RECORDER),
      paths: paths(r),
      clock: clock(r),
      log: log(r).child({ component: 'planning' }),
      // Resolved per plan, not at construction: the integration service is
      // composed after planning, and a plan should see what is connected now.
      connectedApps: async (workspaceId) => (await r.resolve(t.INTEGRATION_SERVICE).list(asId(workspaceId)))
        .filter((view) => view.integration.enabled !== false && view.health.state === 'healthy')
        .map((view) => ({
          name: view.integration.name,
          capabilities: [...new Set(view.availableCapabilities.map((c) => c.capability))],
          detail: view.health.detail,
        })),
    }), { source: SOURCE });

    bind(t.APPROVAL_SERVICE, (r) => new ApprovalServiceImpl({
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      roles: r.resolve(t.ROLE_REPOSITORY),
      scheduler: r.resolve(t.SCHEDULER),
      waiter: r.resolve(t.APPROVAL_WAITER),
      rounds: r.resolve(t.FEEDBACK_ROUNDS),
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      reviews: r.resolve(t.REVIEW_PIPELINE),
      recorder: r.resolve(t.EVENT_RECORDER),
      members: r.resolve(t.MEMBER_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      clock: clock(r),
      log: log(r).child({ component: 'approvals' }),
    }), { source: SOURCE });

    // Depends on no service but projections, so the mission service can use it for a retry with a note without a cycle.
    bind(t.FEEDBACK_SERVICE, (r) => new FeedbackServiceImpl({
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      feedback: r.resolve(t.FEEDBACK_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      rounds: r.resolve(t.FEEDBACK_ROUNDS),
      projections: r.resolve(t.PROJECTION_SERVICE),
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      recorder: r.resolve(t.EVENT_RECORDER),
      scheduler: r.resolve(t.SCHEDULER),
    }), { source: SOURCE });

    bind(t.MISSION_SERVICE, (r) => new MissionServiceImpl({
      criteria: r.resolve(t.MISSION_CRITERIA_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      repositories: r.resolve(t.REPO_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      artifactStore: r.resolve(t.ARTIFACT_STORE),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      measure: r.resolve(t.ARTIFACT_MEASURE),
      members: r.resolve(t.MEMBER_REPOSITORY),
      roles: r.resolve(t.ROLE_REPOSITORY),
      reviews: r.resolve(t.REVIEW_PIPELINE),
      planning: r.resolve(t.PLANNING_SERVICE),
      projections: r.resolve(t.PROJECTION_SERVICE),
      scheduler: r.resolve(t.SCHEDULER),
      feedback: r.resolve(t.FEEDBACK_SERVICE),
      rounds: r.resolve(t.FEEDBACK_ROUNDS),
      overrides: r.resolve(t.RUNTIME_OVERRIDES),
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
      log: log(r).child({ component: 'missions' }),
    }), { source: SOURCE });

    bind(t.CRITERIA_SERVICE, (r) => new CriteriaServiceImpl({
      missions: r.resolve(t.MISSION_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      gates: r.resolve(t.GATE_SERVICE),
    }), { source: SOURCE });

    bind(t.TANDEMISE_SERVICES, (r): TandemiseServices => ({
      system: r.resolve(t.SYSTEM_SERVICE),
      workspaces: r.resolve(t.WORKSPACE_SERVICE),
      workflows: r.resolve(t.WORKFLOW_SERVICE),
      missions: r.resolve(t.MISSION_SERVICE),
      planning: r.resolve(t.PLANNING_SERVICE),
      approvals: r.resolve(t.APPROVAL_SERVICE),
      artifacts: r.resolve(t.ARTIFACT_SERVICE),
      runtimes: r.resolve(t.RUNTIME_SERVICE),
      roles: r.resolve(t.ROLE_SERVICE),
      integrations: r.resolve(t.INTEGRATION_SERVICE),
      projections: r.resolve(t.PROJECTION_SERVICE),
      identity: r.resolve(t.IDENTITY),
      team: r.resolve(t.TEAM_SERVICE),
      staffing: r.resolve(t.STAFFING_SERVICE),
      feedback: r.resolve(t.FEEDBACK_SERVICE),
      criteria: r.resolve(t.CRITERIA_SERVICE),
    }), { source: SOURCE });
  });
}

/** Convenience binding for composition roots with no scheduler override. */
export const applicationModule: TandemiseModule = createApplicationModule();

/**
 * The application's public surface, assembled.
 *
 * A function rather than a token lookup at the call site because this is the
 * one thing the daemon genuinely needs from the container, and `createServices`
 * reads as what it is: "give me the API".
 */
export function createServices(container: Container): TandemiseServices {
  return container.resolve(t.TANDEMISE_SERVICES);
}

const log = (r: Resolver): Logger => r.tryResolve(EXECUTION_LOGGER) ?? nullLogger;
const clock = (r: Resolver): Clock => r.tryResolve(EXECUTION_CLOCK) ?? systemClock;
const paths = (r: Resolver): TandemisePaths => r.tryResolve(EXECUTION_PATHS) ?? createPaths();
