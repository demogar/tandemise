import type { AgentEvent } from '@tandemise/domain';
import { TandemiseError, nullLogger } from '@tandemise/shared';
import type { Logger } from '@tandemise/shared';
import { isTerminalEvent, normalizeAgentEvent } from './normalize.js';

export interface NormalizingEventSinkOptions {
  readonly log?: Logger;
  /**
   * What to do with a value that is not a valid `AgentEvent`.
   *
   * `throw` (default) treats it as what it is - an adapter bug - and fails the
   * run loudly rather than shipping a silently wrong timeline. `raw` is the
   * resilient setting for adapters translating third-party output they do not
   * control: the payload survives in the raw log view instead of vanishing.
   */
  readonly onInvalid?: 'throw' | 'raw';
}

/**
 * The queue every adapter pushes through on its way to the caller.
 *
 * Adapters parse; this validates, redacts and orders. Centralising it is what
 * keeps a new adapter honest: there is no path from a runtime's stdout to the
 * mission timeline that skips `normalizeAgentEvent` (MVP.md §10.4).
 *
 * Ordering guarantee: events are yielded in push order, and `close()`/`abort()`
 * never discard events already queued.
 */
export class NormalizingEventSink implements AsyncIterable<AgentEvent> {
  readonly #queue: AgentEvent[] = [];
  readonly #log: Logger;
  readonly #onInvalid: 'throw' | 'raw';
  #waiter: ((r: IteratorResult<AgentEvent>) => void) | null = null;
  #failure: unknown = null;
  #closed = false;
  #terminated = false;

  constructor(options: NormalizingEventSinkOptions = {}) {
    this.#log = options.log ?? nullLogger;
    this.#onInvalid = options.onInvalid ?? 'throw';
  }

  /** Queued-but-unread events. Adapters pause their stdout stream on depth. */
  get pending(): number {
    return this.#queue.length;
  }

  /** True once a `completed` or `failed` event has been pushed. */
  get terminated(): boolean {
    return this.#terminated;
  }

  push(event: unknown): void {
    if (this.#closed) return;
    const result = normalizeAgentEvent(event);
    if (!result.ok) {
      if (this.#onInvalid === 'throw') throw result.error;
      this.#log.warn('dropping invalid agent event into raw log', { error: result.error.message });
      this.#enqueue({ type: 'raw', channel: 'stderr', text: result.error.message });
      return;
    }
    if (isTerminalEvent(result.value)) this.#terminated = true;
    this.#enqueue(result.value);
  }

  /** Convenience for the unclassifiable-output path every adapter has. */
  raw(channel: 'stdout' | 'stderr', text: string): void {
    if (text.length > 0) this.push({ type: 'raw', channel, text });
  }

  /**
   * Pushes a terminal event unless the run already produced one.
   *
   * Every process-backed adapter has two sources of a verdict - the runtime's
   * own result record and the child's exit - and they both fire on a normal
   * run. A terminal event means "the run is over" to the executor, so emitting
   * two either double-counts the run or races the post-run harvest. These two
   * methods are the only supported way to end a stream, and they are guarded
   * here so that no adapter has to remember to do it.
   */
  fail(code: string, message: string, retryable: boolean): void {
    if (this.#terminated) return;
    this.push({ type: 'failed', code, message, retryable });
  }

  complete(result: { resultRef?: string; summary?: string } = {}): void {
    if (this.#terminated) return;
    this.push({ type: 'completed', ...result });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#wake();
  }

  /**
   * Ends the stream by rejecting the consumer. Reserved for failures the
   * consumer must not mistake for a normal end of run (a sink bug, a spawn
   * error); an *agent* failure is a `failed` event followed by `close()`.
   */
  abort(error: unknown): void {
    if (this.#closed) return;
    this.#failure = error instanceof Error ? error : new TandemiseError('INTERNAL', String(error));
    this.#closed = true;
    this.#wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    for (;;) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#failure !== null) throw this.#failure;
      if (this.#closed) return;
      const result = await new Promise<IteratorResult<AgentEvent>>((resolve) => {
        this.#waiter = resolve;
      });
      if (result.done) {
        if (this.#failure !== null) throw this.#failure;
        return;
      }
      yield result.value;
    }
  }

  #enqueue(event: AgentEvent): void {
    const waiter = this.#waiter;
    if (waiter !== null) {
      this.#waiter = null;
      waiter({ done: false, value: event });
      return;
    }
    this.#queue.push(event);
  }

  #wake(): void {
    const waiter = this.#waiter;
    if (waiter !== null) {
      this.#waiter = null;
      waiter({ done: true, value: undefined });
    }
  }
}
