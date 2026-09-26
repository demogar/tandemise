import { TandemiseError, asId, type SkillId, type WorkspaceId } from '@tandemise/shared';
import type { Skill, SkillFileEntry, SkillRepositoryPort, SkillSource, SkillVersion } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';

interface SkillRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  source: string;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  skill_id: string;
  version: number;
  hash: string;
  description: string;
  files: string;
  size_bytes: number;
  source: string;
  created_at: string;
}

const SKILL_COLUMNS = 'id, workspace_id, name, description, source, created_at, updated_at';
const VERSION_COLUMNS = 'id, skill_id, version, hash, description, files, size_bytes, source, created_at';
const NO_SOURCE: SkillSource = { kind: 'path', path: '' };

function toRow(s: Skill): SkillRow {
  return {
    id: s.id,
    workspace_id: s.workspaceId,
    name: s.name,
    description: s.description,
    source: toJson(s.source),
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

function fromRow(r: SkillRow): Skill {
  return {
    id: asId<'SkillId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    name: r.name,
    description: r.description,
    source: parseJson<SkillSource>(r.source, NO_SOURCE),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function versionFromRow(r: VersionRow): SkillVersion {
  return {
    id: asId<'SkillVersionId'>(r.id),
    skillId: asId<'SkillId'>(r.skill_id),
    version: r.version,
    hash: r.hash,
    description: r.description,
    files: parseJson<SkillFileEntry[]>(r.files, []),
    sizeBytes: r.size_bytes,
    source: parseJson<SkillSource>(r.source, NO_SOURCE),
    createdAt: r.created_at,
  };
}

/** The skills library (P13). Versions are append-only. */
export class SqliteSkillRepository implements SkillRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #insert;
  readonly #update;
  readonly #selectOne;
  readonly #selectByName;
  readonly #selectByWorkspace;
  readonly #delete;
  readonly #insertVersion;
  readonly #selectVersions;
  readonly #hashInUse;

  constructor(db: TandemiseDatabase) {
    this.#db = db;
    this.#insert = db.handle.prepare<SkillRow>(
      `INSERT INTO skills (${SKILL_COLUMNS}) VALUES (:id, :workspace_id, :name, :description, :source, :created_at, :updated_at)`,
    );
    this.#update = db.handle.prepare<SkillRow>(
      'UPDATE skills SET description = :description, source = :source, updated_at = :updated_at WHERE id = :id',
    );
    this.#selectOne = db.handle.prepare<{ id: string }, SkillRow>(`SELECT ${SKILL_COLUMNS} FROM skills WHERE id = :id`);
    this.#selectByName = db.handle.prepare<{ workspaceId: string; name: string }, SkillRow>(
      `SELECT ${SKILL_COLUMNS} FROM skills WHERE workspace_id = :workspaceId AND name = :name`,
    );
    this.#selectByWorkspace = db.handle.prepare<{ workspaceId: string }, SkillRow>(
      `SELECT ${SKILL_COLUMNS} FROM skills WHERE workspace_id = :workspaceId ORDER BY name COLLATE NOCASE, id`,
    );
    this.#delete = db.handle.prepare<{ id: string }>('DELETE FROM skills WHERE id = :id');
    this.#insertVersion = db.handle.prepare<VersionRow>(
      `INSERT INTO skill_versions (${VERSION_COLUMNS})
       VALUES (:id, :skill_id, :version, :hash, :description, :files, :size_bytes, :source, :created_at)`,
    );
    this.#selectVersions = db.handle.prepare<{ skillId: string }, VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM skill_versions WHERE skill_id = :skillId ORDER BY version`,
    );
    this.#hashInUse = db.handle.prepare<{ hash: string }, { n: number }>(
      'SELECT COUNT(*) AS n FROM skill_versions WHERE hash = :hash',
    );
  }

  create(skill: Skill): Skill {
    this.#insert.run(toRow(skill));
    return skill;
  }

  get(id: SkillId): Skill | undefined {
    const row = this.#selectOne.get({ id });
    return row ? fromRow(row) : undefined;
  }

  getByName(workspaceId: WorkspaceId, name: string): Skill | undefined {
    const row = this.#selectByName.get({ workspaceId, name });
    return row ? fromRow(row) : undefined;
  }

  list(workspaceId: WorkspaceId): readonly Skill[] {
    return this.#selectByWorkspace.all({ workspaceId }).map(fromRow);
  }

  update(id: SkillId, patch: Partial<Pick<Skill, 'description' | 'source' | 'updatedAt'>>): Skill {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (current === undefined) throw TandemiseError.notFound('Skill', id);
      const next: Skill = { ...current, ...patch };
      this.#update.run(toRow(next));
      return next;
    });
  }

  remove(id: SkillId): void {
    this.#delete.run({ id });
  }

  addVersion(version: SkillVersion): SkillVersion {
    this.#insertVersion.run({
      id: version.id,
      skill_id: version.skillId,
      version: version.version,
      hash: version.hash,
      description: version.description,
      files: toJson(version.files),
      size_bytes: version.sizeBytes,
      source: toJson(version.source),
      created_at: version.createdAt,
    });
    return version;
  }

  versions(skillId: SkillId): readonly SkillVersion[] {
    return this.#selectVersions.all({ skillId }).map(versionFromRow);
  }

  hashInUse(hash: string): boolean {
    return (this.#hashInUse.get({ hash })?.n ?? 0) > 0;
  }
}
