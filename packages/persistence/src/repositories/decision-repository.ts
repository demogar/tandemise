import { TandemiseError, asId, type ArtifactId, type MissionId, type WorkspaceId } from '@tandemise/shared';
import type { Decision, DecisionAlternative, DecisionRepositoryPort } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';
import { applyPatch } from '../patch.js';

interface DecisionRow {
  id: string;
  workspace_id: string;
  mission_id: string | null;
  title: string;
  context: string;
  decision: string;
  rationale: string;
  alternatives: string;
  consequences: string;
  status: string;
  owner: string;
  related_artifacts: string;
  supersedes: string | null;
  created_at: string;
  decided_at: string | null;
}

function toRow(d: Decision): DecisionRow {
  return {
    id: d.id,
    workspace_id: d.workspaceId,
    mission_id: d.missionId,
    title: d.title,
    context: d.context,
    decision: d.decision,
    rationale: d.rationale,
    alternatives: toJson(d.alternatives),
    consequences: toJson(d.consequences),
    status: d.status,
    owner: d.owner,
    related_artifacts: toJson(d.relatedArtifacts),
    supersedes: d.supersedes,
    created_at: d.createdAt,
    decided_at: d.decidedAt,
  };
}

function fromRow(r: DecisionRow): Decision {
  return {
    id: asId<'DecisionId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    missionId: r.mission_id === null ? null : asId<'MissionId'>(r.mission_id),
    title: r.title,
    context: r.context,
    decision: r.decision,
    rationale: r.rationale,
    alternatives: parseJson<readonly DecisionAlternative[]>(r.alternatives, []),
    consequences: parseJson<readonly string[]>(r.consequences, []),
    status: r.status as Decision['status'],
    owner: r.owner,
    relatedArtifacts: parseJson<readonly ArtifactId[]>(r.related_artifacts, []),
    supersedes: r.supersedes === null ? null : asId<'DecisionId'>(r.supersedes),
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

const COLUMNS = `id, workspace_id, mission_id, title, context, decision, rationale,
  alternatives, consequences, status, owner, related_artifacts, supersedes,
  created_at, decided_at`;

export class SqliteDecisionRepository implements DecisionRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #insert;
  readonly #update;
  readonly #selectOne;
  readonly #selectByMission;
  readonly #selectByWorkspace;

  constructor(db: TandemiseDatabase) {
    this.#db = db;
    this.#insert = db.handle.prepare<DecisionRow>(
      `INSERT INTO decisions (${COLUMNS}) VALUES (
        :id, :workspace_id, :mission_id, :title, :context, :decision, :rationale,
        :alternatives, :consequences, :status, :owner, :related_artifacts, :supersedes,
        :created_at, :decided_at)`,
    );
    this.#update = db.handle.prepare<DecisionRow>(
      `UPDATE decisions SET
         mission_id = :mission_id, title = :title, context = :context, decision = :decision,
         rationale = :rationale, alternatives = :alternatives, consequences = :consequences,
         status = :status, owner = :owner, related_artifacts = :related_artifacts,
         supersedes = :supersedes, decided_at = :decided_at
       WHERE id = :id`,
    );
    this.#selectOne = db.handle.prepare<{ id: string }, DecisionRow>(
      `SELECT ${COLUMNS} FROM decisions WHERE id = :id`,
    );
    this.#selectByMission = db.handle.prepare<{ missionId: string }, DecisionRow>(
      `SELECT ${COLUMNS} FROM decisions WHERE mission_id = :missionId ORDER BY created_at, id`,
    );
    this.#selectByWorkspace = db.handle.prepare<{ workspaceId: string }, DecisionRow>(
      `SELECT ${COLUMNS} FROM decisions WHERE workspace_id = :workspaceId ORDER BY created_at DESC, id DESC`,
    );
  }

  create(decision: Decision): Decision {
    this.#insert.run(toRow(decision));
    return decision;
  }

  get(id: string): Decision | undefined {
    const row = this.#selectOne.get({ id });
    return row ? fromRow(row) : undefined;
  }

  listByMission(missionId: MissionId): readonly Decision[] {
    return this.#selectByMission.all({ missionId }).map(fromRow);
  }

  listByWorkspace(workspaceId: WorkspaceId): readonly Decision[] {
    return this.#selectByWorkspace.all({ workspaceId }).map(fromRow);
  }

  update(id: string, patch: Partial<Decision>): Decision {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (!current) throw TandemiseError.notFound('Decision', id);
      // `id`, `workspaceId` and `createdAt` are in `Partial<Decision>` but the
      // UPDATE deliberately does not set them: a decision record that can be
      // re-homed or back-dated is not a record.
      const next = applyPatch(current, patch);
      this.#update.run(toRow(next));
      return { ...next, id: current.id, workspaceId: current.workspaceId, createdAt: current.createdAt };
    });
  }
}
