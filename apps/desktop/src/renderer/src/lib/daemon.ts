import type {
  ApiErrorBody,
  ApprovalView,
  HomeView,
  InboxView,
  ConnectIntegrationRequest,
  ConnectionAttemptView,
  ConnectorView,
  IntegrationView,
  ArtifactReadView,
  ArtifactView,
  MissionArtifactView,
  MissionDetail,
  MissionFeedView,
  MissionCriterionView,
  MissionSummary,
  RepositoryProbe,
  RuntimeDiscoveryView,
  RuntimeView,
  SystemInfo,
  TaskView,
  WorkflowSummary,
  WorkspaceView,
  CreateMissionRequest,
  DecideApprovalRequest,
  CreateRuntimeProfileRequest,
  CreateIntegrationRequest,
  UpsertRoleRequest,
  UpdateWorkspaceRequest,
  AddRepositoryRequest,
  CreateWorkspaceRequest,
  AddMemberRequest,
  ClaimTaskRequest,
  CompleteTaskRequest,
  CreatePersonRequest,
  MeView,
  MemberView,
  PersonView,
  RoleStaffingPatchRequest,
  StaffingPreviewView,
  TaskStaffingPatchRequest,
  TeamView,
  UpdateMemberRequest,
  UpdatePersonRequest,
  FeedbackGivenView,
  FeedbackView,
  GiveFeedbackRequest,
  StartRoundRequest,
  TaskFeedbackView,
} from '@tandemise/api-contract';
import { API_VERSION, API_VERSION_HEADER, STREAM_PATH } from './domain.js';
import type {
  MissionStatus,
  Repository,
  RoleStaffing,
  RoleTemplate,
  RunEventRecord,
  RuntimeProfile,
  Workspace,
} from '@tandemise/domain';
import type { DaemonConnection } from '../../../shared/bridge.js';

/**
 * A daemon error, already unwrapped from the `ApiErrorBody` envelope.
 *
 * Keeping `code` and `retryable` on the thrown value is what lets a screen show
 * "the runtime is busy, retrying" rather than a generic red box - the daemon
 * already classified the failure, and discarding that here would force the UI
 * to guess (MVP.md §7.2).
 */
export class DaemonError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown>,
    readonly retryable: boolean,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'DaemonError';
  }
}

