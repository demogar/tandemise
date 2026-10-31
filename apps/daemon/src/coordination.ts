import { hostname } from 'node:os';
import { TandemiseError, type Clock, type Logger } from '@tandemise/shared';
import type { SecretStorePort } from '@tandemise/domain';
import { Outbox } from '@tandemise/coordination-relay';
import type {
  ClaimResult, ClaimSync, CoordinationControlPort, CoordinationMe, CoordinationPort, CoordinationStatus, CoordinationTopic, SettingsStorePort,
} from '@tandemise/application';
import type {
  ClaimView, CoordDeviceView, CoordMemberView, CreateEndpointRequest, CreateInviteRequest, EndpointView, ImportReport, LeaseRequest, LeaseView, MailboxMessage, PresenceView,
} from '@tandemise/api-contract/relay';
import {
  ChangeEmitter, CoordinationStore, LocalCoordination, exportLines, filterWebhookHeaders, handshakeResponse, migrateCoordination, parkedMessages,
  migrateCoordinationDaemon, type SqlHandle,
} from '@tandemise/coordination';

/** The daemon settings file's `coordination` key. The device token itself is only ever in the secret store. */
export interface CoordinationSettings {
  readonly mode?: 'local' | 'relay';
  readonly relayUrl?: string;
  readonly deviceTokenRef?: string;
  readonly memberId?: string;
  readonly deviceId?: string;
  readonly teamName?: string;
  readonly allowInsecure?: boolean;
  readonly projectKeys?: Record<string, string>;
  readonly localHooksUnauthenticated?: boolean;
}

/** After this long without a pointer or key in any desktop window, you are away. */
export const PRESENCE_AWAY_MS = 600_000;
const PRESENCE_REPORT_MS = 30_000;

/** What the relay client gives the switch (Task 11 provides it; solo builds have none). */
export interface RelayHandle extends CoordinationPort {
  readonly mode: 'relay';
  readonly host: string;
  teamName(): string | null;
  start(): Promise<void>;
  stop(): void;
  reportPresence(status: 'online' | 'away'): void;
  offerImport(): boolean;
  importLocal(localLines: string[]): Promise<ImportReport>;
  createInvite(req: CreateInviteRequest): Promise<{ code: string; expiresAt: string }>;
  revokeDevice(id: string): Promise<void>;
  removeMember(id: string): Promise<void>;
  devices(): readonly CoordDeviceView[];
  createEndpoint(req: CreateEndpointRequest): Promise<EndpointView>;
  disableEndpoint(id: string): Promise<void>;
  retryParked(id: string): Promise<void>;
  dropParked(id: string): Promise<void>;
  endpoints(): readonly EndpointView[];
  parked(): Promise<{ id: string; endpointId: string; receivedAt: string; lastDeviceId: string | null }[]>;
  failures(): readonly { id: string; op: string; lastError: string }[];
  /** Back to solo: own active claims become local ones; other rows stay, marked as last seen from the relay. */
  handBack(local: LocalCoordination): void;
  /** One bounded, best-effort drain of the outbox before a disconnect. */
  drainBeforeLeaving(timeoutMs?: number): Promise<void>;
  /** On connect: own local claims become pending relay claims, sent with normal claim semantics. */
  adoptLocal(localMe: ReturnType<LocalCoordination['me']>): void;
}

export interface RelayFactoryInput {
  readonly store: CoordinationStore;
  readonly url: string;
  readonly token: () => Promise<string>;
  readonly settings: CoordinationSettings;
  readonly log: Logger;
}

export interface RelayConnectInput {
  readonly url: string;
  readonly code: string;
  readonly displayName: string;
  readonly deviceLabel: string;
}

export interface RelayFactory {
  /** Redeems an invite: `{ memberId, deviceId, deviceToken, team }`. */
  redeem(input: RelayConnectInput): Promise<{ memberId: string; deviceId: string; deviceToken: string; team: { id: string; name: string } }>;
  create(input: RelayFactoryInput): RelayHandle;
}

const SECRET_NAME = 'coordination.relay';

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.startsWith('127.');
}

