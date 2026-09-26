/** ISO-8601 UTC instant. Every timestamp crossing a boundary uses this shape. */
export type Timestamp = string;

export interface Clock {
  now(): Timestamp;
  epochMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  epochMs: () => Date.now(),
};

/** A clock that can be moved forward while it runs. */
export interface AdjustableClock extends Clock {
  /** Adds to the offset; answers with the new offset. */
  advance(ms: number): number;
  offsetMs(): number;
}

/**
 * Real time plus an offset the caller can grow: the daemon's test knob
 * (TANDEMISE_CLOCK_OFFSET_MS), so a real-app suite can reach a routine's next
 * run without waiting for it. Only ever moves forward, like time.
 */
export function adjustableClock(initialOffsetMs = 0, base: Clock = systemClock): AdjustableClock {
  let offset = initialOffsetMs;
  return {
    now: () => new Date(base.epochMs() + offset).toISOString(),
    epochMs: () => base.epochMs() + offset,
    advance: (ms: number) => {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError('The clock only moves forward.');
      offset += ms;
      return offset;
    },
    offsetMs: () => offset,
  };
}

/** Deterministic clock for tests and the fake runtime. */
export function fixedClock(startMs: number, stepMs = 1000): Clock {
  let t = startMs;
  return {
    now: () => new Date((t += stepMs)).toISOString(),
    epochMs: () => (t += stepMs),
  };
}

export function durationMs(from: Timestamp, to: Timestamp): number {
  return Date.parse(to) - Date.parse(from);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
