import type { AgentEvent } from '@tandemise/domain';
import { Err, Ok, TandemiseError, asId, redactSecrets, summarize } from '@tandemise/shared';
import type { Result } from '@tandemise/shared';

/**
 * Free text kept in full (redacted) rather than summarized: a `message` is what
 * the user actually reads in the timeline, and `summarize` collapses whitespace,
 * which would destroy code blocks and lists. Still clipped, because a runaway
 * runtime must not be able to grow one event without bound.
 */
export const MAX_TEXT_CHARS = 16_000;
/** Fields that exist to be skimmed. `summarize` collapses whitespace on purpose. */
export const MAX_SUMMARY_CHARS = 400;

function clip(text: string, max: number): string {
  const redacted = redactSecrets(text);
  return redacted.length <= max ? redacted : `${redacted.slice(0, max)}… (+${redacted.length - max} chars)`;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function invalid(detail: string, event: unknown): Result<never, TandemiseError> {
  return Err(TandemiseError.validation(`Adapter produced an invalid AgentEvent: ${detail}`, {
    event: summarize(event, 200),
  }));
}

/** Copies `key` from `source` onto `target` only when it carries a real number. */
function copyNumber(target: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  const value = num(source[key]);
  if (value !== undefined) target[key] = value;
}

/**
 * Validates an adapter-produced value against the canonical `AgentEvent` union
 * and normalizes its free text (MVP.md §10.4, §22.3).
 *
 * This is the one place that decides what a well-formed event is, so an adapter
 * cannot quietly widen the organization's vocabulary or leak an unredacted
 * token into the timeline. It narrows from `unknown` deliberately: adapters
 * build these from CLI output, which is a trust boundary.
 */
export function normalizeAgentEvent(input: unknown): Result<AgentEvent, TandemiseError> {
  if (typeof input !== 'object' || input === null) return invalid('not an object', input);
  const e = input as Record<string, unknown>;
  const type = str(e['type']);
  if (type === null) return invalid('missing `type`', input);

  switch (type) {
    case 'message':
    case 'thinking_summary': {
      const text = str(e['text']);
      if (text === null) return invalid(`${type} without text`, input);
      // A thinking *summary* is meant to be skimmed; a message is meant to be read.
      return Ok(type === 'message'
        ? { type, text: clip(text, MAX_TEXT_CHARS) }
        : { type, text: summarize(text, MAX_SUMMARY_CHARS) });
    }

    case 'tool.started': {
      const tool = str(e['tool']);
      if (tool === null) return invalid('tool.started without tool', input);
      return Ok({ type, tool, inputSummary: summarize(e['inputSummary'] ?? '', MAX_SUMMARY_CHARS) });
    }

    case 'tool.completed': {
      const tool = str(e['tool']);
      const outcome = str(e['outcome']);
      if (tool === null) return invalid('tool.completed without tool', input);
      if (outcome !== 'ok' && outcome !== 'error') return invalid(`tool.completed outcome '${outcome}'`, input);
      const out: AgentEvent = e['outputSummary'] === undefined
        ? { type, tool, outcome }
        : { type, tool, outcome, outputSummary: summarize(e['outputSummary'], MAX_SUMMARY_CHARS) };
      return Ok(out);
    }

    case 'file.changed': {
      const path = str(e['path']);
      const change = str(e['change']);
      if (path === null || path === '') return invalid('file.changed without path', input);
      if (change !== 'add' && change !== 'edit' && change !== 'delete') {
        return invalid(`file.changed change '${change}'`, input);
      }
      return Ok({ type, path, change });
    }

    case 'artifact.created': {
      const id = str(e['artifactId']);
      if (id === null) return invalid('artifact.created without artifactId', input);
      return Ok({ type, artifactId: asId(id) });
    }

    case 'approval.requested': {
      const id = str(e['approvalId']);
      if (id === null) return invalid('approval.requested without approvalId', input);
      return Ok({ type, approvalId: asId(id) });
    }

    case 'usage': {
      const usage: Record<string, unknown> = { type };
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
        copyNumber(usage, e, key);
      }
      // Subscription runtimes report no trustworthy cost; null says "unknown",
      // which is different from "free" (MVP.md §22.2).
      const cost = e['costUsd'];
      if (cost === null || num(cost) !== undefined) usage['costUsd'] = cost === null ? null : num(cost);
      return Ok(usage as unknown as AgentEvent);
    }

    case 'checkpoint': {
      const checkpoint: Record<string, unknown> = { type };
      const session = str(e['externalSessionId']);
      const label = str(e['label']);
      if (session !== null) checkpoint['externalSessionId'] = session;
      if (label !== null) checkpoint['label'] = label;
      return Ok(checkpoint as unknown as AgentEvent);
    }

    case 'completed': {
      const completed: Record<string, unknown> = { type };
      const resultRef = str(e['resultRef']);
      if (resultRef !== null) completed['resultRef'] = resultRef;
      if (e['summary'] !== undefined) completed['summary'] = summarize(e['summary'], MAX_SUMMARY_CHARS);
      return Ok(completed as unknown as AgentEvent);
    }

    case 'failed': {
      const code = str(e['code']);
      const message = str(e['message']);
      if (code === null || message === null) return invalid('failed without code/message', input);
      return Ok({
        type,
        code,
        message: summarize(message, MAX_SUMMARY_CHARS),
        retryable: e['retryable'] === true,
      });
    }

    case 'raw': {
      const channel = str(e['channel']);
      const text = str(e['text']);
      if (channel !== 'stdout' && channel !== 'stderr') return invalid(`raw channel '${channel}'`, input);
      if (text === null) return invalid('raw without text', input);
      return Ok({ type, channel, text: clip(text, MAX_TEXT_CHARS) });
    }

    default:
      return invalid(`unknown type '${type}'`, input);
  }
}

/** True for the events that end a run's event stream. */
export function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === 'completed' || event.type === 'failed';
}
