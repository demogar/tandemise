import {
  TandemiseError, asId, type ApprovalId, type MissionId, type TaskId, type WorkspaceId,
} from '@tandemise/shared';
import type {
  Approval, ApprovalEvidence, ApprovalKind, ApprovalOption, ApprovalRepositoryPort, ApprovalStatus,
  RiskClass,
} from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';
import { applyPatch } from '../patch.js';

interface ApprovalRow {
  id: string;
  workspace_id: string;
  mission_id: string | null;
  task_id: string | null;
  run_id: string | null;
  kind: string;
  status: string;
  risk: string;
  title: string;
  rationale: string;
  effect: string;
  evidence: string;
  options: string;
  recommended_option_id: string | null;
  selected_option_id: string | null;
  decided_by: string | null;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
  expires_at: string | null;
}

function toRow(a: Approval): ApprovalRow {
  return {
    id: a.id,
    workspace_id: a.workspaceId,
    mission_id: a.missionId,
    task_id: a.taskId,
    run_id: a.runId,
    kind: a.kind,
    status: a.status,
    risk: a.risk,
    title: a.title,
    rationale: a.rationale,
    effect: a.effect,
    evidence: toJson(a.evidence),
    options: toJson(a.options),
    recommended_option_id: a.recommendedOptionId,
    selected_option_id: a.selectedOptionId,
    decided_by: a.decidedBy,
    decision_note: a.decisionNote,
    created_at: a.createdAt,
    decided_at: a.decidedAt,
    expires_at: a.expiresAt,
  };
}

function fromRow(r: ApprovalRow): Approval {
  return {
    id: asId<'ApprovalId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    missionId: r.mission_id === null ? null : asId<'MissionId'>(r.mission_id),
    taskId: r.task_id === null ? null : asId<'TaskId'>(r.task_id),
    runId: r.run_id === null ? null : asId<'RunId'>(r.run_id),
    kind: r.kind as ApprovalKind,
    status: r.status as ApprovalStatus,
    risk: r.risk as RiskClass,
    title: r.title,
    rationale: r.rationale,
    effect: r.effect,
    evidence: parseJson<readonly ApprovalEvidence[]>(r.evidence, []),
    options: parseJson<readonly ApprovalOption[]>(r.options, []),
    recommendedOptionId: r.recommended_option_id,
    selectedOptionId: r.selected_option_id,
    decidedBy: r.decided_by,
    decisionNote: r.decision_note,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    expiresAt: r.expires_at,
  };
}

const COLUMNS = `id, workspace_id, mission_id, task_id, run_id, kind, status, risk, title,
  rationale, effect, evidence, options, recommended_option_id, selected_option_id,
  decided_by, decision_note, created_at, decided_at, expires_at`;

export class SqliteApprovalRepository implements ApprovalRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #insert;
  readonly #update;
  readonly #selectOne;
  readonly #selectList;
  readonly #selectPendingForTask;

  constructor(db: TandemiseDatabase) {
    this.#db = db;
    this.#insert = db.handle.prepare<ApprovalRow>(
      `INSERT INTO approvals (${COLUMNS}) VALUES (
        :id, :workspace_id, :mission_id, :task_id, :run_id, :kind, :status, :risk, :title,
        :rationale, :effect, :evidence, :options, :recommended_option_id, :selected_option_id,
        :decided_by, :decision_note, :created_at, :decided_at, :expires_at)`,
    );
    this.#update = db.handle.prepare<ApprovalRow>(
      `UPDATE approvals SET
         mission_id = :mission_id, task_id = :task_id, run_id = :run_id, kind = :kind,
         status = :status, risk = :risk, title = :title, rationale = :rationale,
         effect = :effect, evidence = :evidence, options = :options,
         recommended_option_id = :recommended_option_id, selected_option_id = :selected_option_id,
         decided_by = :decided_by, decision_note = :decision_note, decided_at = :decided_at,
         expires_at = :expires_at
       WHERE id = :id`,
    );
    this.#selectOne = db.handle.prepare<{ id: string }, ApprovalRow>(
      `SELECT ${COLUMNS} FROM approvals WHERE id = :id`,
    );
    this.#selectList = db.handle.prepare<
      { workspaceId: string | null; missionId: string | null; statuses: string | null },
      ApprovalRow
    >(
      `SELECT ${COLUMNS} FROM approvals
       WHERE (:workspaceId IS NULL OR workspace_id = :workspaceId)
         AND (:missionId IS NULL OR mission_id = :missionId)
         AND (:statuses IS NULL OR status IN (SELECT value FROM json_each(:statuses)))
       ORDER BY created_at DESC, id DESC`,
    );
    this.#selectPendingForTask = db.handle.prepare<{ taskId: string }, ApprovalRow>(
      `SELECT ${COLUMNS} FROM approvals
       WHERE task_id = :taskId AND status = 'PENDING'
       ORDER BY created_at, id`,
    );
  }

  create(approval: Approval): Approval {
    this.#insert.run(toRow(approval));
    return approval;
  }

  get(id: ApprovalId): Approval | undefined {
    const row = this.#selectOne.get({ id });
    return row ? fromRow(row) : undefined;
  }

  list(
    filter?: { workspaceId?: WorkspaceId; missionId?: MissionId; statuses?: readonly ApprovalStatus[] },
  ): readonly Approval[] {
    return this.#selectList
      .all({
        workspaceId: filter?.workspaceId ?? null,
        missionId: filter?.missionId ?? null,
        statuses: filter?.statuses && filter.statuses.length > 0 ? toJson(filter.statuses) : null,
      })
      .map(fromRow);
  }

  update(id: ApprovalId, patch: Partial<Omit<Approval, 'id' | 'createdAt'>>): Approval {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (!current) throw TandemiseError.notFound('Approval', id);
      const next = applyPatch(current, patch);
      this.#update.run(toRow(next));
      return next;
    });
  }

  pendingForTask(taskId: TaskId): readonly Approval[] {
    return this.#selectPendingForTask.all({ taskId }).map(fromRow);
  }
}
