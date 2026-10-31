import { randomUUID } from 'node:crypto';
import type {
  ClaimView, CoordDeviceView, CoordMemberView, CreateEndpointRequest, CreateInviteRequest, EndpointView, ImportReport, MailboxMessage,
  PresenceView, RelayServerFrame, RelaySnapshot,
} from '@tandemise/api-contract/relay';
import {
  ChangeEmitter, CoordError, clockTime, heldBySentence, itemKey, readClaimSync, writeClaimSync,
  type ClaimInput, type ClaimResult, type ClaimSync, type CoordinationStatus, type CoordinationStore, type CoordinationTopic, type LocalCoordination, type Me,
} from '@tandemise/coordination';
import { RelayClient, RelayHttpError, isOffline } from './client.js';
import { Mirror, PROVISIONAL } from './mirror.js';
import { Outbox, type DrainResult, type OutboxRow } from './outbox.js';
import { RelayStream } from './stream.js';

const FIRST_RETRY_MS = 1000;
/** The note on outbox rows still unsent when the person disconnected. */
export const ABANDONED = 'Not sent: you disconnected before the team relay heard about it.';
const MAX_RETRY_MS = 300_000;
/** A connected daemon re-reads its snapshot this often; it is also what keeps it "seen". */
const RESNAPSHOT_MS = 5 * 60_000;

export interface RelayCoordinationOptions {
  readonly store: CoordinationStore;
  readonly url: string;
  readonly token: () => Promise<string>;
  readonly memberId: string;
  readonly deviceId: string;
  readonly teamName?: string;
  readonly log?: { warn(msg: string, fields?: Record<string, unknown>): void; info?(msg: string, fields?: Record<string, unknown>): void };
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Coordination with a team relay (spec §Implementation 2): the same store,
 * used as a mirror plus an outbox. Writes go to the relay first; when it
 * can't be reached they queue, a claim is held as pending, and the mission
 * starts anyway. Reads come from the mirror, never the network.
 */
export class RelayCoordination {
  readonly mode = 'relay' as const;
  readonly host: string;
  readonly store: CoordinationStore;
  readonly client: RelayClient;
  readonly #mirror: Mirror;
  readonly #outbox: Outbox;
  readonly #stream: RelayStream;
  readonly #emitter = new ChangeEmitter();
  readonly #opts: RelayCoordinationOptions;
  #status: CoordinationStatus;
  #offlineSince: string | null = null;
  #refused: string | null = null;
  #retryMs = FIRST_RETRY_MS;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #resnapshotTimer: ReturnType<typeof setInterval> | null = null;
  #stopped = false;
  #syncing: Promise<void> | null = null;
  /** Something asked for a sync while one was running: run again once it ends, so nothing it asked for is missed. */
  #dirty = false;
  #endpoints: EndpointView[] = [];
  #lastPresence: 'online' | 'away' = 'online';
  #snapshot: RelaySnapshot | null = null;

  constructor(opts: RelayCoordinationOptions) {
    this.#opts = opts;
    this.store = opts.store;
    this.host = new URL(opts.url).host;
    this.client = new RelayClient({ baseUrl: opts.url, token: opts.token, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    this.#mirror = new Mirror(opts.store);
    this.#outbox = new Outbox(opts.store);
    this.#stream = new RelayStream(opts.url, {
      open: () => this.#onStreamOpen(),
      frame: (f) => this.#onFrame(f),
      close: (code) => this.#onStreamClose(code),
    });
    this.#status = { kind: 'offline', since: this.store.now(), pendingOps: this.#outbox.count() };
    this.#offlineSince = this.store.now();
  }

  // ---- lifecycle

