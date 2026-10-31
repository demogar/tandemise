import { asId, ids, type Clock, type WebhookMessageId } from '@tandemise/shared';
import type { WebhookMailboxPort, WebhookMessage } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';

interface InboxRow {
  id: string;
  source_id: string;
  received_at: string;
  headers: string;
  body: Buffer;
}

/**
 * The local webhook mailbox (plan Task 2, Global Constraints): the opt-in
 * listener puts what it received, the runners pull and ack it. A pulled
 * message is claimed so a second pull skips it; release hands it back.
 */
export class SqliteWebhookMailbox implements WebhookMailboxPort {
  readonly #db: TandemiseDatabase;
  readonly #clock: Clock;
  readonly #insert;
  readonly #selectOpen;
  readonly #claim;
  readonly #ack;
  readonly #release;
  readonly #releaseStale;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    const h = db.handle;
    this.#insert = h.prepare<{ id: string; source: string; at: string; headers: string; body: Buffer }>(
      `INSERT INTO intake_webhook_inbox (id, source_id, received_at, headers, body, claimed_at, done_at)
       VALUES (:id, :source, :at, :headers, :body, NULL, NULL)`,
    );
    this.#selectOpen = h.prepare<{ max: number }, InboxRow>(
      `SELECT id, source_id, received_at, headers, body FROM intake_webhook_inbox
       WHERE claimed_at IS NULL AND done_at IS NULL ORDER BY received_at, id LIMIT :max`,
    );
    this.#claim = h.prepare<{ id: string; now: string }>('UPDATE intake_webhook_inbox SET claimed_at = :now WHERE id = :id');
    this.#ack = h.prepare<{ id: string; now: string }>(
      'UPDATE intake_webhook_inbox SET done_at = :now WHERE id = :id AND done_at IS NULL',
    );
    this.#release = h.prepare<{ id: string }>(
      'UPDATE intake_webhook_inbox SET claimed_at = NULL WHERE id = :id AND done_at IS NULL',
    );
    this.#releaseStale = h.prepare<{ before: string }>(
      'UPDATE intake_webhook_inbox SET claimed_at = NULL WHERE claimed_at IS NOT NULL AND claimed_at < :before AND done_at IS NULL',
    );
  }

  put(msg: { readonly sourceId: string; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array }): WebhookMessageId {
    const id = ids.webhookMessage();
    this.#insert.run({
      id, source: msg.sourceId, at: this.#clock.now(), headers: toJson(msg.headers),
      body: Buffer.from(msg.body.buffer, msg.body.byteOffset, msg.body.byteLength),
    });
    return id;
  }

  pull(max: number): readonly WebhookMessage[] {
    if (max <= 0) return [];
    return this.#db.transaction(() => {
      const now = this.#clock.now();
      const rows = this.#selectOpen.all({ max: Math.floor(max) });
      for (const r of rows) this.#claim.run({ id: r.id, now });
      return rows.map((r) => ({
        id: asId<'WebhookMessageId'>(r.id),
        sourceId: r.source_id,
        receivedAt: r.received_at,
        headers: parseJson<Readonly<Record<string, string>>>(r.headers, {}),
        body: new Uint8Array(r.body),
      }));
    });
  }

  ack(id: WebhookMessageId): void {
    this.#ack.run({ id, now: this.#clock.now() });
  }

  release(id: WebhookMessageId): void {
    this.#release.run({ id });
  }

  releaseStale(claimedBefore: string): number {
    return this.#releaseStale.run({ before: claimedBefore }).changes;
  }
}
