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

  fail(ip: string): void {
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