  /** Connects: drain the outbox, read the snapshot, open the stream. Never throws; failures mean offline and a retry. */
  async start(): Promise<void> {
    this.#stopped = false;
    await this.#sync();
    if (this.#resnapshotTimer === null) {
      this.#resnapshotTimer = setInterval(() => { if (this.#stream.open) void this.#sync(); }, RESNAPSHOT_MS);
      this.#resnapshotTimer.unref?.();
    }
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    if (this.#resnapshotTimer) clearInterval(this.#resnapshotTimer);
    this.#retryTimer = null;
    this.#resnapshotTimer = null;
    this.#stream.close();
  }

  #sync(): Promise<void> {
    if (this.#syncing !== null) {
      this.#dirty = true;
      return this.#syncing;
    }
    const run = async (): Promise<void> => {
      do {
        this.#dirty = false;
        await this.#doSync();
      } while (this.#dirty && !this.#stopped);
    };
    this.#syncing = run().finally(() => { this.#syncing = null; });
    return this.#syncing;
  }

  async #doSync(): Promise<void> {
    if (this.#stopped) return;
    try {
      const drained = await this.#outbox.drain((row) => this.#send(row));
      if (!drained) throw new Error('The relay is not taking writes yet.');
      await this.#resnapshot();
      if (!this.#stream.open && !(await this.#stream.connect(await this.#opts.token()))) return;
      this.#retryMs = FIRST_RETRY_MS;
    } catch (e) {
      this.#wentOffline(e);
    }
  }

  async #resnapshot(): Promise<void> {
    const snap = await this.client.snapshot();
    this.#snapshot = snap;
    this.#endpoints = [...snap.endpoints];
    const vanished = this.#mirror.applySnapshot(snap, Date.now());
    // An own claim the relay no longer has: learn why (a take-over or a removal shows Unclaimed).
    for (const c of vanished) {
      try {
        const history = await this.client.history(c.projectKey, c.itemRef);
        const mine = history.find((h) => h.id === c.id);
        if (mine) this.#mirror.upsertClaim({ ...mine, localRef: mine.localRef ?? c.localRef });
        const holder = history.find((h) => h.state === 'active');
        if (holder) this.#mirror.upsertClaim(holder);
      } catch {
        /* the next snapshot tries again */
      }
    }
    this.#refused = null;
    this.#emitter.emit('claims');
    this.#emitter.emit('members');
  }

  #wentOffline(e: unknown): void {
    if (e instanceof RelayHttpError && (e.status === 401 || e.status === 412)) {
      this.#refused = e.message;
      this.#status = { kind: 'refused', reason: e.message };
    } else {
      this.#offlineSince ??= this.store.now();
      this.#status = { kind: 'offline', since: this.#offlineSince, pendingOps: this.#outbox.count() };
    }
    this.#emitter.emit('presence');
    if (this.#stopped) return;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => { this.#retryTimer = null; void this.#sync(); }, this.#retryMs);
    this.#retryTimer.unref?.();
    this.#retryMs = Math.min(this.#retryMs * 2, MAX_RETRY_MS);
  }

  #onStreamOpen(): void {
    this.#offlineSince = null;
    this.#refused = null;
    this.#status = { kind: 'connected', host: this.host, teamName: this.teamName() ?? '' };
    this.#stream.send({ type: 'presence', status: this.#lastPresence });
    this.#emitter.emit('presence');
  }

  #onStreamClose(code: number): void {
    if (this.#stopped) return;
    if (code === 4401) {
      this.#refused = 'This computer was removed from the team relay. Disconnect, then join again with a new invite.';
      this.#status = { kind: 'refused', reason: this.#refused };
      this.#emitter.emit('presence');
      return;
    }
    this.#wentOffline(new Error(`stream closed (${code})`));
  }

