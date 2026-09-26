import { TandemiseError, asId, ids, type Clock, type RoutineId, type Timestamp, type WorkspaceId } from '@tandemise/shared';
import type {
  Limit, MissionPriority, Routine, RoutineDraft, RoutineKind, RoutineOutcome, RoutineRepositoryPort, RoutineRun,
  RoutineSchedule, RoutineTrigger,
} from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';
import { applyPatch } from '../patch.js';

interface RoutineRow {
  id: string;
  workspace_id: string;
  name: string;
  kind: string;
  goal: string;
  success_criteria: string;
  priority: string;
  limits: string | null;
  workflow_preset: string | null;
  schedule: string;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_outcome: string | null;
  last_detail: string | null;
  last_mission_id: string | null;
  last_artifact_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  routine_id: string;
  trigger: string;
  scheduled_for: string | null;
  ran_at: string;
  outcome: string;
  detail: string;
  skipped_count: number;
  mission_id: string | null;
  artifact_id: string | null;
}

const COLUMNS = `id, workspace_id, name, kind, goal, success_criteria, priority, limits, workflow_preset, schedule,
  enabled, next_run_at, last_run_at, last_outcome, last_detail, last_mission_id, last_artifact_id, created_by, created_at, updated_at`;

function toRow(r: Routine): RoutineRow {
  return {
    id: r.id,
    workspace_id: r.workspaceId,
    name: r.name,
    kind: r.kind,
    goal: r.goal,
    success_criteria: toJson(r.successCriteria),
    priority: r.priority,
    limits: r.limits === null ? null : toJson(r.limits),
    workflow_preset: r.workflowPreset,
    schedule: toJson(r.schedule),
    enabled: r.enabled ? 1 : 0,
    next_run_at: r.nextRunAt,
    last_run_at: r.lastRunAt,
    last_outcome: r.lastOutcome,
    last_detail: r.lastDetail,
    last_mission_id: r.lastMissionId,
    last_artifact_id: r.lastArtifactId,
    created_by: r.createdBy,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

function fromRow(r: RoutineRow): Routine {
  return {
    id: asId<'RoutineId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    name: r.name,
    kind: r.kind as RoutineKind,
    goal: r.goal,
    successCriteria: parseJson<readonly string[]>(r.success_criteria, []),
    priority: r.priority as MissionPriority,
    limits: r.limits === null ? null : parseJson<readonly Limit[]>(r.limits, []),
    workflowPreset: r.workflow_preset,
    schedule: parseJson<RoutineSchedule>(r.schedule, { type: 'daily', at: '09:00' }),
    enabled: r.enabled === 1,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastOutcome: r.last_outcome as RoutineOutcome | null,
    lastDetail: r.last_detail,
    lastMissionId: r.last_mission_id === null ? null : asId<'MissionId'>(r.last_mission_id),
    lastArtifactId: r.last_artifact_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function runFromRow(r: RunRow): RoutineRun {
  return {
    id: asId<'RoutineRunId'>(r.id),
    routineId: asId<'RoutineId'>(r.routine_id),
    trigger: r.trigger as RoutineTrigger,
    scheduledFor: r.scheduled_for,
    ranAt: r.ran_at,
    outcome: r.outcome as RoutineOutcome,
    detail: r.detail,
    skippedCount: r.skipped_count,
    missionId: r.mission_id === null ? null : asId<'MissionId'>(r.mission_id),
    artifactId: r.artifact_id,
  };
}

/** Routines and their run notes (P11). */
export class SqliteRoutineRepository implements RoutineRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #clock: Clock;
  readonly #insert;
  readonly #update;
  readonly #selectOne;
  readonly #selectByWorkspace;
  readonly #selectDue;
  readonly #claim;
  readonly #delete;
  readonly #insertRun;
  readonly #selectRuns;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    this.#insert = db.handle.prepare<RoutineRow>(
      `INSERT INTO routines (${COLUMNS}) VALUES (:id, :workspace_id, :name, :kind, :goal, :success_criteria, :priority,
        :limits, :workflow_preset, :schedule, :enabled, :next_run_at, :last_run_at, :last_outcome, :last_detail,
        :last_mission_id, :last_artifact_id, :created_by, :created_at, :updated_at)`,
    );
    this.#update = db.handle.prepare<RoutineRow>(
      `UPDATE routines SET name = :name, kind = :kind, goal = :goal, success_criteria = :success_criteria,
         priority = :priority, limits = :limits, workflow_preset = :workflow_preset, schedule = :schedule,
         enabled = :enabled, next_run_at = :next_run_at, last_run_at = :last_run_at, last_outcome = :last_outcome,
         last_detail = :last_detail, last_mission_id = :last_mission_id, last_artifact_id = :last_artifact_id,
         created_by = :created_by, updated_at = :updated_at
       WHERE id = :id`,
    );
    this.#selectOne = db.handle.prepare<{ id: string }, RoutineRow>(`SELECT ${COLUMNS} FROM routines WHERE id = :id`);
    this.#selectByWorkspace = db.handle.prepare<{ workspaceId: string }, RoutineRow>(
      `SELECT ${COLUMNS} FROM routines WHERE workspace_id = :workspaceId ORDER BY created_at, id`,
    );
    // ISO-8601 UTC strings of one width compare in time order, so the index does the work.
    this.#selectDue = db.handle.prepare<{ now: string }, RoutineRow>(
      `SELECT ${COLUMNS} FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= :now
        ORDER BY next_run_at, id`,
    );
    this.#claim = db.handle.prepare<{ id: string; from: string; to: string; now: string }>(
      `UPDATE routines SET next_run_at = :to, updated_at = :now
        WHERE id = :id AND enabled = 1 AND next_run_at = :from`,
    );
    this.#delete = db.handle.prepare<{ id: string }>('DELETE FROM routines WHERE id = :id');
    this.#insertRun = db.handle.prepare<RunRow>(
      `INSERT INTO routine_runs (id, routine_id, trigger, scheduled_for, ran_at, outcome, detail, skipped_count, mission_id, artifact_id)
       VALUES (:id, :routine_id, :trigger, :scheduled_for, :ran_at, :outcome, :detail, :skipped_count, :mission_id, :artifact_id)`,
    );
    this.#selectRuns = db.handle.prepare<{ routineId: string; limit: number }, RunRow>(
      `SELECT id, routine_id, trigger, scheduled_for, ran_at, outcome, detail, skipped_count, mission_id, artifact_id
         FROM routine_runs WHERE routine_id = :routineId ORDER BY ran_at DESC, rowid DESC LIMIT :limit`,
    );
  }

  create(draft: RoutineDraft): Routine {
    const now = this.#clock.now();
    const routine: Routine = {
      ...draft,
      id: ids.routine(),
      lastRunAt: null,
      lastOutcome: null,
      lastDetail: null,
      lastMissionId: null,
      lastArtifactId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#insert.run(toRow(routine));
    return routine;
  }

  get(id: RoutineId): Routine | undefined {
    const row = this.#selectOne.get({ id });
    return row ? fromRow(row) : undefined;
  }

  list(workspaceId: WorkspaceId): readonly Routine[] {
    return this.#selectByWorkspace.all({ workspaceId }).map(fromRow);
  }

  listDue(now: Timestamp): readonly Routine[] {
    return this.#selectDue.all({ now }).map(fromRow);
  }

  update(id: RoutineId, patch: Partial<Omit<Routine, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt'>>): Routine {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (current === undefined) throw TandemiseError.notFound('Routine', id);
      const next: Routine = { ...applyPatch(current, patch), updatedAt: this.#clock.now() };
      this.#update.run(toRow(next));
      return next;
    });
  }

  claim(id: RoutineId, from: Timestamp, to: Timestamp): boolean {
    return this.#claim.run({ id, from, to, now: this.#clock.now() }).changes === 1;
  }

  remove(id: RoutineId): void {
    this.#delete.run({ id });
  }

  recordRun(run: Omit<RoutineRun, 'id'>): RoutineRun {
    const recorded: RoutineRun = { ...run, id: ids.routineRun() };
    this.#insertRun.run({
      id: recorded.id,
      routine_id: recorded.routineId,
      trigger: recorded.trigger,
      scheduled_for: recorded.scheduledFor,
      ran_at: recorded.ranAt,
      outcome: recorded.outcome,
      detail: recorded.detail,
      skipped_count: recorded.skippedCount,
      mission_id: recorded.missionId,
      artifact_id: recorded.artifactId,
    });
    return recorded;
  }

  recentRuns(id: RoutineId, limit: number): readonly RoutineRun[] {
    return this.#selectRuns.all({ routineId: id, limit }).map(runFromRow);
  }
}
