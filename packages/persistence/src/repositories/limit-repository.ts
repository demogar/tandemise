import { TandemiseError, asId, ids, type Clock, type LimitIncidentId, type MissionId, type WorkspaceId } from '@tandemise/shared';
import type {
  LimitIncident, LimitIncidentKey, LimitIncidentStatus, LimitMetric, LimitRepositoryPort, LimitThreshold, UsageTotals,
} from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';

interface IncidentRow {
  id: string;
  workspace_id: string;
  mission_id: string | null;
  metric: string;
  window_start: string;
  window_end: string | null;
  amount_limit: number;
  amount_observed: number;
  threshold: string;
  status: string;
  approval_id: string | null;
  paused_missions: string;
  created_at: string;
  resolved_at: string | null;
}

interface UsageRow {
  agent_ms: number | null;
  tokens: number | null;
  token_runs: number;
  cost: number | null;
  cost_runs: number;
  runs: number;
}

const COLUMNS = `id, workspace_id, mission_id, metric, window_start, window_end, amount_limit, amount_observed,
  threshold, status, approval_id, paused_missions, created_at, resolved_at`;

/**
 * Sums over `usage_records`. Tokens are input plus output (cache reads and
 * writes are counted by the provider differently and are not what a person
 * budgets). A sum is null when no row reported the value: SUM over nothing
 * reported would otherwise read as zero, and zero is a claim.
 */
const USAGE = `
  COALESCE(SUM(u.wall_time_ms), 0) AS agent_ms,
  SUM(COALESCE(u.input_tokens, 0) + COALESCE(u.output_tokens, 0)) AS tokens,
  SUM(CASE WHEN u.input_tokens IS NOT NULL OR u.output_tokens IS NOT NULL THEN 1 ELSE 0 END) AS token_runs,
  SUM(u.cost_usd) AS cost,
  SUM(CASE WHEN u.cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS cost_runs,
  COUNT(u.id) AS runs`;

function toTotals(row: UsageRow | undefined): UsageTotals {
  if (row === undefined) return { agentMs: 0, tokens: null, costUsd: null, runs: 0 };
  return {
    agentMs: row.agent_ms ?? 0,
    tokens: row.token_runs > 0 ? row.tokens ?? 0 : null,
    costUsd: row.cost_runs > 0 ? row.cost ?? 0 : null,
    runs: row.runs,
  };
}

