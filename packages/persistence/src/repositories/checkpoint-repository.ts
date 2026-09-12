import { asId, type RunId } from '@tandemise/shared';
import type { Checkpoint, CheckpointRepositoryPort } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';

interface CheckpointRow {
  run_id: string;
  sequence: number;
  label: string;
  external_session_id: string | null;
  payload: string;
  created_at: string;
}

function fromRow(r: CheckpointRow): Checkpoint {
  return {
    runId: asId<'RunId'>(r.run_id),
    sequence: r.sequence,
    label: r.label,
    externalSessionId: r.external_session_id,
    payload: parseJson<Record<string, unknown>>(r.payload, {}),
    createdAt: r.created_at,
  };
}

const COLUMNS = 'run_id, sequence, label, external_session_id, payload, created_at';

export class SqliteCheckpointRepository implements CheckpointRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #insert;
  readonly #nextSequence;
  readonly #selectLatest;
  readonly #selectAll;

  constructor(db: TandemiseDatabase) {
    this.#db = db;
    this.#insert = db.handle.prepare<CheckpointRow>(
      `INSERT INTO checkpoints (${COLUMNS}) VALUES (
        :run_id, :sequence, :label, :external_session_id, :payload, :created_at)`,
    );
    this.#nextSequence = db.handle.prepare<{ runId: string }, { next: number }>(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM checkpoints WHERE run_id = :runId',
    );
    this.#selectLatest = db.handle.prepare<{ runId: string }, CheckpointRow>(
      `SELECT ${COLUMNS} FROM checkpoints WHERE run_id = :runId ORDER BY sequence DESC LIMIT 1`,
    );
    this.#selectAll = db.handle.prepare<{ runId: string }, CheckpointRow>(
      `SELECT ${COLUMNS} FROM checkpoints WHERE run_id = :runId ORDER BY sequence`,
    );
  }

  /**
   * The store assigns the sequence; the caller's value is ignored.
   *
   * Checkpoints are written by the supervisor after durable milestones, often
   * from more than one place in a run's lifecycle, and nothing there is in a
   * position to know the next free number. Returning the assigned sequence is
   * what makes "resume from the last checkpoint" well defined (MVP.md §21.1).
   */
  append(checkpoint: Checkpoint): Checkpoint {
    return this.#db.transaction(() => {
      const sequence = this.#nextSequence.get({ runId: checkpoint.runId })?.next ?? 1;
      const stored: Checkpoint = { ...checkpoint, sequence };
      this.#insert.run({
        run_id: stored.runId,
        sequence: stored.sequence,
        label: stored.label,
        external_session_id: stored.externalSessionId,
        payload: toJson(stored.payload),
        created_at: stored.createdAt,
      });
      return stored;
    });
  }

  latest(runId: RunId): Checkpoint | undefined {
    const row = this.#selectLatest.get({ runId });
    return row ? fromRow(row) : undefined;
  }

  list(runId: RunId): readonly Checkpoint[] {
    return this.#selectAll.all({ runId }).map(fromRow);
  }
}
