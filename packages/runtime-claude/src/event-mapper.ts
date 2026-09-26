import type { AgentEvent } from '@tandemise/domain';
import { summarize } from '@tandemise/shared';

/**
 * Tools whose use means the filesystem changed. `Write` on a path that does not
 * yet exist is an add; everything else is an edit. Deletions are absent
 * deliberately - Claude Code deletes through `Bash`, where the path is not
 * recoverable from the tool input without parsing a shell command, and a
 * wrong `file.changed` is worse than a missing one.
 */
const FILE_MUTATING_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Result subtypes and messages worth another attempt (MVP.md §9.5). */
const RETRYABLE_FAILURE = /rate.?limit|timeout|timed out|overload|unavailable|econnreset|enotfound|socket hang up|502|503|529/i;

export interface ClaudeEventMapperOptions {
  /** Injected so the add-vs-edit decision stays testable without a real disk. */
  readonly fileExists: (path: string) => boolean;
  /**
   * Called when the CLI reports quota pressure. `AgentEvent` has no warning
   * member, and inventing one would widen the organization's vocabulary for a
   * vendor detail; `RuntimeHealth.quotaWarning` is where this belongs
   * (MVP.md §22.2).
   */
  readonly onQuotaWarning: (text: string) => void;
}

/**
 * Translates Claude Code's `stream-json` output into the canonical vocabulary
 * (MVP.md §10.4).
 *
 * Stateful by necessity: `tool_result` identifies its tool only by
 * `tool_use_id`, so the tool's *name* has to be remembered from the earlier
 * `tool_use` block for `tool.completed` to say anything useful.
 */
export class ClaudeEventMapper {
  readonly #toolNamesById = new Map<string, string>();
  readonly #options: ClaudeEventMapperOptions;
  #sessionId: string | null = null;

  constructor(options: ClaudeEventMapperOptions) {
    this.#options = options;
  }

  /** The session handle to persist for resume (MVP.md §21.2). */
  get sessionId(): string | null {
    return this.#sessionId;
  }

  map(raw: unknown): AgentEvent[] {
    const line = asRecord(raw);
    if (line === null) return [];
    const session = asString(line['session_id']);
    if (session !== null) this.#sessionId = session;

    switch (asString(line['type'])) {
      case 'system': return this.#mapSystem(line);
      case 'assistant': return this.#mapAssistant(line);
      case 'user': return this.#mapUser(line);
      case 'result': return this.#mapResult(line);
      case 'rate_limit_event': return this.#mapRateLimit(line);
      default: return [];
    }
  }

  #mapSystem(line: Record<string, unknown>): AgentEvent[] {
    // `hook_started`/`hook_response` describe the *user's* local Claude Code
    // configuration, not the work; `thinking_tokens` is a progress tick whose
    // totals the final `result` reports authoritatively. Both are noise here.
    if (asString(line['subtype']) !== 'init') return [];
    const session = asString(line['session_id']);
    return [{ type: 'checkpoint', externalSessionId: session ?? undefined, label: 'session.init' }];
  }

  #mapAssistant(line: Record<string, unknown>): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const block of contentBlocks(line)) {
      switch (asString(block['type'])) {
        case 'text': {
          const text = asString(block['text']);
          if (text !== null && text.trim().length > 0) events.push({ type: 'message', text });
          break;
        }
        case 'thinking': {
          const text = asString(block['thinking']);
          // Extended thinking arrives with an empty body plus a signature while
          // the model is still working; there is nothing to summarize yet.
          if (text !== null && text.trim().length > 0) events.push({ type: 'thinking_summary', text });
          break;
        }
        case 'tool_use':
          events.push(...this.#mapToolUse(block));
          break;
        default:
          break;
      }
    }
    return events;
  }

  #mapToolUse(block: Record<string, unknown>): AgentEvent[] {
    const tool = asString(block['name']);
    if (tool === null) return [];
    const id = asString(block['id']);
    if (id !== null) this.#toolNamesById.set(id, tool);

    const input = asRecord(block['input']) ?? {};
    const events: AgentEvent[] = [{ type: 'tool.started', tool, inputSummary: summarize(input) }];

    // A file change is emitted here, not on tool_result, because the result
    // carries no path - and the existence probe must happen *before* the write
    // lands or every create would look like an edit.
    const path = asString(input['file_path']) ?? asString(input['notebook_path']);
    if (path !== null && FILE_MUTATING_TOOLS.has(tool)) {
      const change = tool === 'Write' && !this.#options.fileExists(path) ? 'add' : 'edit';
      events.push({ type: 'file.changed', path, change });
    }
    return events;
  }

  #mapUser(line: Record<string, unknown>): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const block of contentBlocks(line)) {
      if (asString(block['type']) !== 'tool_result') continue;
      const id = asString(block['tool_use_id']);
      const tool = (id !== null ? this.#toolNamesById.get(id) : undefined) ?? 'unknown';
      if (id !== null) this.#toolNamesById.delete(id);
      events.push({
        type: 'tool.completed',
        tool,
        outcome: block['is_error'] === true ? 'error' : 'ok',
        outputSummary: summarize(block['content'] ?? ''),
      });
    }
    return events;
  }

  #mapResult(line: Record<string, unknown>): AgentEvent[] {
    const events: AgentEvent[] = [];
    const usage = asRecord(line['usage']);
    const cost = line['total_cost_usd'];
    if (usage !== null || typeof cost === 'number') {
      events.push({
        type: 'usage',
        inputTokens: asNumber(usage?.['input_tokens']),
        outputTokens: asNumber(usage?.['output_tokens']),
        cacheReadTokens: asNumber(usage?.['cache_read_input_tokens']),
        cacheWriteTokens: asNumber(usage?.['cache_creation_input_tokens']),
        costUsd: typeof cost === 'number' ? cost : null,
        // The result line's own duration: the time Claude Code spent on the run.
        wallTimeMs: asNumber(line['duration_ms']),
      });
    }

    const subtype = asString(line['subtype']) ?? 'unknown';
    const text = asString(line['result']);
    if (subtype === 'success' && line['is_error'] !== true) {
      events.push({
        type: 'completed',
        resultRef: this.#sessionId ?? undefined,
        summary: text ?? undefined,
      });
      return events;
    }

    const message = text ?? asString(line['api_error_status']) ?? subtype;
    events.push({
      type: 'failed',
      code: subtype,
      message,
      retryable: RETRYABLE_FAILURE.test(`${subtype} ${message}`),
    });
    return events;
  }

  #mapRateLimit(line: Record<string, unknown>): AgentEvent[] {
    const info = asRecord(line['rate_limit_info']);
    const status = asString(info?.['status']) ?? 'unknown';
    if (status === 'allowed') return [];
    const utilization = asNumber(info?.['utilization']);
    const window = asString(info?.['rateLimitType']) ?? 'unknown window';
    const detail = utilization === undefined
      ? `Claude Code reported rate limit status '${status}' (${window})`
      : `Claude Code reported rate limit status '${status}': ${Math.round(utilization * 100)}% of the ${window} limit used`;
    this.#options.onQuotaWarning(detail);
    // Kept in the raw log so the timeline can explain a slowdown after the fact.
    return [{ type: 'raw', channel: 'stderr', text: detail }];
  }
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

/** `message.content` is an array of blocks; anything else is not worth mapping. */
function contentBlocks(line: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = asRecord(line['message'])?.['content'];
  if (!Array.isArray(content)) return [];
  return content.map(asRecord).filter((b): b is Record<string, unknown> => b !== null);
}
