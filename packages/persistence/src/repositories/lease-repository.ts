import { ids, type Clock, type RunId, type TaskId, type Timestamp } from '@tandemise/shared';
import type { LeaseRepositoryPort, ResourceLease } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';

interface LeaseRow {
  id: string;
  resource_key: string;
  holder_run_id: string | null;
  holder_task_id: string | null;
  acquired_at: string;
  expires_at: string;
  heartbeat_at: string;
}

function fromRow(r: LeaseRow): ResourceLease {
  return {
    id: r.id,
    resourceKey: r.resource_key,
    holderRunId: r.holder_run_id,
    holderTaskId: r.holder_task_id,
    acquiredAt: r.acquired_at,
    expiresAt: r.expires_at,
    heartbeatAt: r.heartbeat_at,
  };
}

const COLUMNS = 'id, resource_key, holder_run_id, holder_task_id, acquired_at, expires_at, heartbeat_at';

/**
 * Exclusive claims on shared resources - a branch, a repository checkout, a
 * browser profile (MVP.md §9.4).
 *
 * Timestamps are ISO-8601 UTC, whose lexicographic order is chronological, so
 * expiry is a plain string comparison in SQL and needs no conversion function
 * that the query planner would have to defeat an index over.
 */
export class SqliteLeaseRepository implements LeaseRepositoryPort {
  readonly #clock: Clock;
  readonly #acquire;
  readonly #renew;
  readonly #release;
  readonly #releaseByRun;
  readonly #selectExpired;
  readonly #selectAll;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#clock = clock;
    // The single statement that makes contention safe. An uncontended key takes
    // the INSERT branch; a contended one takes DO UPDATE, which is guarded so
    // it only fires when the incumbent has already expired. SQLite evaluates
    // the whole thing while holding the write lock, so of two callers racing
    // for the same key exactly one gets a row back and the other gets nothing.
    this.#acquire = db.handle.prepare<
      {
        id: string; resourceKey: string; runId: string | null; taskId: string | null;
        now: string; expiresAt: string;
      },
      LeaseRow
    >(
      `INSERT INTO resource_leases (${COLUMNS})
       VALUES (:id, :resourceKey, :runId, :taskId, :now, :expiresAt, :now)
       ON CONFLICT (resource_key) DO UPDATE SET
         id             = excluded.id,
         holder_run_id  = excluded.holder_run_id,
         holder_task_id = excluded.holder_task_id,
         acquired_at    = excluded.acquired_at,
         expires_at     = excluded.expires_at,
         heartbeat_at   = excluded.heartbeat_at
       WHERE resource_leases.expires_at <= :now
       RETURNING ${COLUMNS}`,
    );
    this.#renew = db.handle.prepare<{ id: string; now: string; expiresAt: string }>(
      `UPDATE resource_leases
       SET expires_at = :expiresAt, heartbeat_at = :now
       WHERE id = :id AND expires_at > :now`,
    );
    this.#release = db.handle.prepare<{ id: string }>('DELETE FROM resource_leases WHERE id = :id');
    this.#releaseByRun = db.handle.prepare<{ runId: string }>(
      'DELETE FROM resource_leases WHERE holder_run_id = :runId',
    );
    this.#selectExpired = db.handle.prepare<{ now: string }, LeaseRow>(
      `SELECT ${COLUMNS} FROM resource_leases WHERE expires_at <= :now ORDER BY expires_at, id`,
    );
    this.#selectAll = db.handle.prepare<[], LeaseRow>(
      `SELECT ${COLUMNS} FROM resource_leases ORDER BY resource_key`,
    );
  }

  /** `undefined` means the resource is held by someone else - not an error. */
  acquire(
    resourceKey: string,
    holder: { runId?: RunId | null; taskId?: TaskId | null },
    ttlMs: number,
  ): ResourceLease | undefined {
    const { now, expiresAt } = this.#window(ttlMs);
    const row = this.#acquire.get({
      id: ids.lease(),
      resourceKey,
      runId: holder.runId ?? null,
      taskId: holder.taskId ?? null,
      now,
      expiresAt,
    });
    return row ? fromRow(row) : undefined;
  }

  /**
   * False when the lease has already lapsed. A holder that let its lease expire
   * must re-acquire rather than extend, because the resource may already have
   * been handed to someone else - silently extending would reintroduce exactly
   * the double-ownership the lease exists to prevent.
   */
  renew(id: string, ttlMs: number): boolean {
    const { now, expiresAt } = this.#window(ttlMs);
    return this.#renew.run({ id, now, expiresAt }).changes > 0;
  }

  release(id: string): void {
    this.#release.run({ id });
  }

  releaseByRun(runId: RunId): void {
    this.#releaseByRun.run({ runId });
  }

  listExpired(now: Timestamp): readonly ResourceLease[] {
    return this.#selectExpired.all({ now }).map(fromRow);
  }

  listAll(): readonly ResourceLease[] {
    return this.#selectAll.all().map(fromRow);
  }

  /**
   * One clock read for both ends of the window. `Clock` is allowed to advance
   * between calls (the deterministic test clock does exactly that), so reading
   * it twice would make a lease's own expiry inconsistent with its start.
   */
  #window(ttlMs: number): { now: string; expiresAt: string } {
    const nowMs = this.#clock.epochMs();
    return {
      now: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
    };
  }
}
