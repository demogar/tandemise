import { randomUUID } from 'node:crypto';
import type { CreateEndpointRequest, EndpointView, Handshake, MailboxMessage } from '@tandemise/api-contract/relay';
import type { CoordinationStore } from './store.js';
import { newSlug } from './secrets.js';

/** One webhook request body may be this big; beyond it the ingress answers 413. */
export const MAX_BODY_BYTES = 1_048_576;
/** A message leased this many times without an ack is parked on its next pull. */
export const PARK_AFTER_ATTEMPTS = 10;
export const MAX_PULL = 50;
export const MAX_LEASE_SECONDS = 300;

export interface RetentionPolicy {
  /** How long an acked row (body already gone) stays for "last received". */
  readonly ackedRowMs: number;
  /** How long an unacked message is kept before it is dropped. */
  readonly unackedMs: number;
  readonly maxMessages: number;
  readonly maxBytes: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  ackedRowMs: 86_400_000,
  unackedMs: 14 * 86_400_000,
  maxMessages: 10_000,
  maxBytes: 200 * 1_048_576,
};

export interface EndpointRow {
  id: string; project_key: string; slug: string; name: string; source: string; handshake: Handshake;
  handshake_secret: string | null; created_by: string | null; created_at: string; disabled_at: string | null;
  dropped_count: number; drop_flag: number;
}

interface MailboxRow {
  id: number; endpoint_id: string; received_at: string; method: string; query: string; headers: string;
  content_type: string | null; body: Buffer | null; body_bytes: number; lease_device: string | null; lease_until: string | null;
  attempts: number; acked_at: string | null; acked_by: string | null; parked_at: string | null; project_key: string;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'cookie', 'authorization', 'host', 'content-length']);

/**
 * What of a webhook's headers is kept: everything a local runner may need to
 * verify it (signature headers included), minus hop-by-hop headers, cookies and
 * credentials. `host` and `content-length` describe the relay's own hop.
 */
export function filterWebhookHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(h)) {
    if (value === undefined) continue;
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP.has(key) || key.startsWith('proxy-')) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export function endpointUrl(base: string, slug: string): string {
  return `${base.replace(/\/+$/, '')}/hooks/${slug}`;
}

function endpointView(store: CoordinationStore, r: EndpointRow): EndpointView {
  const counts = store.stmt(`
    SELECT
      SUM(CASE WHEN acked_at IS NULL AND parked_at IS NULL THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN acked_at IS NULL AND parked_at IS NOT NULL THEN 1 ELSE 0 END) AS parked,
      MAX(received_at) AS last
    FROM coord_mailbox WHERE endpoint_id = ?`).get(r.id) as { pending: number | null; parked: number | null; last: string | null };
  return {
    id: r.id, projectKey: r.project_key, slug: r.slug, url: endpointUrl(store.hooksBase, r.slug), name: r.name, source: r.source,
    handshake: r.handshake, createdAt: r.created_at, disabledAt: r.disabled_at, lastReceivedAt: counts.last,
    pending: counts.pending ?? 0, parked: counts.parked ?? 0, droppedCount: r.dropped_count, dropFlag: r.drop_flag === 1,
  };
}

