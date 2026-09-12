import { IntegrationUnauthorizedError } from '@tandemise/integrations-core';
import { errorMessage } from '@tandemise/shared';
import {
  DEFAULT_REQUEST_TIMEOUT_MS, PROTOCOL_VERSIONS, asRecord, initializeParams, readCallResult, readServerInfo,
  readString, readTools, type McpCallResult, type McpClient, type McpServerInfo, type McpToolDefinition,
} from './protocol.js';

export interface McpHttpServerSpec {
  readonly url: string;
  /** Resolved per request, so a refreshed token is picked up without reconnecting. */
  readonly accessToken?: () => Promise<string | null>;
  readonly requestTimeoutMs?: number;
  /** The caller's cancellation: a cancelled mission abandons its in-flight request. */
  readonly signal?: AbortSignal;
  /** Injected in tests; the global `fetch` otherwise. */
  readonly fetch?: typeof fetch;
}

/** A tools/call may wait on a person or a long job; listing and handshakes should not. */
const MAX_PAGES = 20;

/**
 * An MCP client over Streamable HTTP - a vendor's hosted server.
 *
 * This is the transport the connectors use. Figma, Linear, Supabase and the
 * rest publish an MCP endpoint behind OAuth, and reaching one needs nothing
 * installed locally: no `npx`, no binary on the PATH, no token pasted into a
 * config file.
 *
 * Every request is a POST of one JSON-RPC message. The server answers either
 * with a JSON body or with an SSE stream that carries the response among
 * whatever notifications it sends first; both are handled, because which one a
 * server picks is its choice, not ours. The session id the server issues on
 * `initialize` is echoed on every later request, as the spec requires.
 *
 * A 401 surfaces as `IntegrationUnauthorizedError` rather than a generic
 * failure, so the caller can refresh the credential once and retry - an expired
 * access token is routine, not an outage.
 */
export class McpHttpClient implements McpClient {
  #sessionId: string | null = null;
  #protocolVersion: string = PROTOCOL_VERSIONS[0];
  #serverInfo: McpServerInfo | null = null;
  #nextId = 0;
  #connected = false;
  readonly #abort = new AbortController();

  constructor(private readonly spec: McpHttpServerSpec) {}

  get serverInfo(): McpServerInfo | null {
    return this.#serverInfo;
  }

  async connect(): Promise<void> {
    if (this.#connected) return;
    const { result, response } = await this.#rpc('initialize', initializeParams());
    this.#sessionId = response.headers.get('mcp-session-id');
    this.#protocolVersion = readString(result, 'protocolVersion') ?? this.#protocolVersion;
    this.#serverInfo = readServerInfo(result);
    this.#connected = true;
    await this.#send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async listTools(): Promise<readonly McpToolDefinition[]> {
    const tools: McpToolDefinition[] = [];
    let cursor: string | null = null;
    // Hosted servers paginate. Reading only the first page would publish a
    // silently truncated tool list, which looks exactly like a working one.
    for (let page = 0; page < MAX_PAGES; page++) {
      const { result } = await this.#rpc('tools/list', cursor === null ? {} : { cursor });
      tools.push(...readTools(result));
      cursor = readString(result, 'nextCursor');
      if (cursor === null) break;
    }
    return tools;
  }

  async callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<McpCallResult> {
    const { result } = await this.#rpc('tools/call', { name, arguments: args });
    return readCallResult(result);
  }

  close(): void {
    const sessionId = this.#sessionId;
    this.#connected = false;
    this.#sessionId = null;
    this.#abort.abort();
    if (sessionId === null) return;
    // Best effort: telling the server the session is over lets it free what it
    // holds, but a server that is unreachable is no reason to fail a close.
    void this.#fetch()(this.spec.url, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': this.#protocolVersion },
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }

  // ----------------------------------------------------------------- wire

  async #rpc(method: string, params: unknown): Promise<{ result: unknown; response: Response }> {
    const id = ++this.#nextId;
    const response = await this.#send({ jsonrpc: '2.0', id, method, params });
    const message = await this.#readResponse(response, id, method);
    const error = asRecord(message)?.['error'];
    if (error !== undefined && error !== null) {
      throw new Error(readString(error, 'message') ?? `The MCP server rejected '${method}'.`);
    }
    return { result: asRecord(message)?.['result'], response };
  }

  async #send(message: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': this.#protocolVersion,
    };
    if (this.#sessionId !== null) headers['mcp-session-id'] = this.#sessionId;
    const token = await this.spec.accessToken?.();
    if (token) headers['authorization'] = `Bearer ${token}`;

    const method = typeof message['method'] === 'string' ? message['method'] : 'request';
    const timeoutMs = this.spec.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    let response: Response;
    try {
      response = await this.#fetch()(this.spec.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.any([
          this.#abort.signal,
          AbortSignal.timeout(timeoutMs),
          ...(this.spec.signal === undefined ? [] : [this.spec.signal]),
        ]),
      });
    } catch (e) {
      throw new Error(`Could not reach ${new URL(this.spec.url).host} for '${method}': ${errorMessage(e)}`);
    }

    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new IntegrationUnauthorizedError(
        response.status === 401
          ? `${new URL(this.spec.url).host} needs you to connect your account again.`
          : `${new URL(this.spec.url).host} refused access with the account that is connected.`,
      );
    }
    if (!response.ok && response.status !== 202) {
      const text = await response.text().catch(() => '');
      throw new Error(`${new URL(this.spec.url).host} answered '${method}' with HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    return response;
  }

  /** The JSON-RPC message answering `id`, from a JSON body or an SSE stream. */
  async #readResponse(response: Response, id: number, method: string): Promise<unknown> {
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) return this.#readStream(response, id, method);
    const text = await response.text();
    if (text.trim() === '') throw new Error(`${new URL(this.spec.url).host} sent an empty answer to '${method}'.`);
    const parsed: unknown = JSON.parse(text);
    // A batch reply is legal; take the member answering this request.
    return Array.isArray(parsed) ? parsed.find((m) => answers(m, id)) : parsed;
  }

  async #readStream(response: Response, id: number, method: string): Promise<unknown> {
    const body = response.body;
    if (body === null) throw new Error(`${new URL(this.spec.url).host} opened an empty stream for '${method}'.`);
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value !== undefined) buffer += value;
        // Events are separated by a blank line; a partial one waits for more.
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary !== -1) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data !== '') {
            const message = safeParse(data);
            // Progress notifications and server requests share the stream;
            // only the answer to this request ends the read.
            if (answers(message, id)) return message;
          }
          boundary = buffer.search(/\r?\n\r?\n/);
        }
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    throw new Error(`${new URL(this.spec.url).host} closed the stream without answering '${method}'.`);
  }

  #fetch(): typeof fetch {
    return this.spec.fetch ?? fetch;
  }
}

/**
 * Whether a message is the response to request `id`.
 *
 * A server may send its own requests - `ping`, `roots/list`, elicitation - on
 * the same stream, numbered independently of ours. Matching on id alone would
 * take a server request that happens to share the number as the reply.
 */
function answers(message: unknown, id: number): boolean {
  const record = asRecord(message);
  return record !== null && record['id'] === id && record['method'] === undefined
    && ('result' in record || 'error' in record);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
