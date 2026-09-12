import { connect, type Socket } from 'node:net';
import type { ToolDescriptor } from '@tandemise/domain';
import {
  LineStream, type BridgeRequest, type BridgeResponse, type BridgeToolResult,
} from './protocol.js';

/**
 * The MCP server's connection back to the daemon's broker.
 *
 * Requests are correlated by id rather than by arrival order because an MCP
 * client may have several `tools/call` in flight; matching responses
 * positionally would hand one agent's result to another call.
 */
export class ToolBridgeClient {
  #socket: Socket | undefined;
  readonly #pending = new Map<number, {
    resolve: (r: BridgeResponse) => void;
    reject: (e: Error) => void;
  }>();
  #nextId = 1;

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
  ) {}

  async connect(): Promise<void> {
    const socket = connect(this.socketPath);
    socket.setEncoding('utf8');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => {
        socket.removeListener('error', reject);
        resolve();
      });
      socket.once('error', reject);
    });
    const lines = new LineStream();
    socket.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) this.#onResponse(line);
    });
    socket.on('close', () => this.#failAll(new Error('Tool bridge closed')));
    socket.on('error', (e) => this.#failAll(e));
    this.#socket = socket;
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = undefined;
  }

  async listTools(): Promise<readonly ToolDescriptor[]> {
    const response = await this.#send((id) => ({ id, type: 'list', token: this.token }));
    if (!response.ok) throw new Error(response.error);
    if (!('tools' in response)) throw new Error('Bridge returned no tool list');
    return response.tools;
  }

  async callTool(tool: string, input: unknown): Promise<BridgeToolResult> {
    const response = await this.#send((id) => ({ id, type: 'call', token: this.token, tool, input }));
    if (!response.ok) throw new Error(response.error);
    if (!('result' in response)) throw new Error('Bridge returned no tool result');
    return response.result;
  }

  #send(build: (id: number) => BridgeRequest): Promise<BridgeResponse> {
    const socket = this.#socket;
    if (!socket) return Promise.reject(new Error('Tool bridge is not connected'));
    const id = this.#nextId++;
    return new Promise<BridgeResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      socket.write(JSON.stringify(build(id)) + '\n');
    });
  }

  #onResponse(line: string): void {
    let response: BridgeResponse;
    try {
      response = JSON.parse(line) as BridgeResponse;
    } catch {
      return;
    }
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    pending.resolve(response);
  }

  #failAll(error: Error): void {
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }
}
