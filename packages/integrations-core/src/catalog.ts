import { TandemiseError, errorMessage, type Logger } from '@tandemise/shared';
import type { Integration } from '@tandemise/domain';
import type { IntegrationProviderRegistry } from './provider.js';
import type { IntegrationTool } from './tool.js';

/** The set of tools a broker may resolve against. */
export interface ToolCatalog {
  list(): readonly IntegrationTool[];
  find(name: string): IntegrationTool | undefined;
}

/**
 * The catalog assembled from the workspace's configured integrations.
 *
 * Integrations are supplied by a thunk rather than a snapshot because they are
 * database rows: enabling an integration mid-mission must take effect without
 * rebuilding the broker.
 */
export class IntegrationToolCatalog implements ToolCatalog {
  constructor(
    private readonly providers: IntegrationProviderRegistry,
    private readonly integrations: () => readonly Integration[],
    private readonly log: Logger,
  ) {}

  list(): readonly IntegrationTool[] {
    const out: IntegrationTool[] = [];
    const seen = new Set<string>();
    for (const integration of this.integrations()) {
      if (!integration.enabled) continue;
      for (const tool of this.#toolsFor(integration)) {
        if (seen.has(tool.name)) {
          // Two integrations of the same provider would otherwise silently
          // shadow each other, and the loser would be un-invokable but visible.
          this.log.warn('tool.duplicate_name', {
            tool: tool.name,
            integrationId: integration.id,
            providerId: integration.providerId,
          });
          continue;
        }
        seen.add(tool.name);
        out.push(tool);
      }
    }
    return out;
  }

  find(name: string): IntegrationTool | undefined {
    return this.list().find((t) => t.name === name);
  }

  #toolsFor(integration: Integration): readonly IntegrationTool[] {
    const provider = this.providers.get(integration.providerId);
    if (!provider) {
      this.log.warn('integration.provider_missing', {
        integrationId: integration.id,
        providerId: integration.providerId,
      });
      return [];
    }
    const config = provider.configSchema.safeParse(integration.config);
    if (!config.success) {
      // A misconfigured integration contributes nothing rather than a tool that
      // fails at the worst possible moment, mid-run.
      this.log.warn('integration.config_invalid', {
        integrationId: integration.id,
        providerId: integration.providerId,
        detail: config.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      return [];
    }
    try {
      return provider.tools(integration);
    } catch (e) {
      this.log.error('integration.tools_failed', {
        integrationId: integration.id,
        providerId: integration.providerId,
        error: errorMessage(e),
      });
      return [];
    }
  }
}

/**
 * Built-in tools first, then whatever the workspace's integrations publish.
 *
 * Order is the precedence rule: a built-in cannot be shadowed by an integration
 * that happens to publish the same name. Without that, configuring an
 * integration could silently replace the channel a worker uses to ask its
 * supervisor a question with one the integration controls - a prompt-injection
 * path straight through the trust fence (MVP.md §19.3).
 */
export class CompositeToolCatalog implements ToolCatalog {
  constructor(
    private readonly builtIn: readonly IntegrationTool[],
    private readonly integrations: ToolCatalog,
    private readonly log: Logger,
  ) {}

  list(): readonly IntegrationTool[] {
    const reserved = new Set(this.builtIn.map((t) => t.name));
    const published = this.integrations.list().filter((tool) => {
      if (!reserved.has(tool.name)) return true;
      this.log.warn('tool.shadows_built_in', {
        tool: tool.name,
        integrationId: tool.integrationId,
        detail: 'A built-in tool of this name already exists; the integration\'s is not published.',
      });
      return false;
    });
    return [...this.builtIn, ...published];
  }

  find(name: string): IntegrationTool | undefined {
    return this.list().find((t) => t.name === name);
  }
}

/** A fixed set of tools. Used by the run-scoped views and by tests. */
export class StaticToolCatalog implements ToolCatalog {
  readonly #byName: ReadonlyMap<string, IntegrationTool>;

  constructor(private readonly tools: readonly IntegrationTool[]) {
    const byName = new Map<string, IntegrationTool>();
    for (const tool of tools) {
      if (byName.has(tool.name)) {
        throw TandemiseError.validation(`Duplicate tool name '${tool.name}'`);
      }
      byName.set(tool.name, tool);
    }
    this.#byName = byName;
  }

  list(): readonly IntegrationTool[] {
    return this.tools;
  }

  find(name: string): IntegrationTool | undefined {
    return this.#byName.get(name);
  }
}
