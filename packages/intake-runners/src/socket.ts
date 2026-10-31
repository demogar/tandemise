import { setTimeout as delay } from 'node:timers/promises';
import type { RunnerContext } from '@tandemise/domain';
import { TandemiseError, errorMessage } from '@tandemise/shared';

/** Plan Task 12: a dropped socket is opened again after 1 s, doubling up to 30 s while it keeps failing. */
export const FIRST_RETRY_MS = 1_000;
export const MAX_RETRY_MS = 30_000;

/** One open connection, as the runner reads it. */
export interface SocketSession {
  /** Each text frame, in order. Not awaited: slow work goes through a `SerialQueue`. */
  onMessage(socket: WebSocket, data: string): void;
  /**
   * The socket closed, for whatever reason: clear the session's timers.
   * Answers the sentence for a close the vendor will repeat (Discord's 4004,
   * Slack's `link_disabled`), which stops the loop for good (Ruling 25).
   */
  onClose?(code: number, reason: string): string | undefined;
}

/**
 * A refusal the vendor will repeat however long the loop waits (Ruling 25):
 * thrown from `connect`, it stops the loop and the sentence goes on the
 * source's `last_error`.
 */
export function fatalSocketError(message: string): TandemiseError {
  return new TandemiseError('INTEGRATION_FAILED', message, { retryable: false, details: { fatal: true } });
}

function isFatal(e: unknown): e is TandemiseError {
  return e instanceof TandemiseError && e.details['fatal'] === true;
}

export interface SocketLoopOptions {
  readonly label: string;
  readonly ctx: RunnerContext;
  /**
   * Asks the vendor where to connect, every time: Slack's Socket Mode URLs
   * are single-use, and Discord's gateway URL can move.
   */
  connect(signal: AbortSignal): Promise<{ readonly url: string; readonly session: SocketSession }>;
}

/**
 * Keeps one outbound WebSocket open for a socket runner (spec §2: Slack's
 * Socket Mode and Discord's gateway, over Node 22's built-in `WebSocket`, so
 * no dependency). When the socket closes, or connecting fails, it tries again
 * after 1 s, doubling up to 30 s; a socket that delivered anything resets the
 * wait to 1 s, so a vendor's routine reconnect costs a second. Backoff runs on
 * real timers: the injected clock is for what Tandemise records, not for
 * waiting on a network. Stops when the host aborts the runner's signal or
 * `stop()` is called, closing the socket.
 *
 * Ruling 25: a connect that fails is reported to the host (`ctx.reportError`,
 * the source's `last_error`) and tried again; a socket that opens clears it
 * (`ctx.reportConnected`). A refusal the vendor will repeat (a
 * `fatalSocketError` from `connect`, or a close the session names) is
 * reported as fatal and the loop stops, so a revoked token is not hammered
 * every 30 s and the person sees why.
 */
export class SocketLoop {
  readonly #options: SocketLoopOptions;
  readonly #abort = new AbortController();
  readonly #signal: AbortSignal;
  readonly #done: Promise<void>;

  constructor(options: SocketLoopOptions) {
    this.#options = options;
    this.#signal = AbortSignal.any([options.ctx.signal, this.#abort.signal]);
    this.#done = this.#run();
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#done;
  }

  async #run(): Promise<void> {
    const { label, ctx } = this.#options;
    const signal = this.#signal;
    let wait = FIRST_RETRY_MS;
    while (!signal.aborted) {
      let heard = false;
      let fatal: string | undefined;
      try {
        const { url, session } = await this.#options.connect(signal);
        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          const socket = new WebSocket(url);
          const onAbort = (): void => { socket.close(1000); };
          signal.addEventListener('abort', onAbort, { once: true });
          socket.addEventListener('open', () => { if (!signal.aborted) ctx.reportConnected(); });
          socket.addEventListener('message', (ev) => {
            heard = true;
            if (typeof ev.data === 'string') {
              try {
                session.onMessage(socket, ev.data);
              } catch (e) {
                ctx.log.warn('intake.socket_frame_failed', { source: label, error: errorMessage(e) });
              }
            }
          });
          socket.addEventListener('close', (ev) => {
            signal.removeEventListener('abort', onAbort);
            fatal = session.onClose?.(ev.code, ev.reason);
            if (!signal.aborted) ctx.log.info('intake.socket_closed', { source: label, code: ev.code, reason: ev.reason });
            resolve();
          });
        });
      } catch (e) {
        if (isFatal(e)) fatal = e.message;
        else if (!signal.aborted) {
          ctx.log.warn('intake.socket_connect_failed', { source: label, error: errorMessage(e) });
          ctx.reportError(errorMessage(e));
        }
      }
      if (signal.aborted) break;
      if (fatal !== undefined) {
        ctx.log.warn('intake.socket_stopped', { source: label, error: fatal });
        ctx.reportError(fatal, { fatal: true });
        break;
      }
      if (heard) wait = FIRST_RETRY_MS;
      await delay(wait, undefined, { signal }).catch(() => {});
      wait = Math.min(wait * 2, MAX_RETRY_MS);
    }
  }
}

/**
 * Runs a socket runner's events one at a time, in arrival order, so two
 * reactions on the same thread never race each other into the pipeline. A
 * failed event is logged and the next one runs.
 */
export class SerialQueue {
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly onError: (e: unknown) => void) {}

  push(work: () => Promise<void>): void {
    this.#tail = this.#tail.then(work).catch((e: unknown) => { this.onError(e); });
  }

  /** Resolves once everything pushed so far has run. */
  idle(): Promise<void> {
    return this.#tail;
  }
}