function fromRow(r: IncidentRow): LimitIncident {
  return {
    id: asId<'LimitIncidentId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    missionId: r.mission_id === null ? null : asId<'MissionId'>(r.mission_id),
    metric: r.metric as LimitMetric,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    amountLimit: r.amount_limit,
    amountObserved: r.amount_observed,
    threshold: r.threshold as LimitThreshold,
    status: r.status as LimitIncidentStatus,
    approvalId: r.approval_id === null ? null : asId<'ApprovalId'>(r.approval_id),
    pausedMissionIds: parseJson<readonly string[]>(r.paused_missions, []).map((id) => asId<'MissionId'>(id)),
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

/** Limit incidents and the usage sums they are measured from (P8). */
export class SqliteLimitRepository implements LimitRepositoryPort {
  readonly #clock: Clock;
  readonly #missionUsage;
  readonly #workspaceUsage;
  readonly #usageByMission;
  readonly #find;
  readonly #get;
  readonly #byApproval;
  readonly #insert;
  readonly #transition;
  readonly #listOpen;
  readonly #listByMission;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#clock = clock;
    this.#missionUsage = db.handle.prepare<{ missionId: string }, UsageRow>(
      `SELECT ${USAGE} FROM usage_records u WHERE u.mission_id = :missionId`,
    );
    this.#workspaceUsage = db.handle.prepare<{ workspaceId: string; start: string; end: string }, UsageRow>(
      `SELECT ${USAGE} FROM usage_records u JOIN missions m ON m.id = u.mission_id
        WHERE m.workspace_id = :workspaceId AND u.recorded_at >= :start AND u.recorded_at < :end`,
    );
    this.#usageByMission = db.handle.prepare<{ workspaceId: string; start: string; end: string }, UsageRow & { mission_id: string }>(
      `SELECT u.mission_id AS mission_id, ${USAGE} FROM usage_records u JOIN missions m ON m.id = u.mission_id
        WHERE m.workspace_id = :workspaceId AND u.recorded_at >= :start AND u.recorded_at < :end
        GROUP BY u.mission_id ORDER BY agent_ms DESC, u.mission_id`,
    );
    this.#find = db.handle.prepare<{ workspaceId: string; missionId: string; metric: string; windowStart: string; threshold: string; amount: number }, IncidentRow>(
      `SELECT ${COLUMNS} FROM limit_incidents
        WHERE workspace_id = :workspaceId AND COALESCE(mission_id, '') = :missionId AND metric = :metric
          AND window_start = :windowStart AND threshold = :threshold AND amount_limit = :amount`,
    );
    this.#get = db.handle.prepare<{ id: string }, IncidentRow>(`SELECT ${COLUMNS} FROM limit_incidents WHERE id = :id`);
    this.#byApproval = db.handle.prepare<{ approvalId: string }, IncidentRow>(
      `SELECT ${COLUMNS} FROM limit_incidents WHERE approval_id = :approvalId`,
    );
    this.#insert = db.handle.prepare<IncidentRow>(
      `INSERT INTO limit_incidents (${COLUMNS}) VALUES (
        :id, :workspace_id, :mission_id, :metric, :window_start, :window_end, :amount_limit, :amount_observed,
        :threshold, :status, :approval_id, :paused_missions, :created_at, :resolved_at)`,
    );
    this.#transition = db.handle.prepare<{
      id: string; from: string; to: string; resolvedAt: string | null;
      approvalId: string | null; setApproval: number; observed: number | null; paused: string | null;
    }>(
      `UPDATE limit_incidents SET status = :to, resolved_at = :resolvedAt,
         approval_id = CASE WHEN :setApproval = 1 THEN :approvalId ELSE approval_id END,
         amount_observed = COALESCE(:observed, amount_observed),
         paused_missions = COALESCE(:paused, paused_missions)
       WHERE id = :id AND status = :from`,
    );
    this.#listOpen = db.handle.prepare<{ workspaceId: string }, IncidentRow>(
      `SELECT ${COLUMNS} FROM limit_incidents WHERE workspace_id = :workspaceId AND status = 'open' ORDER BY created_at, id`,
    );
    this.#listByMission = db.handle.prepare<{ missionId: string }, IncidentRow>(
      `SELECT ${COLUMNS} FROM limit_incidents WHERE mission_id = :missionId ORDER BY created_at, id`,
    );
  }

  usageForMission(missionId: MissionId): UsageTotals {
    return toTotals(this.#missionUsage.get({ missionId }));
  }

  usageForWorkspace(workspaceId: WorkspaceId, start: string, end: string): UsageTotals {
    return toTotals(this.#workspaceUsage.get({ workspaceId, start, end }));
  }

  usageByMission(workspaceId: WorkspaceId, start: string, end: string): readonly { missionId: MissionId; totals: UsageTotals }[] {
    return this.#usageByMission.all({ workspaceId, start, end })
      .map((row) => ({ missionId: asId<'MissionId'>(row.mission_id), totals: toTotals(row) }));
  }

  find(key: LimitIncidentKey): LimitIncident | undefined {
    const row = this.#find.get({
      workspaceId: key.workspaceId, missionId: key.missionId ?? '', metric: key.metric,
      windowStart: key.windowStart, threshold: key.threshold, amount: key.amountLimit,
    });
    return row === undefined ? undefined : fromRow(row);
  }

  get(id: LimitIncidentId): LimitIncident | undefined {
    const row = this.#get.get({ id });
    return row === undefined ? undefined : fromRow(row);
  }

  byApproval(approvalId: string): LimitIncident | undefined {
    const row = this.#byApproval.get({ approvalId });
    return row === undefined ? undefined : fromRow(row);
  }

  create(incident: Omit<LimitIncident, 'id' | 'createdAt' | 'resolvedAt'>): LimitIncident {
    const row: IncidentRow = {
      id: ids.limitIncident(),
      workspace_id: incident.workspaceId,
      mission_id: incident.missionId,
      metric: incident.metric,
      window_start: incident.windowStart,
      window_end: incident.windowEnd,
      amount_limit: incident.amountLimit,
      amount_observed: incident.amountObserved,
      threshold: incident.threshold,
      status: incident.status,
      approval_id: incident.approvalId,
      paused_missions: toJson(incident.pausedMissionIds),
      created_at: this.#clock.now(),
      resolved_at: null,
    };
    try {
      this.#insert.run(row);
    } catch (e) {
      // The unique index is the one-incident-per-limit rule; a second writer lost the race.
      if (String((e as { code?: string }).code ?? '').startsWith('SQLITE_CONSTRAINT')) {
        throw new TandemiseError('CONFLICT', 'This limit already has an incident for this window.', { details: { metric: incident.metric } });
      }
      throw e;
    }
    return fromRow(row);
  }

  transition(
    id: LimitIncidentId,
    from: LimitIncidentStatus,
    to: LimitIncidentStatus,
    patch: Partial<Pick<LimitIncident, 'approvalId' | 'amountObserved' | 'pausedMissionIds'>> = {},
  ): LimitIncident | null {
    const changed = this.#transition.run({
      id, from, to,
      resolvedAt: to === 'open' ? null : this.#clock.now(),
      approvalId: patch.approvalId ?? null,
      setApproval: patch.approvalId === undefined ? 0 : 1,
      observed: patch.amountObserved ?? null,
      paused: patch.pausedMissionIds === undefined ? null : toJson(patch.pausedMissionIds),
    }).changes;
    return changed === 0 ? null : this.get(id) ?? null;
  }

  listOpen(workspaceId: WorkspaceId): readonly LimitIncident[] {
    return this.#listOpen.all({ workspaceId }).map(fromRow);
  }

  listByMission(missionId: MissionId): readonly LimitIncident[] {
    return this.#listByMission.all({ missionId }).map(fromRow);
  }
}
