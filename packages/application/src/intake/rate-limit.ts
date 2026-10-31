import type { Clock } from '@tandemise/shared';

/**
 * A sliding one-minute window per key, on the injected clock (plan Task 3,
 * spec §2 "Each token is rate-limited"). It counts signals, not requests, so a
 * batch of 50 uses 50 of the minute's allowance.
 *
 * In memory on purpose: a restart forgets the window, which errs on the side
 * of letting a runner push, and nothing about it needs to outlive the daemon.
 */
export class SlidingWindowLimit {
  readonly #seen = new Map<string, number[]>();

  constructor(
    private readonly clock: Clock,
    readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /**
   * Takes `count` from the key's allowance, all or none. False when that
   * would go past the limit inside the window; nothing is taken then.
   */
  take(key: string, count = 1): boolean {
    const now = this.clock.epochMs();
    const recent = (this.#seen.get(key) ?? []).filter((at) => at > now - this.windowMs);
    if (recent.length + count > this.limit) {
      this.#seen.set(key, recent);
      return false;
    }
    for (let i = 0; i < count; i++) recent.push(now);
    this.#seen.set(key, recent);
    return true;
  }
}
