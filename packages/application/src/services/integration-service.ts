import type {
  Integration, IntegrationRepositoryPort, SecretStorePort, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { riskForCapability } from '@tandemise/policy';
import type {
  ConnectIntegrationRequest, ConnectionAttemptView, ConnectorView, CreateIntegrationRequest, IntegrationView,
} from '@tandemise/api-contract';
import type {
  CommandExecutor, IntegrationProvider, IntegrationProviderRegistry,
} from '@tandemise/integrations-core';
import type { Clock, IntegrationId, Logger, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId, errorMessage, ids } from '@tandemise/shared';
import type { IntegrationService } from '../services.js';
import type { ConnectFlow } from './connect-flow.js';
import type { IntegrationCredentials } from '../support/integration-credentials.js';

const HEALTH_TIMEOUT_MS = 15_000;

export interface IntegrationDeps {
  readonly integrations: IntegrationRepositoryPort;
  readonly workspaces: WorkspaceRepositoryPort;
  readonly providers: IntegrationProviderRegistry;
  readonly secrets: SecretStorePort;
  readonly exec: CommandExecutor | null;
  /** Null when no callback listener is composed - a headless daemon cannot send anyone to consent. */
  readonly connect: ConnectFlow | null;
  readonly credentials: IntegrationCredentials;
  readonly clock: Clock;
  readonly log: Logger;
}

/**
 * Configured integrations (MVP.md §12.1, §23.6).
 *
 * The credential never touches this service's return values, its logs, or the
 * database (MVP.md §P8): `create` hands the raw secret straight to the
 * `SecretStorePort` and keeps only the opaque reference. That is the entire
 * reason the request carries `secret` and the entity carries `credentialRef`.
 */
export class IntegrationServiceImpl implements IntegrationService {
  constructor(private readonly deps: IntegrationDeps) {}

  /**
   * Integrations, for one workspace or for the whole install.
   *
   * Omitting the workspace is the honest answer to "what is connected?" before
   * a workspace is chosen - the desktop asks exactly that on a screen the user
   * can reach without having picked one. Requiring it here made the screen fail
   * outright rather than show what exists.
   */
  async list(workspaceId?: WorkspaceId): Promise<readonly IntegrationView[]> {
    const integrations = workspaceId === undefined
      ? this.deps.workspaces.list().flatMap((w) => this.deps.integrations.listByWorkspace(w.id))
      : this.deps.integrations.listByWorkspace(workspaceId);
    return Promise.all(integrations.map((i) => this.#view(i)));
  }

  listProviders(): readonly { id: string; displayName: string; transport: string; description: string }[] {
    return this.deps.providers.all().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      transport: p.transport,
      description: (p.provides ?? []).join(', '),
    }));
  }

  listConnectors(): readonly ConnectorView[] {
    return (this.deps.connect?.connectors() ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      category: c.category,
      providerId: c.providerId,
      authorization: c.authorization,
      usedBy: c.usedBy,
      homepage: c.homepage,
    }));
  }

  connect(request: ConnectIntegrationRequest): Promise<ConnectionAttemptView> {
    return this.#flow().start(request);
  }

  connection(attemptId: string): ConnectionAttemptView {
    return this.#flow().get(attemptId);
  }

  cancelConnection(attemptId: string): ConnectionAttemptView {
    return this.#flow().cancel(attemptId);
  }

  #flow(): ConnectFlow {
    if (this.deps.connect === null) {
      throw new TandemiseError('PRECONDITION_FAILED', 'This daemon cannot connect accounts: no callback listener is available.');
    }
    return this.deps.connect;
  }

  async create(request: CreateIntegrationRequest): Promise<IntegrationView> {
    const workspaceId = asId<'WorkspaceId'>(request.workspaceId);
    if (this.deps.workspaces.get(workspaceId) === undefined) {
      throw TandemiseError.notFound('Workspace', workspaceId);
    }
    const provider = this.#requireProvider(request.providerId);

    const config = request.config ?? {};
    const parsed = provider.configSchema.safeParse(config);
    if (!parsed.success) {
      throw TandemiseError.validation(
        `Configuration for '${provider.displayName}' is invalid.`,
        { issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) },
      );
    }

    const id = ids.integration();
    const now = this.deps.clock.now();
    const created = this.deps.integrations.create({
      id,
      workspaceId,
      providerId: provider.id,
      name: request.name,
      transport: provider.transport,
      config: parsed.data as Record<string, unknown>,
      credentialRef: await this.#storeSecret(id, request.secret),
      enabledCapabilities: request.enabledCapabilities ?? [],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    return this.#view(created);
  }

  async update(
    id: IntegrationId,
    patch: Partial<CreateIntegrationRequest> & { readonly enabled?: boolean },
  ): Promise<IntegrationView> {
    const existing = this.#require(id);
    const updated = this.deps.integrations.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.config !== undefined ? { config: { ...existing.config, ...patch.config } } : {}),
      ...(patch.enabledCapabilities !== undefined
        ? { enabledCapabilities: patch.enabledCapabilities }
        : {}),
      ...(patch.secret !== undefined
        ? { credentialRef: await this.#storeSecret(id, patch.secret) }
        : {}),
      updatedAt: this.deps.clock.now(),
    });
    return this.#view(updated);
  }

  remove(id: IntegrationId): void {
    const existing = this.#require(id);
    this.deps.integrations.remove(id);
    if (existing.credentialRef !== null) {
      // Fire-and-forget with a logged failure: the row is already gone, and a
      // credential store that is momentarily unavailable must not leave the
      // integration half-deleted.
      void this.deps.secrets.remove(existing.credentialRef).catch((e: unknown) => {
        this.deps.log.warn('integration.secret_remove_failed', {
          integrationId: id, error: errorMessage(e),
        });
      });
    }
  }

  async checkHealth(id: IntegrationId): Promise<IntegrationView> {
    return this.#view(this.#require(id));
  }

  // ------------------------------------------------------------------ internals

  async #view(integration: Integration): Promise<IntegrationView> {
    const provider = this.deps.providers.get(integration.providerId);
    const health = provider === undefined
      ? {
        state: 'unavailable',
        detail: `No provider '${integration.providerId}' is registered.`,
        checkedAt: this.deps.clock.now(),
      }
      : await this.#health(provider, integration);

    return {
      integration,
      health,
      connectorId: this.deps.connect?.connectorFor(integration)?.id ?? null,
      account: await this.deps.credentials.account(integration).catch(() => null),
      reconnectable: provider?.authorizer !== undefined && integration.config['auth'] === 'oauth',
      availableCapabilities: provider === undefined
        ? []
        : provider.tools(integration).map((tool) => ({
          capability: tool.capability,
          risk: riskForCapability(tool.capability),
          description: tool.description,
        })),
    };
  }

  async #health(
    provider: IntegrationProvider,
    integration: Integration,
  ): Promise<{ state: string; detail: string; checkedAt: string }> {
    if (this.deps.exec === null) {
      return {
        state: 'unknown',
        detail: 'No command executor is composed, so this integration cannot be probed.',
        checkedAt: this.deps.clock.now(),
      };
    }
    try {
      const result = await provider.healthCheck(integration, {
        exec: this.deps.exec,
        logger: this.deps.log.child({ integrationId: integration.id }),
        clock: this.deps.clock,
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return { state: result.state, detail: result.detail, checkedAt: result.checkedAt };
    } catch (e) {
      // A provider is contractually forbidden to throw here. One that does is a
      // bug in the provider, not a reason to fail the integrations screen.
      this.deps.log.warn('integration.health_threw', {
        integrationId: integration.id, error: errorMessage(e),
      });
      return { state: 'unknown', detail: errorMessage(e), checkedAt: this.deps.clock.now() };
    }
  }

  async #storeSecret(id: IntegrationId, secret: string | undefined): Promise<string | null> {
    if (secret === undefined || secret.length === 0) return null;
    return this.deps.secrets.store(`integration:${id}`, secret);
  }

  #requireProvider(providerId: string): IntegrationProvider {
    const provider = this.deps.providers.get(providerId);
    if (provider === undefined) {
      throw TandemiseError.validation(`No integration provider '${providerId}' is registered.`, {
        available: this.deps.providers.ids(),
      });
    }
    return provider;
  }

  #require(id: IntegrationId): Integration {
    const integration = this.deps.integrations.get(id);
    if (integration === undefined) throw TandemiseError.notFound('Integration', id);
    return integration;
  }
}
