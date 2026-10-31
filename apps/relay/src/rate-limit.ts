/**
 * Failed auth, per IP (spec §Security, "Brute force"): ten failures in a
 * minute, then every request from that address is refused for ten minutes.
 * Covers bad device tokens and bad invite codes alike.
 */
export class FailedAuthLimiter {
  readonly #failures = new Map<string, number[]>();
  readonly #lockedUntil = new Map<string, number>();

  constructor(
    private readonly now: () => number,
    private readonly maxFailures = 10,
    private readonly windowMs = 60_000,
    private readonly lockMs = 600_000,
  ) {}

  locked(ip: string): boolean {
    const until = this.#lockedUntil.get(ip);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.#lockedUntil.delete(ip);
    return false;
  }

  /** Drops windows and locks that are over. Runs on every failure and every minute. */
  sweep(): void {
    const now = this.now();
    for (const [ip, times] of this.#failures) {
      const recent = times.filter((t) => now - t < this.windowMs);
      if (recent.length === 0) this.#failures.delete(ip);
      else this.#failures.set(ip, recent);
    }
    for (const [ip, until] of this.#lockedUntil) if (until <= now) this.#lockedUntil.delete(ip);
  }

  /** Addresses tracked: what the sweep keeps bounded. */
  get size(): number {
    return this.#failures.size + this.#lockedUntil.size;
  }

  startSweep(everyMs = 60_000): () => void {
    const timer = setInterval(() => this.sweep(), everyMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  fail(ip: string): void {
    // A burst of addresses can't grow the maps without bound between sweeps.
    if (this.#failures.size > 10_000) this.sweep();
    const now = this.now();
    const recent = (this.#failures.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    this.#failures.set(ip, recent);
    if (recent.length >= this.maxFailures) {
      this.#lockedUntil.set(ip, now + this.lockMs);
      this.#failures.delete(ip);
    }
  }
}

/** A token bucket: `perMinute` refill, up to `burst`. One per webhook endpoint. */
export class TokenBuckets {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly now: () => number, private readonly perMinute = 60, private readonly burst = 120) {}

  take(key: string): boolean {
    const now = this.now();
    const b = this.#buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 60_000) * this.perMinute);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.#buckets.set(key, b);
    return ok;
  }
}
