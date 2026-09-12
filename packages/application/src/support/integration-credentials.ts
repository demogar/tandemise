import type { Integration, IntegrationRepositoryPort, SecretStorePort } from '@tandemise/domain';
import type {
  IntegrationCredential, IntegrationCredentialSource, IntegrationProviderRegistry,
} from '@tandemise/integrations-core';
import { IntegrationUnauthorizedError } from '@tandemise/integrations-core';
import type { Clock, IntegrationId, Logger } from '@tandemise/shared';
import { errorMessage } from '@tandemise/shared';

/** Refresh this long before a token lapses, so a call never starts on one that will. */
const REFRESH_MARGIN_MS = 60_000;
const REFRESH_TIMEOUT_MS = 30_000;

export interface IntegrationCredentialsDeps {
  readonly secrets: SecretStorePort;
  readonly integrations: IntegrationRepositoryPort;
  readonly providers: IntegrationProviderRegistry;
  readonly clock: Clock;
  readonly log: Logger;
}

/**
 * Access tokens for connected integrations, kept fresh without the user.
 *
 * The whole credential - access token, refresh token, the client registered for
 * this install - is one JSON value in the OS credential store; the integration
 * row holds only its reference (MVP.md §P8). Providers ask this for an access
 * token and never see the rest.
 *
 * Refreshes are single-flight per integration. A worker firing three tool calls
 * at a server whose token just lapsed would otherwise refresh three times, and
 * a server that rotates refresh tokens invalidates the first two the moment the
 * third lands - leaving the integration disconnected by its own retries.
 */
export class IntegrationCredentials implements IntegrationCredentialSource {
  readonly #resolving = new Map<IntegrationId, Promise<string | null>>();
  readonly #stale = new Set<IntegrationId>();

  constructor(private readonly deps: IntegrationCredentialsDeps) {}

  async accessToken(integration: Integration, signal: AbortSignal): Promise<string | null> {
    // Registered before the first await. The keychain read runs a CLI and takes
    // tens of milliseconds; checking the map before it and filling it after let
    // concurrent callers all slip through and all refresh.
    const inFlight = this.#resolving.get(integration.id);
    if (inFlight !== undefined) return inFlight;
    const resolving = this.#resolve(integration).finally(() => this.#resolving.delete(integration.id));
    this.#resolving.set(integration.id, resolving);
    // Callers wait on the shared resolution, but their own cancellation only
    // abandons their wait - it must not cancel a refresh others depend on.
    return abandonable(resolving, signal);
  }

  async #resolve(integration: Integration): Promise<string | null> {
    // Re-read the row: a refresh elsewhere may have replaced the reference
    // since the caller loaded this integration.
    const current = this.deps.integrations.get(integration.id) ?? integration;
    if (current.credentialRef === null) return null;
    const credential = await this.#read(current.credentialRef);
    if (credential === null) {
      throw new IntegrationUnauthorizedError(`${current.name} is not connected any more. Reconnect it.`);
    }
    const lapsing = credential.expiresAt !== null
      && Date.parse(credential.expiresAt) - this.deps.clock.epochMs() < REFRESH_MARGIN_MS;
    if (!lapsing && !this.#stale.has(current.id)) return credential.accessToken;
    return this.#refresh(current, credential);
  }

  invalidate(integration: Integration): void {
    this.#stale.add(integration.id);
  }

  /** Stores a new credential for an integration, replacing and removing any previous one. */
  async replace(integration: Integration, credential: IntegrationCredential): Promise<Integration> {
    const ref = await this.deps.secrets.store(`integration:${integration.id}`, JSON.stringify(credential));
    const previous = this.deps.integrations.get(integration.id)?.credentialRef ?? null;
    const updated = this.deps.integrations.update(integration.id, {
      credentialRef: ref,
      updatedAt: this.deps.clock.now(),
    });
    this.#stale.delete(integration.id);
    if (previous !== null && previous !== ref) {
      await this.deps.secrets.remove(previous).catch((e: unknown) => {
        this.deps.log.warn('integration.old_credential_not_removed', {
          integrationId: integration.id, error: errorMessage(e),
        });
      });
    }
    return updated;
  }

  /** The account label, for the UI. Never the token. */
  async account(integration: Integration): Promise<string | null> {
    if (integration.credentialRef === null) return null;
    return (await this.#read(integration.credentialRef))?.account ?? null;
  }

  async #refresh(integration: Integration, credential: IntegrationCredential): Promise<string | null> {
    const authorizer = this.deps.providers.get(integration.providerId)?.authorizer;
    // Its own deadline, not a caller's signal: one cancelled tool call must not
    // abort the refresh every concurrent call is waiting on.
    const refreshed = authorizer === undefined ? null : await authorizer.refresh(credential, AbortSignal.timeout(REFRESH_TIMEOUT_MS));
    if (refreshed === null) {
      this.deps.log.info('integration.needs_reconnect', { integrationId: integration.id });
      throw new IntegrationUnauthorizedError(
        `${integration.name}'s access expired and could not be renewed. Reconnect it from Integrations.`,
      );
    }
    await this.replace(integration, { ...refreshed, account: refreshed.account ?? credential.account });
    this.deps.log.debug('integration.token_refreshed', { integrationId: integration.id });
    return refreshed.accessToken;
  }

  async #read(ref: string): Promise<IntegrationCredential | null> {
    const raw = await this.deps.secrets.resolve(ref);
    if (raw === undefined) return null;
    try {
      const parsed = JSON.parse(raw) as IntegrationCredential;
      return typeof parsed.accessToken === 'string' ? parsed : null;
    } catch {
      // A plain token pasted by the user before connectors existed. It is its
      // own access token and cannot be refreshed.
      return { accessToken: raw, expiresAt: null, account: null, data: {} };
    }
  }
}

/** Resolves as `promise` does, or rejects when `signal` aborts first - without cancelling `promise`. */
function abandonable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
