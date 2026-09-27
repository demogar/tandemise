import { TandemiseError, asId, type Clock, type MissionId, type WorkspaceId } from '@tandemise/shared';
import type {
  AutonomyLevel, Limit, Mission, MissionDraft, MissionPriority, MissionProgress, MissionRepositoryPort, MissionStatus, RoleStaffing,
} from '@tandemise/domain';
import { DEFAULT_MISSION_PRIORITY, REPORT_HOLDER_PRESET } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';
import { applyPatch } from '../patch.js';

interface MissionRow {
  id: string;
  workspace_id: string;
  repository_id: string | null;
  title: string;
  goal: string;
  constraints: string;
  success_criteria: string;
  status: string;
  autonomy: string;
  workflow_preset: string;
  workflow_inputs: string;
  integration_branch: string | null;
  base_branch: string | null;
  status_reason: string | null;
  created_by: string | null;
  staffing: string;
  priority: string;
  rank: number;
  queued_at: string | null;
  limits: string | null;
  routine_id: string | null;
  issue_link_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface ProgressRow {
  total: number;
  completed: number;
  running: number;
  blocked: number;
  failed: number;
  pending_approvals: number;
}

/**
 * A mission with no preset still needs one; `standard` is the planner's default
 * workflow. Stored rather than resolved at read time so that changing the
 * default later does not silently re-shape missions already in flight.
 */
const DEFAULT_WORKFLOW_PRESET = 'standard';
const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = 'balanced';

function toRow(m: Mission): MissionRow {
  return {
    id: m.id,
    workspace_id: m.workspaceId,
    repository_id: m.repositoryId,
    title: m.title,
    goal: m.goal,
    constraints: toJson(m.constraints),
    success_criteria: toJson(m.successCriteria),
    status: m.status,
    autonomy: m.autonomy,
    workflow_preset: m.workflowPreset,
    workflow_inputs: toJson(m.workflowInputs),
    integration_branch: m.integrationBranch,
    base_branch: m.baseBranch,
    status_reason: m.statusReason,
    created_by: m.createdBy ?? null,
    staffing: toJson(m.staffing ?? {}),
    priority: m.priority,
    rank: m.rank,
    queued_at: m.queuedAt,
    limits: m.limits === null || m.limits === undefined ? null : toJson(m.limits),
    routine_id: m.routineId ?? null,
    issue_link_id: m.issueLinkId ?? null,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    started_at: m.startedAt,
    completed_at: m.completedAt,
  };
}

function fromRow(r: MissionRow): Mission {
  return {
    id: asId<'MissionId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    repositoryId: r.repository_id === null ? null : asId<'RepositoryId'>(r.repository_id),
    title: r.title,
    goal: r.goal,
    constraints: parseJson<readonly string[]>(r.constraints, []),
    successCriteria: parseJson<readonly string[]>(r.success_criteria, []),
    status: r.status as MissionStatus,
    autonomy: r.autonomy as AutonomyLevel,
    workflowPreset: r.workflow_preset,
    workflowInputs: parseJson<Readonly<Record<string, string>>>(r.workflow_inputs, {}),
    integrationBranch: r.integration_branch,
    baseBranch: r.base_branch,
    statusReason: r.status_reason,
    createdBy: r.created_by,
    staffing: parseJson<RoleStaffing>(r.staffing, {}),
    priority: r.priority as MissionPriority,
    rank: r.rank,
    queuedAt: r.queued_at,
    limits: r.limits === null ? null : parseJson<readonly Limit[]>(r.limits, []),
    routineId: r.routine_id === null ? null : asId<'RoutineId'>(r.routine_id),
    issueLinkId: r.issue_link_id === null ? null : asId<'IssueLinkId'>(r.issue_link_id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}

const COLUMNS = `id, workspace_id, repository_id, title, goal, constraints, success_criteria,
  status, autonomy, workflow_preset, workflow_inputs, integration_branch, base_branch, status_reason,
  created_by, staffing, priority, rank, queued_at, limits, routine_id, issue_link_id, created_at, updated_at, started_at, completed_at`;

export class SqliteMissionRepository implements MissionRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #clock: Clock;
  readonly #insert;
  readonly #update;
  readonly #selectOne;
  readonly #selectList;
  readonly #selectProgress;
  readonly #delete;
  readonly #lastRank;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    this.#insert = db.handle.prepare<MissionRow>(
      `INSERT INTO missions (${COLUMNS}) VALUES (
        :id, :workspace_id, :repository_id, :title, :goal, :constraints, :success_criteria,
        :status, :autonomy, :workflow_preset, :workflow_inputs, :integration_branch, :base_branch, :status_reason,
        :created_by, :staffing, :priority, :rank, :queued_at, :limits, :routine_id, :issue_link_id, :created_at, :updated_at, :started_at, :completed_at)`,
    );
    this.#update = db.handle.prepare<MissionRow>(
      `UPDATE missions SET
         repository_id = :repository_id, title = :title, goal = :goal, constraints = :constraints,
         success_criteria = :success_criteria, status = :status, autonomy = :autonomy,
         workflow_preset = :workflow_preset, workflow_inputs = :workflow_inputs,
         integration_branch = :integration_branch,
         base_branch = :base_branch, status_reason = :status_reason, created_by = :created_by, staffing = :staffing,
         priority = :priority, rank = :rank, queued_at = :queued_at, limits = :limits, routine_id = :routine_id, issue_link_id = :issue_link_id,
         updated_at = :updated_at,
         started_at = :started_at, completed_at = :completed_at
       WHERE id = :id`,
    );
    this.#selectOne = db.handle.prepare<{ id: string }, MissionRow>(
      `SELECT ${COLUMNS} FROM missions WHERE id = :id`,
    );
    // One statement covers every filter combination: a NULL parameter disables
    // its clause, and the status set arrives as a JSON array so the placeholder
    // count - and therefore the prepared statement - never varies.
    // A project's report holder (P10) is never listed: it holds status reports,
    // it is not work, so no count, backlog, liveness or scheduler pass sees it.
    this.#selectList = db.handle.prepare<
      { workspaceId: string | null; statuses: string | null; limit: number | null; holder: string },
      MissionRow
    >(
      `SELECT ${COLUMNS} FROM missions
       WHERE (:workspaceId IS NULL OR workspace_id = :workspaceId)
         AND workflow_preset <> :holder
         AND (:statuses IS NULL OR status IN (SELECT value FROM json_each(:statuses)))
       ORDER BY created_at DESC, id DESC
       LIMIT COALESCE(:limit, -1)`,
    );
    this.#selectProgress = db.handle.prepare<{ missionId: string }, ProgressRow>(
      `SELECT
         COUNT(*)                                                          AS total,
         COALESCE(SUM(status IN ('SUCCEEDED','SKIPPED')), 0)               AS completed,
         COALESCE(SUM(status = 'RUNNING'), 0)                              AS running,
         COALESCE(SUM(status = 'BLOCKED'), 0)                              AS blocked,
         COALESCE(SUM(status = 'FAILED'), 0)                               AS failed,
         (SELECT COUNT(*) FROM approvals
           WHERE mission_id = :missionId AND status = 'PENDING')           AS pending_approvals
       FROM mission_tasks
       WHERE mission_id = :missionId`,
    );
    this.#delete = db.handle.prepare<{ id: string }>('DELETE FROM missions WHERE id = :id');
    this.#lastRank = db.handle.prepare<{ workspaceId: string }, { rank: number | null }>(
      'SELECT MAX(rank) AS rank FROM missions WHERE workspace_id = :workspaceId',
    );
  }

  create(draft: MissionDraft & { id: MissionId }): Mission {
    const now = this.#clock.now();
    const mission: Mission = {
      id: draft.id,
      workspaceId: draft.workspaceId,
      repositoryId: draft.repositoryId,
      title: draft.title,
      goal: draft.goal,
      constraints: draft.constraints ?? [],
      successCriteria: draft.successCriteria ?? [],
      workflowInputs: draft.workflowInputs ?? {},
      status: 'DRAFT',
      autonomy: draft.autonomy ?? DEFAULT_AUTONOMY_LEVEL,
      workflowPreset: draft.workflowPreset ?? DEFAULT_WORKFLOW_PRESET,
      integrationBranch: null,
      baseBranch: draft.baseBranch ?? null,
      statusReason: null,
      createdBy: draft.createdBy ?? null,
      staffing: draft.staffing ?? {},
      priority: draft.priority ?? DEFAULT_MISSION_PRIORITY,
      // Last in the project unless told otherwise: without any reordering the
      // backlog is first come, first served within a priority.
      rank: draft.rank ?? (this.#lastRank.get({ workspaceId: draft.workspaceId })?.rank ?? 0) + 1,
      queuedAt: draft.queued === true ? now : null,
      limits: draft.limits ?? null,
      routineId: draft.routineId ?? null,
      issueLinkId: draft.issueLinkId ?? null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    };
    this.#insert.run(toRow(mission));
    return mission;
  }

  get(id: MissionId): Mission | undefined {
    const row = this.#selectOne.get({ id });
    return row ? fromRow(row) : undefined;
  }

  list(
    filter?: { workspaceId?: WorkspaceId; statuses?: readonly MissionStatus[]; limit?: number },
  ): readonly Mission[] {
    return this.#selectList
      .all({
        workspaceId: filter?.workspaceId ?? null,
        statuses: filter?.statuses && filter.statuses.length > 0 ? toJson(filter.statuses) : null,
        limit: filter?.limit ?? null,
        holder: REPORT_HOLDER_PRESET,
      })
      .map(fromRow);
  }

  update(id: MissionId, patch: Partial<Omit<Mission, 'id' | 'workspaceId' | 'createdAt'>>): Mission {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (!current) throw TandemiseError.notFound('Mission', id);
      const next: Mission = { ...applyPatch(current, patch), updatedAt: this.#clock.now() };
      this.#update.run(toRow(next));
      return next;
    });
  }

  /**
   * Counters are computed, never stored, so they cannot drift from the task
   * rows they summarize. SKIPPED counts as completed because a skipped task
   * will never finish any other way - excluding it leaves a progress bar that
   * can never reach 100%.
   */
  progress(id: MissionId): MissionProgress {
    const row = this.#selectProgress.get({ missionId: id });
    if (!row) {
      // Unreachable: an aggregate over zero rows still returns one row. Kept so
      // the optional from `.get()` is narrowed without a non-null assertion.
      return { totalTasks: 0, completed: 0, running: 0, blocked: 0, failed: 0, pendingApprovals: 0 };
    }
    return {
      totalTasks: row.total,
      completed: row.completed,
      running: row.running,
      blocked: row.blocked,
      failed: row.failed,
      pendingApprovals: row.pending_approvals,
    };
  }

  remove(id: MissionId): void {
    this.#delete.run({ id });
  }
}
