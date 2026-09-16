import type {
  ApprovalId, ArtifactId, EventId, FeedbackId, MemberId, MissionId, PersonId, RepositoryId, RunId, RuntimeProfileId,
  ExecutionTargetId, IntegrationId, TaskId, Timestamp, WorkerAssignmentId, WorkspaceId,
} from '@tandemise/shared';
import type { Mission, MissionDraft, MissionProgress, MissionStatus } from '../entities/mission.js';
import type { MissionTask, TaskStatus } from '../entities/task.js';
import type { Run, RunStatus, RunUsage, Checkpoint } from '../entities/run.js';
import type { ArtifactManifest, ArtifactType } from '../entities/artifact.js';
import type { Approval, ApprovalStatus } from '../entities/approval.js';
import type { Repository, Workspace } from '../entities/workspace.js';
import type { Member, Person } from '../entities/member.js';
import type { RoleTemplate } from '../entities/role.js';
import type { RuntimeProfile } from '../entities/runtime.js';
import type { ExecutionTargetRecord, ResourceLease, TargetStatus } from '../entities/target.js';
import type { Integration } from '../entities/integration.js';
import type { WorkerAssignment } from '../entities/assignment.js';
import type { RunEventRecord, TandemiseEventBody } from '../event.js';
import type { Decision } from '../entities/decision.js';
import type { CheckResult, Evaluation } from '../entities/evaluation.js';
import type { FeedbackItem, FeedbackStatus } from '../entities/feedback.js';

/**
 * Persistence ports.
 *
 * These are the only database-shaped contracts the application layer knows
 * about. The SQLite implementation lives outward in `@tandemise/persistence`
 * and is bound by the composition root, which is what keeps the mission engine
 * testable against an in-memory double and free of SQL (MVP.md §6.1).
 */

export interface WorkspaceRepositoryPort {
  create(workspace: Omit<Workspace, 'createdAt' | 'updatedAt'>): Workspace;
  get(id: WorkspaceId): Workspace | undefined;
  list(): readonly Workspace[];
  update(id: WorkspaceId, patch: Partial<Omit<Workspace, 'id' | 'createdAt'>>): Workspace;
}

/** People are global to the installation; removal is a timestamp so history keeps its names. */
export interface PersonRepositoryPort {
  create(p: Omit<Person, 'createdAt' | 'removedAt'>): Person;
  get(id: PersonId): Person | undefined;
  list(options?: { includeRemoved?: boolean }): readonly Person[];
  update(id: PersonId, patch: Partial<Pick<Person, 'displayName' | 'handles' | 'accountId' | 'removedAt'>>): Person;
}

export interface MemberRepositoryPort {
  create(m: Omit<Member, 'createdAt' | 'updatedAt'>): Member;
  get(id: MemberId): Member | undefined;
  listByWorkspace(workspaceId: WorkspaceId, options?: { includeRemoved?: boolean }): readonly Member[];
  findPersonMember(workspaceId: WorkspaceId, personId: PersonId): Member | undefined;
  update(id: MemberId, patch: Partial<Omit<Member, 'id' | 'workspaceId' | 'kind' | 'createdAt'>>): Member;
}

export interface RepoRepositoryPort {
  create(repo: Omit<Repository, 'createdAt' | 'updatedAt'>): Repository;
  get(id: RepositoryId): Repository | undefined;
  listByWorkspace(workspaceId: WorkspaceId): readonly Repository[];
  update(id: RepositoryId, patch: Partial<Omit<Repository, 'id' | 'workspaceId' | 'createdAt'>>): Repository;
  remove(id: RepositoryId): void;
}

export interface MissionRepositoryPort {
  create(draft: MissionDraft & { id: MissionId }): Mission;
  get(id: MissionId): Mission | undefined;
  list(filter?: { workspaceId?: WorkspaceId; statuses?: readonly MissionStatus[]; limit?: number }): readonly Mission[];
  update(id: MissionId, patch: Partial<Omit<Mission, 'id' | 'workspaceId' | 'createdAt'>>): Mission;
  progress(id: MissionId): MissionProgress;
  remove(id: MissionId): void;
}

