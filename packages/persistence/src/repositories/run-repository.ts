import {
  TandemiseError, asId, type Clock, type MissionId, type RunId, type TaskId, type Timestamp,
} from '@tandemise/shared';
import type { Run, RunPurpose, RunRepositoryPort, RunStatus, RunUsage } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJsonOrNull, toJsonOrNull, toJson } from '../json.js';
import { applyPatch } from '../patch.js';

interface RunRow {
  id: string;
  mission_id: string;
  task_id: string;
  assignment_id: string;
  attempt: number;
  status: string;
  role_id: string;
  runtime_profile_id: string;
  execution_target_id: string;
  external_session_id: string | null;
  pid: number | null;
  exit_code: number | null;
  error_code: string | null;
  error_message: string | null;
  usage: string | null;
  started_at: string;
  finished_at: string | null;
  heartbeat_at: string | null;
  last_event_at: string | null;
  watch_snoozed_until: string | null;
  agent_member_id: string | null;
  round: number | null;
  purpose: string | null;
}

function toRow(r: Run): RunRow {
  return {
    id: r.id,
    mission_id: r.missionId,
    task_id: r.taskId,
    assignment_id: r.assignmentId,
    attempt: r.attempt,
    status: r.status,
    role_id: r.roleId,
    runtime_profile_id: r.runtimeProfileId,
    execution_target_id: r.executionTargetId,
    external_session_id: r.externalSessionId,
    pid: r.pid,
    exit_code: r.exitCode,
    error_code: r.errorCode,
    error_message: r.errorMessage,
    usage: toJsonOrNull(r.usage),
    started_at: r.startedAt,
    finished_at: r.finishedAt,
    heartbeat_at: r.heartbeatAt,
    last_event_at: r.lastEventAt ?? r.startedAt,
    watch_snoozed_until: r.watchSnoozedUntil ?? null,
    agent_member_id: r.agentMemberId ?? null,
    round: r.round ?? null,
    purpose: r.purpose ?? null,
  };
}

function fromRow(r: RunRow): Run {
  return {
    id: asId<'RunId'>(r.id),
    missionId: asId<'MissionId'>(r.mission_id),
    taskId: asId<'TaskId'>(r.task_id),
    assignmentId: asId<'WorkerAssignmentId'>(r.assignment_id),
    attempt: r.attempt,
    status: r.status as RunStatus,
    roleId: r.role_id,
    runtimeProfileId: r.runtime_profile_id,
    executionTargetId: r.execution_target_id,
    externalSessionId: r.external_session_id,
    pid: r.pid,
    exitCode: r.exit_code,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    usage: parseJsonOrNull<RunUsage>(r.usage),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    heartbeatAt: r.heartbeat_at,
    lastEventAt: r.last_event_at ?? r.started_at,
    watchSnoozedUntil: r.watch_snoozed_until,
    agentMemberId: r.agent_member_id,
    round: r.round,
    purpose: r.purpose as RunPurpose | null,
  };
}

const COLUMNS = `id, mission_id, task_id, assignment_id, attempt, status, role_id,
  runtime_profile_id, execution_target_id, external_session_id, pid, exit_code,
  error_code, error_message, usage, started_at, finished_at, heartbeat_at, last_event_at, watch_snoozed_until, agent_member_id,
  round, purpose`;

interface UsageParams {
  runId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  wallTimeMs: number | null;
  turns: number | null;
  recordedAt: string;
}

