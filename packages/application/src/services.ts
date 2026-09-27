import type {
  ApprovalId, ArtifactId, CriterionId, FeedbackId, IntegrationId, IssueLinkId, QuestionId, MemberId, MissionId, PersonId, RepositoryId, RoutineId, RuntimeProfileId,
  TaskId, WorkspaceId,
} from '@tandemise/shared';
import type {
  Approval, ArtifactManifest, ExecutionTargetRecord, Mission, RoleStaffing, RoleTemplate,
  RunEventRecord, RuntimeProfile, StaffingPatch,
} from '@tandemise/domain';
import type {
  AddRepositoryRequest, ApprovalView, CreateIntegrationRequest, CreateMissionRequest,
  CreateRuntimeProfileRequest, CreateWorkspaceRequest, DecideApprovalRequest, HomeView, InboxView,
  ConnectIntegrationRequest, ConnectionAttemptView, ConnectorView,
  IntegrationView, MissionDetail, MissionSummary, RepositoryProbe, RuntimeDiscoveryView,
  RuntimeView, SystemInfo, TaskView, UpdateWorkspaceRequest, UpsertRoleRequest, WorkspaceView,
  ClaimTaskRequest, CompleteTaskRequest,
  WorkflowSummary,
  AddMemberRequest, ArtifactView, CreatePersonRequest, MeView, MemberView, PersonView, StaffingPreviewView,
  TeamView, UpdateMemberRequest, UpdatePersonRequest, MissionArtifactView, MissionFeedView, ArtifactReadView,
  DismissFeedbackRequest, FeedbackGivenView, FeedbackView, GiveFeedbackRequest, StartRoundRequest, TaskFeedbackView,
  MissionCriterionView, RefinementView, CriterionVerdictRequest, AnswerQuestionRequest, AddCriterionRequest,
} from '@tandemise/api-contract';
import type { Caller, IdentityPort } from './support/identity.js';
import type { RoundBegun } from './engine/feedback-rounds.js';
import type { RoleStaffingEdit } from './support/staffing-edit.js';

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
  /** Who requests act as. The daemon's routes use it until a principal is resolved per request. */
  readonly identity: IdentityPort;
  readonly team: TeamService;
  readonly staffing: StaffingService;
  readonly feedback: FeedbackService;
  readonly criteria: CriteriaService;
  readonly refinement: RefinementService;
  /** The ranked backlog and the work-in-progress limit (P7). */
  readonly backlog: import('./services/backlog-service.js').BacklogService;
  /** Hard limits on spend and time (P8). */
  readonly limits: import('./services/limit-service.js').LimitService;
  /** Stalled missions and quiet runs (P9). */
  readonly liveness: import('./services/liveness-service.js').LivenessService;
  /** The owner's desk: Home's numbers and the status report (P10). */
  readonly desk: import('./services/desk-service.js').DeskService;
  readonly routines: import('./services/routine-service.js').RoutineService;
  /** Desktop notifications from the Inbox (P16). */
  readonly notifications: import('./services/notification-service.js').NotificationService;
  readonly skills: import('./services/skill-service.js').SkillService;
  /** GitHub issues in and out (P14). */
  readonly issues: import('./services/issue-service.js').IssueService;
}

/** Making a rough request ready to plan (P6). Every write is refused once the mission has left DRAFT. */
export interface RefinementService {
  /** Starts a refinement pass in the background; answers at once with the view (`running`). */
  begin(caller: Caller, missionId: MissionId): RefinementView;
  /** A pass is running on the mission right now; the backlog does not pull it meanwhile. */
  isRunning(missionId: MissionId): boolean;
  /** Resolves once the mission's current pass, if any, has settled. */
  settled(missionId: MissionId): Promise<void>;
  view(missionId: MissionId): RefinementView;
  /** Accepts (optionally reworded) or rejects a proposed criterion. */
  decide(caller: Caller, criterionId: CriterionId, request: CriterionVerdictRequest): RefinementView;
  answer(caller: Caller, questionId: QuestionId, request: AnswerQuestionRequest): RefinementView;
  /** Adds an accepted criterion in the person's own words. */
  addCriterion(caller: Caller, missionId: MissionId, request: AddCriterionRequest): RefinementView;
}

