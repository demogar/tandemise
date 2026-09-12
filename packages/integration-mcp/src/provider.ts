import { z } from 'zod';
import type { Integration, IntegrationHealth, RiskClass } from '@tandemise/domain';
import { RISK_CLASSES } from '@tandemise/domain';
import {
  IntegrationUnauthorizedError,
  type IntegrationCredentialSource, type IntegrationHealthContext, type IntegrationProvider,
  type IntegrationTool, type ToolContext,
} from '@tandemise/integrations-core';
import { errorMessage, type Logger } from '@tandemise/shared';
import { McpStdioClient } from './client.js';
import { McpHttpClient } from './http-client.js';
import { MCP_CONNECTORS } from './connectors.js';
import { McpOAuthAuthorizer } from './oauth.js';
import type { McpClient, McpToolDefinition } from './protocol.js';
import { jsonSchemaToZod } from './schema.js';

/**
 * Any MCP server, as an integration - installed locally or hosted by a vendor.
 *
 * This is the provider that makes the rest unnecessary. Figma, Linear,
 * Supabase, a database, a vendor's own server - each becomes a configured
 * integration rather than a package someone has to write here.
 *
 * The tools still arrive through the broker. Someone else authoring a tool is
 * not a reason to trust it: its capability is declared by us, its risk is
 * classified, and an approval-gated call is gated exactly as a built-in one is.
 *
 * **Discovery is a side effect of the health check**, because `tools()` is
 * synchronous and asking a server what it offers is not. The service checks on
 * create, so the list is populated by the time anything asks. The cache is per
 * integration id, so two Supabase projects do not share a tool list.
 */

export const MCP_PROVIDER_ID = 'mcp';

/**
 * Risk as the domain names it.
 *
 * The first version of this schema used `local_write` and `external_write`,
 * which are not risk classes, and cast them through. Any approval created for
 * one of those tools would then have failed the approvals table's CHECK
 * constraint. Rows written with the old names are read as what they meant.
 */
const LEGACY_RISK: Readonly<Record<string, RiskClass>> = {
  local_write: 'write_reversible',
  external_write: 'external_side_effect',
};
const risk = z.preprocess(
  (value) => (typeof value === 'string' ? LEGACY_RISK[value] ?? value : value),
  z.enum(RISK_CLASSES),
).default('external_side_effect');

const common = {
  /**
   * Capability every tool from this server is published under.
   *
   * One per server rather than one per tool, because granting access is a
   * decision about the *server* - "designers may use Figma" - and a per-tool
   * capability would be a permission surface nobody could reason about.
   */
  capability: z.string().min(1).default('mcp.call'),
  risk,
  /**
   * Publish tools the server marks read-only under `<capability>.read`, at risk
   * `read`. Only curated connectors set this: the annotation is the server's own
   * claim, and a server someone typed the URL of could make any claim it liked.
   */
  trustAnnotations: z.boolean().default(false),
  requestTimeoutMs: z.number().int().positive().max(600_000).optional(),
};

const stdioConfig = z.object({
  /** Executable that speaks MCP on stdio, e.g. `npx`. */
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Variables the server needs. Not secrets: those belong in the credential store. */
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  ...common,
});

const httpConfig = z.object({
  /** A hosted server speaking Streamable HTTP. */
  url: z.string().url().refine((u) => u.startsWith('https://') || /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u), {
    message: 'A hosted MCP server must be https (plain http only on loopback).',
  }),
  /** `oauth` sends the user through the server's consent screen to connect. */
  auth: z.enum(['oauth', 'none']).default('oauth'),
  /** Override the scopes the server advertises. */
  scopes: z.array(z.string()).optional(),
  ...common,
});

const mcpConfig = z.union([httpConfig, stdioConfig]);
type McpConfig = z.infer<typeof mcpConfig>;
type HttpConfig = z.infer<typeof httpConfig>;

export interface McpProviderOptions {
  /**
   * Where access tokens come from. A thunk because the source is bound by the
   * application, after providers are composed - and a daemon composed without
   * one still runs local servers.
   */
  readonly credentials?: () => IntegrationCredentialSource | null;
  readonly fetch?: typeof fetch;
}

export class McpIntegrationProvider implements IntegrationProvider {
  readonly id = MCP_PROVIDER_ID;
  readonly displayName = 'MCP server';
  readonly transport = 'mcp' as const;
  readonly configSchema = mcpConfig;
  readonly provides: readonly string[] = ['mcp.call'];
  readonly connectors = MCP_CONNECTORS;
  readonly authorizer: McpOAuthAuthorizer;

  /** Discovered tools per integration, refreshed by `healthCheck`. */
  readonly #discovered = new Map<string, readonly McpToolDefinition[]>();

