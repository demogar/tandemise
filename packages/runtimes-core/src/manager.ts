import type {
  AgentEvent, RuntimeCapability, RuntimeDiscovery, RuntimeHealth, RuntimeProfile,
} from '@tandemise/domain';
import { Err, Ok, TandemiseError, errorMessage, nullLogger, systemClock } from '@tandemise/shared';
import type { Clock, Logger, Result, RunId, RuntimeProfileId } from '@tandemise/shared';
import { token } from '@tandemise/kernel';
import type { AgentRuntimeAdapter, RunRequest } from './adapter.js';
import type { RuntimeRegistry } from './registry.js';

/** How long a health probe is reused. Short enough for a polling UI to feel live. */
export const DEFAULT_HEALTH_TTL_MS = 10_000;

export interface RuntimeSelection {
  readonly profile: RuntimeProfile;
  readonly adapter: AgentRuntimeAdapter;
  readonly health: RuntimeHealth;
}

/** Why a candidate was passed over. Surfaced verbatim so routing is explainable. */
export interface RuntimeRejection {
  readonly profileId: RuntimeProfileId;
  readonly reason: string;
}

export interface RuntimeSelectionFailure {
  readonly requiredCapabilities: readonly RuntimeCapability[];
  readonly rejections: readonly RuntimeRejection[];
}

export interface RuntimeManagerOptions {
  readonly registry: RuntimeRegistry;
  readonly clock?: Clock;
  readonly log?: Logger;
  readonly healthTtlMs?: number;
}

interface CachedHealth {
  readonly health: RuntimeHealth;
  readonly expiresAt: number;
  /** Invalidates when the profile itself is edited, not only on TTL expiry. */
  readonly revision: string;
}

/**
 * Discovery, health, concurrency and capability routing for every runtime
 * (MVP.md §9.4, §10).
 *
 * The manager is deliberately vendor-blind: it reads `profile.adapterId`,
 * resolves it through the registry, and asks the adapter what it can do. There
 * is no branch anywhere in this class on a runtime's name, which is the
 * property that lets a mission be re-run on a different worker without the
 * scheduler changing (MVP.md §P2).
 */
export class RuntimeManager {
  readonly #registry: RuntimeRegistry;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #healthTtlMs: number;
  readonly #health = new Map<RuntimeProfileId, CachedHealth>();
  readonly #inFlight = new Map<RuntimeProfileId, number>();

  constructor(options: RuntimeManagerOptions) {
    this.#registry = options.registry;
    this.#clock = options.clock ?? systemClock;
    this.#log = options.log ?? nullLogger;
    this.#healthTtlMs = options.healthTtlMs ?? DEFAULT_HEALTH_TTL_MS;
  }

  get registry(): RuntimeRegistry {
    return this.#registry;
  }

