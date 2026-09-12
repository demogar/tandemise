import type { ToolDescriptor } from '@tandemise/domain';
import type { ExternalRef } from '@tandemise/domain';
import type { ToolOutcome, ToolResult } from '../tool.js';

/**
 * The wire between the MCP server process and the daemon that owns the broker.
 *
 * It exists because the MCP server has to be a *separate process* - a runtime
 * spawns it and speaks stdio to it - while the broker, the policy engine and
 * the approval surface all live in the daemon. Rather than re-create any of
 * that in the child, the child forwards two questions over a run-scoped unix
 * socket and stays a pure protocol translator.
 *
 * Newline-delimited JSON, one frame per line. Small enough to read in one
 * sitting, which is the point: this is a trust boundary.
 */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** Environment the daemon sets on the spawned MCP server. */
export const BRIDGE_SOCKET_ENV = 'TANDEMISE_TOOL_BRIDGE';
export const BRIDGE_TOKEN_ENV = 'TANDEMISE_TOOL_BRIDGE_TOKEN';

export type BridgeRequest =
  | { readonly id: number; readonly type: 'list'; readonly token: string }
  | {
      readonly id: number;
      readonly type: 'call';
      readonly token: string;
      readonly tool: string;
      readonly input: unknown;
    };

/**
 * A JSON-safe projection of `ToolResult`.
 *
 * Evidence bytes deliberately do not cross: a screenshot belongs in the
 * artifact store, written by the application layer on the daemon side, and
 * shipping megabytes through an agent's stdio would be both wasteful and a way
 * for binary content to reach a context window (MVP.md §15).
 */
export interface BridgeToolResult {
  readonly tool: string;
  readonly outcome: ToolOutcome;
  readonly output: unknown;
  readonly summary: string;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly externalRefs: readonly ExternalRef[];
  /** Filenames of evidence retained daemon-side, so the agent can refer to it. */
  readonly evidence: readonly string[];
  readonly durationMs: number;
}

export type BridgeResponse =
  | { readonly id: number; readonly ok: true; readonly tools: readonly ToolDescriptor[] }
  | { readonly id: number; readonly ok: true; readonly result: BridgeToolResult }
  | { readonly id: number; readonly ok: false; readonly error: string };

export function toBridgeResult(result: ToolResult): BridgeToolResult {
  return {
    tool: result.tool,
    outcome: result.outcome,
    output: result.output,
    summary: result.summary,
    error: result.error,
    externalRefs: result.externalRefs,
    evidence: result.evidence.map((e) => e.filename),
    durationMs: result.durationMs,
  };
}

/**
 * Splits a byte stream into complete lines.
 *
 * A socket read is not a message boundary; assuming it is produces a bug that
 * only appears under load, which is the worst kind to have on a security
 * boundary.
 */
export class LineStream {
  #buffer = '';

  push(chunk: string): readonly string[] {
    this.#buffer += chunk;
    const parts = this.#buffer.split('\n');
    this.#buffer = parts.pop() ?? '';
    return parts.filter((line) => line.trim().length > 0);
  }
}