  constructor(private readonly options: McpProviderOptions = {}) {
    this.authorizer = new McpOAuthAuthorizer(options.fetch ?? fetch);
  }

  tools(integration: Integration): readonly IntegrationTool[] {
    const parsed = mcpConfig.safeParse(integration.config);
    if (!parsed.success) return [];
    return (this.#discovered.get(integration.id) ?? []).map((definition) =>
      this.#tool(integration, parsed.data, definition));
  }

  async healthCheck(integration: Integration, ctx: IntegrationHealthContext): Promise<IntegrationHealth> {
    const checkedAt = ctx.clock.now();
    const state = (s: IntegrationHealth['state'], detail: string): IntegrationHealth =>
      ({ integrationId: integration.id, state: s, detail, checkedAt });

    const parsed = mcpConfig.safeParse(integration.config);
    if (!parsed.success) {
      return state('unavailable',
        `Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    if (isHttp(parsed.data) && parsed.data.auth === 'oauth' && integration.credentialRef === null) {
      return state('unavailable', 'Not connected. Connect your account to use it.');
    }

    try {
      const tools = await this.#withClient(integration, parsed.data, ctx.logger, ctx.signal,
        async (client) => {
          const listed = await client.listTools();
          return { listed, server: client.serverInfo };
        });
      this.#discovered.set(integration.id, tools.listed);
      const { listed, server } = tools;
      return listed.length === 0
        ? state('degraded', `${server?.name ?? 'The server'} connected but publishes no tools.`)
        : state('healthy', `${server?.name ?? 'Connected'}${server ? ` ${server.version}` : ''} — `
          + `${listed.length} tool${listed.length === 1 ? '' : 's'}: ${listed.map((t) => t.name).join(', ')}`);
    } catch (error) {
      // Never throws: a server that will not start, or an account that needs
      // reconnecting, is a state this integration is in, not an exception.
      return state('unavailable', errorMessage(error));
    }
  }

  #tool(integration: Integration, config: McpConfig, definition: McpToolDefinition): IntegrationTool {
    const readOnly = config.trustAnnotations && definition.readOnly;
    const provider = this;
    return {
      // Namespaced by integration so two servers offering `search` stay distinct.
      name: `${integration.name}.${definition.name}`.replace(/[^a-zA-Z0-9_.-]/g, '_'),
      integrationId: integration.id,
      capability: readOnly ? `${config.capability}.read` : config.capability,
      risk: readOnly ? 'read' : config.risk,
      description: definition.description,
      inputSchema: jsonSchemaToZod(definition.inputSchema) as IntegrationTool['inputSchema'],
      resource: () => integration.name,
      async execute(ctx: ToolContext, input: unknown) {
        // Connected per call rather than held open: a session per integration
        // would outlive the missions that needed it, and one that died between
        // calls would fail in a way nothing retries.
        const result = await provider.#withClient(integration, config, ctx.logger, ctx.signal, (client) =>
          client.callTool(
            definition.name,
            (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>,
          ));
        if (result.isError) throw new Error(result.text || `${definition.name} failed.`);
        return { output: result.raw, summary: firstLine(result.text) || `${definition.name} succeeded.` };
      },
    };
  }

  /**
   * Opens a session, runs `work`, closes it - and on a rejected token, refreshes
   * once and tries again. Access tokens from hosted servers last an hour or so;
   * the first call after one lapses should not fail the worker's tool call.
   */
  async #withClient<T>(
    integration: Integration,
    config: McpConfig,
    log: Logger,
    signal: AbortSignal,
    work: (client: McpClient) => Promise<T>,
  ): Promise<T> {
    const attempt = async (): Promise<T> => {
      const client = this.#client(integration, config, log, signal);
      try {
        await client.connect();
        return await work(client);
      } finally {
        client.close();
      }
    };
    try {
      return await attempt();
    } catch (error) {
      const credentials = this.options.credentials?.() ?? null;
      if (!(error instanceof IntegrationUnauthorizedError) || credentials === null) throw error;
      credentials.invalidate(integration);
      return attempt();
    }
  }

  #client(integration: Integration, config: McpConfig, log: Logger, signal: AbortSignal): McpClient {
    if (!isHttp(config)) {
      return new McpStdioClient({
        command: config.command,
        args: config.args,
        env: config.env,
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
        ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
      }, log);
    }
    const credentials = this.options.credentials?.() ?? null;
    return new McpHttpClient({
      url: config.url,
      signal,
      ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      ...(config.auth === 'oauth'
        ? {
          accessToken: async () => {
            if (credentials === null) {
              throw new IntegrationUnauthorizedError('No credential store is available to this daemon.');
            }
            return credentials.accessToken(integration, signal);
          },
        }
        : {}),
    });
  }
}

function isHttp(config: McpConfig): config is HttpConfig {
  return 'url' in config;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 200) ?? '';
}
