import { asId, ids, type Clock, type WebhookMessageId, type WorkspaceId } from '@tandemise/shared';
import type { WebhookMailboxPort, WebhookMessage } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';

interface InboxRow {
  id: string;
  workspace_id: string;
  source_id: string;
  received_at: string;
  headers: string;
  body: Buffer;
}

/**
 * The local webhook mailbox (plan Task 2, Global Constraints): the opt-in
 * listener puts what it received, the runners pull and ack it. A pulled
 * message is claimed so a second pull skips it; release hands it back. A
 * relay delivery read here leaves a done row with no body, so a redelivery
 * is a no-op; done rows are pruned after a day (Ruling 24).
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
  readonly #prune;
  readonly #handled;
  readonly #recordHandled;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    const h = db.handle;
    this.#insert = h.prepare<{ id: string; workspace: string; source: string; at: string; headers: string; body: Buffer }>(
      `INSERT INTO intake_webhook_inbox (id, workspace_id, source_id, received_at, headers, body, claimed_at, done_at)
       VALUES (:id, :workspace, :source, :at, :headers, :body, NULL, NULL)`,
    );
    this.#selectOpen = h.prepare<{ max: number }, InboxRow>(
      `SELECT id, workspace_id, source_id, received_at, headers, body FROM intake_webhook_inbox
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
    this.#prune = h.prepare<{ before: string }>('DELETE FROM intake_webhook_inbox WHERE done_at IS NOT NULL AND done_at < :before');
    this.#handled = h.prepare<{ id: string }, { one: number }>('SELECT 1 AS one FROM intake_webhook_inbox WHERE id = :id AND done_at IS NOT NULL');
    this.#recordHandled = h.prepare<{ id: string; workspace: string; source: string; now: string }>(
      `INSERT OR IGNORE INTO intake_webhook_inbox (id, workspace_id, source_id, received_at, headers, body, claimed_at, done_at)
       VALUES (:id, :workspace, :source, :now, '{}', x'', :now, :now)`,
    );
  }

  put(msg: { readonly workspaceId: WorkspaceId; readonly sourceId: string; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array }): WebhookMessageId {
    const id = ids.webhookMessage();
    this.#insert.run({
      id, workspace: msg.workspaceId, source: msg.sourceId, at: this.#clock.now(), headers: toJson(msg.headers),
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
        workspaceId: asId<'WorkspaceId'>(r.workspace_id),
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

  prune(doneBefore: string): number {
    return this.#prune.run({ before: doneBefore }).changes;
  }

  handled(key: string): boolean {
    return this.#handled.get({ id: key }) !== undefined;
  }

  recordHandled(entry: { readonly key: string; readonly workspaceId: WorkspaceId; readonly sourceId: string }): void {
    this.#recordHandled.run({ id: entry.key, workspace: entry.workspaceId, source: entry.sourceId, now: this.#clock.now() });
  }
}
