import type { MemberView } from '@tandemise/api-contract';
import type { StaffingPatch, StaffingReview } from '@tandemise/domain';
import {
  presetToStaffing, staffingToPreset, type StaffingPreset,
} from '@tandemise/domain/staffing-presets';
import { useState } from 'react';
import { Icon } from '../../components/Icon.js';
import { Field, Segmented } from '../../components/primitives.js';
import { ESCALATION_OPTIONS, PRESET_LABELS, STAFFING_PRESET_OPTIONS, builtInAssignees, displayedPreset, staffingSummary } from '../../lib/staffing.js';
import type { Actors } from '../../lib/team.js';

export type StaffingLevel = 'workspace' | 'mission' | 'task';

/** The `Team` shape `staffingToPreset` needs, built from the members the app already has. */
export function presetOf(value: StaffingPatch, actors: Actors): ReturnType<typeof staffingToPreset> {
  return staffingToPreset(value, { members: actors.members, byId: actors.byId, owners: actors.people.filter((p) => p.access === 'owner') });
}

/**
 * Applies a preset while keeping whoever was already picked, so switching from
 * "AI only" to "AI drafts, responsible approves" does not forget the agent.
 */
export function applyPreset(preset: Exclude<StaffingPreset, 'custom'>, current: StaffingPatch, roleId: string, actors: Actors): StaffingPatch {
  const known = presetOf(current, actors);
  const agents = known.agents.length > 0 ? known.agents : builtInAssignees(roleId, actors);
  const people = known.people.length > 0 ? known.people : peopleWithRole(roleId, actors);
  // A preset never delegates; clearing it here is what makes the pick stick
  // when the stored staffing had an explicit responsible person.
  return { ...presetToStaffing(preset, { agents, people }), responsible: null };
}

/** A people preset that found nobody to preselect: it needs a pick before it means anything. */
export function needsPick(preset: string, patch: StaffingPatch): preset is 'person' | 'pool' {
  return (preset === 'person' || preset === 'pool') && (patch.assignees ?? []).length === 0;
}

/**
 * The people a people preset starts with: whoever holds the role. Nobody holds
 * it, nobody is picked - picking everyone, or just you, would staff the role
 * with people who do not do it.
 */
export function peopleWithRole(roleId: string, actors: Actors): string[] {
  return actors.people.filter((p) => p.roleIds.includes(roleId)).map((p) => p.id);
}

/**
 * Who does a role, at any level.
 *
 * Presets first, because that is how people think about it; the full shape
 * (assignees, mode, responsible, reviews) only appears under Custom. The same
 * editor serves the workspace default, a mission's override and a task's, and
 * at the last two an empty value means "inherit".
 */
