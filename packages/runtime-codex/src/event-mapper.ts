import type { AgentEvent, AgentEventType } from '@tandemise/domain';
import { summarize } from '@tandemise/shared';

/**
 * Codex event type → canonical type, as a best-effort default table.
 *
 * Like the argv defaults, this is unverified against a live binary and is
 * overridable per profile via `settings.eventTypes`. Anything absent from the
 * table becomes a `raw` event rather than a guess, so an unrecognised Codex
 * release degrades to "the timeline shows the raw log" instead of "the timeline
 * shows something untrue".
 */
export const DEFAULT_CODEX_EVENT_TYPES: Readonly<Record<string, AgentEventType | 'ignore'>> = {
  session_configured: 'checkpoint',
  task_started: 'checkpoint',
  agent_message: 'message',
  'item.completed': 'message',
  agent_reasoning: 'thinking_summary',
  // Deltas arrive per token; the completed event carries the same content.
  agent_reasoning_delta: 'ignore',
  agent_message_delta: 'ignore',
  exec_command_begin: 'tool.started',
  exec_command_end: 'tool.completed',
  exec_command_output_delta: 'ignore',
  mcp_tool_call_begin: 'tool.started',
  mcp_tool_call_end: 'tool.completed',
  patch_apply_begin: 'tool.started',
  patch_apply_end: 'tool.completed',
  token_count: 'usage',
  task_complete: 'completed',
  'turn.completed': 'completed',
  error: 'failed',
  stream_error: 'failed',
  'turn.failed': 'failed',
};

const RETRYABLE_FAILURE = /rate.?limit|timeout|timed out|overload|unavailable|econnreset|enotfound|socket hang up|429|502|503|529/i;

export interface CodexEventMapperOptions {
  readonly eventTypes: Readonly<Record<string, AgentEventType | 'ignore'>>;
}

/**
 * Translates Codex CLI JSON-lines output into the canonical vocabulary
 * (MVP.md §10.4).
 *
 * Codex wraps its payload in `{ id, msg: { type, ... } }` on the classic
 * protocol and emits a flatter `{ type, item }` shape on the newer experimental
 * one. Both are unwrapped here rather than forcing the user to configure which
 * dialect their build speaks.
 */
export class CodexEventMapper {
  readonly #types: Readonly<Record<string, AgentEventType | 'ignore'>>;
  #sessionId: string | null = null;

  constructor(options: CodexEventMapperOptions) {
    this.#types = { ...DEFAULT_CODEX_EVENT_TYPES, ...options.eventTypes };
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  /** Returns `null` when the line is not recognised, so the caller can keep it raw. */
  map(raw: unknown): AgentEvent[] | null {
    const envelope = asRecord(raw);
    if (envelope === null) return null;
    // `msg` is the classic protocol's payload; `item` the experimental one.
    const body = asRecord(envelope['msg']) ?? asRecord(envelope['item']) ?? envelope;

    const session = asString(envelope['session_id'])
      ?? asString(body['session_id'])
      ?? asString(body['conversation_id'])
      ?? asString(body['thread_id']);
    if (session !== null) this.#sessionId = session;

    const codexType = asString(body['type']) ?? asString(envelope['type']);
    if (codexType === null) return null;
    const target = this.#types[codexType];
    if (target === 'ignore') return [];
    if (target === undefined) return null;

    return this.#build(target, codexType, body);
  }

  #build(target: AgentEventType, codexType: string, body: Record<string, unknown>): AgentEvent[] {
    switch (target) {
      case 'checkpoint':
        return [{
          type: 'checkpoint',
          externalSessionId: this.#sessionId ?? undefined,
          label: codexType,
        }];

      case 'message': {
        const text = asString(body['message']) ?? asString(body['last_agent_message']) ?? asString(body['text']);
        return text === null || text.trim().length === 0 ? [] : [{ type: 'message', text }];
      }

      case 'thinking_summary': {
        const text = asString(body['text']) ?? asString(body['reasoning']) ?? asString(body['message']);
        return text === null || text.trim().length === 0 ? [] : [{ type: 'thinking_summary', text }];
      }

      case 'tool.started':
        return this.#toolStarted(codexType, body);

      case 'tool.completed':
        return [{
          type: 'tool.completed',
          tool: toolName(codexType, body),
          outcome: failedOutcome(body) ? 'error' : 'ok',
          outputSummary: summarize(body['stdout'] ?? body['output'] ?? body['result'] ?? ''),
        }];

      case 'usage': {
        const info = asRecord(body['info']) ?? body;
        return [{
          type: 'usage',
          inputTokens: asNumber(info['input_tokens']),
          outputTokens: asNumber(info['output_tokens']),
          cacheReadTokens: asNumber(info['cached_input_tokens']),
          // Codex bills through the user's own ChatGPT plan; it reports no
          // per-run cost, and null says "unknown" rather than "free".
          costUsd: null,
        }];
      }

      case 'completed':
        return [{
          type: 'completed',
          resultRef: this.#sessionId ?? undefined,
          summary: asString(body['last_agent_message']) ?? asString(body['message']) ?? undefined,
        }];

      case 'failed': {
        const message = asString(body['message']) ?? asString(body['error']) ?? codexType;
        return [{
          type: 'failed',
          code: codexType,
          message,
          retryable: RETRYABLE_FAILURE.test(`${codexType} ${message}`),
        }];
      }

      default:
        return [];
    }
  }

  #toolStarted(codexType: string, body: Record<string, unknown>): AgentEvent[] {
    const tool = toolName(codexType, body);
    const input = body['command'] ?? body['arguments'] ?? body['changes'] ?? body;
    const events: AgentEvent[] = [{ type: 'tool.started', tool, inputSummary: summarize(input) }];

    // A patch names every file it touches, which is the one place Codex tells
    // us about filesystem changes in a form we can trust.
    for (const [path, change] of patchedPaths(body)) {
      events.push({ type: 'file.changed', path, change });
    }
    return events;
  }
}

/** `changes` maps an absolute path to a one-key object: `add`, `update` or `delete`. */
function patchedPaths(body: Record<string, unknown>): Array<[string, 'add' | 'edit' | 'delete']> {
  const changes = asRecord(body['changes']);
  if (changes === null) return [];
  const out: Array<[string, 'add' | 'edit' | 'delete']> = [];
  for (const [path, value] of Object.entries(changes)) {
    if (path.length === 0) continue;
    const kinds = Object.keys(asRecord(value) ?? {});
    const change = kinds.includes('add') ? 'add' : kinds.includes('delete') ? 'delete' : 'edit';
    out.push([path, change]);
  }
  return out;
}

function toolName(codexType: string, body: Record<string, unknown>): string {
  if (codexType.startsWith('exec_command')) return 'Shell';
  if (codexType.startsWith('patch_apply')) return 'ApplyPatch';
  return asString(body['tool'])
    ?? asString(body['server'])
    ?? asString(body['name'])
    ?? codexType;
}

function failedOutcome(body: Record<string, unknown>): boolean {
  const exitCode = asNumber(body['exit_code']);
  if (exitCode !== undefined) return exitCode !== 0;
  return body['success'] === false || body['is_error'] === true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
