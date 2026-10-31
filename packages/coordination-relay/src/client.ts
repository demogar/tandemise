import {
  RELAY_API_HEADER, RELAY_API_VERSION,
  type ClaimRequest, type ClaimView, type CreateEndpointRequest, type CreateInviteRequest, type CreateInviteResponse, type EndpointView,
  type ImportReport, type LeaseRequest, type LeaseView, type MailboxAckResponse, type MailboxMessage, type RedeemInviteRequest, type RedeemInviteResponse,
  type RelayErrorBody, type RelaySnapshot,
} from '@tandemise/api-contract/relay';

/** A relay answered, and not with 2xx. `body` is the daemon-style error envelope. */
export class RelayHttpError extends Error {
  constructor(readonly status: number, readonly body: RelayErrorBody | null) {
    super(body?.error.message ?? `The relay answered ${status}.`);
    this.name = 'RelayHttpError';
  }

  get reason(): string | undefined {
    const r = this.body?.error.details['reason'];
    return typeof r === 'string' ? r : undefined;
  }

  /** Worth trying again later: the relay is struggling or rate-limiting, not refusing. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

/** The relay could not be reached at all. */
export class RelayUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`The team relay can't be reached (${cause instanceof Error ? cause.message : String(cause)}).`);
    this.name = 'RelayUnreachableError';
  }
}

export const isOffline = (e: unknown): boolean => e instanceof RelayUnreachableError || (e instanceof RelayHttpError && e.retryable);

export interface RelayClientOptions {
  readonly baseUrl: string;
  readonly token: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/**
 * The relay's HTTP API, typed per route (spec §Protocol). Every request sets
 * the device token and `x-tandemise-relay-api`; the token never goes in a URL.
 */
export class RelayClient {
  readonly baseUrl: string;
  readonly #token: () => Promise<string>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(opts: RelayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async #call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { [RELAY_API_HEADER]: RELAY_API_VERSION };
    if (auth) headers['authorization'] = `Bearer ${await this.#token()}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}${path}`, {
        method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      throw new RelayUnreachableError(e);
    }
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const envelope = json && typeof json === 'object' && 'error' in json ? (json as RelayErrorBody) : null;
      throw new RelayHttpError(res.status, envelope);
    }
    return json as T;
  }

  health(): Promise<{ ok: boolean; apiVersion: string }> { return this.#call('GET', '/relay/v1/health', undefined, false); }
  redeem(req: RedeemInviteRequest): Promise<RedeemInviteResponse> { return this.#call('POST', '/relay/v1/invites/redeem', req, false); }
  snapshot(projects?: readonly string[]): Promise<RelaySnapshot> {
    return this.#call('GET', `/relay/v1/snapshot${projects && projects.length ? `?projects=${encodeURIComponent(projects.join(','))}` : ''}`);
  }
  claim(req: ClaimRequest): Promise<ClaimView> { return this.#call('POST', '/relay/v1/claims', req); }
  release(id: string, reason: 'done' | 'released'): Promise<ClaimView> { return this.#call('POST', `/relay/v1/claims/${encodeURIComponent(id)}/release`, { reason }); }
  takeOver(id: string, localRef: string): Promise<ClaimView> { return this.#call('POST', `/relay/v1/claims/${encodeURIComponent(id)}/take-over`, { localRef }); }
  lease(req: LeaseRequest): Promise<LeaseView> { return this.#call('POST', '/relay/v1/leases', req); }
  history(project: string, item: string): Promise<ClaimView[]> {
    return this.#call('GET', `/relay/v1/claims?project=${encodeURIComponent(project)}&item=${encodeURIComponent(item)}`);
  }
  createInvite(req: CreateInviteRequest): Promise<CreateInviteResponse> { return this.#call('POST', '/relay/v1/invites', req); }
  removeMember(id: string): Promise<void> { return this.#call('DELETE', `/relay/v1/members/${encodeURIComponent(id)}`); }
  revokeDevice(id: string): Promise<void> { return this.#call('DELETE', `/relay/v1/devices/${encodeURIComponent(id)}`); }
  createEndpoint(req: CreateEndpointRequest): Promise<EndpointView> { return this.#call('POST', '/relay/v1/endpoints', req); }
  endpoints(): Promise<EndpointView[]> { return this.#call('GET', '/relay/v1/endpoints'); }
  disableEndpoint(id: string): Promise<void> { return this.#call('POST', `/relay/v1/endpoints/${encodeURIComponent(id)}/disable`); }
  pull(project: string, max: number, leaseSeconds: number): Promise<MailboxMessage[]> { return this.#call('POST', '/relay/v1/mailbox/pull', { project, max, leaseSeconds }); }
  ack(ids: readonly string[]): Promise<MailboxAckResponse> { return this.#call('POST', '/relay/v1/mailbox/ack', { ids }); }
  parked(): Promise<{ id: string; endpointId: string; receivedAt: string; lastDeviceId: string | null }[]> { return this.#call('GET', '/relay/v1/mailbox/parked'); }
  retryParked(id: string): Promise<void> { return this.#call('POST', `/relay/v1/mailbox/${encodeURIComponent(id)}/retry`); }
  dropParked(id: string): Promise<void> { return this.#call('POST', `/relay/v1/mailbox/${encodeURIComponent(id)}/drop`); }
  importLines(lines: readonly string[]): Promise<ImportReport> { return this.#call('POST', '/relay/v1/import', { lines }); }
}
