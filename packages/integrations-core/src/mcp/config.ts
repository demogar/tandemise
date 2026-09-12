import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDescriptor } from '@tandemise/domain';
import type { RunScopedToolGateway } from '../gateway.js';
import { BRIDGE_SOCKET_ENV, BRIDGE_TOKEN_ENV } from './protocol.js';

/** The shape `claude --mcp-config <file>` (and every MCP client) expects. */
export interface McpServerConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface McpConfigFile {
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
}

/** The name the published server appears under. Tools arrive as `mcp__tandemise__<tool>`. */
export const MCP_SERVER_NAME = 'tandemise';

export interface McpGatewayRequest {
  readonly gateway: RunScopedToolGateway;
  /** Where the config file is written. Run-scoped; deleted with the run. */
  readonly configPath: string;
  readonly socketPath: string;
  readonly token: string;
  /** Defaults to the Node binary currently running the daemon. */
  readonly nodeExecutable?: string;
  /** Overrides the resolved `dist/mcp-server.js`. Tests and unusual layouts. */
  readonly serverEntryPath?: string;
}

export interface McpGatewayHandle {
  readonly configPath: string;
  readonly serverName: string;
  /** Exactly the tools the assignment may see - the point of the gateway. */
  readonly publishedTools: readonly ToolDescriptor[];
  readonly config: McpConfigFile;
}

/**
 * Writes the ephemeral, run-scoped MCP config (MVP.md §12.4).
 *
 * Pairs with `--strict-mcp-config` on the runtime side, which is what makes the
 * published list exhaustive: without it the agent would additionally inherit
 * whatever MCP servers the user has configured globally, and the whole
 * "a QA worker cannot discover the finance tools" property would be decorative.
 *
 * The config names a *process*, not a port. Everything the child needs to reach
 * the broker travels in its environment, so nothing about the run is guessable
 * from the config file alone.
 */
export async function writeMcpGatewayConfig(
  request: McpGatewayRequest,
): Promise<McpGatewayHandle> {
  const publishedTools = request.gateway.describe();
  const config: McpConfigFile = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: request.nodeExecutable ?? process.execPath,
        args: [request.serverEntryPath ?? defaultServerEntryPath()],
        env: {
          [BRIDGE_SOCKET_ENV]: request.socketPath,
          [BRIDGE_TOKEN_ENV]: request.token,
        },
      },
    },
  };
  await mkdir(dirname(request.configPath), { recursive: true, mode: 0o700 });
  await writeFile(request.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return {
    configPath: request.configPath,
    serverName: MCP_SERVER_NAME,
    publishedTools,
    config,
  };
}

/**
 * The built `mcp-server.js` that sits next to this module. Resolved from
 * `import.meta.url` rather than from the process CWD, because the daemon's
 * working directory is not something this package should depend on.
 */
export function defaultServerEntryPath(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'mcp-server.js');
}
