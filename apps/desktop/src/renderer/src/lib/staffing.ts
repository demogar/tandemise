import type { StaffingPatch, StaffingReview } from '@tandemise/domain';
import { STAFFING_PRESETS, type StaffingPreset } from '@tandemise/domain/staffing-presets';
import type { TaskStaffingPatchRequest } from '@tandemise/api-contract';
import type { Actors } from './team.js';
import { flag } from './flags.js';

export const PRESET_LABELS: Readonly<Record<StaffingPreset, string>> = {
  ai_only: 'AI only',
  ai_then_approve: 'AI drafts, responsible approves',
  ai_then_check: 'AI drafts, responsible checks later',
  person: 'A person does it',
  pool: 'Anyone from a group',
  ai_safety_net: 'AI with a safety net',
  custom: 'Custom',
};

/**
 * The staffing presets a picker offers, gated by feature flags.
 *
 * The full list still exists in `STAFFING_PRESETS` so stored staffing keeps
 * round-tripping; these are only what the user can choose.
 */
export const STAFFING_PRESET_OPTIONS: readonly StaffingPreset[] = flag('agentsOnly')
  ? STAFFING_PRESETS.filter((preset) => preset !== 'person' && preset !== 'pool')
  : [...STAFFING_PRESETS];

/**
 * The value a preset picker should display. Presets hidden by feature flags
 * (`person`, `pool`) still exist as stored staffing, so they must never be the
 * select's `value` — otherwise the select has no matching `<option>` and
 * renders blank. They read as Custom, which is the truth: not one of the shapes
 * the picker offers.
 */
export function displayedPreset(preset: StaffingPreset): StaffingPreset {
  return STAFFING_PRESET_OPTIONS.includes(preset) ? preset : 'custom';
}

export const ESCALATION_OPTIONS: readonly { value: number | null; label: string }[] = [
  { value: 3_600_000, label: 'after 1 hour' },
  { value: 4 * 3_600_000, label: 'after 4 hours' },
  { value: 86_400_000, label: 'after 1 day' },
  { value: 3 * 86_400_000, label: 'after 3 days' },
  { value: null, label: 'never' },
];

/**
 * One line that says who does a role and who answers for it:
 * "Ana's Figma agent · Ana approves". The Team screen shows only this per role,
 * so it has to carry the whole decision in words, not field names.
 */
export function staffingSummary(patch: StaffingPatch, roleId: string, actors: Actors): string {
  const assignees = (patch.assignees ?? builtInAssignees(roleId, actors)).filter((id) => actors.byId.get(id)?.active);
  const members = assignees.map((id) => actors.byId.get(id)).filter((m) => m !== undefined);
  const agents = members.filter((m) => m.kind === 'agent');
  const people = members.filter((m) => m.kind === 'person');
  const mode = patch.mode ?? 'first_available';
  const first = mode === 'pool' ? (agents[0] ?? people[0]) : members[0];

  const owner = actors.people.find((p) => p.access === 'owner') ?? actors.people[0];
  const responsibleId =
    patch.responsible ?? (first === undefined ? owner?.id : first.kind === 'person' ? first.id : first.reportsTo) ?? null;
  const responsible = lower(actors.name(responsibleId));

  let who: string;
  if (first === undefined) {
    who = mode === 'pool' ? `${cap(responsible)} ${verb(responsible, 'pick')} it up` : 'Any enabled runtime';
  } else if (first.kind === 'agent') {
    const ownerName = first.reportsTo === actors.meId ? 'Your' : `${actors.byId.get(first.reportsTo ?? '')?.name ?? 'Someone'}'s`;
    const fallback = agents.length > 1 ? ` (+${agents.length - 1})` : '';
    who = `${ownerName} ${first.name}${fallback}`;
  } else if (mode === 'pool') {
    who = `${orList(people.map((p) => actors.name(p.id)))} ${people.length === 1 ? verb(lower(actors.name(people[0]?.id)), 'pick') : 'picks'} it up`;
  } else {
    const name = actors.name(first.id);
    who = `${name} ${verb(lower(name), 'do')} it`;
  }

  const reviews = patch.reviews ?? [];
  const parts = [who];
  if (reviews.length === 1) parts.push(reviewPhrase(reviews[0] as StaffingReview, responsible, actors));
  else if (reviews.length > 1) parts.push(`${reviews.length} reviews`);
  else if (first?.kind === 'agent' || first === undefined) parts.push(responsible === 'you' ? "You're responsible" : `${responsible} is responsible`);
  return parts.join(' · ');
}

function reviewPhrase(review: StaffingReview, responsible: string, actors: Actors): string {
  const by = review.by === 'responsible' ? responsible : orList(review.by.map((id) => lower(actors.name(id))));
  const single = review.by === 'responsible' || review.by.length === 1;
  const act = review.mode === 'after' ? 'check' : 'approve';
  const head = `${cap(by)} ${single ? verb(by, act) : `${act}s`}`;
  if (review.mode === 'after') return `${head} later`;
  if (review.when === 'always') return head;
  if (/task\.risk_level\s*>=\s*2/.test(review.when)) return `${head} risky work`;
  return `${head} when ${review.when}`;
}

/** Who the built-in layer would pick: every active agent that has the role. */
export function builtInAssignees(roleId: string, actors: Actors): string[] {
  return actors.agents.filter((a) => a.roleIds.includes(roleId)).map((a) => a.id);
}

function verb(subject: string, base: string): string {
  if (subject === 'you') return base;
  return base === 'do' ? 'does' : `${base}s`;
}

function orList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

function lower(name: string): string {
  return name === 'You' ? 'you' : name;
}

function cap(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The request schema's arrays are mutable; the domain's are readonly. Same data. */
export function toWire(patch: StaffingPatch | null): TaskStaffingPatchRequest {
  return patch as TaskStaffingPatchRequest;
}
