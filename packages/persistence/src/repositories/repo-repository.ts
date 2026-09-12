import { TandemiseError, asId, type Clock, type RepositoryId, type WorkspaceId } from '@tandemise/shared';
import type { RepoRepositoryPort, Repository, RepositoryChecks } from '@tandemise/domain';
import { NO_CHECKS } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';
import { applyPatch } from '../patch.js';

interface RepoRow {
  id: string;
  workspace_id: string;
  name: string;
  path: string;
  default_branch: string;
  remote_url: string | null;
  checks: string;
  created_at: string;
  updated_at: string;
}

function toRow(r: Repository): RepoRow {
  return {
    id: r.id,
    workspace_id: r.workspaceId,
    name: r.name,
    path: r.path,
    default_branch: r.defaultBranch,
    remote_url: r.remoteUrl,
    checks: toJson(r.checks),
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

function fromRow(r: RepoRow): Repository {
  return {
    id: asId<'RepositoryId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    name: r.name,
    path: r.path,
    defaultBranch: r.default_branch,
    remoteUrl: r.remote_url,
    checks: parseJson<RepositoryChecks>(r.checks, NO_CHECKS),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS = 'id, workspace_id, name, path, default_branch, remote_url, checks, created_at, updated_at';

export class SqliteRepoRepository implements RepoRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #clock: Clock;
  readonly #insert;
  readonly #update;
  readonly #selectOne;
  readonly #selectByWorkspace;
  readonly #delete;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    this.#insert = db.handle.prepare<RepoRow>(
      `INSERT INTO repositories (${COLUMNS}) VALUES (
        :id, :workspace_id, :name, :path, :default_branch, :remote_url, :checks, :created_at, :updated_at)`,
    );
    this.#update = db.handle.prepare<RepoRow>(
      `UPDATE repositories SET
         name = :name, path = :path, default_branch = :default_branch, remote_url = :remote_url,
         checks = :checks, updated_at = :updated_at
       WHERE id = :id`,
    );
    this.#selectOne = db.handle.prepare<{ id: string }, RepoRow>(
      `SELECT ${COLUMNS} FROM repositories WHERE id = :id`,
    );
    this.#selectByWorkspace = db.handle.prepare<{ workspaceId: string }, RepoRow>(
      `SELECT ${COLUMNS} FROM repositories WHERE workspace_id = :workspaceId ORDER BY name, id`,
    );
    this.#delete = db.handle.prepare<{ id: string }>('DELETE FROM repositories WHERE id = :id');
  }

  create(repo: Omit<Repository, 'createdAt' | 'updatedAt'>): Repository {
    const now = this.#clock.now();
    const entity: Repository = { ...repo, createdAt: now, updatedAt: now };
    this.#insert.run(toRow(entity));
    return entity;
  }

  get(id: RepositoryId): Repository | undefined {
    const row = this.#selectOne.get({ id });
    return row ? fromRow(row) : undefined;
  }

  listByWorkspace(workspaceId: WorkspaceId): readonly Repository[] {
    return this.#selectByWorkspace.all({ workspaceId }).map(fromRow);
  }

  update(
    id: RepositoryId,
    patch: Partial<Omit<Repository, 'id' | 'workspaceId' | 'createdAt'>>,
  ): Repository {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (!current) throw TandemiseError.notFound('Repository', id);
      const next: Repository = { ...applyPatch(current, patch), updatedAt: this.#clock.now() };
      this.#update.run(toRow(next));
      return next;
    });
  }

  remove(id: RepositoryId): void {
    this.#delete.run({ id });
  }
}
