import { randomUUID } from 'node:crypto';
import type {
  ClaimEndReason, ClaimRequest, ClaimView, CoordDeviceView, CoordMemberView, CreateEndpointRequest, EndpointView, MailboxMessage,
  PresenceView, RedeemInviteResponse, RelayErrorReason, RelayRole, RelayTeam,
} from '@tandemise/api-contract/relay';
import type { SqlHandle, SqlStatement } from './sql.js';
import { hashSecret, newDeviceToken, newInviteCode, normalizeInviteCode, safeEqualHex } from './secrets.js';
import { DEFAULT_STALE_AFTER_MS, INVITE_TTL_DAYS, presenceOf, takeOverRefusal } from './rules.js';
import { normalizeItemRef } from './item-ref.js';
import * as mailbox from './mailbox.js';
import { DEFAULT_RETENTION, type EndpointRow, type RetentionPolicy, type StoredRequest } from './mailbox.js';

/** A refusal the store makes on purpose. `reason` is one of the contract's relay reasons. */
export class CoordError extends Error {
  readonly reason: RelayErrorReason;
  readonly details: Record<string, unknown>;
  constructor(reason: RelayErrorReason, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CoordError';
    this.reason = reason;
    this.details = details;
  }
}

export type ClaimOutcome =
  | { readonly kind: 'claimed'; readonly claim: ClaimView }
  | { readonly kind: 'held'; readonly claim: ClaimView; readonly self: boolean };

export interface DeviceAuth extends CoordDeviceView {
  readonly role: RelayRole;
  readonly memberStatus: 'active' | 'removed';
}

interface ClaimRow {
  id: string; project_key: string; item_ref: string; item_title: string; item_url: string | null; member_id: string;
  device_id: string; local_ref: string | null; state: 'active' | 'ended'; ended_reason: ClaimEndReason | null;
  ended_by: string | null; started_at: string; ended_at: string | null; seq: number;
  member_name: string | null; device_label: string | null;
}
interface MemberRow {
  id: string; display_name: string; handles: string; role: RelayRole; status: 'active' | 'removed'; created_at: string; updated_at: string;
}
interface DeviceRow {
  id: string; member_id: string; label: string; token_hash: string | null; created_at: string; last_seen_at: string | null; revoked_at: string | null;
}

const TOUCH_EVERY_MS = 60_000;
const CLAIM_SELECT = `
  SELECT c.*, m.display_name AS member_name, d.label AS device_label
    FROM coord_claims c
    LEFT JOIN coord_members m ON m.id = c.member_id
    LEFT JOIN coord_devices d ON d.id = c.device_id`;

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

export function claimFromRow(r: ClaimRow): ClaimView {
  return {
    id: r.id, projectKey: r.project_key, itemRef: r.item_ref, itemTitle: r.item_title, itemUrl: r.item_url,
    memberId: r.member_id, memberName: r.member_name ?? '', deviceId: r.device_id, deviceLabel: r.device_label ?? '',
    localRef: r.local_ref, state: r.state, endedReason: r.ended_reason, endedBy: r.ended_by,
    startedAt: r.started_at, endedAt: r.ended_at, seq: r.seq,
  };
}

function deviceFromRow(r: DeviceRow): CoordDeviceView {
  return { id: r.id, memberId: r.member_id, label: r.label, createdAt: r.created_at, lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at };
}

/** Hides `localRef` from everyone but the holder: it is opaque to the team. */
export function claimForViewer(claim: ClaimView, viewerMemberId: string): ClaimView {
  return claim.memberId === viewerMemberId ? claim : { ...claim, localRef: null };
}

/**
 * Members, devices, invites, claims and presence over one `SqlHandle`. The
 * relay and the daemon use the same class over the same tables. Every write
 * bumps the team-wide `seq` in the same transaction.
 */
