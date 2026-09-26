import { asId, ids, type ArtifactId, type Clock, type MissionId } from '@tandemise/shared';
import type {
  CriterionSource, MissionCriteriaRepositoryPort, MissionCriterion, SpecCriterionInput,
} from '@tandemise/domain';
import { CRITERION_STATEMENT_MAX, userCriterionKey } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';

interface CriterionRow {
  id: string;
  mission_id: string;
  key: string;
  statement: string;
  source: string;
  covers: string;
  spec_artifact_id: string | null;
  position: number;
  superseded_at: string | null;
  created_at: string;
}

const COLUMNS = 'id, mission_id, key, statement, source, covers, spec_artifact_id, position, superseded_at, created_at';

function fromRow(r: CriterionRow): MissionCriterion {
  return {
    id: asId<'CriterionId'>(r.id),
    missionId: asId<'MissionId'>(r.mission_id),
    key: r.key,
    statement: r.statement,
    source: r.source as CriterionSource,
    covers: parseJson<readonly string[]>(r.covers, []),
    specArtifactId: r.spec_artifact_id === null ? null : asId<'ArtifactId'>(r.spec_artifact_id),
    position: r.position,
    supersededAt: r.superseded_at,
    createdAt: r.created_at,
  };
}

/**
 * A statement is quoted into prompts and shown in a checklist; one past the
 * column's limit is cut rather than refused, because the text came from a
 * person's form or a spec that was otherwise valid.
 */
function clampStatement(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= CRITERION_STATEMENT_MAX ? trimmed : `${trimmed.slice(0, CRITERION_STATEMENT_MAX - 1)}…`;
}

export class SqliteMissionCriteriaRepository implements MissionCriteriaRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #clock: Clock;
  readonly #insert;
  readonly #selectActive;
  readonly #selectAll;
  readonly #supersedeSpec;
  readonly #userCount;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    this.#insert = db.handle.prepare<CriterionRow>(
      `INSERT INTO mission_criteria (${COLUMNS}) VALUES (
        :id, :mission_id, :key, :statement, :source, :covers, :spec_artifact_id, :position, :superseded_at, :created_at)`,
    );
    // User first, then spec: the order a person reads a trace in.
    this.#selectActive = db.handle.prepare<{ missionId: string }, CriterionRow>(
      `SELECT ${COLUMNS} FROM mission_criteria
       WHERE mission_id = :missionId AND superseded_at IS NULL
       ORDER BY CASE source WHEN 'user' THEN 0 ELSE 1 END, position, created_at, id`,
    );
    this.#selectAll = db.handle.prepare<{ missionId: string }, CriterionRow>(
      `SELECT ${COLUMNS} FROM mission_criteria WHERE mission_id = :missionId ORDER BY created_at, position, id`,
    );
    this.#supersedeSpec = db.handle.prepare<{ missionId: string; at: string }>(
      `UPDATE mission_criteria SET superseded_at = :at
       WHERE mission_id = :missionId AND source = 'spec' AND superseded_at IS NULL`,
    );
    this.#userCount = db.handle.prepare<{ missionId: string }, { n: number }>(
      "SELECT count(*) AS n FROM mission_criteria WHERE mission_id = :missionId AND source = 'user'",
    );
  }

  listActive(missionId: MissionId): readonly MissionCriterion[] {
    return this.#selectActive.all({ missionId }).map(fromRow);
  }

  listAll(missionId: MissionId): readonly MissionCriterion[] {
    return this.#selectAll.all({ missionId }).map(fromRow);
  }

  addUserCriteria(missionId: MissionId, statements: readonly string[]): readonly MissionCriterion[] {
    const lines = statements.map(clampStatement).filter((s) => s.length > 0);
    if (lines.length === 0) return [];
    return this.#db.transaction(() => {
      const offset = this.#userCount.get({ missionId })?.n ?? 0;
      const now = this.#clock.now();
      return lines.map((statement, i) => this.#write({
        id: ids.criterion(), mission_id: missionId, key: userCriterionKey(offset + i), statement, source: 'user',
        covers: '[]', spec_artifact_id: null, position: offset + i, superseded_at: null, created_at: now,
      }));
    });
  }

  replaceSpecCriteria(missionId: MissionId, specArtifactId: ArtifactId, criteria: readonly SpecCriterionInput[]): readonly MissionCriterion[] {
    return this.#db.transaction(() => {
      const now = this.#clock.now();
      this.#supersedeSpec.run({ missionId, at: now });
      return criteria.map((c, i) => this.#write({
        id: ids.criterion(), mission_id: missionId, key: c.key.trim(), statement: clampStatement(c.statement), source: 'spec',
        covers: toJson([...new Set(c.covers.map((k) => k.trim()).filter((k) => k.length > 0))]),
        spec_artifact_id: specArtifactId, position: i, superseded_at: null, created_at: now,
      }));
    });
  }

  #write(row: CriterionRow): MissionCriterion {
    this.#insert.run(row);
    return fromRow(row);
  }
}
