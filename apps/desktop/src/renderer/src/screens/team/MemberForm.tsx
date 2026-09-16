import { useMemo, useState } from 'react';
import type { MemberView } from '@tandemise/api-contract';
import type { AccessLevel } from '@tandemise/domain';
import { Icon } from '../../components/Icon.js';
import { ConfirmDialog, Drawer } from '../../components/Modal.js';
import { ErrorState, Field, Switch } from '../../components/primitives.js';
import { useDaemonMutation, useIntegrations, useRoles, useRuntimes } from '../../lib/queries.js';
import { useWorkspaceId } from '../../lib/workspace.js';
import { pluralize } from '../../lib/format.js';
import type { Actors } from '../../lib/team.js';

export type MemberTarget = { readonly kind: 'new-agent' } | { readonly kind: 'edit'; readonly member: MemberView };

const ACCESS: readonly { value: AccessLevel; label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'guest', label: 'Guest' },
];

/**
 * Add an agent, or edit a member, in a drawer.
 *
 * An agent needs an owner, roles and the runtimes it runs on in order; a person
 * has access and, once someone reports to them, how closely they oversee
 * delegated work. Only agents are added here: the app is you and your agents.
 */
export function MemberDrawer({ target, actors, onClose }: { target: MemberTarget; actors: Actors; onClose: () => void }): JSX.Element {
  const workspaceId = useWorkspaceId() ?? '';
  const editing = target.kind === 'edit' ? target.member : null;
  const isAgent = target.kind === 'new-agent' || editing?.kind === 'agent';

  const roles = useRoles();
  const runtimes = useRuntimes();
  const integrations = useIntegrations();

  const [name, setName] = useState(editing?.name ?? '');
  const [title, setTitle] = useState(editing?.title ?? '');
  // An existing member keeps where they are - '' is "Nobody (top of the team)", sent as null. Only a new
  // member defaults to reporting to me. (`editing?.reportsTo ?? me` sent the top owner as reporting to themselves.)
  const [reportsTo, setReportsTo] = useState<string>(editing ? editing.reportsTo ?? '' : actors.meId ?? '');
  const [access, setAccess] = useState<AccessLevel>(editing?.access ?? 'member');
  const [oversight, setOversight] = useState(editing?.oversight ?? 'delegate_owns');
  const [roleIds, setRoleIds] = useState<readonly string[]>(editing?.roleIds ?? []);
  const [runtimeIds, setRuntimeIds] = useState<readonly string[]>(editing?.runtimeProfileIds ?? []);
  const [integrationIds, setIntegrationIds] = useState<readonly string[]>(editing?.integrationIds ?? []);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const reports = editing ? actors.members.filter((m) => m.reportsTo === editing.id && m.status === 'active') : [];
  const agentsOwned = reports.filter((m) => m.kind === 'agent');
  // A manager cannot report to themselves or to anyone below them.
  const managers = useMemo(() => {
    if (!editing) return actors.people;
    const below = new Set<string>([editing.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const m of actors.members) {
        if (m.reportsTo !== null && below.has(m.reportsTo) && !below.has(m.id)) {
          below.add(m.id);
          grew = true;
        }
      }
    }
    return actors.people.filter((p) => !below.has(p.id));
  }, [actors, editing]);

  const save = useDaemonMutation(
    async (d) => {
      if (target.kind === 'new-agent') {
        return d.addMember(workspaceId, {
          kind: 'agent', name: name.trim(), reportsTo, roleIds: [...roleIds], runtimeProfileIds: [...runtimeIds],
          integrationIds: [...integrationIds], title: title.trim() || null,
        });
      }
      const member = target.member;
      if (member.kind === 'person') {
        if (member.personId && name.trim() !== member.name) await d.updatePerson(member.personId, { displayName: name.trim() });
        return d.updateMember(member.id, { reportsTo: reportsTo || null, access, oversight, title: title.trim() || null, roleIds: [...roleIds] });
      }
      return d.updateMember(member.id, {
        name: name.trim(), reportsTo, title: title.trim() || null, roleIds: [...roleIds],
        runtimeProfileIds: [...runtimeIds], integrationIds: [...integrationIds],
      });
    },
    ['workspaces', 'tasks'],
  );
  const remove = useDaemonMutation((d) => d.removeMember(editing?.id ?? ''), ['workspaces', 'tasks']);
  const restore = useDaemonMutation((d) => d.updateMember(editing?.id ?? '', { status: 'active' }), ['workspaces', 'tasks']);

  const valid = name.trim().length > 0 && (!isAgent || (reportsTo !== '' && roleIds.length > 0));
  const removed = editing?.status === 'removed';
  const heading = target.kind === 'new-agent' ? 'Add an agent' : editing?.name ?? '';

  return (
    <Drawer
      title={heading}
      subtitle={editing ? memberSubtitle(editing, actors) : 'Works for a person, on the runtimes you rank.'}
      onClose={onClose}
      footer={
        <>
          {editing && !removed && editing.id !== actors.meId ? (
            <button type="button" className="btn btn--ghost" style={{ marginRight: 'auto' }} onClick={() => setConfirmRemove(true)}>
              <Icon name="trash" size={13} />
              Remove
            </button>
          ) : null}
          {removed ? (
            <button type="button" className="btn" style={{ marginRight: 'auto' }} disabled={restore.isPending} onClick={() => restore.mutate(undefined, { onSuccess: onClose })}>
              Restore
            </button>
          ) : null}
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!valid || save.isPending || removed} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            {save.isPending ? 'Saving…' : editing ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 'var(--s4)' }}>
        <Field label="Name">
          <input data-autofocus className="input" value={name} placeholder={isAgent ? 'Figma design agent' : 'Ana Ruiz'} onChange={(event) => setName(event.target.value)} />
        </Field>

        <Field label="Title" hint="Optional, e.g. Director of Design.">
          <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>

        <div className={isAgent ? '' : 'grid grid--2'}>
          <Field label={isAgent ? 'Owner' : 'Reports to'} hint={isAgent ? 'Answers for what this agent does.' : undefined}>
            <select className="select" value={reportsTo} onChange={(event) => setReportsTo(event.target.value)}>
              {isAgent ? null : <option value="">Nobody (top of the team)</option>}
              {managers.map((p) => (
                <option key={p.id} value={p.id}>
                  {actors.name(p.id)}
                </option>
              ))}
            </select>
          </Field>
          {isAgent ? null : (
            <Field label="Access" hint="Stored now; enforced once accounts arrive.">
              <select className="select" value={access} onChange={(event) => setAccess(event.target.value as AccessLevel)}>
                {ACCESS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>

        <div className="field">
          <span className="field__label">{isAgent ? 'Roles it can perform' : 'Roles they cover'}</span>
          <Toggles
            options={(roles.data ?? []).map((r) => ({ id: r.id, label: r.name }))}
            picked={roleIds}
            onChange={setRoleIds}
          />
          {isAgent && roleIds.length === 0 ? <span className="field__hint">Pick at least one.</span> : null}
        </div>

        {isAgent ? (
          <>
            <div className="field">
              <span className="field__label">Runtimes, in order</span>
              <span className="field__hint">The first healthy one runs the work. None picked: any enabled runtime.</span>
              <RankedRuntimes
                options={(runtimes.data ?? []).map((r) => ({ id: r.profile.id, name: r.profile.name, healthy: r.health.state === 'healthy' }))}
                value={runtimeIds}
                onChange={setRuntimeIds}
              />
            </div>
            {(integrations.data ?? []).length > 0 ? (
              <div className="field">
                <span className="field__label">Connected tools</span>
                <Toggles
                  options={(integrations.data ?? []).map((i) => ({ id: i.integration.id, label: i.integration.name }))}
                  picked={integrationIds}
                  onChange={setIntegrationIds}
                />
              </div>
            ) : null}
          </>
        ) : null}

        {editing?.kind === 'person' && reports.length > 0 ? (
          <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
            <Switch
              label="Sign off on delegated work"
              checked={oversight === 'both_sign_off'}
              onChange={(on) => setOversight(on ? 'both_sign_off' : 'delegate_owns')}
            />
            <div>
              <div style={{ color: 'var(--text)', fontWeight: 550 }}>Sign off on delegated work</div>
              <div className="field__hint">
                When someone reporting to {editing.id === actors.meId ? 'you' : editing.name} approves work, it comes to{' '}
                {editing.id === actors.meId ? 'you' : 'them'} for a final sign-off.
              </div>
            </div>
          </div>
        ) : null}

        {save.isError ? <ErrorState error={save.error} /> : null}
        {remove.isError ? <ErrorState error={remove.error} /> : null}
        {restore.isError ? <ErrorState error={restore.error} /> : null}
      </div>

      {confirmRemove && editing ? (
        <ConfirmDialog
          title={`Remove ${editing.name}?`}
          confirmLabel="Remove"
          destructive
          busy={remove.isPending}
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => remove.mutate(undefined, { onSuccess: onClose })}
          body={
            <p>
              Their past work keeps their name.
              {agentsOwned.length === 1
                ? ' Their agent stops taking work until someone else owns it.'
                : agentsOwned.length > 1
                  ? ` Their ${pluralize(agentsOwned.length, 'agent')} stop taking work until someone else owns them.`
                  : ''}
            </p>
          }
        />
      ) : null}
    </Drawer>
  );
}

export function memberSubtitle(member: MemberView, actors: Actors): string {
  const parts: string[] = [];
  if (member.kind === 'agent') parts.push(`Agent · ${member.reportsTo === actors.meId ? 'yours' : `${member.ownerName ?? 'no owner'}'s`}`);
  else parts.push(member.title ?? (member.access === 'owner' ? 'Owner' : 'Person'));
  if (member.kind === 'agent' && member.title) parts.push(member.title);
  if (member.status === 'removed') parts.push('Removed');
  else if (!member.active) parts.push('Inactive: owner removed');
  return parts.join(' · ');
}

function Toggles({ options, picked, onChange }: { options: readonly { id: string; label: string }[]; picked: readonly string[]; onChange: (next: readonly string[]) => void }): JSX.Element {
  return (
    <div className="row row--wrap" style={{ gap: 'var(--s1)' }}>
      {options.map((o) => {
        const on = picked.includes(o.id);
        return (
          <button key={o.id} type="button" className="pick" aria-pressed={on} onClick={() => onChange(on ? picked.filter((id) => id !== o.id) : [...picked, o.id])}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function RankedRuntimes({
  options,
  value,
  onChange,
}: {
  options: readonly { id: string; name: string; healthy: boolean }[];
  value: readonly string[];
  onChange: (next: readonly string[]) => void;
}): JSX.Element {
  const move = (index: number, delta: number): void => {
    const next = [...value];
    const a = next[index];
    const b = next[index + delta];
    if (a === undefined || b === undefined) return;
    next[index] = b;
    next[index + delta] = a;
    onChange(next);
  };
  const unpicked = options.filter((o) => !value.includes(o.id));
  return (
    <div className="stack" style={{ gap: 'var(--s2)' }}>
      {value.length > 0 ? (
        <div className="routing">
          {value.map((id, index) => {
            const runtime = options.find((o) => o.id === id);
            return (
              <div key={id} className="routing__row">
                <span className="routing__rank">{index + 1}</span>
                <span className={`dot dot--${runtime?.healthy ? 'succeeded' : 'pending'}`} />
                <span style={{ flex: 1 }}>{runtime?.name ?? 'Removed runtime'}</span>
                <button type="button" className="btn btn--icon btn--ghost" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up">
                  <Icon name="arrowUp" size={13} />
                </button>
                <button type="button" className="btn btn--icon btn--ghost" disabled={index === value.length - 1} onClick={() => move(index, 1)} aria-label="Move down">
                  <Icon name="arrowDown" size={13} />
                </button>
                <button type="button" className="btn btn--icon btn--ghost" onClick={() => onChange(value.filter((v) => v !== id))} aria-label="Remove runtime">
                  <Icon name="x" size={13} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      {unpicked.length > 0 ? (
        <div className="row row--wrap" style={{ gap: 'var(--s1)' }}>
          {unpicked.map((o) => (
            <button key={o.id} type="button" className="pick" aria-pressed={false} onClick={() => onChange([...value, o.id])}>
              <Icon name="plus" size={11} />
              {o.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
