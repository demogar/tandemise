import type { BadgeTone, Tone } from '../src/react/index.js';

/** The five status tones every status component speaks, in the order work moves through them. */
export const TONES = ['pending', 'running', 'blocked', 'failed', 'succeeded'] as const satisfies readonly Tone[];

/** Badge colours: the status tones, the accent and the release risk. */
export const BADGE_TONES = [...TONES, 'accent', 'release'] as const satisfies readonly BadgeTone[];