/**
 * The daemon's one coordination object (relay spec, §Moving from solo to a
 * relay). It holds the current implementation, local or relay, and swaps
 * between them in place on connect and disconnect, without a restart. The
 * application binds `COORDINATION` and `COORDINATION_CONTROL` to it and never
 * learns which one answers.
 */
export class SwitchableCoordination implements CoordinationPort, CoordinationControlPort {
  readonly store: CoordinationStore;
  readonly #local: LocalCoordination;
  #relay: RelayHandle | null = null;
  readonly #emitter = new ChangeEmitter();
  readonly #settings: SettingsStorePort;
  readonly #secrets: SecretStorePort;
  readonly #log: Logger;
  readonly #factory: RelayFactory | null;
  readonly #setRelayHandle: (handle: string | null) => void;
  #presenceTimer: ReturnType<typeof setInterval> | null = null;
  /** A connect in flight: a second one is refused rather than racing it. */
  #connecting = false;

  constructor(opts: {
    db: SqlHandle;
    settings: SettingsStorePort;
    secrets: SecretStorePort;
    clock: Clock;
    log: Logger;
    localName: string;
    deviceLabel?: string;
    relayFactory?: RelayFactory | null;
    /** Records `people.handles.relay` for the local person. */
    setRelayHandle?: (handle: string | null) => void;
  }) {
    migrateCoordination(opts.db);
    migrateCoordinationDaemon(opts.db);
    this.store = new CoordinationStore(opts.db, () => new Date(opts.clock.now()));
    this.#settings = opts.settings;
    this.#secrets = opts.secrets;
    this.#log = opts.log.child({ component: 'coordination' });
    this.#factory = opts.relayFactory ?? null;
    this.#setRelayHandle = opts.setRelayHandle ?? (() => {});
    this.#local = new LocalCoordination(this.store, { displayName: opts.localName, deviceLabel: opts.deviceLabel ?? hostname() });
    this.#local.onChange((t) => this.#emitter.emit(t));
  }

  settings(): CoordinationSettings {
    return (this.#settings.read()['coordination'] as CoordinationSettings | undefined) ?? {};
  }

  #writeSettings(patch: Partial<CoordinationSettings>): void {
    this.#settings.write({ coordination: { ...this.settings(), ...patch } });
  }

  /** Reconnects to the relay recorded in settings, if any. Called once at boot. */
  async resume(): Promise<void> {
    const s = this.settings();
    if (s.mode !== 'relay' || !s.relayUrl || !s.deviceTokenRef || this.#factory === null) return;
    void this.#swapIn(this.#factory.create({ store: this.store, url: s.relayUrl, token: () => this.#token(), settings: s, log: this.#log }));
  }

  async #token(): Promise<string> {
    const ref = this.settings().deviceTokenRef;
    const token = ref ? await this.#secrets.resolve(ref) : undefined;
    if (!token) throw new TandemiseError('PRECONDITION_FAILED', 'The team relay token is missing. Disconnect and connect again.');
    return token;
  }

  #swapIn(relay: RelayHandle): Promise<void> {
    this.#relay = relay;
    relay.onChange((t) => this.#emitter.emit(t));
    this.#emitter.emit('claims');
    return relay.start().catch((e: unknown) => this.#log.warn('relay.start_failed', { error: String(e) }));
  }

  #current(): CoordinationPort {
    return this.#relay ?? this.#local;
  }

  /** Where local webhook URLs point: this daemon's own `/v1`. */
  setHooksBase(base: string): void {
    this.store.hooksBase = base;
  }