export class SqliteRunRepository implements RunRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #clock: Clock;
  readonly #insert;
  readonly #update;
  readonly #selectOne;
  readonly #selectByTask;
  readonly #selectByMission;
  readonly #selectByStatus;
  readonly #setUsage;
  readonly #appendUsage;
  readonly #heartbeat;
  readonly #activity;
  readonly #snooze;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    this.#insert = db.handle.prepare<RunRow>(
      `INSERT INTO runs (${COLUMNS}) VALUES (
        :id, :mission_id, :task_id, :assignment_id, :attempt, :status, :role_id,
        :runtime_profile_id, :execution_target_id, :external_session_id, :pid, :exit_code,
        :error_code, :error_message, :usage, :started_at, :finished_at, :heartbeat_at, :last_event_at, :watch_snoozed_until, :agent_member_id,
        :round, :purpose)`,
    );
    this.#update = db.handle.prepare<RunRow>(
      `UPDATE runs SET
         mission_id = :mission_id, assignment_id = :assignment_id, attempt = :attempt,
         status = :status, role_id = :role_id, runtime_profile_id = :runtime_profile_id,
         execution_target_id = :execution_target_id, external_session_id = :external_session_id,
         pid = :pid, exit_code = :exit_code, error_code = :error_code,
         error_message = :error_message, usage = :usage, finished_at = :finished_at,
         heartbeat_at = :heartbeat_at, last_event_at = :last_event_at,
         watch_snoozed_until = :watch_snoozed_until, agent_member_id = :agent_member_id,
         round = :round, purpose = :purpose
       WHERE id = :id`,
    );
    this.#selectOne = db.handle.prepare<{ id: string }, RunRow>(
      `SELECT ${COLUMNS} FROM runs WHERE id = :id`,
    );
    this.#selectByTask = db.handle.prepare<{ taskId: string }, RunRow>(
      `SELECT ${COLUMNS} FROM runs WHERE task_id = :taskId ORDER BY attempt, started_at`,
    );
    this.#selectByMission = db.handle.prepare<{ missionId: string }, RunRow>(
      `SELECT ${COLUMNS} FROM runs WHERE mission_id = :missionId ORDER BY started_at, id`,
    );
    this.#selectByStatus = db.handle.prepare<{ statuses: string }, RunRow>(
      `SELECT ${COLUMNS} FROM runs
       WHERE status IN (SELECT value FROM json_each(:statuses))
       ORDER BY started_at, id`,
    );
    this.#setUsage = db.handle.prepare<{ id: string; usage: string }>(
      'UPDATE runs SET usage = :usage WHERE id = :id',
    );
    this.#appendUsage = db.handle.prepare<UsageParams>(
      `INSERT INTO usage_records (
         run_id, mission_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cost_usd, wall_time_ms, turns, recorded_at)
       SELECT :runId, r.mission_id, :inputTokens, :outputTokens, :cacheReadTokens,
              :cacheWriteTokens, :costUsd, :wallTimeMs, :turns, :recordedAt
       FROM runs r WHERE r.id = :runId`,
    );
    this.#heartbeat = db.handle.prepare<{ id: string; at: string }>(
      'UPDATE runs SET heartbeat_at = :at WHERE id = :id',
    );
    // Any output ends a "keep waiting": the run spoke, so the next silence is measured afresh.
    this.#activity = db.handle.prepare<{ id: string; at: string }>(
      'UPDATE runs SET last_event_at = :at, watch_snoozed_until = NULL WHERE id = :id',
    );
    this.#snooze = db.handle.prepare<{ id: string; until: string }>(
      'UPDATE runs SET watch_snoozed_until = :until WHERE id = :id',
    );
  }

  create(run: Run): Run {
    this.#insert.run(toRow(run));
    return run;
  }

  get(id: RunId): Run | undefined {
    const row = this.#selectOne.get({ id });
    return row ? fromRow(row) : undefined;
  }

  listByTask(taskId: TaskId): readonly Run[] {
    return this.#selectByTask.all({ taskId }).map(fromRow);
  }

  listByMission(missionId: MissionId): readonly Run[] {
    return this.#selectByMission.all({ missionId }).map(fromRow);
  }

  listByStatus(statuses: readonly RunStatus[]): readonly Run[] {
    if (statuses.length === 0) return [];
    return this.#selectByStatus.all({ statuses: toJson(statuses) }).map(fromRow);
  }

  update(id: RunId, patch: Partial<Omit<Run, 'id' | 'taskId' | 'startedAt'>>): Run {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (!current) throw TandemiseError.notFound('Run', id);
      const next = applyPatch(current, patch);
      this.#update.run(toRow(next));
      return next;
    });
  }

  /**
   * The run keeps the latest observation for its detail view; the append-only
   * `usage_records` table keeps every observation, because a runtime that
   * reports usage twice with different numbers is reporting two facts, not
   * correcting one (MVP.md §22.2).
   */
  recordUsage(id: RunId, usage: RunUsage): void {
    this.#db.transaction(() => {
      const updated = this.#setUsage.run({ id, usage: toJson(usage) });
      if (updated.changes === 0) throw TandemiseError.notFound('Run', id);
      this.#appendUsage.run({
        runId: id,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        cacheReadTokens: usage.cacheReadTokens ?? null,
        cacheWriteTokens: usage.cacheWriteTokens ?? null,
        costUsd: usage.costUsd ?? null,
        wallTimeMs: usage.wallTimeMs ?? null,
        turns: usage.turns ?? null,
        recordedAt: this.#clock.now(),
      });
    });
  }

  heartbeat(id: RunId, at: Timestamp): void {
    this.#heartbeat.run({ id, at });
  }

  markActivity(id: RunId, at: Timestamp): void {
    this.#activity.run({ id, at });
  }

  snooze(id: RunId, until: Timestamp): void {
    if (this.#snooze.run({ id, until }).changes === 0) throw TandemiseError.notFound('Run', id);
  }
}