/** The Done-when ledger of a mission (P5). */
export interface CriteriaService {
  /** Live criteria, user first then spec, each traced against the newest QA report. */
  list(missionId: MissionId): readonly MissionCriterionView[];
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
  /** The caller becomes the new workspace's owner. */
  create(caller: Caller, request: CreateWorkspaceRequest): Promise<WorkspaceView>;
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
  /** `origin.routineId` marks a mission a routine created (P11). */
  create(caller: Caller, request: CreateMissionRequest, origin?: { routineId?: RoutineId; issueLinkId?: IssueLinkId }): Promise<Mission>;
  start(id: MissionId): Promise<Mission>;
  pause(id: MissionId): Promise<Mission>;
  resume(id: MissionId): Promise<Mission>;
  cancel(id: MissionId, reason?: string): Promise<Mission>;
  remove(id: MissionId): Promise<void>;
  retryTask(caller: Caller, taskId: TaskId, options: { runtimeProfileId?: string; note?: string; addCapabilities?: readonly string[]; stopRun?: boolean }): Promise<TaskView>;
  skipTask(caller: Caller, taskId: TaskId): Promise<TaskView>;
  /** A person reports a `human` task done, with whatever they produced. */
  completeTask(caller: Caller, taskId: TaskId, request: CompleteTaskRequest): Promise<TaskView>;
  /** A person takes an unassigned human task, for themselves or for the member named. */
  claimTask(caller: Caller, taskId: TaskId, request: ClaimTaskRequest): Promise<TaskView>;
}

export interface PlanningService {
  /** Runs the planner role, validates the result, and stores the plan. */
  plan(id: MissionId): Promise<MissionDetail>;
  /** Moves the mission to PLANNING and plans in the background; resolves at once. */
  begin(id: MissionId): Promise<MissionDetail>;
  /** Re-plans missions a previous daemon left in PLANNING. */
  resumeInterrupted(): readonly MissionId[];
  /**
   * Stops planning a mission that was cancelled: aborts its planner run, and
   * whatever plan still arrives is discarded rather than written.
   */
  abandon(id: MissionId): void;
  /** Whether a planner is running for the mission in this daemon (P9: a PLANNING mission without one is stalled). */
  isPlanning(id: MissionId): boolean;
}

export interface ApprovalService {
  list(filter: { workspaceId?: string; missionId?: string; status?: string }): readonly ApprovalView[];
  get(id: ApprovalId): ApprovalView;
  /** Decided by the caller's member, or by `onBehalfOf` and recorded by the caller's. */
  decide(caller: Caller, id: ApprovalId, request: DecideApprovalRequest): Promise<ApprovalView>;
}

export interface ArtifactService {
  /** The live versions, or every version when asked, each numbered along its chain. */
  listByMission(missionId: MissionId, options?: { includeSuperseded?: boolean }): readonly MissionArtifactView[];
  /** The manifest carries the database's attribution, which the store's copy does not. */
  read(id: ArtifactId): Promise<ArtifactReadView>;
  /** Omit the workspace to search the whole install. Current versions only unless `includeSuperseded`. */
  search(workspaceId: WorkspaceId | undefined, query: string, options?: { includeSuperseded?: boolean }): readonly ArtifactView[];
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
  /** Upgrades unedited built-in roles to the shipped definition; returns how many changed. */
  refreshBuiltIns(workspaceIds: readonly WorkspaceId[]): number;
}

export interface IntegrationService {
  /** Omit the workspace to list every integration in the install. */
  list(workspaceId?: WorkspaceId): Promise<readonly IntegrationView[]>;
  listProviders(): readonly { id: string; displayName: string; transport: string; description: string }[];
  create(request: CreateIntegrationRequest): Promise<IntegrationView>;
  update(id: IntegrationId, patch: Partial<CreateIntegrationRequest> & { readonly enabled?: boolean }): Promise<IntegrationView>;
  remove(id: IntegrationId): void;
  checkHealth(id: IntegrationId): Promise<IntegrationView>;
  /** One-click integrations the composed providers offer. */
  listConnectors(): readonly ConnectorView[];
  /** Starts connecting an account; the desktop opens the returned URL. */
  connect(request: ConnectIntegrationRequest): Promise<ConnectionAttemptView>;
  connection(attemptId: string): ConnectionAttemptView;
  cancelConnection(attemptId: string): ConnectionAttemptView;
}