/** A transport failure: the daemon is not answering at all. */
export class DaemonUnreachableError extends Error {
  readonly code = 'UNREACHABLE';
  constructor(message: string) {
    super(message);
    this.name = 'DaemonUnreachableError';
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

export class DaemonClient {
  constructor(private readonly connection: DaemonConnection) {}

  get streamUrl(): string {
    const base = new URL(this.connection.url);
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    base.pathname = STREAM_PATH;
    base.searchParams.set('token', this.connection.token);
    return base.toString();
  }

  get token(): string {
    return this.connection.token;
  }

  // --------------------------------------------------------------- transport

  async #request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
    const url = new URL(`/v1${path}`, this.connection.url);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.connection.token}`,
          [API_VERSION_HEADER]: API_VERSION,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new DaemonUnreachableError(
        error instanceof Error ? `Could not reach the daemon: ${error.message}` : 'Could not reach the daemon.',
      );
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const payload: unknown = text.length > 0 ? safeJson(text) : undefined;

    if (!response.ok) throw toDaemonError(payload, response.status, text);
    return payload as T;
  }

  #get<T>(path: string, query?: Query): Promise<T> {
    return this.#request<T>('GET', path, undefined, query);
  }

  // ------------------------------------------------------------------ system

  health(): Promise<{ status: string }> {
    return this.#get('/health');
  }

  system(): Promise<SystemInfo> {
    return this.#get('/system');
  }

  home(workspaceId?: string): Promise<HomeView> {
    return this.#get('/home', { workspaceId });
  }

  /** Pending approvals and tasks waiting on a person, in one read. */
  inbox(workspaceId: string): Promise<InboxView> {
    return this.#get('/inbox', { workspaceId });
  }

  // -------------------------------------------------------------- workspaces

  workspaces(): Promise<readonly WorkspaceView[]> {
    return this.#get('/workspaces');
  }

  workspace(id: string): Promise<WorkspaceView> {
    return this.#get(`/workspaces/${id}`);
  }

  createWorkspace(body: CreateWorkspaceRequest): Promise<WorkspaceView> {
    return this.#request('POST', '/workspaces', body);
  }

  updateWorkspace(id: string, body: UpdateWorkspaceRequest): Promise<Workspace> {
    return this.#request('PATCH', `/workspaces/${id}`, body);
  }

  repositories(workspaceId: string): Promise<readonly Repository[]> {
    return this.#get(`/workspaces/${workspaceId}/repositories`);
  }

  addRepository(workspaceId: string, body: AddRepositoryRequest): Promise<Repository> {
    return this.#request('POST', `/workspaces/${workspaceId}/repositories`, body);
  }

  probeRepository(path: string): Promise<RepositoryProbe> {
    return this.#request('POST', '/repositories/probe', { path });
  }

  removeRepository(id: string): Promise<void> {
    return this.#request('DELETE', `/repositories/${id}`);
  }

  // ---------------------------------------------------------------- missions

  missions(query?: { workspaceId?: string; status?: MissionStatus; limit?: number }): Promise<readonly MissionSummary[]> {
    return this.#get('/missions', query);
  }

  mission(id: string): Promise<MissionDetail> {
    return this.#get(`/missions/${id}`);
  }

  createMission(body: CreateMissionRequest): Promise<MissionDetail> {
    return this.#request('POST', '/missions', body);
  }

  missionAction(id: string, action: 'plan' | 'start' | 'pause' | 'resume' | 'cancel', body?: unknown): Promise<MissionDetail> {
    return this.#request('POST', `/missions/${id}/${action}`, body ?? {});
  }

  deleteMission(id: string): Promise<void> {
    return this.#request('DELETE', `/missions/${id}`);
  }

  missionEvents(id: string, query?: { afterSequence?: number; limit?: number; semanticOnly?: boolean }): Promise<readonly RunEventRecord[]> {
    return this.#get(`/missions/${id}/events`, query);
  }

  /** Live versions only, unless `includeSuperseded`; each row carries its version number and successor. */
  missionArtifacts(id: string, query?: { includeSuperseded?: boolean }): Promise<readonly MissionArtifactView[]> {
    return this.#get(`/missions/${id}/artifacts`, query);
  }

  /** The mission's cards grouped for the principal; `doneLimit` defaults to 5 on the daemon. */
  missionFeed(id: string, query?: { doneLimit?: number }): Promise<MissionFeedView> {
    return this.#get(`/missions/${id}/feed`, query);
  }

  /** The mission's Done-when ledger, traced against the newest QA report. */
  missionCriteria(id: string): Promise<readonly MissionCriterionView[]> {
    return this.#get(`/missions/${id}/criteria`);
  }

  /** A person reporting they have done a `human` task, with what they produced; `onBehalfOf` records it for a teammate. */
  completeTask(id: string, body: CompleteTaskRequest): Promise<TaskView> {
    return this.#request('POST', `/tasks/${id}/complete`, body);
  }

  /** Takes an unassigned pool task, for the principal or for `onBehalfOf`. */
  claimTask(id: string, body: ClaimTaskRequest = {}): Promise<TaskView> {
    return this.#request('POST', `/tasks/${id}/claim`, body);
  }

  retryTask(taskId: string, body?: { runtimeProfileId?: string; note?: string; addCapabilities?: readonly string[] }): Promise<void> {
    return this.#request('POST', `/tasks/${taskId}/retry`, body ?? {});
  }

  // ---------------------------------------------------------- feedback and rounds

  /** A note on a task. What it does follows the task's state; `impact` is set when finished work used its output. */
  giveFeedback(taskId: string, body: GiveFeedbackRequest): Promise<FeedbackGivenView> {
    return this.#request('POST', `/tasks/${taskId}/feedback`, body);
  }

  /** Confirms a round that waited on the person's choice about the work downstream. */
  startRound(taskId: string, body: StartRoundRequest): Promise<TaskView> {
    return this.#request('POST', `/tasks/${taskId}/rounds`, body);
  }

  /** The task's notes, oldest first, and the round open notes are waiting on. */
  taskFeedback(taskId: string): Promise<TaskFeedbackView> {
    return this.#get(`/tasks/${taskId}/feedback`);
  }

  dismissFeedback(id: string, body: { onBehalfOf?: string } = {}): Promise<FeedbackView> {
    return this.#request('POST', `/feedback/${id}/dismiss`, body);
  }

  // ---------------------------------------------------------- people and team

  me(): Promise<MeView> {
    return this.#get('/me');
  }

  listPeople(): Promise<readonly PersonView[]> {
    return this.#get('/people');
  }

  createPerson(body: CreatePersonRequest): Promise<PersonView> {
    return this.#request('POST', '/people', body);
  }

  updatePerson(id: string, body: UpdatePersonRequest): Promise<PersonView> {
    return this.#request('PATCH', `/people/${id}`, body);
  }

  /** Soft: the person and every seat they held are marked removed. */
  removePerson(id: string): Promise<void> {
    return this.#request('DELETE', `/people/${id}`);
  }

  team(workspaceId: string): Promise<TeamView> {
    return this.#get(`/workspaces/${workspaceId}/team`);
  }

  addMember(workspaceId: string, body: AddMemberRequest): Promise<MemberView> {
    return this.#request('POST', `/workspaces/${workspaceId}/members`, body);
  }

  updateMember(id: string, body: UpdateMemberRequest): Promise<MemberView> {
    return this.#request('PATCH', `/members/${id}`, body);
  }

  removeMember(id: string): Promise<void> {
    return this.#request('DELETE', `/members/${id}`);
  }

  // ---------------------------------------------------------------- staffing

  getStaffing(workspaceId: string): Promise<RoleStaffing> {
    return this.#get(`/workspaces/${workspaceId}/staffing`);
  }

  /** Merged per role; send only the roles that changed, `null` removes one. */
  patchStaffing(workspaceId: string, body: RoleStaffingPatchRequest): Promise<RoleStaffing> {
    return this.#request('PATCH', `/workspaces/${workspaceId}/staffing`, body);
  }

  patchMissionStaffing(missionId: string, body: RoleStaffingPatchRequest): Promise<RoleStaffing> {
    return this.#request('PATCH', `/missions/${missionId}/staffing`, body);
  }

  /** `null` clears the override. Refused with CONFLICT once the task has started. */
  patchTaskStaffing(taskId: string, body: TaskStaffingPatchRequest): Promise<TaskView> {
    return this.#request('PATCH', `/tasks/${taskId}/staffing`, body);
  }

  previewStaffing(taskId: string): Promise<StaffingPreviewView> {
    return this.#get(`/tasks/${taskId}/staffing/preview`);
  }

  // --------------------------------------------------------------- artifacts

  artifacts(query: { workspaceId?: string; q?: string; includeSuperseded?: boolean }): Promise<readonly ArtifactView[]> {
    return this.#get('/artifacts', query);
  }

  /** The manifest numbered along its versions, the body, and the appendix already split off. */
  artifact(id: string): Promise<ArtifactReadView> {
    return this.#get(`/artifacts/${id}`);
  }

  // --------------------------------------------------------------- approvals

  approvals(workspaceId?: string): Promise<readonly ApprovalView[]> {
    return this.#get('/approvals', { workspaceId });
  }

  decideApproval(id: string, body: DecideApprovalRequest): Promise<ApprovalView> {
    return this.#request('POST', `/approvals/${id}/decide`, body);
  }

  // ---------------------------------------------------------------- runtimes

  runtimes(workspaceId?: string): Promise<readonly RuntimeView[]> {
    return this.#get('/runtimes', { workspaceId });
  }

  discoverRuntimes(): Promise<readonly RuntimeDiscoveryView[]> {
    return this.#request('POST', '/runtimes/discover', {});
  }

  createRuntime(body: CreateRuntimeProfileRequest): Promise<RuntimeProfile> {
    return this.#request('POST', '/runtimes', body);
  }

  updateRuntime(id: string, body: Partial<CreateRuntimeProfileRequest>): Promise<RuntimeProfile> {
    return this.#request('PATCH', `/runtimes/${id}`, body);
  }

  deleteRuntime(id: string): Promise<void> {
    return this.#request('DELETE', `/runtimes/${id}`);
  }

  checkRuntimeHealth(id: string): Promise<RuntimeView> {
    return this.#request('POST', `/runtimes/${id}/health`, {});
  }

  // ------------------------------------------------------------------- roles

  roles(workspaceId?: string): Promise<readonly RoleTemplate[]> {
    return this.#get('/roles', { workspaceId });
  }

  upsertRole(id: string, body: UpsertRoleRequest): Promise<RoleTemplate> {
    return this.#request('PUT', `/roles/${id}`, body);
  }

  // --------------------------------------------------------------- workflows

  /** The project's own workflow files, then the built-in presets. */
  workflows(workspaceId: string): Promise<readonly WorkflowSummary[]> {
    return this.#get('/workflows', { workspaceId });
  }

  // ------------------------------------------------------------ integrations

  integrations(workspaceId?: string): Promise<readonly IntegrationView[]> {
    return this.#get('/integrations', { workspaceId });
  }

  createIntegration(body: CreateIntegrationRequest): Promise<IntegrationView> {
    return this.#request('POST', '/integrations', body);
  }

  updateIntegration(id: string, body: Record<string, unknown>): Promise<IntegrationView> {
    return this.#request('PATCH', `/integrations/${id}`, body);
  }

  deleteIntegration(id: string): Promise<void> {
    return this.#request('DELETE', `/integrations/${id}`);
  }

  connectors(): Promise<readonly ConnectorView[]> {
    return this.#get('/integrations/connectors');
  }

  /** Starts connecting an account. Open the returned `authorizationUrl` in the browser. */
  connectIntegration(body: ConnectIntegrationRequest): Promise<ConnectionAttemptView> {
    return this.#request('POST', '/integrations/connect', body);
  }

  connectionAttempt(attemptId: string): Promise<ConnectionAttemptView> {
    return this.#get(`/integrations/connect/${attemptId}`);
  }

  cancelConnection(attemptId: string): Promise<ConnectionAttemptView> {
    return this.#request('DELETE', `/integrations/connect/${attemptId}`);
  }

  // ---------------------------------------------------------------- settings

  settings(): Promise<DaemonSettings> {
    return this.#get('/settings');
  }

  updateSettings(body: Partial<DaemonSettings>): Promise<DaemonSettings> {
    return this.#request('PATCH', '/settings', body);
  }
}

/** Daemon-level preferences; distinct from per-workspace policy. */
export interface DaemonSettings {
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly home: string;
  readonly artifactRoot: string;
  readonly worktreeRoot: string;
  readonly telemetryEnabled: boolean;
  readonly updateChannel: 'stable' | 'beta';
  readonly developerMode: boolean;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toDaemonError(payload: unknown, status: number, fallbackText: string): DaemonError {
  const envelope = payload as Partial<ApiErrorBody> | undefined;
  const error = envelope?.error;
  if (error && typeof error.message === 'string') {
    return new DaemonError(error.code ?? 'INTERNAL', error.message, error.details ?? {}, error.retryable ?? false, status);
  }
  // A non-enveloped body means something in front of the daemon answered; say so
  // rather than pretending it was a domain error.
  return new DaemonError('INTERNAL', fallbackText.slice(0, 400) || `Request failed with status ${status}.`, {}, status >= 500, status);
}

export function describeError(error: unknown): { title: string; detail: string; retryable: boolean } {
  if (error instanceof DaemonError) {
    return { title: errorTitle(error.code), detail: error.message, retryable: error.retryable };
  }
  if (error instanceof DaemonUnreachableError) {
    return { title: 'Daemon unreachable', detail: error.message, retryable: true };
  }
  return { title: 'Something went wrong', detail: error instanceof Error ? error.message : String(error), retryable: true };
}

const ERROR_TITLES: Readonly<Record<string, string>> = {
  NOT_FOUND: 'Not found',
  CONFLICT: 'Conflicting change',
  VALIDATION: 'That request was not valid',
  PERMISSION_DENIED: 'Not permitted',
  APPROVAL_REQUIRED: 'Approval required',
  PRECONDITION_FAILED: 'Precondition failed',
  RUNTIME_UNAVAILABLE: 'Runtime unavailable',
  RUNTIME_FAILED: 'Runtime failed',
  TARGET_UNAVAILABLE: 'Execution target unavailable',
  INTEGRATION_FAILED: 'Integration failed',
  CANCELLED: 'Cancelled',
  TIMEOUT: 'Timed out',
  INTERNAL: 'Daemon error',
};

function errorTitle(code: string): string {
  return ERROR_TITLES[code] ?? 'Daemon error';
}