export class CoordinationStore {
  readonly db: SqlHandle;
  readonly clock: () => Date;
  readonly #statements = new Map<string, SqlStatement>();
  /** Where webhook URLs point: the relay's public URL, or the daemon's own `/v1`. */
  hooksBase = '';
  retention: RetentionPolicy = DEFAULT_RETENTION;

  constructor(db: SqlHandle, clock: () => Date = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }

  /** A prepared statement, prepared once per store. */
  stmt(sql: string): SqlStatement {
    let s = this.#statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.#statements.set(sql, s);
    }
    return s;
  }

  now(): string {
    return this.clock().toISOString();
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- meta and team

  meta(key: string): string | null {
    const row = this.stmt(`SELECT value FROM coord_meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.stmt(`INSERT INTO coord_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  seq(): number {
    return Number(this.meta('seq') ?? '0');
  }

  /** Bumps and returns the team-wide sequence. Call inside a transaction. */
  bumpSeq(): number {
    const next = this.seq() + 1;
    this.setMeta('seq', String(next));
    return next;
  }

  team(): RelayTeam | null {
    const id = this.meta('team_id');
    const name = this.meta('team_name');
    return id && name !== null ? { id, name } : null;
  }

  ensureTeam(name: string): RelayTeam {
    return this.tx(() => {
      const existing = this.team();
      if (existing) return existing;
      const team = { id: `team_${randomUUID()}`, name };
      this.setMeta('team_id', team.id);
      this.setMeta('team_name', name);
      this.setMeta('created_at', this.now());
      return team;
    });
  }

  /**
   * No claims, no endpoints, no mailbox rows, and at most one member: safe to
   * import into. Claims of `owner` don't count: a first admin's own claims,
   * already sent as they connected, come back unchanged in their import.
   */
  isEmpty(owner?: string): boolean {
    const n = (sql: string, ...p: unknown[]) => (this.stmt(sql).get(...p) as { n: number }).n;
    return n(`SELECT COUNT(*) AS n FROM coord_claims WHERE member_id <> ?`, owner ?? '') === 0
      && n(`SELECT COUNT(*) AS n FROM coord_endpoints`) === 0
      && n(`SELECT COUNT(*) AS n FROM coord_mailbox`) === 0
      && n(`SELECT COUNT(*) AS n FROM coord_members`) <= 1;
  }

  // ---- members

  createMember(input: { displayName: string; role: RelayRole; handles?: Record<string, string>; id?: string }): CoordMemberView {
    const id = input.id ?? `cm_${randomUUID()}`;
    this.tx(() => {
      const now = this.now();
      this.stmt(`INSERT INTO coord_members (id, display_name, handles, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`)
        .run(id, input.displayName, JSON.stringify(input.handles ?? {}), input.role, now, now);
      this.bumpSeq();
    });
    return this.member(id)!;
  }

  memberRow(id: string): MemberRow | null {
    return (this.stmt(`SELECT * FROM coord_members WHERE id = ?`).get(id) as MemberRow | undefined) ?? null;
  }

  #memberView(r: MemberRow, presence: readonly PresenceView[]): CoordMemberView {
    const seen = this.stmt(`SELECT MAX(last_seen_at) AS t FROM coord_devices WHERE member_id = ?`).get(r.id) as { t: string | null };
    return {
      id: r.id, displayName: r.display_name, role: r.role, status: r.status,
      presence: r.status === 'active' ? presenceOf(presence, r.id) : 'offline', lastSeenAt: seen.t,
    };
  }

  members(): CoordMemberView[] {
    const presence = this.presence();
    return (this.stmt(`SELECT * FROM coord_members ORDER BY created_at, id`).all() as MemberRow[]).map((r) => this.#memberView(r, presence));
  }

  member(id: string): CoordMemberView | null {
    const r = this.memberRow(id);
    return r ? this.#memberView(r, this.presence()) : null;
  }

  /** Revokes every device of the member and ends their active claims with `removed`. */
  removeMember(id: string, by: string | null): ClaimView[] {
    return this.tx(() => {
      const now = this.now();
      if (!this.memberRow(id)) throw new CoordError('not_holder', 'That person is not on this team.');
      this.stmt(`UPDATE coord_members SET status = 'removed', updated_at = ? WHERE id = ?`).run(now, id);
      this.stmt(`UPDATE coord_devices SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL`).run(now, id);
      this.stmt(`DELETE FROM coord_presence WHERE member_id = ?`).run(id);
      this.bumpSeq();
      const active = this.stmt(`SELECT id FROM coord_claims WHERE member_id = ? AND state = 'active'`).all(id) as { id: string }[];
      for (const c of active) this.#end(c.id, 'removed', by);
      return active.map((c) => this.claimById(c.id)!);
    });
  }

  // ---- devices

  createDevice(memberId: string, label: string): { device: CoordDeviceView; token: string } {
    const id = `cd_${randomUUID()}`;
    const token = newDeviceToken();
    this.tx(() => {
      this.stmt(`INSERT INTO coord_devices (id, member_id, label, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, memberId, label, hashSecret(token), this.now(), this.now());
      this.bumpSeq();
    });
    return { device: this.device(id)!, token };
  }

  device(id: string): CoordDeviceView | null {
    const r = this.stmt(`SELECT * FROM coord_devices WHERE id = ?`).get(id) as DeviceRow | undefined;
    return r ? deviceFromRow(r) : null;
  }

  devices(memberId?: string): CoordDeviceView[] {
    // `seen:` rows are a daemon mirror's record of when a member was last seen; they are not computers.
    const rows = memberId === undefined
      ? this.stmt(`SELECT * FROM coord_devices WHERE id NOT LIKE 'seen:%' ORDER BY created_at, id`).all()
      : this.stmt(`SELECT * FROM coord_devices WHERE member_id = ? AND id NOT LIKE 'seen:%' ORDER BY created_at, id`).all(memberId);
    return (rows as DeviceRow[]).map(deviceFromRow);
  }

  /** Looks a token up by its hash, then confirms it in constant time. */
  deviceByToken(token: string): DeviceAuth | null {
    const hash = hashSecret(token);
    const r = this.stmt(`
      SELECT d.*, m.role AS role, m.status AS member_status
        FROM coord_devices d JOIN coord_members m ON m.id = d.member_id
       WHERE d.token_hash = ?`).get(hash) as (DeviceRow & { role: RelayRole; member_status: 'active' | 'removed' }) | undefined;
    if (!r || !r.token_hash || !safeEqualHex(r.token_hash, hash)) return null;
    return { ...deviceFromRow(r), role: r.role, memberStatus: r.member_status };
  }

  /** Records that a device was seen, at most once a minute. */
  touchDevice(id: string): void {
    const now = this.clock();
    const r = this.stmt(`SELECT last_seen_at FROM coord_devices WHERE id = ?`).get(id) as { last_seen_at: string | null } | undefined;
    if (!r) return;
    if (r.last_seen_at && now.getTime() - Date.parse(r.last_seen_at) < TOUCH_EVERY_MS) return;
    this.stmt(`UPDATE coord_devices SET last_seen_at = ? WHERE id = ?`).run(now.toISOString(), id);
  }

  revokeDevice(id: string): void {
    this.tx(() => {
      const r = this.stmt(`UPDATE coord_devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`).run(this.now(), id);
      if (r.changes === 0) throw new CoordError('not_holder', 'That computer is not on this team.');
      this.stmt(`DELETE FROM coord_presence WHERE device_id = ?`).run(id);
      this.bumpSeq();
    });
  }

  // ---- invites

  createInvite(input: { role: RelayRole; displayName: string; createdBy: string | null; expiresInDays?: number; memberId?: string }): { code: string; expiresAt: string } {
    if (input.memberId !== undefined) {
      const m = this.memberRow(input.memberId);
      if (!m || m.status !== 'active') throw new CoordError('invite_invalid', 'A new-computer invite needs someone who is still on the team.');
    }
    const code = newInviteCode();
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + (input.expiresInDays ?? INVITE_TTL_DAYS) * 86_400_000).toISOString();
    this.stmt(`INSERT INTO coord_invites (id, code_hash, role, display_name, member_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`ci_${randomUUID()}`, hashSecret(normalizeInviteCode(code)), input.role, input.displayName, input.memberId ?? null, input.createdBy, now.toISOString(), expiresAt);
    return { code, expiresAt };
  }

  /** Joins the team: creates the member (or adds a computer to one) and returns a device token. */
  redeemInvite(input: { code: string; displayName: string; deviceLabel: string }): RedeemInviteResponse {
    return this.tx(() => {
      const hash = hashSecret(normalizeInviteCode(input.code));
      const inv = this.stmt(`SELECT * FROM coord_invites WHERE code_hash = ?`).get(hash) as
        { id: string; role: RelayRole; member_id: string | null; expires_at: string; redeemed_at: string | null } | undefined;
      if (!inv) throw new CoordError('invite_invalid', "That invite code isn't right. Check it and try again.");
      if (inv.redeemed_at) throw new CoordError('invite_used', 'That invite code has already been used. Ask for a new one.');
      if (Date.parse(inv.expires_at) <= this.clock().getTime()) throw new CoordError('invite_expired', 'That invite code has expired. Ask for a new one.');
      let memberId = inv.member_id;
      if (memberId) {
        const m = this.memberRow(memberId);
        if (!m || m.status !== 'active') throw new CoordError('invite_invalid', 'That invite is for someone who is no longer on the team.');
      } else {
        memberId = this.createMember({ displayName: input.displayName, role: inv.role }).id;
      }
      const { device, token } = this.createDevice(memberId, input.deviceLabel);
      this.stmt(`UPDATE coord_invites SET redeemed_at = ?, redeemed_by = ? WHERE id = ?`).run(this.now(), memberId, inv.id);
      const team = this.team();
      if (!team) throw new Error('The relay has no team yet.');
      return { memberId, deviceId: device.id, deviceToken: token, team };
    });
  }

  // ---- claims

  claimById(id: string): ClaimView | null {
    const r = this.stmt(`${CLAIM_SELECT} WHERE c.id = ?`).get(id) as ClaimRow | undefined;
    return r ? claimFromRow(r) : null;
  }

  activeClaimFor(projectKey: string, itemRef: string): ClaimView | null {
    const r = this.stmt(`${CLAIM_SELECT} WHERE c.project_key = ? AND c.item_ref = ? AND c.state = 'active'`).get(projectKey, itemRef) as ClaimRow | undefined;
    return r ? claimFromRow(r) : null;
  }

  /**
   * One active claim per item. The partial unique index is the only arbiter:
   * whoever commits first holds it, and a second claim reads the holder.
   * Claiming again with the same member and `localRef` is idempotent.
   */
  claim(input: ClaimRequest & { memberId: string; deviceId: string; id?: string; startedAt?: string }): ClaimOutcome {
    const itemRef = normalizeItemRef(input.itemRef);
    const held = (): ClaimOutcome | null => {
      const holder = this.activeClaimFor(input.projectKey, itemRef);
      if (!holder) return null;
      if (holder.memberId === input.memberId && (holder.localRef ?? '') === (input.localRef ?? '') && holder.deviceId === input.deviceId) {
        return { kind: 'claimed', claim: holder };
      }
      return { kind: 'held', claim: holder, self: holder.memberId === input.memberId };
    };
    const before = held();
    if (before) return before;
    const id = input.id ?? `cc_${randomUUID()}`;
    try {
      this.tx(() => {
        const seq = this.bumpSeq();
        this.stmt(`INSERT INTO coord_claims (id, project_key, item_ref, item_title, item_url, member_id, device_id, local_ref, state, started_at, seq)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
          .run(id, input.projectKey, itemRef, input.itemTitle, input.itemUrl, input.memberId, input.deviceId, input.localRef || null, input.startedAt ?? this.now(), seq);
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const after = held();
      if (after) return after;
      throw e;
    }
    return { kind: 'claimed', claim: this.claimById(id)! };
  }

  #end(id: string, reason: ClaimEndReason, by: string | null): void {
    const seq = this.bumpSeq();
    this.stmt(`UPDATE coord_claims SET state = 'ended', ended_reason = ?, ended_by = ?, ended_at = ?, seq = ? WHERE id = ? AND state = 'active'`)
      .run(reason, by, this.now(), seq, id);
  }

  /** Ends a claim with `done` or `released`. Only its holder or an admin may. Ending an ended claim is a no-op. */
  release(claimId: string, reason: 'done' | 'released', by: { memberId: string; role: RelayRole }): ClaimView {
    return this.tx(() => {
      const c = this.claimById(claimId);
      if (!c) throw new CoordError('not_holder', 'That claim does not exist.');
      if (c.state === 'ended') return c;
      if (c.memberId !== by.memberId && by.role !== 'admin') {
        throw new CoordError('not_holder', `Only ${c.memberName || 'the person working on it'} or an admin can stop this claim.`);
      }
      this.#end(claimId, reason, by.memberId);
      return this.claimById(claimId)!;
    });
  }

  /**
   * When the holder was last seen on any computer: an authenticated request or
   * a presence change. An open socket alone does not refresh it; a connected
   * daemon re-reads its snapshot every few minutes, which does.
   */
  holderLastSeenAt(memberId: string): string | null {
    const r = this.stmt(`SELECT MAX(t) AS t FROM (
        SELECT MAX(last_seen_at) AS t FROM coord_devices WHERE member_id = ?
        UNION ALL SELECT MAX(last_seen_at) AS t FROM coord_presence WHERE member_id = ?)`).get(memberId, memberId) as { t: string | null };
    return r.t;
  }

  /** Ends the old claim with `taken_over` and creates the taker's, in one transaction. */
  takeOver(claimId: string, by: { memberId: string; deviceId: string; role: RelayRole; localRef: string }, staleAfterMs: number = DEFAULT_STALE_AFTER_MS): ClaimView {
    return this.tx(() => {
      const c = this.claimById(claimId);
      if (!c) throw new CoordError('take_over_refused', 'That claim does not exist.');
      if (c.state !== 'active') throw new CoordError('take_over_refused', 'Nobody holds this any more. Start it again to work on it.', { claim: c });
      const refusal = takeOverRefusal({
        actor: { memberId: by.memberId, role: by.role }, holderMemberId: c.memberId, holderName: c.memberName,
        itemRef: c.itemRef, holderLastSeenAt: this.holderLastSeenAt(c.memberId), now: this.clock(), staleAfterMs,
      });
      if (refusal) throw new CoordError('take_over_refused', refusal, { claim: c });
      this.#end(claimId, 'taken_over', by.memberId);
      const id = `cc_${randomUUID()}`;
      const seq = this.bumpSeq();
      this.stmt(`INSERT INTO coord_claims (id, project_key, item_ref, item_title, item_url, member_id, device_id, local_ref, state, started_at, seq)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
        .run(id, c.projectKey, c.itemRef, c.itemTitle, c.itemUrl, by.memberId, by.deviceId, by.localRef || null, this.now(), seq);
      return this.claimById(id)!;
    });
  }

  activeClaims(projectKeys?: readonly string[]): ClaimView[] {
    const rows = this.stmt(`${CLAIM_SELECT} WHERE c.state = 'active' ORDER BY c.started_at, c.seq`).all() as ClaimRow[];
    const keep = projectKeys ? new Set(projectKeys) : null;
    return rows.filter((r) => !keep || keep.has(r.project_key)).map(claimFromRow);
  }

  claimHistory(projectKey: string, itemRef: string, limit = 20): ClaimView[] {
    return (this.stmt(`${CLAIM_SELECT} WHERE c.project_key = ? AND c.item_ref = ? ORDER BY c.started_at DESC, c.seq DESC LIMIT ?`)
      .all(projectKey, normalizeItemRef(itemRef), limit) as ClaimRow[]).map(claimFromRow);
  }

  /** The newest claim tied to a local mission. */
  claimByLocalRef(localRef: string): ClaimView | null {
    const r = this.stmt(`${CLAIM_SELECT} WHERE c.local_ref = ? ORDER BY c.started_at DESC, c.seq DESC LIMIT 1`).get(localRef) as ClaimRow | undefined;
    return r ? claimFromRow(r) : null;
  }

  // ---- presence

  setPresence(deviceId: string, status: 'online' | 'away'): PresenceView {
    return this.tx(() => {
      const d = this.device(deviceId);
      if (!d) throw new CoordError('device_revoked', 'That computer is not on this team.');
      const now = this.now();
      this.stmt(`INSERT INTO coord_presence (device_id, member_id, status, last_seen_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(device_id) DO UPDATE SET status = excluded.status, last_seen_at = excluded.last_seen_at`)
        .run(deviceId, d.memberId, status, now);
      this.stmt(`UPDATE coord_devices SET last_seen_at = ? WHERE id = ?`).run(now, deviceId);
      this.bumpSeq();
      return { deviceId, memberId: d.memberId, status, lastSeenAt: now };
    });
  }

  clearPresence(deviceId: string): void {
    this.tx(() => {
      const r = this.stmt(`DELETE FROM coord_presence WHERE device_id = ?`).run(deviceId);
      if (r.changes > 0) {
        this.stmt(`UPDATE coord_devices SET last_seen_at = ? WHERE id = ?`).run(this.now(), deviceId);
        this.bumpSeq();
      }
    });
  }

  presence(): PresenceView[] {
    return (this.stmt(`SELECT * FROM coord_presence ORDER BY device_id`).all() as { device_id: string; member_id: string; status: 'online' | 'away'; last_seen_at: string }[])
      .map((r) => ({ deviceId: r.device_id, memberId: r.member_id, status: r.status, lastSeenAt: r.last_seen_at }));
  }

  // ---- endpoints and the mailbox (mailbox.ts)

  createEndpoint(input: CreateEndpointRequest & { createdBy: string | null }, hooksBase?: string): EndpointView {
    if (hooksBase !== undefined) this.hooksBase = hooksBase;
    return mailbox.createEndpoint(this, input);
  }

  disableEndpoint(id: string): void {
    mailbox.disableEndpoint(this, id);
  }

  endpointBySlug(slug: string): EndpointRow | null {
    return mailbox.endpointBySlug(this, slug);
  }

  endpoint(id: string): EndpointRow | null {
    return mailbox.endpointRow(this, id);
  }

  endpoints(projectKeys?: readonly string[]): EndpointView[] {
    return mailbox.listEndpoints(this, projectKeys);
  }

  storeRequest(endpointId: string, req: StoredRequest): { id: string } {
    return mailbox.storeRequest(this, endpointId, req);
  }

  pull(projectKey: string, deviceId: string, max: number, leaseSeconds: number): MailboxMessage[] {
    return mailbox.pull(this, projectKey, deviceId, max, leaseSeconds);
  }

  ack(ids: readonly string[], deviceId: string): { acked: string[]; ignored: string[] } {
    return mailbox.ack(this, ids, deviceId);
  }

  retryParked(id: string): void {
    mailbox.retryParked(this, id);
  }

  dropParked(id: string): void {
    mailbox.dropParked(this, id);
  }

  /** Unacked, unparked messages waiting for a project. */
  pendingCount(projectKey: string): number {
    return (this.stmt(`SELECT COUNT(*) AS n FROM coord_mailbox m JOIN coord_endpoints e ON e.id = m.endpoint_id
                        WHERE e.project_key = ? AND m.acked_at IS NULL AND m.parked_at IS NULL`).get(projectKey) as { n: number }).n;
  }
}
