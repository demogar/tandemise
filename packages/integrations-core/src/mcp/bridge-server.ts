import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorMessage, type Logger } from '@tandemise/shared';
import type { ToolDescriptor } from '@tandemise/domain';
import type { ToolContext, ToolResult } from '../tool.js';
import type { RunScopedToolGateway } from '../gateway.js';
import {
  LineStream, toBridgeResult, type BridgeRequest, type BridgeResponse,
} from './protocol.js';

/** What the bridge is allowed to do on the daemon's behalf. Exactly two things. */
export interface ToolBridgeHandler {
  list(): Promise<readonly ToolDescriptor[]>;
  call(toolName: string, input: unknown): Promise<ToolResult>;
}

/**
 * Adapts a run-scoped gateway to the bridge.
 *
 * The gateway is already narrowed to the assignment, so this adapter has no
 * filtering of its own to do - which is the design working: there is one place
 * that decides what a worker can see, and everything downstream inherits it.
 */
export function gatewayBridgeHandler(
  gateway: RunScopedToolGateway,
  ctx: ToolContext,
): ToolBridgeHandler {
  return {
    list: async () => gateway.describe(),
    call: (toolName, input) => gateway.invoke(toolName, input, ctx),
  };
}

export interface ToolBridgeServerOptions {
  /** Run-scoped path. Placed in a directory only this user can read. */
  readonly socketPath: string;
  /**
   * Shared secret handed to the child through its environment. A unix socket's
   * file permissions are the real control; this is the second lock, so that a
   * process which somehow reaches the socket still cannot use it without having
   * been launched by us.
   */
  readonly token: string;
  readonly log: Logger;
}

/**
 * The daemon-side half of the MCP gateway (MVP.md §12.4).
 *
 * One server per run. Its lifetime is the run's lifetime: when the run ends the
 * socket is removed, and any MCP server still holding it can do nothing.
 */
export class ToolBridgeServer {
  #server: Server | undefined;
  readonly #sockets = new Set<Socket>();

  constructor(
    private readonly handler: ToolBridgeHandler,
    private readonly options: ToolBridgeServerOptions,
  ) {}

  get socketPath(): string {
    return this.options.socketPath;
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    // A stale socket from a crashed run would make listen() fail with EADDRINUSE.
    await rm(this.options.socketPath, { force: true });

    const server = createServer((socket) => this.#onConnection(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    await chmod(this.options.socketPath, 0o600);
    this.options.log.debug('tool_bridge.listening', { socketPath: this.options.socketPath });
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    const server = this.#server;
    this.#server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(this.options.socketPath, { force: true });
  }

  #onConnection(socket: Socket): void {
    this.#sockets.add(socket);
    socket.setEncoding('utf8');
    const lines = new LineStream();
    socket.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) void this.#onLine(socket, line);
    });
    socket.on('error', (e) => {
      this.options.log.debug('tool_bridge.socket_error', { error: errorMessage(e) });
    });
    socket.on('close', () => this.#sockets.delete(socket));
  }

  async #onLine(socket: Socket, line: string): Promise<void> {
    let request: BridgeRequest;
    try {
      request = JSON.parse(line) as BridgeRequest;
    } catch {
      this.#send(socket, { id: 0, ok: false, error: 'Malformed bridge frame' });
      return;
    }
    if (request.token !== this.options.token) {
      this.options.log.warn('tool_bridge.rejected', { reason: 'bad token' });
      this.#send(socket, { id: request.id ?? 0, ok: false, error: 'Unauthorized' });
      socket.destroy();
      return;
    }
    try {
      if (request.type === 'list') {
        this.#send(socket, { id: request.id, ok: true, tools: await this.handler.list() });
        return;
      }
      if (request.type === 'call') {
        const result = await this.handler.call(request.tool, request.input);
        this.#send(socket, { id: request.id, ok: true, result: toBridgeResult(result) });
        return;
      }
      this.#send(socket, { id: request.id, ok: false, error: 'Unknown bridge request type' });
    } catch (e) {
      // The broker answers denials in-band, so reaching here means the daemon
      // itself failed. Report it rather than hanging the agent's call.
      this.#send(socket, { id: request.id, ok: false, error: errorMessage(e) });
    }
  }

  #send(socket: Socket, response: BridgeResponse): void {
    if (socket.destroyed) return;
    socket.write(JSON.stringify(response) + '\n');
  }
}