export interface ProjectionService {
  home(workspaceId?: string): Promise<HomeView>;
  /** Pending approvals and tasks waiting on a person in one workspace. */
  inbox(workspaceId: WorkspaceId): InboxView;
  /** A mission's cards, grouped for the caller: what needs them, what is moving, what is done. */
  missionFeed(id: MissionId, caller: Caller, options?: { doneLimit?: number }): MissionFeedView;
  missionDetail(id: MissionId): Promise<MissionDetail>;
  missionTasks(id: MissionId): Promise<readonly TaskView[]>;
  taskView(id: TaskId): TaskView;
  missionEvents(id: MissionId, opts: { afterSequence?: number; limit?: number; semanticOnly?: boolean }): readonly RunEventRecord[];
  targets(missionId?: string): readonly ExecutionTargetRecord[];
}

export interface TeamService {
  me(caller: Caller): MeView;
  listPeople(): readonly PersonView[];
  createPerson(caller: Caller, request: CreatePersonRequest): PersonView;
  updatePerson(caller: Caller, id: PersonId, request: UpdatePersonRequest): PersonView;
  /** Soft: the person is marked removed and every seat they held is removed. */
  removePerson(caller: Caller, id: PersonId): void;
  team(workspaceId: WorkspaceId): TeamView;
  addMember(caller: Caller, workspaceId: WorkspaceId, request: AddMemberRequest): MemberView;
  updateMember(caller: Caller, id: MemberId, request: UpdateMemberRequest): MemberView;
  /** Marks the seat removed; CONFLICT when it is the workspace's last owner. */
  removeMember(caller: Caller, id: MemberId): void;
}

export interface StaffingService {
  workspace(workspaceId: WorkspaceId): RoleStaffing;
  /** Merged per role; a role set to `null` is removed. */
  patchWorkspace(caller: Caller, workspaceId: WorkspaceId, patch: RoleStaffingEdit): RoleStaffing;
  patchMission(caller: Caller, missionId: MissionId, patch: RoleStaffingEdit): RoleStaffing;
  /** CONFLICT once the task is running or finished. */
  patchTask(caller: Caller, taskId: TaskId, patch: StaffingPatch | null): TaskView;
  preview(taskId: TaskId): StaffingPreviewView;
}

/**
 * Notes on a task's output and the rounds they start (spec §2, §3, §8).
 *
 * Acting on a note is one rule for every entry point: the feed card, the
 * reader, the drawer and a retry with a note all come through `give`.
 */
/** A note written inside someone's unit of work, with what is left to do once that unit commits. */
export interface PendingFeedback {
  readonly view: FeedbackGivenView;
  /** The round the note started, whose overtaken dependents are stopped after the commit. */
  readonly begun: RoundBegun | null;
}

export interface FeedbackService {
  /** Spec §2's table decides what happens; see `feedbackEffectFor`. */
  give(caller: Caller, taskId: TaskId, request: GiveFeedbackRequest, options?: { readonly forceDownstream?: 'keep' }): FeedbackGivenView;
  /**
   * `give`'s writes alone, for a caller with a unit of its own (a retry that
   * also widens access). It must call `afterGive` once that unit has committed:
   * stopping a pass or waking the scheduler before then acts on a round that
   * may still roll back.
   */
  beginGive(caller: Caller, taskId: TaskId, request: GiveFeedbackRequest, options?: { readonly forceDownstream?: 'keep' }): PendingFeedback;
  afterGive(pending: PendingFeedback): FeedbackGivenView;
  /** Confirms a round that waited on the downstream choice. */
  startRound(caller: Caller, taskId: TaskId, request: StartRoundRequest): TaskView;
  list(taskId: TaskId): TaskFeedbackView;
  /** CONFLICT once the note is in a round, addressed or already dismissed. */
  dismiss(caller: Caller, id: FeedbackId, request: DismissFeedbackRequest): FeedbackView;
}

/** Re-exported so the daemon can name the type it binds. */
export type { Approval, ArtifactManifest };
