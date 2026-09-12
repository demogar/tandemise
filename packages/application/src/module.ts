import { defineModule, type Container, type Resolver, type TandemiseModule } from '@tandemise/kernel';
import type { Clock, Logger, TandemisePaths } from '@tandemise/shared';
import { createPaths, nullLogger, systemClock } from '@tandemise/shared';
import { APPROVAL_FACTORY, GRANT_BUILDER, POLICY_ENGINE } from '@tandemise/policy';
import { CONTEXT_COMPILER } from '@tandemise/context';
import { RUNTIME_MANAGER, RUNTIME_REGISTRY } from '@tandemise/runtimes-core';
import {
  CLOCK as EXECUTION_CLOCK, EXECUTION_TARGET_MANAGER, LOGGER as EXECUTION_LOGGER,
  PATHS as EXECUTION_PATHS, PROCESS_SUPERVISOR,
} from '@tandemise/execution-core';
import {
  APPROVAL_GATE, INTEGRATION_PROVIDER_REGISTRY, INTEGRATION_SOURCE, TOOL_BROKER, TOOL_POLICY_GATE,
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
import { SchedulerService } from './engine/scheduler.js';
import { TaskExecutor } from './engine/task-executor.js';
import { EventRecorder } from './support/event-recorder.js';
import { RepositoryProber } from './support/repository-prober.js';
import { RuntimeOverrides } from './support/runtime-overrides.js';
import { ApprovalWaiter, createApprovalGate, createPolicyEngineToolGate } from './support/tool-policy.js';
import { ApprovalServiceImpl } from './services/approval-service.js';
import { ArtifactServiceImpl } from './services/artifact-service.js';
import { IntegrationServiceImpl } from './services/integration-service.js';
import { MissionServiceImpl } from './services/mission-service.js';
import { PlanningServiceImpl } from './services/planning-service.js';
import { ProjectionServiceImpl } from './services/projection-service.js';
import { RoleServiceImpl } from './services/role-service.js';
import { RuntimeServiceImpl } from './services/runtime-service.js';
import { SystemServiceImpl } from './services/system-service.js';
import { WorkspaceServiceImpl } from './services/workspace-service.js';

const SOURCE = 'application';

export interface ApplicationModuleOptions {
  /** Scheduler tick interval. The daemon passes its configured value. */
  readonly tickIntervalMs?: number;
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

    bind(t.EVENT_RECORDER, (r) => new EventRecorder(
      r.resolve(t.EVENT_REPOSITORY),
      r.resolve(t.EVENT_BUS),
      r.resolve(t.PROJECTION_BUS),
      clock(r),
    ), { source: SOURCE });

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
    ), { source: SOURCE });

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
      r.resolve(t.EVENT_RECORDER),
      clock(r),
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
      decisions: r.resolve(t.DECISION_REPOSITORY),
      checkpoints: r.resolve(t.CHECKPOINT_REPOSITORY),
      runtimeManager: r.resolve(RUNTIME_MANAGER),
      targetManager: r.resolve(EXECUTION_TARGET_MANAGER),
      contextCompiler: r.resolve(CONTEXT_COMPILER),
      grantBuilder: r.resolve(GRANT_BUILDER),
      policy: r.resolve(POLICY_ENGINE),
      approvalFactory: r.resolve(APPROVAL_FACTORY),
      toolBroker: r.tryResolve(TOOL_BROKER) ?? null,
      overrides: r.resolve(t.RUNTIME_OVERRIDES),
      templates: r.resolve(t.ARTIFACT_TEMPLATES),
      harvester: r.resolve(t.ARTIFACT_HARVESTER),
      checks: r.resolve(t.CHECK_SERVICE),
      gates: r.resolve(t.GATE_SERVICE),
      recorder: r.resolve(t.EVENT_RECORDER),
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

    bind(t.SCHEDULER, (r) => new SchedulerService({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      executor: r.resolve(t.TASK_EXECUTOR),
      remediation: r.resolve(t.REMEDIATION_PLANNER),
      integration: r.resolve(t.BRANCH_INTEGRATION_SERVICE),
      recorder: r.resolve(t.EVENT_RECORDER),
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
    ), { source: SOURCE });

    bind(t.ROLE_SERVICE, (r) => new RoleServiceImpl(r.resolve(t.ROLE_REPOSITORY), clock(r)), { source: SOURCE });

    bind(t.ARTIFACT_SERVICE, (r) => new ArtifactServiceImpl(
      r.resolve(t.ARTIFACT_REPOSITORY),
      r.resolve(t.ARTIFACT_STORE),
    ), { source: SOURCE });

    bind(t.RUNTIME_SERVICE, (r) => new RuntimeServiceImpl(
      r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      r.resolve(t.WORKSPACE_REPOSITORY),
      r.resolve(RUNTIME_MANAGER),
      clock(r),
    ), { source: SOURCE });

    bind(t.INTEGRATION_SERVICE, (r) => new IntegrationServiceImpl({
      integrations: r.resolve(t.INTEGRATION_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      providers: r.resolve(INTEGRATION_PROVIDER_REGISTRY),
      secrets: r.resolve(t.SECRET_STORE),
      exec: r.tryResolve(INTEGRATION_COMMAND_EXECUTOR) ?? null,
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
    }), { source: SOURCE });

    bind(t.PLANNING_SERVICE, (r) => new PlanningServiceImpl({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      repositories: r.resolve(t.REPO_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      roles: r.resolve(t.ROLE_REPOSITORY),
      runtimeProfiles: r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      approvalFactory: r.resolve(APPROVAL_FACTORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      artifactStore: r.resolve(t.ARTIFACT_STORE),
      runtimeManager: r.resolve(RUNTIME_MANAGER),
      targetManager: r.resolve(EXECUTION_TARGET_MANAGER),
      projections: r.resolve(t.PROJECTION_SERVICE),
      recorder: r.resolve(t.EVENT_RECORDER),
      paths: paths(r),
      clock: clock(r),
      log: log(r).child({ component: 'planning' }),
    }), { source: SOURCE });

    bind(t.APPROVAL_SERVICE, (r) => new ApprovalServiceImpl({
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      roles: r.resolve(t.ROLE_REPOSITORY),
      scheduler: r.resolve(t.SCHEDULER),
      waiter: r.resolve(t.APPROVAL_WAITER),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
      log: log(r).child({ component: 'approvals' }),
    }), { source: SOURCE });

    bind(t.MISSION_SERVICE, (r) => new MissionServiceImpl({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      repositories: r.resolve(t.REPO_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      planning: r.resolve(t.PLANNING_SERVICE),
      projections: r.resolve(t.PROJECTION_SERVICE),
      scheduler: r.resolve(t.SCHEDULER),
      overrides: r.resolve(t.RUNTIME_OVERRIDES),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
      log: log(r).child({ component: 'missions' }),
    }), { source: SOURCE });

    bind(t.TANDEMISE_SERVICES, (r): TandemiseServices => ({
      system: r.resolve(t.SYSTEM_SERVICE),
      workspaces: r.resolve(t.WORKSPACE_SERVICE),
      missions: r.resolve(t.MISSION_SERVICE),
      planning: r.resolve(t.PLANNING_SERVICE),
      approvals: r.resolve(t.APPROVAL_SERVICE),
      artifacts: r.resolve(t.ARTIFACT_SERVICE),
      runtimes: r.resolve(t.RUNTIME_SERVICE),
      roles: r.resolve(t.ROLE_SERVICE),
      integrations: r.resolve(t.INTEGRATION_SERVICE),
      projections: r.resolve(t.PROJECTION_SERVICE),
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
