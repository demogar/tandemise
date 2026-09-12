import { randomBytes } from 'node:crypto';
import type { Integration, IntegrationRepositoryPort, WorkspaceRepositoryPort } from '@tandemise/domain';
import type {
  ConnectIntegrationRequest, ConnectionAttemptView, ConnectionStatus,
} from '@tandemise/api-contract';
import type {
  IntegrationConnector, IntegrationProvider, IntegrationProviderRegistry,
} from '@tandemise/integrations-core';
import type { Clock, IntegrationId, Logger, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId, errorMessage, ids } from '@tandemise/shared';
import type { OAuthCallbackPort } from '../ports.js';
import type { IntegrationCredentials } from '../support/integration-credentials.js';

/** How long a person has to finish consenting before the attempt is abandoned. */
export const CONNECT_TIMEOUT_MS = 10 * 60_000;

/** Settled attempts are kept this long so a slow poll still sees the outcome. */
const SETTLED_RETENTION_MS = 10 * 60_000;

export interface ConnectFlowDeps {
  readonly integrations: IntegrationRepositoryPort;
  readonly workspaces: WorkspaceRepositoryPort;
  readonly providers: IntegrationProviderRegistry;
  readonly credentials: IntegrationCredentials;
  readonly callbacks: OAuthCallbackPort;
  /** Runs the new integration's health check, which is also when its tools are discovered. */
  readonly checkHealth: (id: IntegrationId) => Promise<unknown>;
  readonly clock: Clock;
  readonly log: Logger;
}

interface Attempt {
  view: ConnectionAttemptView;
  readonly abort: AbortController;
}

/**
 * Connecting an account by consent, start to finish.
 *
 * The provider knows the protocol and nothing about attempts; this knows
 * attempts and nothing about any vendor. One attempt is:
 *
 *   1. open a loopback listener that exists for this attempt alone;
 *   2. have the provider build the consent URL, bound to an unguessable state;
 *   3. hand the URL to the desktop, which opens the user's browser;
 *   4. wait for the redirect, ignoring anything that does not carry the state;
 *   5. exchange, store the credential in the OS store, create (or reconnect)
 *      the integration, and discover its tools;
 *   6. tell the browser tab what happened, and close the listener.
 *
 * Attempts live in memory. A daemon restart mid-consent loses the listener the
 * browser would have come back to, so there is nothing to resume - the user
 * clicks Connect again, which is honest and cheap.
 */
export class ConnectFlow {
  readonly #attempts = new Map<string, Attempt>();

  constructor(private readonly deps: ConnectFlowDeps) {}

  connectors(): readonly IntegrationConnector[] {
    return this.deps.providers.connectors();
  }

