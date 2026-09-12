import {
  TandemiseError, asId, type ArtifactId, type MissionId, type TaskId, type WorkspaceId,
} from '@tandemise/shared';
import type {
  ArtifactManifest, ArtifactRepositoryPort, ArtifactType, ExternalRef,
} from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { toJson } from '../json.js';

interface ArtifactRow {
  id: string;
  workspace_id: string;
  mission_id: string;
  task_id: string | null;
  created_by_run_id: string | null;
  type: string;
  title: string;
  content_ref: string;
  media_type: string;
  sha256: string;
  byte_size: number;
  schema_version: number;
  supersedes: string | null;
  summary: string | null;
  created_at: string;
}

interface LinkRow {
  artifact_id: string;
  ordinal: number;
  kind: string;
  value: string;
  label: string | null;
}

const COLUMN_LIST = [
  'id', 'workspace_id', 'mission_id', 'task_id', 'created_by_run_id', 'type', 'title',
  'content_ref', 'media_type', 'sha256', 'byte_size', 'schema_version', 'supersedes',
  'summary', 'created_at',
] as const;

const COLUMNS = COLUMN_LIST.join(', ');
const A_COLUMNS = COLUMN_LIST.map((c) => `a.${c}`).join(', ');

const DEFAULT_SEARCH_LIMIT = 20;

function toRow(a: ArtifactManifest): ArtifactRow {
  return {
    id: a.id,
    workspace_id: a.workspaceId,
    mission_id: a.missionId,
    task_id: a.taskId,
    created_by_run_id: a.createdByRunId,
    type: a.type,
    title: a.title,
    content_ref: a.contentRef,
    media_type: a.mediaType,
    sha256: a.sha256,
    byte_size: a.byteSize,
    schema_version: a.schemaVersion,
    supersedes: a.supersedes,
    summary: a.summary,
    created_at: a.createdAt,
  };
}

function fromRow(r: ArtifactRow, sourceRefs: readonly ExternalRef[]): ArtifactManifest {
  return {
    id: asId<'ArtifactId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    missionId: asId<'MissionId'>(r.mission_id),
    taskId: r.task_id === null ? null : asId<'TaskId'>(r.task_id),
    createdByRunId: r.created_by_run_id === null ? null : asId<'RunId'>(r.created_by_run_id),
    type: r.type as ArtifactType,
    title: r.title,
    contentRef: r.content_ref,
    mediaType: r.media_type,
    sha256: r.sha256,
    byteSize: r.byte_size,
    schemaVersion: r.schema_version,
    sourceRefs,
    supersedes: r.supersedes === null ? null : asId<'ArtifactId'>(r.supersedes),
    summary: r.summary,
    createdAt: r.created_at,
  };
}

/**
 * Turns free text into a safe FTS5 MATCH expression.
 *
 * User input must never reach FTS5 as syntax: an unbalanced quote or a stray
 * `NEAR` would throw rather than return no results. Terms are reduced to
 * letters and digits and then quoted, and the last one gets a prefix match so
 * search-as-you-type finds `onboarding` while the user is still typing `onboa`.
 */
function toMatchExpression(query: string): string | undefined {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!terms || terms.length === 0) return undefined;
  return terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(' ');
}