export function StaffingEditor({
  roleId,
  value,
  onChange,
  actors,
  level,
  inherited,
  startPreset,
  startCustom = false,
  disabled = false,
}: {
  roleId: string;
  value: StaffingPatch | null;
  onChange: (next: StaffingPatch | null) => void;
  actors: Actors;
  level: StaffingLevel;
  /** What applies without this override: said in the summary, and the starting point for a preset. */
  inherited?: StaffingPatch;
  /** A people preset chosen before the editor opened, with nobody picked yet. */
  startPreset?: 'person' | 'pool';
  /** Custom was chosen before the editor opened (a row's preset select): open straight into the full editor. */
  startCustom?: boolean;
  disabled?: boolean;
}): JSX.Element {
  const inherits = value === null || Object.keys(value).length === 0;
  const current: StaffingPatch = value ?? {};
  const base: StaffingPatch = inherits ? (inherited ?? {}) : current;
  // Unset assignees mean the built-in pick; showing them picked is the truth.
  const recognised = presetOf({ ...current, assignees: current.assignees ?? builtInAssignees(roleId, actors) }, actors);
  // A people preset with nobody picked yet is not recognisable from the
  // staffing alone (an empty pool reads as custom, an empty "person" as AI
  // only), so the choice is remembered until someone is picked - otherwise the
  // select would jump away from what was just chosen.
  const [chosen, setChosen] = useState<{ roleId: string; preset: 'person' | 'pool' } | null>(
    startPreset === undefined ? null : { roleId, preset: startPreset },
  );
  const unpicked = !inherits && (current.assignees ?? []).length === 0 && (current.reviews ?? []).length === 0;
  const pending = chosen !== null && chosen.roleId === roleId && unpicked
    && (current.mode ?? 'first_available') === (chosen.preset === 'pool' ? 'pool' : 'first_available') ? chosen.preset : null;
  // Custom is a mode, not a shape: the values it starts from usually still match
  // a preset, and deriving the select from them sent Custom straight back to
  // that preset before anything could be added. Once chosen it holds for this
  // editing session; picking a preset leaves it. A reopened editor derives again.
  const [customFor, setCustomFor] = useState<string | null>(startCustom ? roleId : null);
  const custom = customFor === roleId;
  const preset: StaffingPreset | 'inherit' = inherits && level !== 'workspace' && !custom
    ? 'inherit'
    : custom ? 'custom' : pending ?? recognised.preset;

  const setPreset = (next: string): void => {
    setChosen(next === 'person' || next === 'pool' ? { roleId, preset: next } : null);
    setCustomFor(next === 'custom' ? roleId : null);
    if (next === 'inherit') onChange(null);
    else if (next === 'custom') onChange({ ...base, assignees: base.assignees ?? builtInAssignees(roleId, actors) });
    else onChange(applyPreset(next as Exclude<StaffingPreset, 'custom'>, base, roleId, actors));
  };

  return (
    <fieldset className="staffing" disabled={disabled}>
      <div className="staffing__summary">
        <Icon name="workforce" size={13} />
        <span>{inherits && level !== 'workspace' ? `Default: ${staffingSummary(inherited ?? {}, roleId, actors)}` : staffingSummary(current, roleId, actors)}</span>
      </div>

      <Field label="How this role is staffed">
        <select className="select" value={preset === 'inherit' ? 'inherit' : displayedPreset(preset)} onChange={(event) => setPreset(event.target.value)}>
          {level !== 'workspace' ? <option value="inherit">{level === 'task' ? 'Same as the mission' : 'Same as the project'}</option> : null}
          {STAFFING_PRESET_OPTIONS.map((p) => (
            <option key={p} value={p}>
              {PRESET_LABELS[p]}
            </option>
          ))}
        </select>
      </Field>

      {preset === 'inherit' ? null : preset === 'custom' ? (
        <CustomFields value={current} onChange={onChange} actors={actors} />
      ) : preset === 'person' ? (
        <Field label="Who" hint={recognised.people.length === 0 ? 'Pick at least one.' : undefined}>
          <select
            className="select"
            value={recognised.people[0] ?? ''}
            onChange={(event) => onChange({ ...current, assignees: event.target.value === '' ? [] : [event.target.value] })}
          >
            {recognised.people.length === 0 ? <option value="">Pick someone</option> : null}
            {actors.people.map((p) => (
              <option key={p.id} value={p.id}>
                {actors.name(p.id)}
              </option>
            ))}
          </select>
        </Field>
      ) : preset === 'pool' ? (
        <Field label="Who can pick it up" hint={recognised.people.length === 0 ? 'Pick at least one.' : undefined}>
          <MemberPicks
            options={actors.people}
            picked={recognised.people}
            actors={actors}
            onChange={(ids) => onChange({ ...current, assignees: ids })}
          />
        </Field>
      ) : (
        <Field label="Agents, in order" hint={actors.agents.length === 0 ? 'No agents yet: the work runs on any enabled runtime.' : 'The first available one does the work.'}>
          <MemberPicks
            options={sortByRole(actors.agents, roleId)}
            picked={recognised.agents}
            actors={actors}
            ordered
            onChange={(ids) => onChange({ ...current, assignees: ids })}
          />
        </Field>
      )}

      {preset === 'inherit' ? null : (
        <Field label="If nobody answers, escalate">
          <select
            className="select"
            value={String(current.escalateAfterMs === undefined ? 86_400_000 : current.escalateAfterMs)}
            onChange={(event) => onChange({ ...current, escalateAfterMs: event.target.value === 'null' ? null : Number(event.target.value) })}
          >
            {ESCALATION_OPTIONS.map((o) => (
              <option key={String(o.value)} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      )}
    </fieldset>
  );
}

function CustomFields({ value, onChange, actors }: { value: StaffingPatch; onChange: (next: StaffingPatch) => void; actors: Actors }): JSX.Element {
  const reviews = value.reviews ?? [];
  const setReview = (index: number, patch: Partial<StaffingReview>): void =>
    onChange({ ...value, reviews: reviews.map((r, i) => (i === index ? { ...r, ...patch } : r)) });

  return (
    <>
      <Field label="Assignees, in order">
        <MemberPicks
          options={[...actors.people, ...actors.agents]}
          picked={[...(value.assignees ?? [])]}
          actors={actors}
          ordered
          onChange={(ids) => onChange({ ...value, assignees: ids })}
        />
      </Field>
      <div className="grid grid--2">
        <Field label="Mode">
          <Segmented
            block
            value={value.mode ?? 'first_available'}
            onChange={(mode) => onChange({ ...value, mode })}
            options={[
              { value: 'first_available', label: 'In order' },
              { value: 'pool', label: 'Pool' },
            ]}
          />
        </Field>
        <Field label="Responsible">
          <select
            className="select"
            value={value.responsible ?? ''}
            onChange={(event) => onChange({ ...value, responsible: event.target.value === '' ? null : event.target.value })}
          >
            <option value="">Automatic</option>
            {actors.people.map((p) => (
              <option key={p.id} value={p.id}>
                {actors.name(p.id)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="field">
        <span className="field__label">Reviews</span>
        {reviews.length === 0 ? <span className="field__hint">No review: the work counts as soon as its checks pass.</span> : null}
        {reviews.map((review, index) => (
          <div key={index} className="staffing__review">
            <select
              className="select"
              aria-label="Reviewer"
              value={review.by === 'responsible' ? 'responsible' : (review.by[0] ?? 'responsible')}
              onChange={(event) => setReview(index, { by: event.target.value === 'responsible' ? 'responsible' : [event.target.value] })}
            >
              <option value="responsible">Responsible</option>
              {actors.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {actors.name(p.id)}
                </option>
              ))}
            </select>
            <select
              className="select"
              aria-label="Review mode"
              value={review.mode}
              onChange={(event) => setReview(index, { mode: event.target.value as StaffingReview['mode'] })}
            >
              <option value="blocking">approves first</option>
              <option value="after">checks later</option>
            </select>
            <input
              className="input mono"
              aria-label="When"
              value={review.when}
              placeholder="always"
              onChange={(event) => setReview(index, { when: event.target.value || 'always' })}
            />
            <button
              type="button"
              className="btn btn--icon btn--ghost"
              aria-label="Remove review"
              onClick={() => onChange({ ...value, reviews: reviews.filter((_, i) => i !== index) })}
            >
              <Icon name="x" size={13} />
            </button>
          </div>
        ))}
        <div>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => onChange({ ...value, reviews: [...reviews, { by: 'responsible', mode: 'blocking', when: 'always' }] })}
          >
            <Icon name="plus" size={13} />
            Add review
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Toggle chips. With `ordered`, the order you pick them in is the order they
 * are tried, and the chip shows its rank so that is not a hidden rule.
 */
function MemberPicks({
  options,
  picked,
  onChange,
  actors,
  ordered = false,
}: {
  options: readonly MemberView[];
  picked: readonly string[];
  onChange: (ids: string[]) => void;
  actors: Actors;
  ordered?: boolean;
}): JSX.Element {
  if (options.length === 0) return <span className="field__hint">Nobody to pick yet.</span>;
  return (
    <div className="row row--wrap" style={{ gap: 'var(--s1)' }}>
      {options.map((m) => {
        const rank = picked.indexOf(m.id);
        const on = rank !== -1;
        return (
          <button
            key={m.id}
            type="button"
            className="pick"
            aria-pressed={on}
            onClick={() => onChange(on ? picked.filter((id) => id !== m.id) : [...picked, m.id])}
          >
            {ordered && on ? <span className="pick__rank">{rank + 1}</span> : null}
            {m.kind === 'agent' ? <Icon name="sparkle" size={11} /> : null}
            {actors.name(m.id)}
          </button>
        );
      })}
    </div>
  );
}

/** Agents that already have the role first: they are the likely pick. */
function sortByRole(agents: readonly MemberView[], roleId: string): MemberView[] {
  return [...agents].sort((a, b) => Number(b.roleIds.includes(roleId)) - Number(a.roleIds.includes(roleId)));
}
