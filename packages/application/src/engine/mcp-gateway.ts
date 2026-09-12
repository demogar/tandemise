import { mkdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { RunId, Logger, TandemisePaths, Clock } from '@tandemise/shared';
import { errorMessage } from '@tandemise/shared';
import type { MissionId, WorkspaceId } from '@tandemise/shared';
import type { WorkerAssignment } from '@tandemise/domain';
import {
  RunScopedToolGateway, ToolBridgeServer, gatewayBridgeHandler, writeMcpGatewayConfig,
  type CommandExecutor, type ToolBroker, type ToolContext,
} from '@tandemise/integrations-core';

/**
 * Gives one run a private, policy-gated tool surface (MVP.md §12.4).
 *
 * Three things exist for the duration of a single attempt and are destroyed
 * with it: a unix socket the daemon listens on, a token the child must present,
 * and an MCP config file naming exactly the tools this assignment may see. The
 * runtime is launched with `--strict-mcp-config` pointing at that file, so the
 * published list is exhaustive rather than additive - without it a worker would
 * also inherit whatever MCP servers the user has configured globally, and "a QA
 * worker cannot discover the finance tools" would be decorative.
 *
 * Nothing about the run is guessable from the config file: it names a process,
 * and everything that process needs to reach the broker travels in its
 * environment.
 */
export interface RunToolSurface {
  /** Passed to the runtime adapter; null when no tools are granted. */
  readonly mcpConfigPath: string | null;
  readonly toolNames: readonly string[];
  dispose(): Promise<void>;
}

export const NO_TOOL_SURFACE: RunToolSurface = {
  mcpConfigPath: null,
  toolNames: [],
  dispose: async () => {},
};

export interface McpGatewayProvisionerDeps {
  readonly broker: ToolBroker | null;
  /**
   * How a tool runs a command, resolved lazily.
   *
   * A thunk rather than a value because it is only needed when an assignment
   * actually has tools: a workspace with no integrations composed should not
   * fail to start a run over a dependency no tool will ever use.
   */
  readonly exec: () => CommandExecutor;
  readonly paths: TandemisePaths;
  readonly clock: Clock;
  readonly log: Logger;
}

export interface ProvisionToolSurfaceRequest {
  readonly runId: RunId;
  readonly workspaceId: WorkspaceId;
  readonly missionId: MissionId;
  readonly assignment: WorkerAssignment;
  readonly workingDirectory: string;
  readonly signal: AbortSignal;
}

export class McpGatewayProvisioner {
  constructor(private readonly deps: McpGatewayProvisionerDeps) {}

  async provision(request: ProvisionToolSurfaceRequest): Promise<RunToolSurface> {
    const { broker, paths, clock, log } = this.deps;
    if (broker === null) return NO_TOOL_SURFACE;

    const gateway = RunScopedToolGateway.for(broker, request.assignment, clock);
    const toolNames = gateway.names();
    // A worker with no granted tools gets no gateway at all, rather than an
    // empty one: an MCP server that publishes nothing is pure startup cost.
    if (toolNames.length === 0) return NO_TOOL_SURFACE;

    const runtimeDir = join(paths.mission(request.workspaceId, request.missionId), 'runs', request.runId);
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });

    // Unix socket paths are capped near 104 bytes on macOS, well below what a
    // mission directory can reach, so the socket lives in a short-named
    // sibling keyed by the run id rather than under the mission tree.
    const socketPath = join(paths.root, 'sockets', `${request.runId}.sock`);
    await mkdir(join(paths.root, 'sockets'), { recursive: true, mode: 0o700 });

    const token = randomBytes(24).toString('hex');
    const ctx: ToolContext = {
      assignment: request.assignment,
      assignmentId: request.assignment.id,
      runId: request.runId,
      workingDirectory: request.workingDirectory,
      logger: log.child({ runId: request.runId, component: 'tools' }),
      exec: this.deps.exec(),
      signal: request.signal,
    };

    const bridge = new ToolBridgeServer(gatewayBridgeHandler(gateway, ctx), {
      socketPath,
      token,
      log: log.child({ runId: request.runId, component: 'tool-bridge' }),
    });
    await bridge.start();

    let handle;
    try {
      handle = await writeMcpGatewayConfig({
        gateway,
        configPath: join(runtimeDir, 'mcp.json'),
        socketPath,
        token,
      });
    } catch (e) {
      await bridge.close().catch(() => undefined);
      throw e;
    }

    log.debug('mcp.gateway_ready', {
      runId: request.runId,
      tools: toolNames.length,
      configPath: handle.configPath,
    });

    return {
      mcpConfigPath: handle.configPath,
      toolNames,
      dispose: async () => {
        // The socket and the token die with the run. A leftover socket would be
        // a second, unauthenticated door into the broker.
        try { await bridge.close(); } catch (e) { log.debug('mcp.bridge_stop_failed', { error: errorMessage(e) }); }
        try { await rm(socketPath, { force: true }); } catch { /* already gone */ }
        try { await rm(handle.configPath, { force: true }); } catch { /* already gone */ }
      },
    };
  }
}
