import type { Logger } from '@tandemise/shared';
import type { Integration, IntegrationHealth, IntegrationTransport } from '@tandemise/domain';
import { Registry, multiToken, type Descriptor } from '@tandemise/kernel';
import type { z } from 'zod';
import type { CommandExecutor } from './exec.js';
import type { IntegrationTool } from './tool.js';

/** What a provider is given to answer "is this integration usable right now?". */
export interface IntegrationHealthContext {
  readonly exec: CommandExecutor;
  readonly logger: Logger;
  readonly signal: AbortSignal;
}

/**
 * The plugin seam for integrations (MVP.md §12.1).
 *
 * A provider is a *kind* of integration - GitHub, a browser, a generic REST
 * service - not one configured instance of it. The instance is the `Integration`
 * row, and the provider turns it into tools. That split is what lets a workspace
 * hold two GitHub integrations with different scopes without duplicating code,
 * and what keeps the broker from ever naming a vendor.
 */
export interface IntegrationProvider extends Descriptor {
  readonly transport: IntegrationTransport;
  /** Validates `Integration.config` before the integration is used. */
  readonly configSchema: z.ZodTypeAny;
  tools(integration: Integration): readonly IntegrationTool[];
  /**
   * Must never throw: a missing CLI or an expired login is a *state*, not an
   * exception, and a provider that throws here takes the whole registration
   * down with it (MVP.md §12.5 - degrade, do not fail).
   */
  healthCheck(integration: Integration, ctx: IntegrationHealthContext): Promise<IntegrationHealth>;
}

/** Every integration package contributes here; the core names none of them. */
export const INTEGRATION_PROVIDERS = multiToken<IntegrationProvider>('IntegrationProvider');

export class IntegrationProviderRegistry extends Registry<IntegrationProvider> {
  constructor(providers: readonly IntegrationProvider[] = []) {
    super('integration', providers);
  }

  /** Providers usable over a given transport, for the "add integration" UI. */
  byTransport(transport: IntegrationTransport): readonly IntegrationProvider[] {
    return this.filter((p) => p.transport === transport);
  }
}