  /** Reports "online"/"away" to the relay every 30 s from the desktop's activity. */
  startPresence(desktopPresence: () => 'online' | 'away' | null): void {
    this.stopPresence();
    this.#presenceTimer = setInterval(() => {
      const p = desktopPresence();
      if (p !== null) this.#relay?.reportPresence(p);
    }, PRESENCE_REPORT_MS);
    this.#presenceTimer.unref();
  }

  stopPresence(): void {
    if (this.#presenceTimer !== null) clearInterval(this.#presenceTimer);
    this.#presenceTimer = null;
  }

  close(): void {
    this.stopPresence();
    this.#relay?.stop();
  }

  // ---- CoordinationPort

  get mode(): 'local' | 'relay' {
    return this.#relay === null ? 'local' : 'relay';
  }

  status(): CoordinationStatus { return this.#current().status(); }
  me(): CoordinationMe { return this.#current().me(); }
  claim(input: Parameters<CoordinationPort['claim']>[0]): Promise<ClaimResult> { return this.#current().claim(input); }
  release(claimId: string, reason: 'done' | 'released'): Promise<void> { return this.#current().release(claimId, reason); }
  takeOver(claimId: string, localRef: string): Promise<ClaimResult> { return this.#current().takeOver(claimId, localRef); }
  /** A source's lease (intake spec §3, Ruling 22): the relay's when connected; solo, always granted. */
  async lease(input: LeaseRequest): Promise<LeaseView> {
    const current = this.#current();
    return current.lease === undefined
      ? { granted: true, expiresAt: new Date(Date.parse(this.store.now()) + input.ttlSeconds * 1000).toISOString(), holderName: null, deviceLabel: null }
      : current.lease(input);
  }
  claims(projectKey?: string): readonly ClaimView[] { return this.#current().claims(projectKey); }
  claimByLocalRef(localRef: string): ClaimView | null { return this.#current().claimByLocalRef(localRef); }
  members(): readonly CoordMemberView[] { return this.#current().members(); }
  presence(): readonly PresenceView[] { return this.#current().presence(); }
  holderLastSeenAt(memberId: string): string | null { return this.#current().holderLastSeenAt(memberId); }
  claimSync(claimId: string): ClaimSync { return this.#current().claimSync(claimId); }
  keepGoing(claimId: string): void { this.#current().keepGoing(claimId); }
  markLost(localRef: string, note: string): void { this.#current().markLost(localRef, note); }
  onChange(listener: (topic: CoordinationTopic) => void): () => void { return this.#emitter.on(listener); }
  readonly mailbox = {
    pull: (projectKey: string, max: number, leaseSeconds?: number): Promise<readonly MailboxMessage[]> => this.#current().mailbox.pull(projectKey, max, leaseSeconds),
    ack: (ids: readonly string[]) => this.#current().mailbox.ack(ids),
  };

  // ---- CoordinationControlPort

  host(): string | null {
    return this.#relay?.host ?? null;
  }

  teamName(): string | null {
    return this.#relay?.teamName() ?? null;
  }

  async connect(input: { url: string; code: string; displayName: string; deviceLabel: string; allowInsecure: boolean }): Promise<CoordinationStatus> {
    if (this.#factory === null) throw new TandemiseError('PRECONDITION_FAILED', 'This build of Tandemise cannot connect to a team relay.');
    if (this.#relay !== null) throw new TandemiseError('CONFLICT', `You're already connected to ${this.#relay.host}. Disconnect first.`);
    if (this.#connecting) throw new TandemiseError('CONFLICT', 'Already connecting to a team relay. Wait for it to finish.');
    this.#connecting = true;
    try {
      return await this.#connect(input);
    } finally {
      this.#connecting = false;
    }
  }

  async #connect(input: { url: string; code: string; displayName: string; deviceLabel: string; allowInsecure: boolean }): Promise<CoordinationStatus> {
    const factory = this.#factory!;
    let url: URL;
    try {
      url = new URL(input.url.trim());
    } catch {
      throw TandemiseError.validation("That isn't a web address. It looks like https://relay.example.com.");
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw TandemiseError.validation("That isn't a web address. It looks like https://relay.example.com.");
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && !input.allowInsecure) {
      throw TandemiseError.validation('This relay address isn\'t encrypted. Use https://, or tick "I understand this is unencrypted".', { reason: 'insecure_url' });
    }
    const base = url.origin;
    const joined = await factory.redeem({ url: base, code: input.code, displayName: input.displayName, deviceLabel: input.deviceLabel });
    const ref = await this.#secrets.store(SECRET_NAME, joined.deviceToken);
    this.#writeSettings({
      mode: 'relay', relayUrl: base, deviceTokenRef: ref, memberId: joined.memberId, deviceId: joined.deviceId,
      teamName: joined.team.name, allowInsecure: input.allowInsecure,
    });
    this.#setRelayHandle(`${url.host}/${joined.memberId}`);
    const relay = factory.create({ store: this.store, url: base, token: () => this.#token(), settings: this.settings(), log: this.#log });
    relay.adoptLocal(this.#local.me());
    await this.#swapIn(relay);
    return relay.status();
  }

  offerImport(): boolean {
    return this.#relay?.offerImport() ?? false;
  }

  async importLocal(): Promise<ImportReport> {
    if (this.#relay === null) throw new TandemiseError('PRECONDITION_FAILED', 'Connect to a team relay first.');
    return this.#relay.importLocal(exportLines(this.store, { claimsOf: this.#relay.me().memberId }));
  }

  async disconnect(): Promise<void> {
    const relay = this.#relay;
    if (relay === null) return;
    await relay.drainBeforeLeaving(3000);
    relay.stop();
    relay.handBack(this.#local);
    this.#relay = null;
    const ref = this.settings().deviceTokenRef;
    if (ref) await this.#secrets.remove(ref).catch(() => undefined);
    this.#writeSettings({ mode: 'local', relayUrl: undefined, deviceTokenRef: undefined, memberId: undefined, deviceId: undefined, teamName: undefined });
    this.#setRelayHandle(null);
    this.#emitter.emit('claims');
    this.#emitter.emit('members');
  }

  #relayOnly(): RelayHandle {
    if (this.#relay === null) throw new TandemiseError('PRECONDITION_FAILED', 'Connect to a team relay first.');
    return this.#relay;
  }

  createInvite(req: CreateInviteRequest) { return this.#relayOnly().createInvite(req); }
  revokeDevice(id: string) { return this.#relayOnly().revokeDevice(id); }
  removeMember(id: string) { return this.#relayOnly().removeMember(id); }
  devices(): readonly CoordDeviceView[] { return this.#relay?.devices() ?? this.store.devices(); }

  async createEndpoint(req: CreateEndpointRequest): Promise<EndpointView> {
    if (this.#relay !== null) return this.#relay.createEndpoint(req);
    return this.store.createEndpoint({ ...req, createdBy: this.#local.me().memberId });
  }

  async disableEndpoint(id: string): Promise<void> {
    if (this.#relay !== null) return this.#relay.disableEndpoint(id);
    this.store.disableEndpoint(id);
  }

  async retryParked(id: string): Promise<void> {
    if (this.#relay !== null) return this.#relay.retryParked(id);
    this.store.retryParked(id);
  }

  async dropParked(id: string): Promise<void> {
    if (this.#relay !== null) return this.#relay.dropParked(id);
    this.store.dropParked(id);
  }

  endpoints(): readonly EndpointView[] {
    return this.#relay?.endpoints() ?? this.store.endpoints();
  }

  async parked() {
    return this.#relay !== null ? this.#relay.parked() : parkedMessages(this.store);
  }

  failures() {
    return this.#relay?.failures() ?? new Outbox(this.store).failures();
  }

  exportLines(): string[] {
    return exportLines(this.store);
  }

  /**
   * The daemon's own webhook ingress (spec §The webhook mailbox, "Solo"):
   * a local runner or a tunnel the person set up drops a request into the
   * local mailbox. Unknown and disabled slugs answer the same.
   */
  ingestLocal(slug: string, req: { method: string; query: URLSearchParams; headers: Record<string, string | string[] | undefined>; body: Buffer }):
    { status: number; contentType: string; body: string } {
    const notFound = { status: 404, contentType: 'text/plain; charset=utf-8', body: 'Not found' };
    if (this.#relay !== null) return notFound;
    const endpoint = this.store.endpointBySlug(slug);
    if (endpoint === null) return notFound;
    const contentType = (req.headers['content-type'] as string | undefined) ?? null;
    const hs = handshakeResponse({ handshake: endpoint.handshake, handshakeSecret: endpoint.handshake_secret }, { method: req.method, query: req.query, contentType, body: req.body });
    if (hs !== null) return hs;
    this.store.storeRequest(endpoint.id, { method: req.method, query: req.query.toString(), headers: filterWebhookHeaders(req.headers), contentType, body: req.body });
    this.#emitter.emit('mailbox');
    return { status: 202, contentType: 'text/plain; charset=utf-8', body: '' };
  }
}