export function createEndpoint(store: CoordinationStore, input: CreateEndpointRequest & { createdBy: string | null; id?: string; slug?: string; createdAt?: string; disabledAt?: string | null }): EndpointView {
  const id = input.id ?? `ce_${randomUUID()}`;
  store.stmt(`INSERT INTO coord_endpoints (id, project_key, slug, name, source, handshake, handshake_secret, created_by, created_at, disabled_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.projectKey, input.slug ?? newSlug(), input.name, input.source, input.handshake, input.handshakeSecret ?? null,
      input.createdBy, input.createdAt ?? store.now(), input.disabledAt ?? null);
  return endpointView(store, endpointRow(store, id)!);
}

export function endpointRow(store: CoordinationStore, id: string): EndpointRow | null {
  return (store.stmt(`SELECT * FROM coord_endpoints WHERE id = ?`).get(id) as EndpointRow | undefined) ?? null;
}

/** An enabled endpoint by its slug; a disabled one looks exactly like an unknown one. */
export function endpointBySlug(store: CoordinationStore, slug: string): EndpointRow | null {
  const r = store.stmt(`SELECT * FROM coord_endpoints WHERE slug = ?`).get(slug) as EndpointRow | undefined;
  return r && !r.disabled_at ? r : null;
}

export function listEndpoints(store: CoordinationStore, projectKeys?: readonly string[]): EndpointView[] {
  const keep = projectKeys ? new Set(projectKeys) : null;
  return (store.stmt(`SELECT * FROM coord_endpoints ORDER BY created_at, id`).all() as EndpointRow[])
    .filter((r) => !keep || keep.has(r.project_key))
    .map((r) => endpointView(store, r));
}

export function disableEndpoint(store: CoordinationStore, id: string): void {
  store.stmt(`UPDATE coord_endpoints SET disabled_at = COALESCE(disabled_at, ?) WHERE id = ?`).run(store.now(), id);
}

/** Drops the oldest unacked messages until the mailbox is within its caps, and flags their endpoints. */
export function enforceCaps(store: CoordinationStore, policy: RetentionPolicy): number {
  let dropped = 0;
  for (;;) {
    const t = store.stmt(`SELECT COUNT(*) AS n, COALESCE(SUM(body_bytes), 0) AS bytes FROM coord_mailbox WHERE acked_at IS NULL`).get() as { n: number; bytes: number };
    if (t.n <= policy.maxMessages && t.bytes <= policy.maxBytes) return dropped;
    const oldest = store.stmt(`SELECT id, endpoint_id FROM coord_mailbox WHERE acked_at IS NULL ORDER BY id LIMIT 1`).get() as { id: number; endpoint_id: string } | undefined;
    if (!oldest) return dropped;
    store.stmt(`DELETE FROM coord_mailbox WHERE id = ?`).run(oldest.id);
    store.stmt(`UPDATE coord_endpoints SET dropped_count = dropped_count + 1, drop_flag = 1 WHERE id = ?`).run(oldest.endpoint_id);
    dropped++;
  }
}

export interface StoredRequest {
  readonly method: string;
  readonly query: string;
  readonly headers: Record<string, string>;
  readonly contentType: string | null;
  readonly body: Buffer;
}

export function storeRequest(store: CoordinationStore, endpointId: string, req: StoredRequest, opts: { receivedAt?: string; attempts?: number } = {}): { id: string } {
  return store.tx(() => {
    const r = store.stmt(`INSERT INTO coord_mailbox (endpoint_id, received_at, method, query, headers, content_type, body, body_bytes, attempts)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(endpointId, opts.receivedAt ?? store.now(), req.method, req.query, JSON.stringify(req.headers), req.contentType, req.body, req.body.length, opts.attempts ?? 0);
    enforceCaps(store, store.retention);
    return { id: String(r.lastInsertRowid) };
  });
}

function messageFromRow(r: MailboxRow): MailboxMessage {
  return {
    id: String(r.id), endpointId: r.endpoint_id, projectKey: r.project_key, receivedAt: r.received_at, method: r.method,
    query: r.query, headers: JSON.parse(r.headers) as Record<string, string>, contentType: r.content_type,
    bodyBase64: r.body ? Buffer.from(r.body).toString('base64') : '', attempts: r.attempts,
  };
}

/**
 * Leases up to `max` unacked messages of a project to one device, in arrival
 * order. A leased message is invisible to other pulls until its lease runs
 * out; one already leased `PARK_AFTER_ATTEMPTS` times is parked instead.
 */