  async start(request: ConnectIntegrationRequest): Promise<ConnectionAttemptView> {
    const workspaceId = asId<'WorkspaceId'>(request.workspaceId);
    if (this.deps.workspaces.get(workspaceId) === undefined) {
      throw TandemiseError.notFound('Workspace', workspaceId);
    }
    const target = this.#resolve(request, workspaceId);
    const authorizer = target.provider.authorizer;
    if (authorizer === undefined) {
      throw TandemiseError.validation(`${target.provider.displayName} is not connected through a consent screen.`);
    }
    const parsed = target.provider.configSchema.safeParse(target.config);
    if (!parsed.success) {
      throw TandemiseError.validation(`That configuration for ${target.provider.displayName} is invalid.`, {
        issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      });
    }

    const abort = new AbortController();
    const timeout = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
    const signal = AbortSignal.any([abort.signal, timeout]);
    const listener = await this.deps.callbacks.open();
    const state = randomBytes(24).toString('base64url');

    let start;
    try {
      start = await authorizer.begin({
        config: parsed.data as Record<string, unknown>,
        redirectUri: listener.redirectUri,
        state,
        signal,
      });
    } catch (e) {
      listener.close();
      throw TandemiseError.validation(`Could not start connecting ${target.name}: ${errorMessage(e)}`);
    }

    const attempt: Attempt = {
      abort,
      view: {
        id: randomBytes(12).toString('base64url'),
        status: 'waiting',
        name: target.name,
        connectorId: target.connectorId,
        authorizationUrl: start.authorizationUrl,
        integrationId: target.existing?.id ?? null,
        error: null,
        startedAt: this.deps.clock.now(),
      },
    };
    this.#attempts.set(attempt.view.id, attempt);
    this.#prune();

    void this.#finish(attempt, {
      listener, state, signal, timeout, session: start.session, provider: target.provider,
      workspaceId, config: parsed.data as Record<string, unknown>, existing: target.existing,
    });
    return attempt.view;
  }

  get(id: string): ConnectionAttemptView {
    const attempt = this.#attempts.get(id);
    if (attempt === undefined) throw TandemiseError.notFound('Connection attempt', id);
    return attempt.view;
  }

  cancel(id: string): ConnectionAttemptView {
    const attempt = this.#attempts.get(id);
    if (attempt === undefined) throw TandemiseError.notFound('Connection attempt', id);
    if (attempt.view.status === 'waiting') {
      this.#settle(attempt, 'cancelled', null);
      attempt.abort.abort();
    }
    return attempt.view;
  }

  /** Aborts every attempt in flight, closing their listeners. */
  stop(): void {
    for (const attempt of this.#attempts.values()) attempt.abort.abort();
  }

  async #finish(attempt: Attempt, ctx: {
    listener: Awaited<ReturnType<OAuthCallbackPort['open']>>;
    state: string;
    signal: AbortSignal;
    timeout: AbortSignal;
    session: Readonly<Record<string, unknown>>;
    provider: IntegrationProvider;
    workspaceId: WorkspaceId;
    config: Record<string, unknown>;
    existing: Integration | null;
  }): Promise<void> {
    const { listener, signal } = ctx;
    try {
      for (;;) {
        const callback = await listener.next(signal);
        // Anything without this attempt's state is not the browser coming
        // back from consent - a stale tab, a probe - and must not end the
        // attempt or be exchanged.
        if (callback.params.get('state') !== ctx.state) {
          callback.respond({ ok: false, title: 'Not this request', message: 'This link does not belong to a connection in progress.' });
          continue;
        }
        this.#update(attempt, { status: 'connecting' });
        try {
          const credential = await ctx.provider.authorizer!.complete(ctx.session, callback.params, signal);
          const integration = ctx.existing ?? this.#create(ctx.workspaceId, ctx.provider, attempt.view.name, ctx.config);
          try {
            await this.deps.credentials.replace(integration, credential);
          } catch (e) {
            // A new row with no credential would sit in the list as "not
            // connected" for a connection that never happened.
            if (ctx.existing === null) this.deps.integrations.remove(integration.id);
            throw new Error(`The account was authorized but could not be saved to the credential store: ${errorMessage(e)}`);
          }
          await this.deps.checkHealth(integration.id).catch(() => undefined);
          this.#settle(attempt, 'connected', null, integration.id);
          callback.respond({
            ok: true,
            title: `${attempt.view.name} is connected`,
            message: 'You can close this tab and go back to Tandemise.',
          });
          this.deps.log.info('integration.connected', { integrationId: integration.id, name: attempt.view.name });
        } catch (e) {
          const message = errorMessage(e);
          this.#settle(attempt, 'failed', message);
          callback.respond({ ok: false, title: `${attempt.view.name} was not connected`, message });
        }
        return;
      }
    } catch (e) {
      if (attempt.view.status === 'waiting') {
        this.#settle(attempt, ctx.timeout.aborted ? 'failed' : 'cancelled',
          ctx.timeout.aborted ? 'Nothing came back from the consent screen within 10 minutes.' : null);
      }
      if (!signal.aborted) this.deps.log.warn('integration.connect_failed', { error: errorMessage(e) });
    } finally {
      listener.close();
    }
  }

  #create(workspaceId: WorkspaceId, provider: IntegrationProvider, name: string, config: Record<string, unknown>): Integration {
    const now = this.deps.clock.now();
    return this.deps.integrations.create({
      id: ids.integration(),
      workspaceId,
      providerId: provider.id,
      name: this.#uniqueName(workspaceId, name),
      transport: provider.transport,
      config,
      credentialRef: null,
      enabledCapabilities: [],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  #resolve(request: ConnectIntegrationRequest, workspaceId: WorkspaceId): {
    provider: IntegrationProvider; config: Readonly<Record<string, unknown>>; name: string;
    connectorId: string | null; existing: Integration | null;
  } {
    if (request.integrationId !== undefined) {
      const existing = this.deps.integrations.get(asId<'IntegrationId'>(request.integrationId));
      if (existing === undefined || existing.workspaceId !== workspaceId) {
        throw TandemiseError.notFound('Integration', request.integrationId);
      }
      return {
        provider: this.#provider(existing.providerId),
        config: existing.config,
        name: existing.name,
        connectorId: this.connectorFor(existing)?.id ?? null,
        existing,
      };
    }
    if (request.connectorId !== undefined) {
      const connector = this.connectors().find((c) => c.id === request.connectorId);
      if (connector === undefined) throw TandemiseError.notFound('Connector', request.connectorId);
      return {
        provider: this.#provider(connector.providerId),
        config: connector.config,
        name: request.name ?? connector.id,
        connectorId: connector.id,
        existing: null,
      };
    }
    const provider = this.#provider(request.providerId!);
    return { provider, config: request.config ?? {}, name: request.name ?? provider.id, connectorId: null, existing: null };
  }

  /** The catalog entry an integration came from, matched by the server it points at. */
  connectorFor(integration: Integration): IntegrationConnector | undefined {
    const url = integration.config['url'];
    return this.connectors().find((c) => c.providerId === integration.providerId
      && url !== undefined && c.config['url'] === url);
  }

  #provider(id: string): IntegrationProvider {
    const provider = this.deps.providers.get(id);
    if (provider === undefined) throw TandemiseError.validation(`No integration provider '${id}' is registered.`);
    return provider;
  }

  /** Tool names are namespaced by integration name, so a second Figma account must not share one. */
  #uniqueName(workspaceId: WorkspaceId, base: string): string {
    const taken = new Set(this.deps.integrations.listByWorkspace(workspaceId).map((i) => i.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }

  #update(attempt: Attempt, patch: Partial<ConnectionAttemptView>): void {
    attempt.view = { ...attempt.view, ...patch };
  }

  #settle(attempt: Attempt, status: ConnectionStatus, error: string | null, integrationId?: IntegrationId): void {
    this.#update(attempt, {
      status,
      error,
      // The URL is only useful while someone might still open it.
      authorizationUrl: null,
      ...(integrationId === undefined ? {} : { integrationId }),
    });
  }

  #prune(): void {
    const cutoff = this.deps.clock.epochMs() - CONNECT_TIMEOUT_MS - SETTLED_RETENTION_MS;
    for (const [id, attempt] of this.#attempts) {
      if (Date.parse(attempt.view.startedAt) < cutoff) this.#attempts.delete(id);
    }
  }
}
