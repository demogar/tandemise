import type { ClaimView, CoordMemberView, MailboxMessage, PresenceView } from '@tandemise/api-contract/relay';
import type { CoordinationStore } from './store.js';
import { DEFAULT_STALE_AFTER_MS, heldBySentence, takeOverRefusal } from './rules.js';

export type CoordinationStatus =
  | { readonly kind: 'local' }
  | { readonly kind: 'connected'; readonly host: string; readonly teamName: string }
  | { readonly kind: 'offline'; readonly since: string; readonly pendingOps: number }
  | { readonly kind: 'refused'; readonly reason: string };

export type ClaimResult =
  | { readonly kind: 'claimed'; readonly claim: ClaimView }
  | { readonly kind: 'held_by'; readonly claim: ClaimView; readonly self: boolean; readonly sentence: string; readonly mayTakeOver: boolean }
  | { readonly kind: 'queued_offline'; readonly claim: ClaimView };

export type ClaimSyncState = 'confirmed' | 'pending' | 'conflicted' | 'lost';
export interface ClaimSync {
  readonly sync: ClaimSyncState;
  readonly note: string | null;
  readonly decided: 'keep_going' | null;
}

export type CoordinationTopic = 'claims' | 'members' | 'presence' | 'mailbox';

export interface ClaimInput {
  readonly projectKey: string;
  readonly itemRef: string;
  readonly itemTitle: string;
  readonly itemUrl: string | null;
  readonly localRef: string;
}

export interface Me {
  readonly memberId: string;
  readonly deviceId: string;
  readonly role: 'admin' | 'member';
  readonly displayName: string;
  readonly deviceLabel: string;
}

/** A held item, in the words a person reads, and whether they may take it over. */
export function heldBy(store: CoordinationStore, claim: ClaimView, self: boolean, actor: { memberId: string; role: 'admin' | 'member' }, staleAfterMs = DEFAULT_STALE_AFTER_MS): ClaimResult {
  const sentence = heldBySentence({ holderName: claim.memberName, itemRef: claim.itemRef, startedAt: claim.startedAt, self, deviceLabel: claim.deviceLabel });
  const mayTakeOver = takeOverRefusal({
    actor, holderMemberId: claim.memberId, holderName: claim.memberName, itemRef: claim.itemRef,
    holderLastSeenAt: store.holderLastSeenAt(claim.memberId), now: store.clock(), staleAfterMs,
  }) === null;
  return { kind: 'held_by', claim, self, sentence, mayTakeOver };
}

