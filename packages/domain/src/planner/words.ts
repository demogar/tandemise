import type { Lane, ProfileSignal, RiskLevel, TaskProfile, TaskSize, TaskType } from './types.js';

/**
 * The factory's choices in a person's words (#53 §10). Built here so the
 * daemon says them and the renderer only shows them: no raw enum reaches the
 * screen.
 */
const TYPE_WORDS: Readonly<Record<TaskType, string>> = {
  fix: 'Fix', feature: 'Feature', refactor: 'Refactor', chore: 'Chore', docs: 'Docs', deps: 'Dependencies',
  test: 'Tests', security: 'Security', unknown: 'Unclear kind of work',
};
const SIZE_WORDS: Readonly<Record<TaskSize, string>> = { xs: 'tiny', s: 'small', m: 'medium', l: 'large' };
const RISK_WORDS: Readonly<Record<RiskLevel, string>> = { low: 'low risk', medium: 'medium risk', high: 'high risk' };

export function profileChips(profile: Pick<TaskProfile, 'type' | 'size' | 'risk'>): readonly [string, string, string] {
  return [TYPE_WORDS[profile.type], SIZE_WORDS[profile.size], RISK_WORDS[profile.risk]];
}

/** "Fix · tiny · low risk". */
export function profileLine(profile: Pick<TaskProfile, 'type' | 'size' | 'risk'>): string {
  return profileChips(profile).join(' · ');
}

export function laneLine(lane: Lane, steps: number): string {
  switch (lane) {
    case 'quick': return steps <= 2 ? 'Quick lane: one step, then a pull request.' : `Quick lane: ${steps - 1} steps, then a pull request.`;
    case 'standard': return `Standard lane: ${steps - 1} ${steps - 1 === 1 ? 'step' : 'steps'}, then a pull request.`;
    case 'careful': return `Careful lane: ${steps - 1} ${steps - 1 === 1 ? 'step' : 'steps'}, a plan you approve, then a pull request that always asks for review.`;
  }
}

/** A signal as a sentence: "Tracker type Bug → fix". */
export function signalSentence(signal: ProfileSignal): string {
  const name = signal.name.charAt(0).toUpperCase() + signal.name.slice(1);
  if (signal.effect.startsWith('disagrees:')) return `${name} ${signal.value} disagreed (${signal.effect.slice('disagrees:'.length).trim()})`;
  return `${name} ${signal.value} → ${signal.effect}`;
}
