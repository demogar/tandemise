import { asId, type Timestamp, type WorkspaceId, type TaskId } from '@tandemise/shared';
import type { CriteriaCounts, RunPurpose, RunScore, RunScoreRepositoryPort, RunSkill } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { fromSqlBool, parseJson, toJson, toSqlBool } from '../json.js';

interface RunScoreRow {
  run_id: string;
  task_id: string;
  mission_id: string;
  workspace_id: string;
  role_id: string;
  model: string | null;
  skills: string;
  attempt: number;
  round: number;
  purpose: string | null;
  gate_passed: number;
  gate_detail: string;
  facts: string;
  criteria_verified: number | null;
  criteria_failed: number | null;
  criteria_unverified: number | null;
  over_budget: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  wall_time_ms: number | null;
  eval_trial: number;
  scored_at: string;
}

const COLUMNS = `run_id, task_id, mission_id, workspace_id, role_id, model, skills, attempt, round, purpose,
  gate_passed, gate_detail, facts, criteria_verified, criteria_failed, criteria_unverified, over_budget,
  input_tokens, output_tokens, cost_usd, wall_time_ms, eval_trial, scored_at`;

function toRow(s: RunScore): RunScoreRow {
  return {
    run_id: s.runId,
    task_id: s.taskId,
    mission_id: s.missionId,
    workspace_id: s.workspaceId,
    role_id: s.roleId,
    model: s.model,
    skills: toJson(s.skills),
    attempt: s.attempt,
    round: s.round,
    purpose: s.purpose,
    gate_passed: toSqlBool(s.gatePassed),
    gate_detail: s.gateDetail,
    facts: toJson(s.facts),
    criteria_verified: s.criteria?.verified ?? null,
    criteria_failed: s.criteria?.failed ?? null,
    criteria_unverified: s.criteria?.unverified ?? null,
    over_budget: s.overBudget,
    input_tokens: s.inputTokens,
    output_tokens: s.outputTokens,
    cost_usd: s.costUsd,
    wall_time_ms: s.wallTimeMs,
    eval_trial: toSqlBool(s.evalTrial),
    scored_at: s.scoredAt,
  };
}

function fromRow(r: RunScoreRow): RunScore {
  const criteria: CriteriaCounts | null = r.criteria_verified === null && r.criteria_failed === null && r.criteria_unverified === null
    ? null
    : { verified: r.criteria_verified ?? 0, failed: r.criteria_failed ?? 0, unverified: r.criteria_unverified ?? 0 };
  return {
    runId: asId<'RunId'>(r.run_id),
    taskId: asId<'TaskId'>(r.task_id),
    missionId: asId<'MissionId'>(r.mission_id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    roleId: r.role_id,
    model: r.model,
    skills: parseJson<readonly RunSkill[]>(r.skills, []),
    attempt: r.attempt,
    round: r.round,
    purpose: r.purpose as RunPurpose | null,
    gatePassed: fromSqlBool(r.gate_passed),
    gateDetail: r.gate_detail,
    facts: parseJson<Readonly<Record<string, unknown>>>(r.facts, {}),
    criteria,
    overBudget: r.over_budget,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    wallTimeMs: r.wall_time_ms,
    evalTrial: fromSqlBool(r.eval_trial),
    scoredAt: r.scored_at,
  };
}

/**
 * One row of measured facts per assessed run (P3b spec Part B, §B1). A
 * record: the engine never reads it. `eval_trial` is denormalised onto the
 * row so "From your runs" can leave trials out without joining missions.
 */
export class SqliteRunScoreRepository implements RunScoreRepositoryPort {
  readonly #insert;
  readonly #list;
  readonly #listByTask;

  constructor(db: TandemiseDatabase) {
    this.#insert = db.handle.prepare<RunScoreRow>(
      `INSERT OR IGNORE INTO run_scores (${COLUMNS}) VALUES (
        :run_id, :task_id, :mission_id, :workspace_id, :role_id, :model, :skills, :attempt, :round, :purpose,
        :gate_passed, :gate_detail, :facts, :criteria_verified, :criteria_failed, :criteria_unverified, :over_budget,
        :input_tokens, :output_tokens, :cost_usd, :wall_time_ms, :eval_trial, :scored_at)`,
    );
    this.#list = db.handle.prepare<{ workspaceId: string; since: string; includeTrials: 0 | 1 }, RunScoreRow>(
      `SELECT ${COLUMNS} FROM run_scores
       WHERE workspace_id = :workspaceId AND scored_at >= :since AND (:includeTrials = 1 OR eval_trial = 0)
       ORDER BY scored_at`,
    );
    this.#listByTask = db.handle.prepare<{ taskId: string }, RunScoreRow>(
      `SELECT ${COLUMNS} FROM run_scores WHERE task_id = :taskId ORDER BY scored_at`,
    );
  }

  insert(score: RunScore): void {
    this.#insert.run(toRow(score));
  }

  list(workspaceId: WorkspaceId, since: Timestamp, opts?: { readonly includeTrials?: boolean }): readonly RunScore[] {
    return this.#list.all({ workspaceId, since, includeTrials: toSqlBool(opts?.includeTrials ?? false) }).map(fromRow);
  }

  listByTask(taskId: TaskId): readonly RunScore[] {
    return this.#listByTask.all({ taskId }).map(fromRow);
  }
}