export interface TaskRepositoryPort {
  replaceAll(missionId: MissionId, tasks: readonly MissionTask[]): readonly MissionTask[];
  add(task: MissionTask): MissionTask;
  get(id: TaskId): MissionTask | undefined;
  getByKey(missionId: MissionId, key: string): MissionTask | undefined;
  listByMission(missionId: MissionId): readonly MissionTask[];
  update(id: TaskId, patch: Partial<Omit<MissionTask, 'id' | 'missionId' | 'createdAt'>>): MissionTask;
  /** Tasks in the given statuses across all missions - used by the scheduler. */
  listByStatus(statuses: readonly TaskStatus[]): readonly MissionTask[];
}

export interface RunRepositoryPort {
  create(run: Run): Run;
  get(id: RunId): Run | undefined;
  listByTask(taskId: TaskId): readonly Run[];
  listByMission(missionId: MissionId): readonly Run[];
  listByStatus(statuses: readonly RunStatus[]): readonly Run[];
  update(id: RunId, patch: Partial<Omit<Run, 'id' | 'taskId' | 'startedAt'>>): Run;
  recordUsage(id: RunId, usage: RunUsage): void;
  heartbeat(id: RunId, at: Timestamp): void;
}

export interface EventRepositoryPort {
  /** Returns the persisted record, including its assigned monotonic sequence. */
  append(input: {
    id: EventId;
    workspaceId: WorkspaceId;
    missionId: MissionId;
    taskId?: TaskId | null;
    runId?: RunId | null;
    roleId?: string | null;
    runtimeProfileId?: string | null;
    body: TandemiseEventBody;
    createdAt: Timestamp;
    actorId?: string | null;
  }): RunEventRecord;
  listByMission(missionId: MissionId, opts?: { afterSequence?: number; limit?: number; semanticOnly?: boolean }): readonly RunEventRecord[];
  listByRun(runId: RunId, opts?: { afterSequence?: number; limit?: number }): readonly RunEventRecord[];
  latestSequence(missionId: MissionId): number;
}

export interface ArtifactRepositoryPort {
  create(manifest: ArtifactManifest): ArtifactManifest;
  get(id: ArtifactId): ArtifactManifest | undefined;
  listByMission(missionId: MissionId, type?: ArtifactType): readonly ArtifactManifest[];
  listByTask(taskId: TaskId): readonly ArtifactManifest[];
  /** Most recent non-superseded artifact of a type on a mission. */
  latest(missionId: MissionId, type: ArtifactType): ArtifactManifest | undefined;
  /** Current versions only unless `includeSuperseded`: a search that returns every revision buries the live one. */
  search(workspaceId: WorkspaceId, query: string, limit?: number, options?: { includeSuperseded?: boolean }): readonly ArtifactManifest[];
  /** The workspace's artifacts, newest first; superseded versions are left out unless `includeSuperseded`. */
  listRecent(workspaceId: WorkspaceId, limit: number, options?: { includeSuperseded?: boolean }): readonly ArtifactManifest[];
  markSuperseded(id: ArtifactId, by: ArtifactId): void;
  /**
   * Sets aside the output of a pass that was overtaken before it was judged:
   * every list above leaves it out from now on (`get` still returns it), and
   * the versions it had replaced are live again.
   */
  withdraw(ids: readonly ArtifactId[], at: Timestamp): void;
}

export interface ApprovalRepositoryPort {
  create(approval: Approval): Approval;
  get(id: ApprovalId): Approval | undefined;
  list(filter?: { workspaceId?: WorkspaceId; missionId?: MissionId; statuses?: readonly ApprovalStatus[] }): readonly Approval[];
  update(id: ApprovalId, patch: Partial<Omit<Approval, 'id' | 'createdAt'>>): Approval;
  pendingForTask(taskId: TaskId): readonly Approval[];
  /** PENDING approvals whose `escalateAt` is at or before `at`: the escalation sweep's whole read. */
  dueForEscalation(at: Timestamp): readonly Approval[];
}

export interface RoleRepositoryPort {
  upsert(role: RoleTemplate): RoleTemplate;
  get(id: string, workspaceId: WorkspaceId | null): RoleTemplate | undefined;
  list(workspaceId: WorkspaceId | null): readonly RoleTemplate[];
  remove(id: string, workspaceId: WorkspaceId): void;
}

export interface RuntimeProfileRepositoryPort {
  create(profile: RuntimeProfile): RuntimeProfile;
  get(id: RuntimeProfileId): RuntimeProfile | undefined;
  list(workspaceId?: WorkspaceId | null): readonly RuntimeProfile[];
  update(id: RuntimeProfileId, patch: Partial<Omit<RuntimeProfile, 'id' | 'createdAt'>>): RuntimeProfile;
  remove(id: RuntimeProfileId): void;
}