  #onFrame(f: RelayServerFrame): void {
    switch (f.type) {
      case 'hello':
        // Frames since the snapshot: anything newer than it means re-read.
        if (f.seq > this.#mirror.lastSeq) void this.#sync();
        return;
      case 'claim': {
        if (f.seq <= this.#mirror.lastSeq) return;
        const gap = f.seq > this.#mirror.lastSeq + 1;
        this.#mirror.upsertClaim(f.claim);
        this.#mirror.setSeq(f.seq);
        this.#emitter.emit('claims');
        if (gap) void this.#sync();
        return;
      }
      case 'presence':
        this.#mirror.applyPresence(f.presence, f.seq);
        this.#emitter.emit('presence');
        return;
      case 'members':
        void this.#sync();
        return;
      case 'mailbox':
        this.#emitter.emit('mailbox');
        return;
      case 'pong':
        return;
    }
  }

  // ---- the outbox

  async #send(row: OutboxRow): Promise<DrainResult> {
    try {
      if (row.op === 'claim') {
        const provisionalId = String(row.payload['provisionalId']);
        const input = row.payload['input'] as ClaimInput;
        try {
          const claim = await this.client.claim(input);
          this.#mirror.confirm(provisionalId, claim);
        } catch (e) {
          if (!(e instanceof RelayHttpError) || e.reason !== 'claim_held') throw e;
          const holder = e.body?.error.details['claim'] as ClaimView | undefined;
          const note = holder
            ? `${holder.memberName} started ${itemKey(holder.itemRef)} at ${clockTime(holder.startedAt)}, while you were offline.`
            : e.message;
          this.#mirror.conflict(provisionalId, note, holder ?? null);
        }
        this.#emitter.emit('claims');
      } else if (row.op === 'release') {
        await this.client.release(String(row.payload['claimId']), row.payload['reason'] as 'done' | 'released');
      } else if (row.op === 'ack') {
        await this.client.ack(row.payload['ids'] as string[]);
      }
      return { kind: 'done' };
    } catch (e) {
      if (isOffline(e)) return { kind: 'retry', error: e instanceof Error ? e.message : String(e) };
      return { kind: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ---- CoordinationPort

  status(): CoordinationStatus {
    if (this.#status.kind === 'offline') return { kind: 'offline', since: this.#status.since, pendingOps: this.#outbox.count() };
    if (this.#status.kind === 'connected' && !this.#stream.open) return { kind: 'offline', since: this.#offlineSince ?? this.store.now(), pendingOps: this.#outbox.count() };
    return this.#status;
  }

  teamName(): string | null {
    const team = this.store.meta('relay_team');
    return team ? (JSON.parse(team) as { name: string }).name : this.#opts.teamName ?? null;
  }

  me(): Me {
    const member = this.store.memberRow(this.#opts.memberId);
    const device = this.store.device(this.#opts.deviceId);
    return {
      memberId: this.#opts.memberId, deviceId: this.#opts.deviceId,
      role: (this.store.meta('relay_role') as 'admin' | 'member' | null) ?? 'member',
      displayName: member?.display_name ?? 'You', deviceLabel: device?.label ?? 'This computer',
    };
  }

  async claim(input: ClaimInput): Promise<ClaimResult> {
    try {
      const claim = await this.client.claim(input);
      this.#mirror.upsertClaim(claim);
      writeClaimSync(this.store, claim.id, { sync: 'confirmed', localRef: claim.localRef });
      this.#emitter.emit('claims');
      return { kind: 'claimed', claim };
    } catch (e) {
      if (e instanceof RelayHttpError && e.reason === 'claim_held') {
        const holder = e.body!.error.details['claim'] as ClaimView;
        this.#mirror.upsertClaim(holder);
        this.#emitter.emit('claims');
        return { kind: 'held_by', claim: holder, self: e.body!.error.details['self'] === true, sentence: e.message, mayTakeOver: e.body!.error.details['takeOver'] === true };
      }
      if (!isOffline(e) && !(e instanceof RelayHttpError && (e.status === 401 || e.status === 412))) throw e;
      // Offline (or refused): the claim waits, and local work starts anyway.
      const me = this.me();
      const provisional: ClaimView = {
        id: `${PROVISIONAL}${randomUUID()}`, projectKey: input.projectKey, itemRef: input.itemRef, itemTitle: input.itemTitle, itemUrl: input.itemUrl,
        memberId: me.memberId, memberName: me.displayName, deviceId: me.deviceId, deviceLabel: me.deviceLabel, localRef: input.localRef,
        state: 'active', endedReason: null, endedBy: null, startedAt: this.store.now(), endedAt: null, seq: 0,
      };
      const held = this.store.activeClaimFor(input.projectKey, input.itemRef);
      if (held && held.memberId === me.memberId && held.localRef === input.localRef) return { kind: 'queued_offline', claim: held };
      if (held) {
        // The mirror already knows who holds it: that is the answer, offline or not.
        const self = held.memberId === me.memberId;
        return { kind: 'held_by', claim: held, self, sentence: heldBySentence({ holderName: held.memberName, itemRef: held.itemRef, startedAt: held.startedAt, self, deviceLabel: held.deviceLabel }), mayTakeOver: false };
      }
      this.#mirror.addProvisional(provisional);
      this.#outbox.enqueue('claim', { provisionalId: provisional.id, input });
      this.#wentOffline(e);
      this.#emitter.emit('claims');
      return { kind: 'queued_offline', claim: this.store.claimById(provisional.id)! };
    }
  }

  async release(claimId: string, reason: 'done' | 'released'): Promise<void> {
    if (claimId.startsWith(PROVISIONAL)) {
      // Never sent: drop the queued claim instead of sending a claim and its release.
      this.#outbox.remove((r) => r.op === 'claim' && r.payload['provisionalId'] === claimId);
      this.#mirror.endLocally(claimId, reason === 'done' ? 'released' : 'released');
      this.#emitter.emit('claims');
      return;
    }
    try {
      const ended = await this.client.release(claimId, reason);
      this.#mirror.upsertClaim(ended);
    } catch (e) {
      if (!isOffline(e)) throw e;
      this.#mirror.endLocally(claimId, 'released');
      this.#outbox.enqueue('release', { claimId, reason });
      this.#wentOffline(e);
    }
    this.#emitter.emit('claims');
  }

  async takeOver(claimId: string, localRef: string): Promise<ClaimResult> {
    try {
      const claim = await this.client.takeOver(claimId, localRef);
      this.#mirror.upsertClaim(claim);
      writeClaimSync(this.store, claim.id, { sync: 'confirmed', localRef });
      await this.#resnapshot().catch(() => undefined);
      return { kind: 'claimed', claim };
    } catch (e) {
      if (e instanceof RelayHttpError && e.reason === 'take_over_refused') throw new CoordError('take_over_refused', e.message);
      if (isOffline(e)) throw new CoordError('take_over_refused', "You're offline, so this can't be taken over now. Try again when you're back online.");
      throw e;
    }
  }

  claims(projectKey?: string): readonly ClaimView[] {
    return this.store.activeClaims(projectKey === undefined ? undefined : [projectKey]);
  }

  claimByLocalRef(localRef: string): ClaimView | null {
    return this.store.claimByLocalRef(localRef);
  }

  members(): readonly CoordMemberView[] {
    const ids = this.#mirror.memberIds();
    return this.store.members().filter((m) => ids.has(m.id));
  }

  presence(): readonly PresenceView[] {
    const ids = this.#mirror.memberIds();
    return this.store.presence().filter((p) => ids.has(p.memberId));
  }

  /** In this machine's time: the relay's last-seen moved by the clock difference at the last snapshot. */
  holderLastSeenAt(memberId: string): string | null {
    const t = this.store.holderLastSeenAt(memberId);
    return t === null ? null : new Date(Date.parse(t) - this.#mirror.clockOffsetMs).toISOString();
  }

  claimSync(claimId: string): ClaimSync {
    return readClaimSync(this.store, claimId);
  }

  keepGoing(claimId: string): void {
    writeClaimSync(this.store, claimId, { decided: 'keep_going' });
    this.#emitter.emit('claims');
  }

  markLost(localRef: string, note: string): void {
    writeClaimSync(this.store, `lost:${localRef}`, { sync: 'lost', note, localRef, decided: null });
    this.#emitter.emit('claims');
  }

  onChange(listener: (topic: CoordinationTopic) => void): () => void {
    return this.#emitter.on(listener);
  }

  readonly mailbox = {
    pull: async (projectKey: string, max: number, leaseSeconds = 60): Promise<readonly MailboxMessage[]> => this.client.pull(projectKey, max, leaseSeconds),
    ack: async (ids: readonly string[]): Promise<{ acked: string[]; ignored: string[] }> => {
      try {
        const r = await this.client.ack(ids);
        return { acked: [...r.acked], ignored: [...r.ignored] };
      } catch (e) {
        if (!isOffline(e)) throw e;
        this.#outbox.enqueue('ack', { ids });
        return { acked: [], ignored: [] };
      }
    },
  };

  /** Only on a change: presence carries no activity, and a steady state needs no traffic. */
  reportPresence(status: 'online' | 'away'): void {
    if (status === this.#lastPresence) return;
    this.#lastPresence = status;
    this.#stream.send({ type: 'presence', status });
  }

  // ---- control

  /**
   * On connect: the person's own active local claims become provisional relay
   * claims, queued for the relay with normal claim semantics, so a conflict is
   * reported per item (spec §Moving from solo to a relay, step 4).
   */
  adoptLocal(localMe: Me): void {
    const me = this.me();
    this.store.tx(() => {
      for (const c of this.store.activeClaims()) {
        if (c.memberId !== localMe.memberId) continue;
        const id = `${PROVISIONAL}${randomUUID()}`;
        this.store.stmt(`UPDATE coord_claims SET id = ?, member_id = ?, device_id = ? WHERE id = ?`).run(id, me.memberId, me.deviceId, c.id);
        writeClaimSync(this.store, id, { sync: 'pending', localRef: c.localRef });
        this.#outbox.enqueue('claim', {
          provisionalId: id,
          input: { projectKey: c.projectKey, itemRef: c.itemRef, itemTitle: c.itemTitle, itemUrl: c.itemUrl, localRef: c.localRef ?? '' },
        });
      }
    });
  }

  /** "Bring my local data" applies: an admin, alone on a relay with nothing but their own claims. */
  offerImport(): boolean {
    const s = this.#snapshot;
    if (s === null || s.you.role !== 'admin' || this.store.meta('relay_imported') === '1') return false;
    return s.members.length === 1 && s.endpoints.length === 0 && s.claims.every((c) => c.memberId === s.you.memberId);
  }

  async importLocal(localLines: string[]): Promise<ImportReport> {
    const report = await this.client.importLines(localLines);
    this.store.setMeta('relay_imported', '1');
    await this.#resnapshot();
    return report;
  }

  async createInvite(req: CreateInviteRequest) { return this.client.createInvite(req); }
  async revokeDevice(id: string) { await this.client.revokeDevice(id); await this.#resnapshot(); }
  async removeMember(id: string) { await this.client.removeMember(id); await this.#resnapshot(); }

  devices(): readonly CoordDeviceView[] {
    const ids = this.#mirror.memberIds();
    const own = new Set((this.#snapshot?.devices ?? []).map((d) => d.id));
    return this.store.devices().filter((d) => ids.has(d.memberId) && (own.size === 0 || own.has(d.id)));
  }

  async createEndpoint(req: CreateEndpointRequest): Promise<EndpointView> {
    const ep = await this.client.createEndpoint(req);
    this.#endpoints = await this.client.endpoints().catch(() => [...this.#endpoints, ep]);
    return ep;
  }

  async disableEndpoint(id: string): Promise<void> {
    await this.client.disableEndpoint(id);
    this.#endpoints = await this.client.endpoints().catch(() => this.#endpoints);
  }

  parked() { return this.client.parked(); }
  async retryParked(id: string): Promise<void> { await this.client.retryParked(id); }
  async dropParked(id: string): Promise<void> { await this.client.dropParked(id); }

  endpoints(): readonly EndpointView[] {
    return this.#endpoints;
  }

  failures(): readonly { id: string; op: string; lastError: string }[] {
    return this.#outbox.failures();
  }

  /**
   * Disconnect (spec §Moving from solo to a relay, step 6): own active claims
   * become the local person's again; everyone else's rows stay, marked as last
   * seen from the relay. Nothing is deleted.
   */
  /** Before leaving: one best-effort pass at the outbox, bounded by `timeoutMs`. */
  async drainBeforeLeaving(timeoutMs = 3000): Promise<void> {
    if (this.#outbox.count() === 0) return;
    await Promise.race([
      this.#outbox.drain((row) => this.#send(row)).catch(() => false),
      new Promise((resolve) => { setTimeout(resolve, timeoutMs).unref?.(); }),
    ]);
  }

  handBack(local: LocalCoordination): void {
    const localMe = local.me();
    const me = this.#opts.memberId;
    this.store.tx(() => {
      for (const c of this.store.activeClaims()) {
        if (c.memberId === me) {
          this.store.stmt(`UPDATE coord_claims SET member_id = ?, device_id = ? WHERE id = ?`).run(localMe.memberId, localMe.deviceId, c.id);
          writeClaimSync(this.store, c.id, { sync: 'confirmed', note: null });
        } else {
          writeClaimSync(this.store, c.id, { note: 'Last seen from the relay.' });
        }
      }
      // Nothing is deleted: what the relay never heard about stays, marked, for Settings to show.
      this.store.stmt(`UPDATE coord_outbox SET failed_at = COALESCE(failed_at, ?), last_error = COALESCE(last_error || ' ', '') || ? WHERE failed_at IS NULL`)
        .run(this.store.now(), ABANDONED);
      for (const key of ['relay_seq', 'relay_member_ids', 'relay_team', 'relay_role', 'relay_clock_offset_ms', 'relay_imported']) {
        this.store.stmt(`DELETE FROM coord_meta WHERE key = ?`).run(key);
      }
    });
  }
}
