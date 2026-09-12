/**
 * Entry point for the run-scoped MCP server (MVP.md §12.4).
 *
 * Spawned by a runtime adapter, never by a person. It is handed a unix socket
 * path and a token in its environment, translates MCP over stdio into bridge
 * calls, and holds no policy, no credentials and no tool implementations of its
 * own - everything it can do, it can do because the broker on the other end
 * allowed it for this one assignment.
 *
 * stdout carries JSON-RPC and nothing else; every diagnostic goes to stderr.
 */
import { ToolBridgeClient } from './mcp/bridge-client.js';
import { McpStdioServer, stdioTransport } from './mcp/stdio-server.js';
import { BRIDGE_SOCKET_ENV, BRIDGE_TOKEN_ENV } from './mcp/protocol.js';

async function main(): Promise<void> {
  const socketPath = process.env[BRIDGE_SOCKET_ENV];
  const token = process.env[BRIDGE_TOKEN_ENV];
  if (!socketPath || !token) {
    process.stderr.write(
      `tandemise-mcp: ${BRIDGE_SOCKET_ENV} and ${BRIDGE_TOKEN_ENV} must both be set\n`,
    );
    process.exitCode = 2;
    return;
  }

  const bridge = new ToolBridgeClient(socketPath, token);
  await bridge.connect();

  const server = new McpStdioServer(bridge, stdioTransport(process.stdin, process.stdout));
  server.start();

  // The run owns this process's lifetime: when the daemon tears the bridge
  // down, or the runtime closes our stdin, there is nothing left to serve.
  process.stdin.on('end', () => {
    bridge.close();
    process.exit(0);
  });
}

main().catch((e: unknown) => {
  process.stderr.write(`tandemise-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
