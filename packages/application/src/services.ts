import type {
  ApprovalId, ArtifactId, IntegrationId, MissionId, RepositoryId, RuntimeProfileId,
  TaskId, WorkspaceId,
} from '@tandemise/shared';
import type {
  Approval, ArtifactManifest, ExecutionTargetRecord, LoadedArtifact, Mission, RoleTemplate,
  RunEventRecord, RuntimeProfile,
} from '@tandemise/domain';
import type {
  AddRepositoryRequest, ApprovalView, CreateIntegrationRequest, CreateMissionRequest,
  CreateRuntimeProfileRequest, CreateWorkspaceRequest, DecideApprovalRequest, HomeView,
  IntegrationView, MissionDetail, MissionSummary, RepositoryProbe, RuntimeDiscoveryView,
  RuntimeView, SystemInfo, TaskView, UpdateWorkspaceRequest, UpsertRoleRequest, WorkspaceView,
  CompleteTaskRequest,
  WorkflowSummary,
} from '@tandemise/api-contract';

/**
 * The application's public surface.
 *
 * The daemon's HTTP layer is a projection of exactly this interface and nothing
 * more. Stating it as one type serves two purposes: it keeps orchestration
 * rules out of route handlers, and it means the whole product could be driven
 * by a CLI or a test harness without touching HTTP at all.
 */
export interface TandemiseServices {
  readonly system: SystemService;
  readonly workspaces: WorkspaceService;
  readonly workflows: WorkflowService;
  readonly missions: MissionService;
  readonly planning: PlanningService;
  readonly approvals: ApprovalService;
  readonly artifacts: ArtifactService;
  readonly runtimes: RuntimeService;
  readonly roles: RoleService;
  readonly integrations: IntegrationService;
  readonly projections: ProjectionService;
}

export interface SystemService {
  info(): SystemInfo;
  settings(): Record<string, unknown>;
  updateSettings(patch: Record<string, unknown>): Record<string, unknown>;
  /** Container bindings, registered providers, and paths - the developer pane. */
  diagnostics(): Record<string, unknown>;
}

/** The workflows a project can run: its own files, then the built-in presets. */
export interface WorkflowService {
  list(workspaceId: WorkspaceId): Promise<readonly WorkflowSummary[]>;
}


export interface WorkspaceService {
  list(): readonly WorkspaceView[];
  create(request: CreateWorkspaceRequest): Promise<WorkspaceView>;
  view(id: WorkspaceId): WorkspaceView;
  update(id: WorkspaceId, patch: UpdateWorkspaceRequest): WorkspaceView;
  listRepositories(id: WorkspaceId): readonly import('@tandemise/domain').Repository[];
  addRepository(id: WorkspaceId, request: AddRepositoryRequest): Promise<import('@tandemise/domain').Repository>;
  updateRepository(id: RepositoryId, patch: Partial<AddRepositoryRequest>): import('@tandemise/domain').Repository;
  removeRepository(id: RepositoryId): void;
  /** Inspects a path without adding it: git state, detected checks, warnings. */
  probeRepository(path: string): Promise<RepositoryProbe>;
}

export interface MissionService {
  list(filter: { workspaceId?: string; status?: string; limit?: number }): readonly MissionSummary[];
  create(request: CreateMissionRequest): Promise<Mission>;
  start(id: MissionId): Promise<Mission>;
  pause(id: MissionId): Promise<Mission>;
  resume(id: MissionId): Promise<Mission>;
  cancel(id: MissionId, reason?: string): Promise<Mission>;
  remove(id: MissionId): Promise<void>;
  retryTask(taskId: TaskId, options: { runtimeProfileId?: string; note?: string }): Promise<TaskView>;
  skipTask(taskId: TaskId): Promise<TaskView>;
  /** A person reports a `human` task done, with whatever they produced. */
  completeTask(taskId: TaskId, request: CompleteTaskRequest): Promise<TaskView>;
}

export interface PlanningService {
  /** Runs the planner role, validates the result, and stores the plan. */
  plan(id: MissionId): Promise<MissionDetail>;
}

export interface ApprovalService {
  list(filter: { workspaceId?: string; missionId?: string; status?: string }): readonly ApprovalView[];
  get(id: ApprovalId): ApprovalView;
  decide(id: ApprovalId, request: DecideApprovalRequest): Promise<ApprovalView>;
}

export interface ArtifactService {
  listByMission(missionId: MissionId): readonly ArtifactManifest[];
  read(id: ArtifactId): Promise<LoadedArtifact>;
  /** Omit the workspace to search the whole install. */
  search(workspaceId: WorkspaceId | undefined, query: string): readonly ArtifactManifest[];
}

export interface RuntimeService {
  list(workspaceId?: string): Promise<readonly RuntimeView[]>;
  discover(): Promise<readonly RuntimeDiscoveryView[]>;
  create(request: CreateRuntimeProfileRequest): Promise<RuntimeProfile>;
  update(id: RuntimeProfileId, patch: Partial<CreateRuntimeProfileRequest>): Promise<RuntimeProfile>;
  remove(id: RuntimeProfileId): void;
  checkHealth(id: RuntimeProfileId): Promise<RuntimeView>;
}

export interface RoleService {
  list(workspaceId?: string): readonly RoleTemplate[];
  upsert(request: UpsertRoleRequest): RoleTemplate;
  remove(id: string, workspaceId: WorkspaceId): void;
}

export interface IntegrationService {
  /** Omit the workspace to list every integration in the install. */
  list(workspaceId?: WorkspaceId): Promise<readonly IntegrationView[]>;
  listProviders(): readonly { id: string; displayName: string; transport: string; description: string }[];
  create(request: CreateIntegrationRequest): Promise<IntegrationView>;
  update(id: IntegrationId, patch: Partial<CreateIntegrationRequest>): Promise<IntegrationView>;
  remove(id: IntegrationId): void;
  checkHealth(id: IntegrationId): Promise<IntegrationView>;
}

export interface ProjectionService {
  home(workspaceId?: string): Promise<HomeView>;
  missionDetail(id: MissionId): Promise<MissionDetail>;
  missionTasks(id: MissionId): Promise<readonly TaskView[]>;
  missionEvents(id: MissionId, opts: { afterSequence?: number; limit?: number; semanticOnly?: boolean }): readonly RunEventRecord[];
  targets(missionId?: string): readonly ExecutionTargetRecord[];
}

/** Re-exported so the daemon can name the type it binds. */
export type { Approval, ArtifactManifest };
