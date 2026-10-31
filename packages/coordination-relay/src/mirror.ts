import type { ClaimView, CoordDeviceView, CoordMemberView, PresenceView, RelaySnapshot } from '@tandemise/api-contract/relay';
import { readClaimSync, writeClaimSync, type CoordinationStore } from '@tandemise/coordination';

/** A claim made while the relay was unreachable, waiting in the outbox. */
export const PROVISIONAL = 'pending:';

/**
 * The daemon's local copy of what the relay knows (spec §Implementation 2),
 * in the same `coord_*` tables. Reads never leave the machine; the mirror is
 * refreshed from a snapshot on every (re)connect and from stream frames in
 * between. Provisional rows (claims made offline) are kept until the outbox
 * settles them.
 */
export class Mirror {
  constructor(private readonly store: CoordinationStore) {}

  get lastSeq(): number {
    return Number(this.store.meta('relay_seq') ?? '0');
  }

  memberIds(): Set<string> {
    return new Set(JSON.parse(this.store.meta('relay_member_ids') ?? '[]') as string[]);
  }

  /** Relay time minus local time, as of the last snapshot: "stale" is judged on the relay's clock. */
  get clockOffsetMs(): number {
    return Number(this.store.meta('relay_clock_offset_ms') ?? '0');
  }

