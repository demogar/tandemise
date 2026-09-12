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
