/** Joins class names, skipping the falsy ones: `cx('btn', primary && 'btn--primary')`. */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** The status tones every status component speaks: a task, a run, a check. */
export type Tone = 'running' | 'blocked' | 'failed' | 'succeeded' | 'pending';

/** Badge colours: a status tone, the accent, or the release risk. */
export type BadgeTone = Tone | 'accent' | 'release';
