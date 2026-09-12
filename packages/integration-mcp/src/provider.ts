import { z } from 'zod';
import type { Integration, IntegrationHealth, RiskClass } from '@tandemise/domain';
import type {
  IntegrationHealthContext, IntegrationProvider, IntegrationTool, ToolContext,
} from '@tandemise/integrations-core';
import { errorMessage } from '@tandemise/shared';
import { McpStdioClient, type McpToolDefinition } from './client.js';
import { jsonSchemaToZod } from './schema.js';

/**
 * Any MCP server, as an integration.
 *
 * This is the provider that makes the rest unnecessary. Supabase, a database,
 * a design tool, a vendor's own server - each becomes a configured integration
 * rather than a package someone has to write here. That is the difference
 * between an integration list this repository controls and one the user does.
 *
 * The tools still arrive through the broker. Someone else authoring a tool is
 * not a reason to trust it: its capability is derived and declared, its risk is
 * classified, and an approval-gated call is gated exactly as a built-in one is.
 *
 * **Discovery is a side effect of the health check**, because `tools()` is
 * synchronous and asking a server what it offers is not. An integration reports
 * `unknown` until it has been checked once, and the service checks on create -
 * so in practice the list is populated by the time anything asks. The cache is
 * per integration id, so two Supabase projects do not share a tool list.
 */

export const MCP_PROVIDER_ID = 'mcp';

const mcpConfig = z.object({
  /** Executable that speaks MCP on stdio, e.g. `npx`. */
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /**
   * Variables the server needs. Not secrets: a token belongs in the credential
   * store, and `secretRef` is how an integration names one (MVP.md §P8).
   */
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  /**
   * Capability every tool from this server is published under.
   *
   * One capability per server rather than one per tool, because the user
   * granting access is deciding about the *server* - "this mission may talk to
   * Supabase" - and a per-tool capability would be a permission surface nobody
   * could reason about.
   */
  capability: z.string().min(1).default('mcp.call'),
  /** How the policy layer should treat calls to this server. */
  risk: z.enum(['read', 'local_write', 'external_write', 'destructive', 'financial'])
    .default('external_write'),
  requestTimeoutMs: z.number().int().positive().max(600_000).optional(),
});

type McpConfig = z.infer<typeof mcpConfig>;

export class McpIntegrationProvider implements IntegrationProvider {
  readonly id = MCP_PROVIDER_ID;
  readonly displayName = 'MCP server';
  readonly transport = 'mcp' as const;
  readonly configSchema = mcpConfig;
  readonly provides: readonly string[] = ['mcp.call'];

  /** Discovered tools per integration, refreshed by `healthCheck`. */
  readonly #discovered = new Map<string, readonly McpToolDefinition[]>();

  tools(integration: Integration): readonly IntegrationTool[] {
    const parsed = mcpConfig.safeParse(integration.config);
    if (!parsed.success) return [];
    const config = parsed.data;

    return (this.#discovered.get(integration.id) ?? []).map((definition) =>
      this.#tool(integration, config, definition));
  }

  async healthCheck(integration: Integration, ctx: IntegrationHealthContext): Promise<IntegrationHealth> {
    const checkedAt = ctx.clock.now();
    const parsed = mcpConfig.safeParse(integration.config);
    if (!parsed.success) {
      return {
        integrationId: integration.id,
        state: 'unavailable',
        detail: `Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        checkedAt,
      };
    }

    const client = new McpStdioClient(specFor(parsed.data), ctx.logger);
    try {
      await client.connect();
      const tools = await client.listTools();
      this.#discovered.set(integration.id, tools);
      const server = client.serverInfo;
      return {
        integrationId: integration.id,
        state: tools.length === 0 ? 'degraded' : 'healthy',
        detail: tools.length === 0
          ? `${server?.name ?? 'The server'} connected but publishes no tools.`
          : `${server?.name ?? 'Connected'}${server ? ` ${server.version}` : ''} — ${tools.length} tool${tools.length === 1 ? '' : 's'}: ${tools.map((t) => t.name).join(', ')}`,
        checkedAt,
      };
    } catch (error) {
      // Never throws: a server that will not start is a state this integration
      // is in, not an exception that should take the registry down.
      return {
        integrationId: integration.id,
        state: 'unavailable',
        detail: errorMessage(error),
        checkedAt,
      };
    } finally {
      client.close();
    }
  }

  #tool(integration: Integration, config: McpConfig, definition: McpToolDefinition): IntegrationTool {
    return {
      // Namespaced by integration so two servers offering `query` stay distinct.
      name: `${integration.name}.${definition.name}`.replace(/[^a-zA-Z0-9_.-]/g, '_'),
      integrationId: integration.id,
      capability: config.capability,
      risk: config.risk as RiskClass,
      description: definition.description,
      inputSchema: jsonSchemaToZod(definition.inputSchema) as IntegrationTool['inputSchema'],
      resource: () => integration.name,
      async execute(ctx: ToolContext, input: unknown) {
        // Connected per call rather than held open: a long-lived child process
        // per integration would outlive the missions that needed it, and a
        // server that dies between calls would fail in a way nothing retries.
        // Every logger this provider uses is the one handed to the call, so it
        // needs nothing from the container and stays trivially constructible.
        const client = new McpStdioClient(specFor(config), ctx.logger);
        try {
          await client.connect();
          const result = await client.callTool(
            definition.name,
            (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>,
          );
          if (result.isError) {
            throw new Error(result.text || `${definition.name} failed.`);
          }
          return {
            output: result.raw,
            summary: firstLine(result.text) || `${definition.name} succeeded.`,
          };
        } finally {
          client.close();
        }
      },
    };
  }
}

function specFor(config: McpConfig): {
  command: string; args: readonly string[]; env: Readonly<Record<string, string>>;
  cwd?: string; requestTimeoutMs?: number;
} {
  return {
    command: config.command,
    args: config.args,
    env: config.env,
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
  };
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 200) ?? '';
}
