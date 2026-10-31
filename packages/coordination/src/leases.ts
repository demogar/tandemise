import type { LeaseView } from '@tandemise/api-contract/relay';

/**
 * Short leases (intake spec §3, Ruling 22): "a daemon runs a poll or socket
 * runner only while it holds the claim ('source', sourceId), a lease with a
 * heartbeat (TTL 2 minutes, renewed every 30 seconds). Another daemon takes
 * over when the lease lapses." Unlike an item claim, a lease is not a fact
 * about the team's work: it lives in memory and is gone on a restart, when
 * the next renewal takes it again. The relay holds one table; a solo daemon
 * needs none (it is the only one running its sources).
 */
export interface LeaseHolder {
  readonly memberId: string;
  readonly memberName: string;
  readonly deviceId: string;
  readonly deviceLabel: string;
}

export type LeaseOutcome =
  | { readonly granted: true; readonly expiresAt: string }
  | { readonly granted: false; readonly holder: LeaseHolder; readonly expiresAt: string };

export const LEASE_SCOPES = ['source'] as const;

/**
 * Live leases one device may hold at once. A daemon holds one per source it
 * runs; this only stops a buggy or hostile device from filling the relay's
 * memory (the table is never persisted).
 */
export const MAX_LEASES_PER_DEVICE = 200;

/** Thrown by `take` when a device would hold more than `MAX_LEASES_PER_DEVICE` live leases. */
export class LeaseLimitError extends Error {
  constructor() {
    super(`This device already holds ${MAX_LEASES_PER_DEVICE} source leases; let some go before taking more.`);
    this.name = 'LeaseLimitError';
  }
}
export type LeaseScope = (typeof LEASE_SCOPES)[number];

interface Lease {
  readonly holder: LeaseHolder;
  readonly expiresAtMs: number;
}

export class LeaseTable {
  readonly #leases = new Map<string, Lease>();
  readonly #clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.#clock = clock;
  }

  /**
   * Takes or renews `(projectKey, scope, key)` for `ttlMs`. The device that
   * holds a live lease renews it; anyone takes a lapsed one; everyone else is
   * refused with the holder.
   */
  take(input: { readonly projectKey: string; readonly scope: LeaseScope; readonly key: string; readonly ttlMs: number; readonly holder: LeaseHolder }): LeaseOutcome {
    const now = this.#clock().getTime();
    const id = leaseId(input.projectKey, input.scope, input.key);
    const current = this.#leases.get(id);
    if (current !== undefined && current.expiresAtMs > now && current.holder.deviceId !== input.holder.deviceId) {
      return { granted: false, holder: current.holder, expiresAt: new Date(current.expiresAtMs).toISOString() };
    }
    this.#sweep(now);
    const renewing = current !== undefined && current.expiresAtMs > now && current.holder.deviceId === input.holder.deviceId;
    if (!renewing && this.#liveFor(input.holder.deviceId) >= MAX_LEASES_PER_DEVICE) throw new LeaseLimitError();
    const expiresAtMs = now + input.ttlMs;
    this.#leases.set(id, { holder: input.holder, expiresAtMs });
    return { granted: true, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /** Lets a lease go early; only its device may. */
  release(input: { readonly projectKey: string; readonly scope: LeaseScope; readonly key: string; readonly deviceId: string }): void {
    const id = leaseId(input.projectKey, input.scope, input.key);
    if (this.#leases.get(id)?.holder.deviceId === input.deviceId) this.#leases.delete(id);
  }

  #liveFor(deviceId: string): number {
    let n = 0;
    for (const lease of this.#leases.values()) if (lease.holder.deviceId === deviceId) n++;
    return n;
  }

  #sweep(now: number): void {
    for (const [id, lease] of this.#leases) if (lease.expiresAtMs <= now) this.#leases.delete(id);
  }
}

function leaseId(projectKey: string, scope: LeaseScope, key: string): string {
  return `${projectKey}\u0000${scope}\u0000${key}`;
}

/** The wire answer (`POST /relay/v1/leases`). */
export function leaseView(outcome: LeaseOutcome): LeaseView {
  return outcome.granted
    ? { granted: true, expiresAt: outcome.expiresAt, holderName: null, deviceLabel: null }
    : { granted: false, expiresAt: outcome.expiresAt, holderName: outcome.holder.memberName, deviceLabel: outcome.holder.deviceLabel };
}