  #upsertMember(m: CoordMemberView): void {
    const now = this.store.now();
    this.store.stmt(`INSERT INTO coord_members (id, display_name, handles, role, status, created_at, updated_at) VALUES (?, ?, '{}', ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, role = excluded.role, status = excluded.status, updated_at = excluded.updated_at`)
      .run(m.id, m.displayName, m.role, m.status, now, now);
    // When the member was last seen, as the relay says: the `seen:` row is what staleness reads.
    this.#upsertDevice({ id: `seen:${m.id}`, memberId: m.id, label: '', createdAt: now, lastSeenAt: m.lastSeenAt, revokedAt: null });
  }

  #upsertDevice(d: CoordDeviceView): void {
    this.store.stmt(`INSERT INTO coord_devices (id, member_id, label, token_hash, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, NULL, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET member_id = excluded.member_id, label = CASE WHEN excluded.label = '' THEN coord_devices.label ELSE excluded.label END,
                       last_seen_at = excluded.last_seen_at, revoked_at = excluded.revoked_at`)
      .run(d.id, d.memberId, d.label, d.createdAt, d.lastSeenAt, d.revokedAt);
  }

  /** Inserts or updates one relay claim, ending any other active row for the same item first. */
  upsertClaim(c: ClaimView): void {
    this.store.tx(() => {
      if (c.deviceId) this.#upsertDevice({ id: c.deviceId, memberId: c.memberId, label: c.deviceLabel, createdAt: c.startedAt, lastSeenAt: null, revokedAt: null });
      const existing = this.store.claimById(c.id);
      if (c.state === 'active') {
        const holder = this.store.activeClaimFor(c.projectKey, c.itemRef);
        if (holder && holder.id !== c.id) this.#endLocally(holder.id, holder.id.startsWith(PROVISIONAL) ? null : 'released', null);
      }
      // A frame for someone else's claim carries no local ref; keep ours if we had it.
      const localRef = c.localRef ?? existing?.localRef ?? null;
      this.store.stmt(`INSERT INTO coord_claims (id, project_key, item_ref, item_title, item_url, member_id, device_id, local_ref, state, ended_reason, ended_by, started_at, ended_at, seq)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET state = excluded.state, ended_reason = excluded.ended_reason, ended_by = excluded.ended_by,
                         ended_at = excluded.ended_at, seq = excluded.seq, local_ref = excluded.local_ref, member_id = excluded.member_id, device_id = excluded.device_id`)
        .run(c.id, c.projectKey, c.itemRef, c.itemTitle, c.itemUrl, c.memberId, c.deviceId, localRef, c.state, c.endedReason, c.endedBy, c.startedAt, c.endedAt, c.seq);
    });
  }

  #endLocally(id: string, reason: 'released' | null, by: string | null): void {
    this.store.stmt(`UPDATE coord_claims SET state = 'ended', ended_reason = ?, ended_by = ?, ended_at = ? WHERE id = ? AND state = 'active'`).run(reason, by, this.store.now(), id);
  }

  /** A provisional claim (made offline), held locally until the outbox sends it. */
  addProvisional(c: ClaimView): void {
    this.store.tx(() => {
      this.store.stmt(`INSERT INTO coord_claims (id, project_key, item_ref, item_title, item_url, member_id, device_id, local_ref, state, started_at, seq)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0)`)
        .run(c.id, c.projectKey, c.itemRef, c.itemTitle, c.itemUrl, c.memberId, c.deviceId, c.localRef, c.startedAt);
      writeClaimSync(this.store, c.id, { sync: 'pending', note: null, localRef: c.localRef });
    });
  }

  /** The relay accepted a provisional claim: the relay's row replaces it. */
  confirm(provisionalId: string, claim: ClaimView): void {
    this.store.tx(() => {
      const sync = readClaimSync(this.store, provisionalId);
      this.store.stmt(`DELETE FROM coord_claims WHERE id = ?`).run(provisionalId);
      this.store.stmt(`DELETE FROM coord_claim_sync WHERE claim_id = ?`).run(provisionalId);
      this.upsertClaim(claim);
      writeClaimSync(this.store, claim.id, { sync: 'confirmed', note: null, decided: sync.decided, localRef: claim.localRef });
    });
  }

  /** The relay's order won: someone else holds it. The mission keeps running and shows Unclaimed. */
  conflict(provisionalId: string, note: string, holder: ClaimView | null): void {
    this.store.tx(() => {
      this.#endLocally(provisionalId, null, null);
      writeClaimSync(this.store, provisionalId, { sync: 'conflicted', note });
      if (holder) this.upsertClaim(holder);
    });
  }

  endLocally(id: string, reason: 'released' | null): void {
    this.#endLocally(id, reason, null);
  }

  /**
   * Replaces members, presence and active claims with the relay's. Own
   * provisional rows stay; anything else active that the relay no longer has
   * is ended (its fate is read separately for own claims, by `ownEnded`).
   * Returns own active claims that vanished, so the caller can learn why.
   */
  applySnapshot(s: RelaySnapshot, localNowMs: number): ClaimView[] {
    return this.store.tx(() => {
      for (const m of s.members) this.#upsertMember(m);
      for (const d of s.devices) this.#upsertDevice(d);
      const ids = s.members.map((m) => m.id);
      this.store.setMeta('relay_member_ids', JSON.stringify(ids));
      this.store.setMeta('relay_team', JSON.stringify(s.team));
      this.store.setMeta('relay_role', s.you.role);
      this.store.setMeta('relay_clock_offset_ms', String(Date.parse(s.serverTime) - localNowMs));
      this.store.setMeta('relay_stale_after_ms', String(s.staleAfterMs));
      // Presence: the relay's, for its members' devices.
      const placeholders = ids.map(() => '?').join(',');
      if (ids.length) this.store.stmt(`DELETE FROM coord_presence WHERE member_id IN (${placeholders})`).run(...ids);
      for (const p of s.presence) this.#upsertPresence(p);
      const snapIds = new Set(s.claims.map((c) => c.id));
      const vanished: ClaimView[] = [];
      for (const c of this.store.activeClaims()) {
        if (snapIds.has(c.id) || c.id.startsWith(PROVISIONAL)) continue;
        if (c.memberId === s.you.memberId) vanished.push(c);
        this.#endLocally(c.id, null, null);
      }
      for (const c of s.claims) {
        this.upsertClaim(c);
        if (c.memberId === s.you.memberId && readClaimSync(this.store, c.id).sync === 'pending') {
          writeClaimSync(this.store, c.id, { sync: 'confirmed' });
        }
      }
      this.store.setMeta('relay_seq', String(s.seq));
      return vanished;
    });
  }

  #upsertPresence(p: PresenceView): void {
    this.store.stmt(`INSERT INTO coord_presence (device_id, member_id, status, last_seen_at) VALUES (?, ?, ?, ?)
                     ON CONFLICT(device_id) DO UPDATE SET member_id = excluded.member_id, status = excluded.status, last_seen_at = excluded.last_seen_at`)
      .run(p.deviceId, p.memberId, p.status, p.lastSeenAt);
  }

  applyPresence(p: PresenceView, seq: number): void {
    this.store.tx(() => {
      this.#upsertPresence(p);
      this.store.stmt(`UPDATE coord_devices SET last_seen_at = ? WHERE id = ?`).run(p.lastSeenAt, `seen:${p.memberId}`);
      this.store.setMeta('relay_seq', String(Math.max(seq, this.lastSeq)));
    });
  }

  setSeq(seq: number): void {
    this.store.setMeta('relay_seq', String(seq));
  }
}
