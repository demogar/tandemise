import type { CoordinationStore } from '@tandemise/coordination';

export type OutboxOp = 'claim' | 'release' | 'take_over' | 'ack';

export interface OutboxRow {
  readonly id: number;
  readonly op: OutboxOp;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
}

/** What a handler made of one op: done, try again later (stop draining), or failed for good (move on). */
export type DrainResult = { readonly kind: 'done' } | { readonly kind: 'retry'; readonly error: string } | { readonly kind: 'failed'; readonly error: string };

const FIRST_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 300_000;

/**
 * Writes waiting for the relay, in `coord_outbox` (spec §Offline behaviour).
 * Drained in order on reconnect. A retryable error stops the drain and backs
 * off (1 s doubling to 5 min); a non-retryable one marks that op failed, for
 * Settings to show, and the drain moves on.
 */
export class Outbox {
  #backoffMs = FIRST_BACKOFF_MS;

  constructor(private readonly store: CoordinationStore) {}

  enqueue(op: OutboxOp, payload: Record<string, unknown>): number {
    const r = this.store.stmt(`INSERT INTO coord_outbox (op, payload, created_at) VALUES (?, ?, ?)`).run(op, JSON.stringify(payload), this.store.now());
    return Number(r.lastInsertRowid);
  }

  pending(): OutboxRow[] {
    return (this.store.stmt(`SELECT id, op, payload, attempts FROM coord_outbox WHERE failed_at IS NULL ORDER BY id`).all() as { id: number; op: OutboxOp; payload: string; attempts: number }[])
      .map((r) => ({ id: r.id, op: r.op, payload: JSON.parse(r.payload) as Record<string, unknown>, attempts: r.attempts }));
  }

  count(): number {
    return (this.store.stmt(`SELECT COUNT(*) AS n FROM coord_outbox WHERE failed_at IS NULL`).get() as { n: number }).n;
  }

  /** Drops queued ops matching `pred` (a release that cancels its own queued claim). */
  remove(pred: (row: OutboxRow) => boolean): number {
    let n = 0;
    for (const row of this.pending()) {
      if (!pred(row)) continue;
      this.store.stmt(`DELETE FROM coord_outbox WHERE id = ?`).run(row.id);
      n++;
    }
    return n;
  }

  failures(): { id: string; op: string; lastError: string }[] {
    return (this.store.stmt(`SELECT id, op, last_error FROM coord_outbox WHERE failed_at IS NOT NULL ORDER BY id`).all() as { id: number; op: string; last_error: string | null }[])
      .map((r) => ({ id: String(r.id), op: r.op, lastError: r.last_error ?? 'It failed.' }));
  }

  /** The delay before the next drain attempt after a retryable failure. */
  get backoffMs(): number {
    return this.#backoffMs;
  }

  /** Drains in id order. Resolves true when everything went through. */
  async drain(handle: (row: OutboxRow) => Promise<DrainResult>): Promise<boolean> {
    for (const row of this.pending()) {
      const result = await handle(row);
      if (result.kind === 'done') {
        this.store.stmt(`DELETE FROM coord_outbox WHERE id = ?`).run(row.id);
        continue;
      }
      if (result.kind === 'failed') {
        this.store.stmt(`UPDATE coord_outbox SET attempts = attempts + 1, last_error = ?, failed_at = ? WHERE id = ?`).run(result.error, this.store.now(), row.id);
        continue;
      }
      const next = new Date(this.store.clock().getTime() + this.#backoffMs).toISOString();
      this.store.stmt(`UPDATE coord_outbox SET attempts = attempts + 1, last_error = ?, next_at = ? WHERE id = ?`).run(result.error, next, row.id);
      this.#backoffMs = Math.min(this.#backoffMs * 2, MAX_BACKOFF_MS);
      return false;
    }
    this.#backoffMs = FIRST_BACKOFF_MS;
    return true;
  }
}
