import { TandemiseError, asId, type ExecutionTargetId, type MissionId } from '@tandemise/shared';
import type {
  ExecutionTargetRecord, ExecutionTargetRepositoryPort, TargetKind, TargetStatus,
} from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { toJson } from '../json.js';
import { applyPatch } from '../patch.js';

interface TargetRow {
  id: string;
  workspace_id: string;
  mission_id: string | null;
  task_id: string | null;
  kind: string;
  name: string;
  working_directory: string;
  branch: string | null;
  base_branch: string | null;
  status: string;
  detail: string | null;
  created_at: string;
  released_at: string | null;
}

function toRow(t: ExecutionTargetRecord): TargetRow {
  return {
    id: t.id,
    workspace_id: t.workspaceId,
    mission_id: t.missionId,
    task_id: t.taskId,
    kind: t.kind,
    name: t.name,
    working_directory: t.workingDirectory,
    branch: t.branch,
    base_branch: t.baseBranch,
    status: t.status,
    detail: t.detail,
    created_at: t.createdAt,
    released_at: t.releasedAt,
  };
}

function fromRow(r: TargetRow): ExecutionTargetRecord {
  return {
    id: asId<'ExecutionTargetId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    missionId: r.mission_id === null ? null : asId<'MissionId'>(r.mission_id),
    taskId: r.task_id === null ? null : asId<'TaskId'>(r.task_id),
    kind: r.kind as TargetKind,
    name: r.name,
    workingDirectory: r.working_directory,
    branch: r.branch,
    baseBranch: r.base_branch,
    status: r.status as TargetStatus,
    detail: r.detail,
    createdAt: r.created_at,
    releasedAt: r.released_at,
  };
}

const COLUMNS = `id, workspace_id, mission_id, task_id, kind, name, working_directory,
  branch, base_branch, status, detail, created_at, released_at`;

export class SqliteExecutionTargetRepository implements ExecutionTargetRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #insert;
  readonly #update;
  readonly #selectOne;
  readonly #selectByMission;
  readonly #selectByStatus;

  constructor(db: TandemiseDatabase) {
    this.#db = db;
    this.#insert = db.handle.prepare<TargetRow>(
      `INSERT INTO execution_targets (${COLUMNS}) VALUES (
        :id, :workspace_id, :mission_id, :task_id, :kind, :name, :working_directory,
        :branch, :base_branch, :status, :detail, :created_at, :released_at)`,
    );
    this.#update = db.handle.prepare<TargetRow>(
      `UPDATE execution_targets SET
         workspace_id = :workspace_id, mission_id = :mission_id, task_id = :task_id,
         kind = :kind, name = :name, working_directory = :working_directory, branch = :branch,
         base_branch = :base_branch, status = :status, detail = :detail, released_at = :released_at
       WHERE id = :id`,
    );
    this.#selectOne = db.handle.prepare<{ id: string }, TargetRow>(
      `SELECT ${COLUMNS} FROM execution_targets WHERE id = :id`,
    );
    this.#selectByMission = db.handle.prepare<{ missionId: string }, TargetRow>(
      `SELECT ${COLUMNS} FROM execution_targets WHERE mission_id = :missionId ORDER BY created_at, id`,
    );
    this.#selectByStatus = db.handle.prepare<{ statuses: string }, TargetRow>(
      `SELECT ${COLUMNS} FROM execution_targets
       WHERE status IN (SELECT value FROM json_each(:statuses))
       ORDER BY created_at, id`,
    );
  }

  create(target: ExecutionTargetRecord): ExecutionTargetRecord {
    this.#insert.run(toRow(target));
    return target;
  }

  get(id: ExecutionTargetId): ExecutionTargetRecord | undefined {
    const row = this.#selectOne.get({ id });
    return row ? fromRow(row) : undefined;
  }

  listByMission(missionId: MissionId): readonly ExecutionTargetRecord[] {
    return this.#selectByMission.all({ missionId }).map(fromRow);
  }

  listByStatus(statuses: readonly TargetStatus[]): readonly ExecutionTargetRecord[] {
    if (statuses.length === 0) return [];
    return this.#selectByStatus.all({ statuses: toJson(statuses) }).map(fromRow);
  }

  update(
    id: ExecutionTargetId,
    patch: Partial<Omit<ExecutionTargetRecord, 'id' | 'createdAt'>>,
  ): ExecutionTargetRecord {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (!current) throw TandemiseError.notFound('ExecutionTarget', id);
      const next = applyPatch(current, patch);
      this.#update.run(toRow(next));
      return next;
    });
  }
}
