import { TandemiseError, asId, type Clock, type RuntimeProfileId, type WorkspaceId } from '@tandemise/shared';
import type { RuntimeCapability, RuntimeProfile, RuntimeProfileRepositoryPort } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { fromSqlBool, parseJson, toJson, toSqlBool } from '../json.js';
import { applyPatch } from '../patch.js';

interface ProfileRow {
  id: string;
  workspace_id: string | null;
  adapter_id: string;
  name: string;
  executable_path: string | null;
  args: string;
  settings: string;
  capabilities: string;
  enabled: number;
  max_concurrent: number;
  created_at: string;
  updated_at: string;
}

function toRow(p: RuntimeProfile): ProfileRow {
  return {
    id: p.id,
    workspace_id: p.workspaceId,
    adapter_id: p.adapterId,
    name: p.name,
    executable_path: p.executablePath,
    args: toJson(p.args),
    settings: toJson(p.settings),
    capabilities: toJson(p.capabilities),
    enabled: toSqlBool(p.enabled),
    max_concurrent: p.maxConcurrent,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

function fromRow(r: ProfileRow): RuntimeProfile {
  return {
    id: asId<'RuntimeProfileId'>(r.id),
    workspaceId: r.workspace_id === null ? null : asId<'WorkspaceId'>(r.workspace_id),
    adapterId: r.adapter_id,
    name: r.name,
    executablePath: r.executable_path,
    args: parseJson<readonly string[]>(r.args, []),
    settings: parseJson<Readonly<Record<string, unknown>>>(r.settings, {}),
    capabilities: parseJson<readonly RuntimeCapability[]>(r.capabilities, []),
    enabled: fromSqlBool(r.enabled),
    maxConcurrent: r.max_concurrent,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS = `id, workspace_id, adapter_id, name, executable_path, args, settings,
  capabilities, enabled, max_concurrent, created_at, updated_at`;

export class SqliteRuntimeProfileRepository implements RuntimeProfileRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #clock: Clock;
  readonly #insert;
  readonly #update;
  readonly #selectOne;
  readonly #selectList;
  readonly #delete;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    this.#insert = db.handle.prepare<ProfileRow>(
      `INSERT INTO runtime_profiles (${COLUMNS}) VALUES (
        :id, :workspace_id, :adapter_id, :name, :executable_path, :args, :settings,
        :capabilities, :enabled, :max_concurrent, :created_at, :updated_at)`,
    );
    this.#update = db.handle.prepare<ProfileRow>(
      `UPDATE runtime_profiles SET
         workspace_id = :workspace_id, adapter_id = :adapter_id, name = :name,
         executable_path = :executable_path, args = :args, settings = :settings,
         capabilities = :capabilities, enabled = :enabled, max_concurrent = :max_concurrent,
         updated_at = :updated_at
       WHERE id = :id`,
    );
    this.#selectOne = db.handle.prepare<{ id: string }, ProfileRow>(
      `SELECT ${COLUMNS} FROM runtime_profiles WHERE id = :id`,
    );
    // `all = 1` ignores scope entirely; otherwise global profiles are always
    // visible and the workspace's own are added on top.
    this.#selectList = db.handle.prepare<{ all: 0 | 1; workspaceId: string | null }, ProfileRow>(
      `SELECT ${COLUMNS} FROM runtime_profiles
       WHERE :all = 1 OR workspace_id IS NULL OR workspace_id = :workspaceId
       ORDER BY name, id`,
    );
    this.#delete = db.handle.prepare<{ id: string }>('DELETE FROM runtime_profiles WHERE id = :id');
  }

  create(profile: RuntimeProfile): RuntimeProfile {
    this.#insert.run(toRow(profile));
    return profile;
  }

  get(id: RuntimeProfileId): RuntimeProfile | undefined {
    const row = this.#selectOne.get({ id });
    return row ? fromRow(row) : undefined;
  }

  /**
   * Omitting the argument lists every profile (the settings screen); passing
   * `null` lists only the global ones; passing a workspace lists the globals
   * plus that workspace's own, which is what routing resolves against.
   */
  list(workspaceId?: WorkspaceId | null): readonly RuntimeProfile[] {
    return this.#selectList
      .all({ all: workspaceId === undefined ? 1 : 0, workspaceId: workspaceId ?? null })
      .map(fromRow);
  }

  update(
    id: RuntimeProfileId,
    patch: Partial<Omit<RuntimeProfile, 'id' | 'createdAt'>>,
  ): RuntimeProfile {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (!current) throw TandemiseError.notFound('RuntimeProfile', id);
      const next: RuntimeProfile = { ...applyPatch(current, patch), updatedAt: this.#clock.now() };
      this.#update.run(toRow(next));
      return next;
    });
  }

  remove(id: RuntimeProfileId): void {
    this.#delete.run({ id });
  }
}
