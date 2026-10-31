import { TandemiseError } from '@tandemise/shared';

/** A vendor's wait is honoured up to an hour; past that Tandemise asks again anyway. */
const MAX_WAIT_MS = 3_600_000;
/** At least a second: a shorter wait is not worth a refusal. */
const MIN_WAIT_MS = 1_000;

/**
 * One tracker's wait after its vendor said "slow down" (Ruling 26): a 429
 * with `Retry-After`, or GitHub's rate-limit words from `gh`. Shared by every
 * call of one tracker adapter instance, so while the wait lasts the next
 * calls are refused at once, as a retryable `INTEGRATION_FAILED` in a plain
 * sentence, instead of hammering a vendor that already said no.
 */
export class RateGate {
  #untilMs = 0;

  /** `label` is the vendor's name in the sentence ("YouTrack", "GitHub"). */
  constructor(private readonly label: string, private readonly now: () => number = Date.now) {}

  /** Throws the plain sentence while a wait lasts; nothing otherwise. */
  check(): void {
    const left = this.#untilMs - this.now();
    if (left > 0) throw this.#refusal(left);
  }

  /** Starts (or lengthens) a wait of `ms`, and answers the error for the call the vendor refused. */
  wait(ms: number): TandemiseError {
    const capped = Math.min(Math.max(ms, MIN_WAIT_MS), MAX_WAIT_MS);
    this.#untilMs = Math.max(this.#untilMs, this.now() + capped);
    return this.#refusal(this.#untilMs - this.now());
  }

  #refusal(leftMs: number): TandemiseError {
    const seconds = Math.ceil(leftMs / 1000);
    return new TandemiseError('INTEGRATION_FAILED', `${this.label} asked Tandemise to slow down; it waits ${seconds} s before asking again.`, {
      retryable: true, details: { waitSeconds: seconds },
    });
  }
}

/** `Retry-After` in milliseconds: delta-seconds or an HTTP date. Null when absent or unreadable. */
export function retryAfterMs(header: string | null | undefined, nowMs: number): number | null {
  const value = header?.trim() ?? '';
  if (value === '') return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}
