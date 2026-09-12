import { TandemiseError, asId, type Clock, type WorkspaceId } from '@tandemise/shared';
import type {
  AutonomySettings, ConcurrencySettings, RoleRouting, Workspace, WorkspaceKnowledge,
  WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { DEFAULT_AUTONOMY, DEFAULT_CONCURRENCY, EMPTY_KNOWLEDGE } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';
import { applyPatch } from '../patch.js';

interface WorkspaceRow {
  id: string;
  name: string;
  default_repository_id: string | null;
  autonomy: string;
  concurrency: string;
  routing: string;
  default_autonomy_level: string;
  knowledge: string;
  created_at: string;
  updated_at: string;
}

function toRow(w: Workspace): WorkspaceRow {
  return {
    id: w.id,
    name: w.name,
    default_repository_id: w.defaultRepositoryId,
    autonomy: toJson(w.autonomy),
    concurrency: toJson(w.concurrency),
    routing: toJson(w.routing),
    default_autonomy_level: w.defaultAutonomyLevel,
    knowledge: toJson(w.knowledge),
    created_at: w.createdAt,
    updated_at: w.updatedAt,
  };
}

function fromRow(r: WorkspaceRow): Workspace {
  return {
    id: asId<'WorkspaceId'>(r.id),
    name: r.name,
    defaultRepositoryId: r.default_repository_id === null ? null : asId<'RepositoryId'>(r.default_repository_id),
    autonomy: parseJson<AutonomySettings>(r.autonomy, DEFAULT_AUTONOMY),
    concurrency: parseJson<ConcurrencySettings>(r.concurrency, DEFAULT_CONCURRENCY),
    routing: parseJson<RoleRouting>(r.routing, {}),
    defaultAutonomyLevel: r.default_autonomy_level as Workspace['defaultAutonomyLevel'],
    knowledge: parseJson<WorkspaceKnowledge>(r.knowledge, EMPTY_KNOWLEDGE),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS =
  'id, name, default_repository_id, autonomy, concurrency, routing, default_autonomy_level, knowledge, created_at, updated_at';

export class SqliteWorkspaceRepository implements WorkspaceRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #clock: Clock;
  readonly #insert;
  readonly #update;
  readonly #selectOne;
  readonly #selectAll;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    this.#insert = db.handle.prepare<WorkspaceRow>(
      `INSERT INTO workspaces (${COLUMNS}) VALUES (
        :id, :name, :default_repository_id, :autonomy, :concurrency, :routing,
        :default_autonomy_level, :knowledge, :created_at, :updated_at)`,
    );
    this.#update = db.handle.prepare<WorkspaceRow>(
      `UPDATE workspaces SET
         name = :name, default_repository_id = :default_repository_id, autonomy = :autonomy,
         concurrency = :concurrency, routing = :routing,
         default_autonomy_level = :default_autonomy_level, knowledge = :knowledge,
         updated_at = :updated_at
       WHERE id = :id`,
    );
    this.#selectOne = db.handle.prepare<{ id: string }, WorkspaceRow>(
      `SELECT ${COLUMNS} FROM workspaces WHERE id = :id`,
    );
    this.#selectAll = db.handle.prepare<[], WorkspaceRow>(
      `SELECT ${COLUMNS} FROM workspaces ORDER BY created_at, id`,
    );
  }

  create(workspace: Omit<Workspace, 'createdAt' | 'updatedAt'>): Workspace {
    const now = this.#clock.now();
    const entity: Workspace = { ...workspace, createdAt: now, updatedAt: now };
    this.#insert.run(toRow(entity));
    return entity;
  }

  get(id: WorkspaceId): Workspace | undefined {
    const row = this.#selectOne.get({ id });
    return row ? fromRow(row) : undefined;
  }

  list(): readonly Workspace[] {
    return this.#selectAll.all().map(fromRow);
  }

  update(id: WorkspaceId, patch: Partial<Omit<Workspace, 'id' | 'createdAt'>>): Workspace {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (!current) throw TandemiseError.notFound('Workspace', id);
      const next: Workspace = { ...applyPatch(current, patch), updatedAt: this.#clock.now() };
      this.#update.run(toRow(next));
      return next;
    });
  }
}
