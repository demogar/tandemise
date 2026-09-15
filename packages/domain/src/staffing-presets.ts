import type { StaffingPatch, StaffingReview, Team } from './staffing.js';

/**
 * The handful of staffing shapes most teams want, named in their words.
 *
 * Presets write ordinary staffing, so nothing downstream knows they exist; the
 * reverse mapping lets the Team screen show a stored staffing as the preset it
 * came from, and anything hand-edited beyond them as `custom`. Escalation and
 * notify are orthogonal to the preset and never make a staffing custom.
 */
export const STAFFING_PRESETS = ['ai_only', 'ai_then_approve', 'ai_then_check', 'person', 'pool', 'ai_safety_net', 'custom'] as const;
export type StaffingPreset = (typeof STAFFING_PRESETS)[number];

export interface StaffingPicks {
  readonly agents: readonly string[];
  readonly people: readonly string[];
}

const SAFETY_NET_WHEN = 'task.risk_level >= 2';

export function presetToStaffing(preset: Exclude<StaffingPreset, 'custom'>, picks: StaffingPicks): StaffingPatch {
  switch (preset) {
    case 'ai_only':
      return { assignees: [...picks.agents], mode: 'first_available', reviews: [] };
    case 'ai_then_approve':
      return { assignees: [...picks.agents], mode: 'first_available', reviews: [{ by: 'responsible', mode: 'blocking', when: 'always' }] };
    case 'ai_then_check':
      return { assignees: [...picks.agents], mode: 'first_available', reviews: [{ by: 'responsible', mode: 'after', when: 'always' }] };
    case 'person':
      return { assignees: picks.people.slice(0, 1), mode: 'first_available', reviews: [] };
    case 'pool':
      return { assignees: [...picks.people], mode: 'pool', reviews: [] };
    case 'ai_safety_net':
      return { assignees: [...picks.agents], mode: 'first_available', reviews: [{ by: 'responsible', mode: 'blocking', when: SAFETY_NET_WHEN }] };
  }
}

/** Recognises a stored staffing as a preset, or 'custom'. Round-trips presetToStaffing. */
export function staffingToPreset(s: StaffingPatch, team: Team): { preset: StaffingPreset; agents: string[]; people: string[] } {
  const assignees = [...(s.assignees ?? [])];
  const kinds = assignees.map((id) => team.byId.get(id)?.kind);
  const agents = assignees.filter((_, i) => kinds[i] === 'agent');
  const people = assignees.filter((_, i) => kinds[i] === 'person');
  const custom = { preset: 'custom' as const, agents, people };

  // Unknown members, or an explicit delegation, are beyond what a preset says.
  if (kinds.some((k) => k === undefined)) return custom;
  if (s.responsible !== undefined && s.responsible !== null) return custom;

  const mode = s.mode ?? 'first_available';
  const reviews = s.reviews ?? [];
  if (reviews.length > 1) return custom;
  const review = reviews[0];

  if (mode === 'pool') {
    return review === undefined && agents.length === 0 && people.length > 0 ? { preset: 'pool', agents, people } : custom;
  }
  if (people.length > 0) {
    return review === undefined && agents.length === 0 && people.length === 1 ? { preset: 'person', agents, people } : custom;
  }
  if (review === undefined) return { preset: 'ai_only', agents, people };
  if (!byResponsible(review)) return custom;
  if (review.mode === 'blocking' && review.when === 'always') return { preset: 'ai_then_approve', agents, people };
  if (review.mode === 'after' && review.when === 'always') return { preset: 'ai_then_check', agents, people };
  if (review.mode === 'blocking' && review.when.replace(/\s+/g, ' ').trim() === SAFETY_NET_WHEN) {
    return { preset: 'ai_safety_net', agents, people };
  }
  return custom;
}

function byResponsible(review: StaffingReview): boolean {
  return review.by === 'responsible';
}