export function pull(store: CoordinationStore, projectKey: string, deviceId: string, max: number, leaseSeconds: number): MailboxMessage[] {
  return store.tx(() => {
    const now = store.clock();
    const nowIso = now.toISOString();
    const until = new Date(now.getTime() + Math.min(leaseSeconds, MAX_LEASE_SECONDS) * 1000).toISOString();
    const candidates = store.stmt(`
      SELECT m.*, e.project_key FROM coord_mailbox m JOIN coord_endpoints e ON e.id = m.endpoint_id
       WHERE e.project_key = ? AND m.acked_at IS NULL AND m.parked_at IS NULL AND (m.lease_until IS NULL OR m.lease_until < ?)
       ORDER BY m.id`).all(projectKey, nowIso) as MailboxRow[];
    const leased: MailboxMessage[] = [];
    for (const r of candidates) {
      if (leased.length >= Math.min(max, MAX_PULL)) break;
      if (r.attempts >= PARK_AFTER_ATTEMPTS) {
        store.stmt(`UPDATE coord_mailbox SET parked_at = ?, lease_until = NULL WHERE id = ?`).run(nowIso, r.id);
        continue;
      }
      store.stmt(`UPDATE coord_mailbox SET lease_device = ?, lease_until = ?, attempts = attempts + 1 WHERE id = ?`).run(deviceId, until, r.id);
      leased.push(messageFromRow({ ...r, attempts: r.attempts + 1, lease_device: deviceId, lease_until: until }));
    }
    return leased;
  });
}

/**
 * Acks what this device still holds a lease on. An expired or someone else's
 * lease is ignored, not refused: the message was re-leased and may be
 * processed twice, so intake is idempotent by message id.
 */
export function ack(store: CoordinationStore, ids: readonly string[], deviceId: string): { acked: string[]; ignored: string[] } {
  return store.tx(() => {
    const nowIso = store.now();
    const acked: string[] = [];
    const ignored: string[] = [];
    for (const id of ids) {
      const r = store.stmt(`UPDATE coord_mailbox SET acked_at = ?, acked_by = ?, body = NULL, body_bytes = 0, lease_until = NULL
                            WHERE id = ? AND acked_at IS NULL AND lease_device = ? AND lease_until >= ?`)
        .run(nowIso, deviceId, Number(id), deviceId, nowIso);
      (r.changes > 0 ? acked : ignored).push(id);
    }
    return { acked, ignored };
  });
}

export function retryParked(store: CoordinationStore, id: string): void {
  store.stmt(`UPDATE coord_mailbox SET parked_at = NULL, attempts = 0, lease_until = NULL WHERE id = ? AND acked_at IS NULL`).run(Number(id));
}

export function dropParked(store: CoordinationStore, id: string): void {
  store.stmt(`DELETE FROM coord_mailbox WHERE id = ? AND acked_at IS NULL`).run(Number(id));
}

/** Parked messages, with the last computer that tried, for Settings. */
export function parkedMessages(store: CoordinationStore, endpointId?: string): { id: string; endpointId: string; receivedAt: string; lastDeviceId: string | null }[] {
  const rows = store.stmt(`SELECT id, endpoint_id, received_at, lease_device FROM coord_mailbox WHERE parked_at IS NOT NULL AND acked_at IS NULL ORDER BY id`).all() as
    { id: number; endpoint_id: string; received_at: string; lease_device: string | null }[];
  return rows.filter((r) => !endpointId || r.endpoint_id === endpointId)
    .map((r) => ({ id: String(r.id), endpointId: r.endpoint_id, receivedAt: r.received_at, lastDeviceId: r.lease_device }));
}

/** Unacked messages with their bodies, oldest first: what an export carries. */
export function unackedMessages(store: CoordinationStore): MailboxMessage[] {
  return (store.stmt(`SELECT m.*, e.project_key FROM coord_mailbox m JOIN coord_endpoints e ON e.id = m.endpoint_id WHERE m.acked_at IS NULL ORDER BY m.id`).all() as MailboxRow[])
    .map(messageFromRow);
}