export class SqliteArtifactRepository implements ArtifactRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #insert;
  readonly #insertLink;
  readonly #deleteLinks;
  readonly #selectLinks;
  readonly #selectOne;
  readonly #selectByMission;
  readonly #selectByTask;
  readonly #selectLatest;
  readonly #search;
  readonly #markSuperseded;

  constructor(db: TandemiseDatabase) {
    this.#db = db;
    this.#insert = db.handle.prepare<ArtifactRow>(
      `INSERT INTO artifacts (${COLUMNS}) VALUES (
        :id, :workspace_id, :mission_id, :task_id, :created_by_run_id, :type, :title,
        :content_ref, :media_type, :sha256, :byte_size, :schema_version, :supersedes,
        :summary, :created_at)`,
    );
    this.#insertLink = db.handle.prepare<{
      artifactId: string; ordinal: number; kind: string; value: string; label: string | null;
    }>(
      `INSERT INTO artifact_links (artifact_id, ordinal, kind, value, label)
       VALUES (:artifactId, :ordinal, :kind, :value, :label)`,
    );
    this.#deleteLinks = db.handle.prepare<{ artifactId: string }>(
      'DELETE FROM artifact_links WHERE artifact_id = :artifactId',
    );
    this.#selectLinks = db.handle.prepare<{ ids: string }, LinkRow>(
      `SELECT artifact_id, ordinal, kind, value, label FROM artifact_links
       WHERE artifact_id IN (SELECT value FROM json_each(:ids))
       ORDER BY artifact_id, ordinal`,
    );
    this.#selectOne = db.handle.prepare<{ id: string }, ArtifactRow>(
      `SELECT ${COLUMNS} FROM artifacts WHERE id = :id`,
    );
    this.#selectByMission = db.handle.prepare<{ missionId: string; type: string | null }, ArtifactRow>(
      `SELECT ${COLUMNS} FROM artifacts
       WHERE mission_id = :missionId AND (:type IS NULL OR type = :type)
       ORDER BY created_at DESC, id DESC`,
    );
    this.#selectByTask = db.handle.prepare<{ taskId: string }, ArtifactRow>(
      `SELECT ${COLUMNS} FROM artifacts WHERE task_id = :taskId ORDER BY created_at DESC, id DESC`,
    );
    this.#selectLatest = db.handle.prepare<{ missionId: string; type: string }, ArtifactRow>(
      `SELECT ${COLUMNS} FROM artifacts
       WHERE mission_id = :missionId AND type = :type AND superseded_by IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    );
    this.#search = db.handle.prepare<{ match: string; workspaceId: string; limit: number }, ArtifactRow>(
      `SELECT ${A_COLUMNS} FROM artifacts_fts
       JOIN artifacts a ON a.rowid = artifacts_fts.rowid
       WHERE artifacts_fts MATCH :match AND a.workspace_id = :workspaceId
       ORDER BY bm25(artifacts_fts), a.created_at DESC
       LIMIT :limit`,
    );
    this.#markSuperseded = db.handle.prepare<{ id: string; by: string }>(
      'UPDATE artifacts SET superseded_by = :by WHERE id = :id',
    );
  }

  /**
   * Writing a manifest that declares `supersedes` also sets the back-pointer on
   * the artifact it replaces. The two are the same fact seen from either end,
   * and letting them disagree is how `latest` starts returning stale work.
   */
  create(manifest: ArtifactManifest): ArtifactManifest {
    return this.#db.transaction(() => {
      this.#insert.run(toRow(manifest));
      this.#writeLinks(manifest.id, manifest.sourceRefs);
      if (manifest.supersedes !== null) {
        this.#markSuperseded.run({ id: manifest.supersedes, by: manifest.id });
      }
      return manifest;
    });
  }

  get(id: ArtifactId): ArtifactManifest | undefined {
    const row = this.#selectOne.get({ id });
    return row ? fromRow(row, this.#linksFor([row.id]).get(row.id) ?? []) : undefined;
  }

  listByMission(missionId: MissionId, type?: ArtifactType): readonly ArtifactManifest[] {
    return this.#hydrate(this.#selectByMission.all({ missionId, type: type ?? null }));
  }

  listByTask(taskId: TaskId): readonly ArtifactManifest[] {
    return this.#hydrate(this.#selectByTask.all({ taskId }));
  }

  latest(missionId: MissionId, type: ArtifactType): ArtifactManifest | undefined {
    const row = this.#selectLatest.get({ missionId, type });
    return row ? fromRow(row, this.#linksFor([row.id]).get(row.id) ?? []) : undefined;
  }

  search(workspaceId: WorkspaceId, query: string, limit = DEFAULT_SEARCH_LIMIT): readonly ArtifactManifest[] {
    const match = toMatchExpression(query);
    if (match === undefined) return [];
    return this.#hydrate(this.#search.all({ match, workspaceId, limit }));
  }

  markSuperseded(id: ArtifactId, by: ArtifactId): void {
    const result = this.#markSuperseded.run({ id, by });
    if (result.changes === 0) throw TandemiseError.notFound('Artifact', id);
  }

  #writeLinks(artifactId: string, refs: readonly ExternalRef[]): void {
    this.#deleteLinks.run({ artifactId });
    refs.forEach((ref, ordinal) =>
      this.#insertLink.run({
        artifactId,
        ordinal,
        kind: ref.kind,
        value: ref.value,
        label: ref.label ?? null,
      }),
    );
  }

  #hydrate(rows: readonly ArtifactRow[]): readonly ArtifactManifest[] {
    if (rows.length === 0) return [];
    const links = this.#linksFor(rows.map((r) => r.id));
    return rows.map((r) => fromRow(r, links.get(r.id) ?? []));
  }

  #linksFor(ids: readonly string[]): Map<string, ExternalRef[]> {
    const byArtifact = new Map<string, ExternalRef[]>();
    for (const row of this.#selectLinks.all({ ids: toJson(ids) })) {
      const ref: ExternalRef =
        row.label === null
          ? { kind: row.kind as ExternalRef['kind'], value: row.value }
          : { kind: row.kind as ExternalRef['kind'], value: row.value, label: row.label };
      const list = byArtifact.get(row.artifact_id);
      if (list) list.push(ref);
      else byArtifact.set(row.artifact_id, [ref]);
    }
    return byArtifact;
  }
}
