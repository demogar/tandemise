import type {
  ApprovalId, ArtifactId, EventId, MissionId, RepositoryId, RunId, RuntimeProfileId,
  ExecutionTargetId, IntegrationId, TaskId, Timestamp, WorkerAssignmentId, WorkspaceId,
} from '@tandemise/shared';
import type { Mission, MissionDraft, MissionProgress, MissionStatus } from '../entities/mission.js';
import type { MissionTask, TaskStatus } from '../entities/task.js';
import type { Run, RunStatus, RunUsage, Checkpoint } from '../entities/run.js';
import type { ArtifactManifest, ArtifactType } from '../entities/artifact.js';
import type { Approval, ApprovalStatus } from '../entities/approval.js';
import type { Repository, Workspace } from '../entities/workspace.js';
import type { RoleTemplate } from '../entities/role.js';
import type { RuntimeProfile } from '../entities/runtime.js';
import type { ExecutionTargetRecord, ResourceLease, TargetStatus } from '../entities/target.js';
import type { Integration } from '../entities/integration.js';
import type { WorkerAssignment } from '../entities/assignment.js';
import type { RunEventRecord, TandemiseEventBody } from '../event.js';
import type { Decision } from '../entities/decision.js';
import type { CheckResult, Evaluation } from '../entities/evaluation.js';

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
  search(workspaceId: WorkspaceId, query: string, limit?: number): readonly ArtifactManifest[];
  markSuperseded(id: ArtifactId, by: ArtifactId): void;
}

export interface ApprovalRepositoryPort {
  create(approval: Approval): Approval;
  get(id: ApprovalId): Approval | undefined;
  list(filter?: { workspaceId?: WorkspaceId; missionId?: MissionId; statuses?: readonly ApprovalStatus[] }): readonly Approval[];
  update(id: ApprovalId, patch: Partial<Omit<Approval, 'id' | 'createdAt'>>): Approval;
  pendingForTask(taskId: TaskId): readonly Approval[];
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

/** A single transactional boundary across the repositories above. */
export interface UnitOfWork {
  transaction<T>(fn: () => T): T;
}
