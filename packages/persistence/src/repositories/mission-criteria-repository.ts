import { TandemiseError, asId, ids, type ArtifactId, type Clock, type CriterionId, type MissionId } from '@tandemise/shared';
import type {
  CriterionSource, CriterionStatus, MissionCriteriaRepositoryPort, MissionCriterion, SpecCriterionInput,
} from '@tandemise/domain';
import { CRITERION_STATEMENT_MAX, proposalKey, userCriterionKey } from '@tandemise/domain';
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
  status: string;
  refinement_artifact_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

const COLUMNS = 'id, mission_id, key, statement, source, covers, spec_artifact_id, position, superseded_at, created_at, '
  + 'status, refinement_artifact_id, decided_by, decided_at';

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
    status: r.status as CriterionStatus,
    refinementArtifactId: r.refinement_artifact_id === null ? null : asId<'ArtifactId'>(r.refinement_artifact_id),
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
  };
}

/** A row as the person's own lines are written: accepted, from nobody's refinement. */
const ACCEPTED = { status: 'accepted', refinement_artifact_id: null, decided_by: null, decided_at: null } as const;

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
  readonly #proposalCount;
  readonly #selectOne;
  readonly #selectUserRows;
  readonly #selectProposed;
  readonly #staleProposed;
  readonly #accept;
  readonly #reject;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    this.#insert = db.handle.prepare<CriterionRow>(
      `INSERT INTO mission_criteria (${COLUMNS}) VALUES (
        :id, :mission_id, :key, :statement, :source, :covers, :spec_artifact_id, :position, :superseded_at, :created_at,
        :status, :refinement_artifact_id, :decided_by, :decided_at)`,
    );
    // User first, then spec: the order a person reads a trace in.
    this.#selectActive = db.handle.prepare<{ missionId: string }, CriterionRow>(
      `SELECT ${COLUMNS} FROM mission_criteria
       WHERE mission_id = :missionId AND superseded_at IS NULL AND status = 'accepted'
       ORDER BY CASE source WHEN 'user' THEN 0 ELSE 1 END, position, created_at, id`,
    );
    this.#selectAll = db.handle.prepare<{ missionId: string }, CriterionRow>(
      `SELECT ${COLUMNS} FROM mission_criteria WHERE mission_id = :missionId ORDER BY created_at, position, id`,
    );
    this.#supersedeSpec = db.handle.prepare<{ missionId: string; at: string }>(
      `UPDATE mission_criteria SET superseded_at = :at
       WHERE mission_id = :missionId AND source = 'spec' AND superseded_at IS NULL`,
    );
    // The next U<n> follows the highest one ever given: proposals share the
    // `user` source but carry P keys until accepted, so a plain count would
    // skip or repeat numbers.
    this.#userCount = db.handle.prepare<{ missionId: string }, { n: number }>(
      `SELECT coalesce(max(CAST(substr(key, 2) AS INTEGER)), 0) AS n FROM mission_criteria
       WHERE mission_id = :missionId AND source = 'user' AND key GLOB 'U[0-9]*'`,
    );
    // P<n> is never reused, even after acceptance renamed the row: "P4" always means one proposal.
    this.#proposalCount = db.handle.prepare<{ missionId: string }, { n: number }>(
      `SELECT count(*) AS n FROM mission_criteria
       WHERE mission_id = :missionId AND (refinement_artifact_id IS NOT NULL OR key GLOB 'P[0-9]*')`,
    );
    this.#selectOne = db.handle.prepare<{ id: string }, CriterionRow>(`SELECT ${COLUMNS} FROM mission_criteria WHERE id = :id`);
    this.#selectUserRows = db.handle.prepare<{ missionId: string }, CriterionRow>(
      `SELECT ${COLUMNS} FROM mission_criteria WHERE mission_id = :missionId AND source = 'user' ORDER BY created_at, position, id`,
    );
    this.#selectProposed = db.handle.prepare<{ missionId: string }, CriterionRow>(
      `SELECT ${COLUMNS} FROM mission_criteria WHERE mission_id = :missionId AND status = 'proposed' ORDER BY position, created_at, id`,
    );
    this.#staleProposed = db.handle.prepare<{ missionId: string; at: string }>(
      `UPDATE mission_criteria SET status = 'stale', superseded_at = :at, decided_at = :at
       WHERE mission_id = :missionId AND status = 'proposed'`,
    );
    this.#accept = db.handle.prepare<{ id: string; key: string; statement: string; by: string; at: string; position: number }>(
      `UPDATE mission_criteria SET status = 'accepted', key = :key, statement = :statement, decided_by = :by, decided_at = :at, position = :position
       WHERE id = :id AND status = 'proposed'`,
    );
    // A rejected proposal leaves the live key space, like a superseded spec criterion.
    this.#reject = db.handle.prepare<{ id: string; by: string; at: string }>(
      `UPDATE mission_criteria SET status = 'rejected', superseded_at = :at, decided_by = :by, decided_at = :at
       WHERE id = :id AND status = 'proposed'`,
    );
  }

  get(id: CriterionId): MissionCriterion | undefined {
    const row = this.#selectOne.get({ id });
    return row === undefined ? undefined : fromRow(row);
  }

  listUserRows(missionId: MissionId): readonly MissionCriterion[] {
    return this.#selectUserRows.all({ missionId }).map(fromRow);
  }

  listProposed(missionId: MissionId): readonly MissionCriterion[] {
    return this.#selectProposed.all({ missionId }).map(fromRow);
  }

  propose(missionId: MissionId, refinementArtifactId: ArtifactId, statements: readonly string[]): readonly MissionCriterion[] {
    return this.#db.transaction(() => {
      const now = this.#clock.now();
      this.#staleProposed.run({ missionId, at: now });
      const offset = this.#proposalCount.get({ missionId })?.n ?? 0;
      const lines = statements.map(clampStatement).filter((s) => s.length > 0);
      return lines.map((statement, i) => this.#write({
        id: ids.criterion(), mission_id: missionId, key: proposalKey(offset + i), statement, source: 'user',
        covers: '[]', spec_artifact_id: null, position: offset + i, superseded_at: null, created_at: now,
        status: 'proposed', refinement_artifact_id: refinementArtifactId, decided_by: null, decided_at: null,
      }));
    });
  }

  decide(id: CriterionId, verdict: 'accept' | 'reject', options: { readonly statement?: string; readonly decidedBy: string }): MissionCriterion {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (current === undefined) throw TandemiseError.notFound('Criterion', id);
      if (current.status !== 'proposed') {
        throw new TandemiseError('CONFLICT', `${current.key} is already ${current.status}; only a proposed criterion can be accepted or rejected.`, {
          details: { criterionId: id, status: current.status },
        });
      }
      const now = this.#clock.now();
      if (verdict === 'reject') {
        this.#reject.run({ id, by: options.decidedBy, at: now });
      } else {
        const next = this.#userCount.get({ missionId: current.missionId })?.n ?? 0;
        const statement = options.statement === undefined ? current.statement : clampStatement(options.statement);
        if (statement.length === 0) throw TandemiseError.validation('A criterion needs a statement.');
        // Ordered by acceptance, after every line the person already has.
        this.#accept.run({ id, key: userCriterionKey(next), statement, by: options.decidedBy, at: now, position: next });
      }
      return this.get(id)!;
    });
  }

  listActive(missionId: MissionId): readonly MissionCriterion[] {
    return this.#selectActive.all({ missionId }).map(fromRow);
  }

  listAll(missionId: MissionId): readonly MissionCriterion[] {
    return this.#selectAll.all({ missionId }).map(fromRow);
  }

  addUserCriteria(missionId: MissionId, statements: readonly string[], addedBy?: string): readonly MissionCriterion[] {
    const lines = statements.map(clampStatement).filter((s) => s.length > 0);
    if (lines.length === 0) return [];
    return this.#db.transaction(() => {
      const offset = this.#userCount.get({ missionId })?.n ?? 0;
      const now = this.#clock.now();
      return lines.map((statement, i) => this.#write({
        id: ids.criterion(), mission_id: missionId, key: userCriterionKey(offset + i), statement, source: 'user',
        covers: '[]', spec_artifact_id: null, position: offset + i, superseded_at: null, created_at: now,
        ...ACCEPTED, ...(addedBy === undefined ? {} : { decided_by: addedBy, decided_at: now }),
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
        spec_artifact_id: specArtifactId, position: i, superseded_at: null, created_at: now, ...ACCEPTED,
      }));
    });
  }

  #write(row: CriterionRow): MissionCriterion {
    this.#insert.run(row);
    return fromRow(row);
  }
}
