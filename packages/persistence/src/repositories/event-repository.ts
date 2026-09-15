import {
  asId, type EventId, type MissionId, type RunId, type TaskId, type Timestamp, type WorkspaceId,
} from '@tandemise/shared';
import type { EventRepositoryPort, RunEventRecord, TandemiseEventBody } from '@tandemise/domain';
import { SEMANTIC_EVENT_TYPES } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';

interface EventRow {
  id: string;
  workspace_id: string;
  mission_id: string;
  task_id: string | null;
  run_id: string | null;
  sequence: number;
  type: string;
  role_id: string | null;
  runtime_profile_id: string | null;
  body: string;
  created_at: string;
  actor_id: string | null;
}

/**
 * An event body that failed to parse. Keeping the record visible with an
 * explicit marker beats dropping it: the timeline stays complete, and the
 * anomaly is obvious to whoever is debugging rather than silently absent.
 */
const UNREADABLE_BODY: TandemiseEventBody = {
  type: 'note',
  text: 'event body could not be decoded',
  level: 'error',
};

function fromRow(r: EventRow): RunEventRecord {
  return {
    id: asId<'EventId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    missionId: asId<'MissionId'>(r.mission_id),
    taskId: r.task_id === null ? null : asId<'TaskId'>(r.task_id),
    runId: r.run_id === null ? null : asId<'RunId'>(r.run_id),
    sequence: r.sequence,
    roleId: r.role_id,
    runtimeProfileId: r.runtime_profile_id,
    body: parseJson<TandemiseEventBody>(r.body, UNREADABLE_BODY),
    createdAt: r.created_at,
    actorId: r.actor_id,
  };
}

const COLUMNS = `id, workspace_id, mission_id, task_id, run_id, sequence, type,
  role_id, runtime_profile_id, body, created_at, actor_id`;

interface AppendEventInput {
  id: EventId;
  workspaceId: WorkspaceId;
  missionId: MissionId;
  taskId?: TaskId | null;
  runId?: RunId | null;
  roleId?: string | null;
  runtimeProfileId?: string | null;
  body: TandemiseEventBody;
  createdAt: Timestamp;
  actorId?: string | null;
}

export class SqliteEventRepository implements EventRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #insert;
  readonly #nextSequence;
  readonly #latestSequence;
  readonly #byMission;
  readonly #byRun;
  /** JSON array of the semantic types, bound as one parameter. */
  readonly #semanticTypes = toJson([...SEMANTIC_EVENT_TYPES]);

  constructor(db: TandemiseDatabase) {
    this.#db = db;
    this.#insert = db.handle.prepare<EventRow>(
      `INSERT INTO run_events (${COLUMNS}) VALUES (
        :id, :workspace_id, :mission_id, :task_id, :run_id, :sequence, :type,
        :role_id, :runtime_profile_id, :body, :created_at, :actor_id)`,
    );
    this.#nextSequence = db.handle.prepare<{ missionId: string }, { next: number }>(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM run_events WHERE mission_id = :missionId',
    );
    this.#latestSequence = db.handle.prepare<{ missionId: string }, { latest: number }>(
      'SELECT COALESCE(MAX(sequence), 0) AS latest FROM run_events WHERE mission_id = :missionId',
    );
    // `semanticOnly` is a filter over the live vocabulary rather than a stored
    // flag, so promoting an event type into the semantic timeline is a code
    // change, not a backfill.
    this.#byMission = db.handle.prepare<
      { missionId: string; after: number; limit: number | null; semanticTypes: string | null },
      EventRow
    >(
      `SELECT ${COLUMNS} FROM run_events
       WHERE mission_id = :missionId
         AND sequence > :after
         AND (:semanticTypes IS NULL OR type IN (SELECT value FROM json_each(:semanticTypes)))
       ORDER BY sequence
       LIMIT COALESCE(:limit, -1)`,
    );
    this.#byRun = db.handle.prepare<{ runId: string; after: number; limit: number | null }, EventRow>(
      `SELECT ${COLUMNS} FROM run_events
       WHERE run_id = :runId AND sequence > :after
       ORDER BY sequence
       LIMIT COALESCE(:limit, -1)`,
    );
  }

  /**
   * Assigns the mission's next sequence number and writes the row in one
   * transaction.
   *
   * Read-then-insert is safe because the surrounding transaction is IMMEDIATE:
   * the write lock is held before `MAX(sequence)` is read, so no other
   * connection can commit an event between the read and the insert. The
   * UNIQUE(mission_id, sequence) index is the backstop that would turn any
   * remaining race into a loud constraint violation rather than two events
   * claiming the same position in the timeline.
   */
  append(input: AppendEventInput): RunEventRecord {
    return this.#db.transaction(() => {
      const next = this.#nextSequence.get({ missionId: input.missionId });
      const record: RunEventRecord = {
        id: input.id,
        workspaceId: input.workspaceId,
        missionId: input.missionId,
        taskId: input.taskId ?? null,
        runId: input.runId ?? null,
        sequence: next?.next ?? 1,
        roleId: input.roleId ?? null,
        runtimeProfileId: input.runtimeProfileId ?? null,
        body: input.body,
        createdAt: input.createdAt,
        actorId: input.actorId ?? null,
      };
      this.#insert.run({
        id: record.id,
        workspace_id: record.workspaceId,
        mission_id: record.missionId,
        task_id: record.taskId,
        run_id: record.runId,
        sequence: record.sequence,
        type: record.body.type,
        role_id: record.roleId,
        runtime_profile_id: record.runtimeProfileId,
        body: toJson(record.body),
        created_at: record.createdAt,
        actor_id: record.actorId ?? null,
      });
      return record;
    });
  }

  listByMission(
    missionId: MissionId,
    opts?: { afterSequence?: number; limit?: number; semanticOnly?: boolean },
  ): readonly RunEventRecord[] {
    return this.#byMission
      .all({
        missionId,
        after: opts?.afterSequence ?? 0,
        limit: opts?.limit ?? null,
        semanticTypes: opts?.semanticOnly ? this.#semanticTypes : null,
      })
      .map(fromRow);
  }

  listByRun(
    runId: RunId,
    opts?: { afterSequence?: number; limit?: number },
  ): readonly RunEventRecord[] {
    return this.#byRun
      .all({ runId, after: opts?.afterSequence ?? 0, limit: opts?.limit ?? null })
      .map(fromRow);
  }

  latestSequence(missionId: MissionId): number {
    return this.#latestSequence.get({ missionId })?.latest ?? 0;
  }
}