export interface ExecutionTargetRepositoryPort {
  create(target: ExecutionTargetRecord): ExecutionTargetRecord;
  get(id: ExecutionTargetId): ExecutionTargetRecord | undefined;
  listByMission(missionId: MissionId): readonly ExecutionTargetRecord[];
  listByStatus(statuses: readonly TargetStatus[]): readonly ExecutionTargetRecord[];
  update(id: ExecutionTargetId, patch: Partial<Omit<ExecutionTargetRecord, 'id' | 'createdAt'>>): ExecutionTargetRecord;
}

export interface IntegrationRepositoryPort {
  create(integration: Integration): Integration;
  get(id: IntegrationId): Integration | undefined;
  listByWorkspace(workspaceId: WorkspaceId): readonly Integration[];
  update(id: IntegrationId, patch: Partial<Omit<Integration, 'id' | 'createdAt'>>): Integration;
  remove(id: IntegrationId): void;
}

export interface AssignmentRepositoryPort {
  create(assignment: WorkerAssignment): WorkerAssignment;
  get(id: WorkerAssignmentId): WorkerAssignment | undefined;
  listByTask(taskId: TaskId): readonly WorkerAssignment[];
}

export interface DecisionRepositoryPort {
  create(decision: Decision): Decision;
  get(id: string): Decision | undefined;
  listByMission(missionId: MissionId): readonly Decision[];
  listByWorkspace(workspaceId: WorkspaceId): readonly Decision[];
  update(id: string, patch: Partial<Decision>): Decision;
}

export interface EvaluationRepositoryPort {
  createEvaluation(evaluation: Evaluation): Evaluation;
  listEvaluations(taskId: TaskId): readonly Evaluation[];
  recordCheck(check: CheckResult): CheckResult;
  listChecks(taskId: TaskId): readonly CheckResult[];
  /** One row per check name - the newest measurement. What a person is shown. */
  latestChecksForTask(taskId: TaskId): readonly CheckResult[];
  latestChecks(missionId: MissionId): readonly CheckResult[];
}

export interface CheckpointRepositoryPort {
  append(checkpoint: Checkpoint): Checkpoint;
  latest(runId: RunId): Checkpoint | undefined;
  list(runId: RunId): readonly Checkpoint[];
}

/**
 * Exclusive resource claims. `acquire` returns undefined rather than throwing
 * when the resource is held - contention is an ordinary scheduling outcome, not
 * an error.
 */
export interface LeaseRepositoryPort {
  acquire(resourceKey: string, holder: { runId?: RunId | null; taskId?: TaskId | null }, ttlMs: number): ResourceLease | undefined;
  renew(id: string, ttlMs: number): boolean;
  release(id: string): void;
  releaseByRun(runId: RunId): void;
  listExpired(now: Timestamp): readonly ResourceLease[];
  listAll(): readonly ResourceLease[];
}

export interface FeedbackRepositoryPort {
  create(item: FeedbackItem): FeedbackItem;
  get(id: FeedbackId): FeedbackItem | undefined;
  /** Oldest first. */
  listByTask(taskId: TaskId): readonly FeedbackItem[];
  /** Oldest first, through mission_tasks: one read for a whole feed. */
  listByMission(missionId: MissionId): readonly FeedbackItem[];
  listByStatus(statuses: readonly FeedbackStatus[]): readonly FeedbackItem[];
  /** Stamps `updatedAt`. */
  update(id: FeedbackId, patch: Partial<Pick<FeedbackItem, 'status' | 'round'>>): FeedbackItem;
}

/**
 * What a run actually saw, from the context compiler's `includedArtifactIds`.
 * Downstream impact is read from this rather than guessed from the plan
 * (spec §3); runs from before migration 010 have no rows here.
 */
export interface RunInputRepositoryPort {
  /** Idempotent: a run records what it was given once, and a restart may record it again. */
  record(runId: RunId, artifactIds: readonly ArtifactId[]): void;
  listByRun(runId: RunId): readonly ArtifactId[];
  listByMission(missionId: MissionId): readonly { readonly runId: RunId; readonly artifactId: ArtifactId }[];
}

/** A single transactional boundary across the repositories above. */
export interface UnitOfWork {
  transaction<T>(fn: () => T): T;
}