  /**
   * Probes every adapter for a locally installed runtime. Used by onboarding
   * and by Settings → Runtimes; failures are reported as `detected: false`
   * rather than thrown, because one broken adapter must not hide the others.
   */
  async discoverAll(): Promise<readonly RuntimeDiscovery[]> {
    return Promise.all(this.#registry.all().map(async ({ adapter }) => {
      try {
        return await adapter.discover();
      } catch (e) {
        this.#log.warn('runtime discovery failed', { runtime: adapter.id, error: errorMessage(e) });
        return {
          adapterId: adapter.id,
          displayName: adapter.displayName,
          detected: false,
          executablePath: null,
          version: null,
          capabilities: [],
          detail: `Discovery failed: ${errorMessage(e)}`,
          suggestedSettings: {},
        } satisfies RuntimeDiscovery;
      }
    }));
  }

  capabilities(profile: RuntimeProfile): readonly RuntimeCapability[] {
    const adapter = this.#registry.tryAdapter(profile.adapterId);
    return adapter ? adapter.capabilities(profile) : [];
  }

  /**
   * Health for one profile, cached for `healthTtlMs`. The UI polls this; a
   * cache miss costs a process spawn, so an uncached poll loop would spawn a
   * `--version` child several times a second.
   */
  async health(profile: RuntimeProfile, options: { refresh?: boolean } = {}): Promise<RuntimeHealth> {
    const revision = `${profile.adapterId}@${profile.updatedAt}`;
    const cached = this.#health.get(profile.id);
    if (!options.refresh && cached && cached.revision === revision && cached.expiresAt > this.#clock.epochMs()) {
      return cached.health;
    }

    const adapter = this.#registry.tryAdapter(profile.adapterId);
    const health = adapter
      ? await this.#probe(adapter, profile)
      : this.#unavailable(profile, `No adapter registered for '${profile.adapterId}'`);

    this.#health.set(profile.id, { health, revision, expiresAt: this.#clock.epochMs() + this.#healthTtlMs });
    return health;
  }

  /** Drops cached health, e.g. after the user edits a profile's executable path. */
  invalidateHealth(profileId?: RuntimeProfileId): void {
    if (profileId === undefined) this.#health.clear();
    else this.#health.delete(profileId);
  }

  inFlight(profileId: RuntimeProfileId): number {
    return this.#inFlight.get(profileId) ?? 0;
  }

  isSaturated(profile: RuntimeProfile): boolean {
    return this.inFlight(profile.id) >= Math.max(1, profile.maxConcurrent);
  }

  /**
   * Capability routing (MVP.md §9.4): the first candidate that is enabled, has
   * a registered adapter, offers every required capability, has spare
   * concurrency, and is healthy.
   *
   * Candidate order is the caller's preference order and is honoured, with one
   * refinement: a fully healthy profile always beats a degraded one, so a
   * runtime nursing a quota warning is used as a fallback rather than as the
   * first choice. Failure returns the per-candidate reasons, because "no
   * runtime available" with no explanation is the least actionable message an
   * orchestrator can produce.
   */
  async select(
    candidates: readonly RuntimeProfile[],
    requiredCapabilities: readonly RuntimeCapability[] = [],
  ): Promise<Result<RuntimeSelection, RuntimeSelectionFailure>> {
    const rejections: RuntimeRejection[] = [];
    const eligible: Array<{ profile: RuntimeProfile; adapter: AgentRuntimeAdapter }> = [];

    for (const profile of candidates) {
      const reason = this.#rejectCheaply(profile, requiredCapabilities);
      if (reason !== null) {
        rejections.push({ profileId: profile.id, reason });
        continue;
      }
      // Safe: `#rejectCheaply` returns a reason when the adapter is unknown.
      eligible.push({ profile, adapter: this.#registry.adapter(profile.adapterId) });
    }

    let degraded: RuntimeSelection | null = null;
    for (const { profile, adapter } of eligible) {
      const health = await this.health(profile);
      if (health.state === 'healthy') return Ok({ profile, adapter, health });
      if (health.state === 'degraded') {
        degraded ??= { profile, adapter, health };
        continue;
      }
      rejections.push({ profileId: profile.id, reason: `${health.state}: ${health.detail}` });
    }

    if (degraded !== null) {
      this.#log.warn('routing to a degraded runtime', {
        runtime: degraded.profile.adapterId,
        detail: degraded.health.detail,
      });
      return Ok(degraded);
    }
    return Err({ requiredCapabilities, rejections });
  }

  /**
   * Runs one attempt, holding a concurrency slot for the duration of the
   * stream. Callers should prefer this over `adapter.start` directly: the slot
   * is what `isSaturated` and therefore routing depend on.
   */
  start(request: RunRequest): AsyncIterable<AgentEvent> {
    const adapter = this.#registry.adapter(request.profile.adapterId);
    return this.#tracked(request.profile.id, adapter.start(request));
  }

  resume(sessionRef: string, request: RunRequest): AsyncIterable<AgentEvent> {
    const adapter = this.#registry.adapter(request.profile.adapterId);
    if (adapter.resume === undefined) {
      throw new TandemiseError('PRECONDITION_FAILED', `Runtime '${adapter.id}' cannot resume a session`, {
        details: { adapterId: adapter.id, sessionRef },
      });
    }
    return this.#tracked(request.profile.id, adapter.resume(sessionRef, request));
  }

  async cancel(profile: RuntimeProfile, runId: RunId): Promise<void> {
    await this.#registry.adapter(profile.adapterId).cancel(runId);
  }

  /** First-match-wins reasons that need no process spawn. */
  #rejectCheaply(profile: RuntimeProfile, required: readonly RuntimeCapability[]): string | null {
    if (!profile.enabled) return 'profile is disabled';
    const adapter = this.#registry.tryAdapter(profile.adapterId);
    if (adapter === undefined) return `no adapter registered for '${profile.adapterId}'`;
    const offered = new Set(adapter.capabilities(profile));
    const missing = required.filter((c) => !offered.has(c));
    if (missing.length > 0) return `missing capabilities: ${missing.join(', ')}`;
    if (this.isSaturated(profile)) {
      return `saturated: ${this.inFlight(profile.id)}/${profile.maxConcurrent} runs in flight`;
    }
    return null;
  }

  async #probe(adapter: AgentRuntimeAdapter, profile: RuntimeProfile): Promise<RuntimeHealth> {
    try {
      return await adapter.healthCheck(profile);
    } catch (e) {
      return this.#unavailable(profile, errorMessage(e));
    }
  }

  #unavailable(profile: RuntimeProfile, detail: string): RuntimeHealth {
    return {
      profileId: profile.id,
      state: 'unavailable',
      version: null,
      detail,
      checkedAt: this.#clock.now(),
      quotaWarning: null,
    };
  }

  async *#tracked(profileId: RuntimeProfileId, events: AsyncIterable<AgentEvent>): AsyncIterable<AgentEvent> {
    this.#inFlight.set(profileId, this.inFlight(profileId) + 1);
    try {
      yield* events;
    } finally {
      const next = this.inFlight(profileId) - 1;
      if (next <= 0) this.#inFlight.delete(profileId);
      else this.#inFlight.set(profileId, next);
    }
  }
}

export const RUNTIME_MANAGER = token<RuntimeManager>('RuntimeManager');
