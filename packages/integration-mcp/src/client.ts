import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { errorMessage, type Logger } from '@tandemise/shared';
import {
  DEFAULT_REQUEST_TIMEOUT_MS, initializeParams, readCallResult, readServerInfo, readString, readTools,
  type McpCallResult, type McpClient, type McpServerInfo, type McpToolDefinition,
} from './protocol.js';

/**
 * An MCP client, speaking to a server someone else wrote.
 *
 * Tandemise already implements the MCP *server* side, to hand a worker its
 * granted tools. This is the mirror: it lets Tandemise be the client of a third
 * party's server - Supabase, a database, a design tool - and publish whatever
 * that server offers as ordinary integration tools.
 *
 * That is the whole point. Every MCP server in existence becomes an integration
 * by configuration, which is a very different proposition from writing a
 * provider package per vendor. The tools still arrive through the broker, so
 * policy, risk classification, approval and the audit trail apply to them
 * exactly as they do to anything else - being someone else's tool is not a
 * reason to trust it more.
 *
 * Hand-written rather than taken from the SDK for the same reason the server
 * side is: the three methods needed here - `initialize`, `tools/list`,
 * `tools/call` - have been wire-stable across protocol revisions, and a
 * dependency that spawns processes is a large surface to accept for a small
 * amount of JSON-RPC.
 */

export interface McpServerSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** How long a single request may take before it is abandoned. */
  readonly requestTimeoutMs?: number;
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class McpStdioClient implements McpClient {
  #child: ChildProcessWithoutNullStreams | null = null;
  #buffer = '';
  #nextId = 0;
  readonly #pending = new Map<number, PendingCall>();
  #serverInfo: McpServerInfo | null = null;

  constructor(
    private readonly spec: McpServerSpec,
    private readonly log: Logger,
  ) {}

  get serverInfo(): McpServerInfo | null {
    return this.#serverInfo;
  }

  /** Spawns the server and completes the handshake. */
  async connect(): Promise<void> {
    if (this.#child !== null) return;

    const child = spawn(this.spec.command, [...(this.spec.args ?? [])], {
      // An MCP server is a third party's process. It gets the variables it was
      // configured with plus the base environment it needs to run at all - not
      // whatever the daemon happens to have inherited.
      env: { ...process.env, ...(this.spec.env ?? {}) },
      ...(this.spec.cwd === undefined ? {} : { cwd: this.spec.cwd }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#receive(chunk));
    // A server's stderr is its log, not its protocol. Surfacing it at debug
    // keeps a misconfigured server diagnosable without polluting the timeline.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.log.debug('mcp.server_stderr', { chunk: chunk.trim().slice(0, 500) }));
    child.on('exit', (code) => this.#fail(new Error(`The MCP server exited with code ${code ?? 'null'}.`)));
    child.on('error', (error) => this.#fail(new Error(`The MCP server could not be started: ${errorMessage(error)}`)));

    const result = await this.#request('initialize', initializeParams());
    this.#serverInfo = readServerInfo(result);
    // Notification, not a request: there is no reply to wait for, and waiting
    // for one is a hang.
    this.#notify('notifications/initialized', {});
  }

  async listTools(): Promise<readonly McpToolDefinition[]> {
    return readTools(await this.#request('tools/list', {}));
  }

  async callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<McpCallResult> {
    return readCallResult(await this.#request('tools/call', { name, arguments: args }));
  }

  /** Safe to call more than once, and safe on a client that never connected. */
  close(): void {
    const child = this.#child;
    this.#child = null;
    this.#fail(new Error('The MCP client was closed.'));
    if (child === null) return;
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    child.kill('SIGTERM');
  }

  // ----------------------------------------------------------------- wire

  #request(method: string, params: unknown): Promise<unknown> {
    const child = this.#child;
    if (child === null) return Promise.reject(new Error('The MCP client is not connected.'));

    const id = ++this.#nextId;
    const timeoutMs = this.spec.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`The MCP server did not answer '${method}' within ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  #notify(method: string, params: unknown): void {
    this.#child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    // Newline-delimited JSON: the framing every stdio MCP server uses.
    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0) this.#dispatch(line);
      newline = this.#buffer.indexOf('\n');
    }
  }

  #dispatch(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // A server that writes non-JSON to stdout is misbehaving, but one stray
      // line is not a reason to tear down a working session.
      this.log.debug('mcp.unparseable_line', { line: line.slice(0, 200) });
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const record = message as Record<string, unknown>;
    const id = typeof record['id'] === 'number' ? record['id'] : null;
    if (id === null) return;

    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);

    const error = record['error'];
    if (error !== undefined && error !== null) {
      const message_ = readString(error, 'message') ?? 'The MCP server returned an error.';
      pending.reject(new Error(message_));
      return;
    }
    pending.resolve(record['result']);
  }

  /** Rejects everything outstanding; used when the process dies or we close. */
  #fail(error: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