/** A listener set: `onChange` without an event bus. */
export class ChangeEmitter {
  readonly #listeners = new Set<(topic: CoordinationTopic) => void>();
  on(listener: (topic: CoordinationTopic) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  emit(topic: CoordinationTopic): void {
    for (const l of [...this.#listeners]) {
      try { l(topic); } catch { /* a listener never breaks a write */ }
    }
  }
}

/** Reads `coord_claim_sync`, which only a daemon's database has. */
export function readClaimSync(store: CoordinationStore, claimId: string): ClaimSync {
  try {
    const r = store.stmt(`SELECT sync, note, decided FROM coord_claim_sync WHERE claim_id = ?`).get(claimId) as
      { sync: ClaimSyncState; note: string | null; decided: 'keep_going' | null } | undefined;
    return r ? { sync: r.sync, note: r.note, decided: r.decided } : { sync: 'confirmed', note: null, decided: null };
  } catch {
    return { sync: 'confirmed', note: null, decided: null };
  }
}

export function writeClaimSync(store: CoordinationStore, claimId: string, patch: { sync?: ClaimSyncState; note?: string | null; decided?: 'keep_going' | null; localRef?: string | null }): void {
  const cur = readClaimSync(store, claimId);
  store.stmt(`INSERT INTO coord_claim_sync (claim_id, local_ref, sync, note, decided, updated_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(claim_id) DO UPDATE SET local_ref = COALESCE(excluded.local_ref, coord_claim_sync.local_ref),
                sync = excluded.sync, note = excluded.note, decided = excluded.decided, updated_at = excluded.updated_at`)
    .run(claimId, patch.localRef ?? null, patch.sync ?? cur.sync, patch.note === undefined ? cur.note : patch.note,
      patch.decided === undefined ? cur.decided : patch.decided, store.now());
}

/**
 * Coordination with no relay (spec §Implementation 1): the same store over the
 * daemon's own database. The local person is the team's only admin, presence
 * is just "you", and the one-active-claim index still keeps one person from
 * starting the same tracker item twice.
 */
export class LocalCoordination {
  readonly mode = 'local' as const;
  readonly store: CoordinationStore;
  readonly #emitter = new ChangeEmitter();
  #me: Me;

  constructor(store: CoordinationStore, me: { displayName: string; deviceLabel: string }) {
    this.store = store;
    this.#me = store.tx(() => {
      store.ensureTeam(me.displayName ? `${me.displayName}'s team` : 'Team');
      let memberId = store.meta('local_member_id');
      if (!memberId || !store.memberRow(memberId)) {
        memberId = store.createMember({ displayName: me.displayName || 'You', role: 'admin' }).id;
        store.setMeta('local_member_id', memberId);
      } else {
        store.stmt(`UPDATE coord_members SET display_name = ?, role = 'admin', status = 'active' WHERE id = ? AND display_name <> ?`)
          .run(me.displayName || 'You', memberId, me.displayName || 'You');
      }
      let deviceId = store.meta('local_device_id');
      if (!deviceId || !store.device(deviceId)) {
        deviceId = store.createDevice(memberId, me.deviceLabel || 'This computer').device.id;
        store.setMeta('local_device_id', deviceId);
      }
      return { memberId, deviceId, role: 'admin' as const, displayName: me.displayName || 'You', deviceLabel: store.device(deviceId)!.label };
    });
    store.setPresence(this.#me.deviceId, 'online');
  }

  me(): Me {
    return this.#me;
  }

  status(): CoordinationStatus {
    return { kind: 'local' };
  }

  async claim(input: ClaimInput): Promise<ClaimResult> {
    const out = this.store.claim({ ...input, memberId: this.#me.memberId, deviceId: this.#me.deviceId });
    if (out.kind === 'claimed') {
      this.#emitter.emit('claims');
      return { kind: 'claimed', claim: out.claim };
    }
    return heldBy(this.store, out.claim, out.self, { memberId: this.#me.memberId, role: this.#me.role });
  }

  async release(claimId: string, reason: 'done' | 'released'): Promise<void> {
    this.store.release(claimId, reason, { memberId: this.#me.memberId, role: 'admin' });
    this.#emitter.emit('claims');
  }

  async takeOver(claimId: string, localRef: string): Promise<ClaimResult> {
    const claim = this.store.takeOver(claimId, { memberId: this.#me.memberId, deviceId: this.#me.deviceId, role: 'admin', localRef });
    this.#emitter.emit('claims');
    return { kind: 'claimed', claim };
  }

  claims(projectKey?: string): readonly ClaimView[] {
    return this.store.activeClaims(projectKey === undefined ? undefined : [projectKey]);
  }

  claimByLocalRef(localRef: string): ClaimView | null {
    return this.store.claimByLocalRef(localRef);
  }

  members(): readonly CoordMemberView[] {
    return this.store.members();
  }

  presence(): readonly PresenceView[] {
    return this.store.presence();
  }

  holderLastSeenAt(memberId: string): string | null {
    return this.store.holderLastSeenAt(memberId);
  }

  markLost(localRef: string, note: string): void {
    writeClaimSync(this.store, `lost:${localRef}`, { sync: 'lost', note, localRef, decided: null });
    this.#emitter.emit('claims');
  }

  claimSync(claimId: string): ClaimSync {
    return readClaimSync(this.store, claimId);
  }

  keepGoing(claimId: string): void {
    writeClaimSync(this.store, claimId, { decided: 'keep_going' });
    this.#emitter.emit('claims');
  }

  onChange(listener: (topic: CoordinationTopic) => void): () => void {
    return this.#emitter.on(listener);
  }

  emit(topic: CoordinationTopic): void {
    this.#emitter.emit(topic);
  }

  readonly mailbox = {
    pull: async (projectKey: string, max: number, leaseSeconds = 60): Promise<readonly MailboxMessage[]> =>
      this.store.pull(projectKey, this.#me.deviceId, max, leaseSeconds),
    ack: async (ids: readonly string[]): Promise<{ acked: string[]; ignored: string[] }> => this.store.ack(ids, this.#me.deviceId),
  };
}
