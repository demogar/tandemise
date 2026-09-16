import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import type { MemberView } from '@tandemise/api-contract';
import type { RoleTemplate, StaffingPatch } from '@tandemise/domain';
import type { StaffingPreset } from '@tandemise/domain/staffing-presets';
import { PageHeader } from '../../components/PageHeader.js';
import { Icon } from '../../components/Icon.js';
import { Drawer } from '../../components/Modal.js';
import { Empty, ErrorState, SkeletonList } from '../../components/primitives.js';
import { useDaemonMutation, useRoles, useRuntimes, useStaffing, useTeam } from '../../lib/queries.js';
import { useWorkspaceId } from '../../lib/workspace.js';
import { useActors, type Actors } from '../../lib/team.js';
import { PRESET_LABELS, STAFFING_PRESET_OPTIONS, builtInAssignees, displayedPreset, staffingSummary, toWire } from '../../lib/staffing.js';
import { pluralize } from '../../lib/format.js';
import { MemberDrawer, memberSubtitle, type MemberTarget } from './MemberForm.js';
import { StaffingEditor, applyPreset, needsPick, presetOf } from './StaffingEditor.js';
import { RolesPane } from './RolesPane.js';

export type TeamTab = 'people' | 'staffing' | 'roles';

/**
 * Who works on this project, and who answers for what.
 *
 * You and your agents as one tree (an agent sits under its owner), a
 * staffing row per role, and the role definitions. Every row is one line;
 * anything you can change opens in a drawer.
 */
export function Team({ tab }: { tab: TeamTab }): JSX.Element {
  const team = useTeam();
  const actors = useActors();
  const [target, setTarget] = useState<MemberTarget | null>(null);

  return (
    <>
      <PageHeader
        title="Team"
        subtitle="Who does the work, and who answers for it."
        actions={
          tab === 'people' ? (
            <button type="button" className="btn btn--primary" onClick={() => setTarget({ kind: 'new-agent' })}>
              <Icon name="sparkle" size={13} />
              Add agent
            </button>
          ) : null
        }
      />

      <div className="tabs" role="tablist">
        <TabLink tab="people" current={tab} label="You & agents" count={actors.agents.length} />
        <TabLink tab="staffing" current={tab} label="Staffing" />
        <TabLink tab="roles" current={tab} label="Roles" />
      </div>

      {tab === 'roles' ? (
        <RolesPane />
      ) : (
        <div className="page">
          <div className="page__inner">
            {team.isError ? (
              <ErrorState error={team.error} onRetry={() => void team.refetch()} />
            ) : team.isPending ? (
              <SkeletonList rows={4} />
            ) : tab === 'people' ? (
              <PeoplePane actors={actors} issues={team.data.issues} onOpen={(member) => setTarget({ kind: 'edit', member })} onAddAgent={() => setTarget({ kind: 'new-agent' })} />
            ) : (
              <StaffingPane actors={actors} />
            )}
          </div>
        </div>
      )}

      {target ? <MemberDrawer key={target.kind === 'edit' ? target.member.id : target.kind} target={target} actors={actors} onClose={() => setTarget(null)} /> : null}
    </>
  );
}

function TabLink({ tab, current, label, count }: { tab: TeamTab; current: TeamTab; label: string; count?: number }): JSX.Element {
  return (
    <Link href={tab === 'people' ? '/team' : `/team/${tab}`} className="tab" role="tab" aria-selected={tab === current}>
      {label}
      {count !== undefined && count > 0 ? <span className="tab__count">{count}</span> : null}
    </Link>
  );
}

// ------------------------------------------------------------------- people

function PeoplePane({
  actors,
  issues,
  onOpen,
  onAddAgent,
}: {
  actors: Actors;
  issues: readonly string[];
  onOpen: (member: MemberView) => void;
  onAddAgent: () => void;
}): JSX.Element {
  const roles = useRoles();
  const runtimes = useRuntimes();
  const [showRemoved, setShowRemoved] = useState(false);
  const roleNames = useMemo(() => new Map((roles.data ?? []).map((r) => [r.id, r.name])), [roles.data]);
  const removedCount = actors.members.filter((m) => m.status === 'removed').length;
  const rows = useMemo(() => flattenTree(actors.members.filter((m) => showRemoved || m.status !== 'removed'), actors.meId), [actors, showRemoved]);
  const enabledRuntimes = (runtimes.data ?? []).filter((r) => r.profile.enabled).map((r) => r.profile.name);

  return (
    <div className="stack" style={{ gap: 'var(--s4)' }}>
      {issues.map((issue) => (
        <div key={issue} className="banner banner--warn">
          <Icon name="alert" size={14} />
          <span>{issue}</span>
        </div>
      ))}

      <div className="card card--flush">
        {rows.map(({ member, depth }) => (
          <button
            key={member.id}
            type="button"
            className="list__row tree__row"
            style={{ '--depth': depth } as React.CSSProperties}
            data-inactive={!member.active}
            onClick={() => onOpen(member)}
          >
            <span className="monogram monogram--sm" data-tint={member.kind === 'agent' ? 3 : tintFor(member.id)}>
              {member.kind === 'agent' ? <Icon name="sparkle" size={13} /> : initials(member.name)}
            </span>
            <div className="list__main">
              <div className="list__title">
                {member.name}
                {member.id === actors.meId ? <span className="chip chip--you" style={{ marginLeft: 'var(--s2)', height: 18 }}>you</span> : null}
              </div>
              <div className="list__subtitle truncate">{memberSubtitle(member, actors)}</div>
            </div>
            <div className="list__aside">
              {member.roleIds.slice(0, 3).map((id) => (
                <span key={id} className="chip chip--muted">
                  {roleNames.get(id) ?? id}
                </span>
              ))}
              {member.roleIds.length > 3 ? <span className="dim" style={{ fontSize: 'var(--fs-xs)' }}>+{member.roleIds.length - 3}</span> : null}
              {!member.active ? <span className="badge">{member.status === 'removed' ? 'Removed' : 'Inactive'}</span> : null}
              <Icon name="chevronRight" size={13} className="dim" />
            </div>
          </button>
        ))}
      </div>

      {/* Solo and agent-less is the default install, not a broken one: say what
          happens today and offer the one step that changes it. */}
      {actors.agents.length === 0 ? (
        <div className="banner">
          <Icon name="sparkle" size={15} className="dim" />
          <span style={{ flex: 1 }}>
            <span style={{ color: 'var(--text)', fontWeight: 550 }}>No agents yet.</span>{' '}
            <span className="muted">
              Every role runs on {enabledRuntimes.length > 0 ? namesOr(enabledRuntimes) : 'your enabled runtimes'}. Add an agent to pick which runtime does which role.
            </span>
          </span>
          <button type="button" className="btn" onClick={onAddAgent}>
            Add agent
          </button>
        </div>
      ) : null}

      {removedCount > 0 ? (
        <div>
          <button type="button" className="btn btn--ghost" onClick={() => setShowRemoved((v) => !v)}>
            {showRemoved ? 'Hide removed' : `Show ${pluralize(removedCount, 'removed member')}`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Depth-first, people before their agents, you first at the top. */
function flattenTree(members: readonly MemberView[], meId: string | null): { member: MemberView; depth: number }[] {
  const ids = new Set(members.map((m) => m.id as string));
  const children = new Map<string | null, MemberView[]>();
  for (const m of members) {
    const parent = m.reportsTo !== null && ids.has(m.reportsTo) ? m.reportsTo : null;
    children.set(parent, [...(children.get(parent) ?? []), m]);
  }
  const order = (a: MemberView, b: MemberView): number =>
    (a.id === meId ? -1 : b.id === meId ? 1 : 0) || (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'person' ? -1 : 1);
  const out: { member: MemberView; depth: number }[] = [];
  const walk = (parent: string | null, depth: number, seen: Set<string>): void => {
    for (const m of [...(children.get(parent) ?? [])].sort(order)) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({ member: m, depth });
      walk(m.id, depth + 1, seen);
    }
  };
  walk(null, 0, new Set());
  return out;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('');
}

function tintFor(id: string): number {
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return (hash % 5) + 1;
}

function namesOr(names: readonly string[]): string {
  return names.length <= 2 ? names.join(' or ') : `${names.slice(0, 2).join(', ')} or ${names.length - 2} more`;
}

// ----------------------------------------------------------------- staffing

function StaffingPane({ actors }: { actors: Actors }): JSX.Element {
  const roles = useRoles();
  const staffing = useStaffing();
  const workspaceId = useWorkspaceId() ?? '';
  const [editing, setEditing] = useState<RoleTemplate | null>(null);
  // A people preset nobody holds the role for opens the drawer to pick someone, rather than saving an empty pool.
  const [start, setStart] = useState<{ patch: StaffingPatch; preset: 'person' | 'pool' } | null>(null);
  // Custom picked on the row opens the drawer in the full editor, even when the saved value matches a preset.
  const [startCustom, setStartCustom] = useState(false);
  const save = useDaemonMutation((d, args: { roleId: string; patch: StaffingPatch | null }) => d.patchStaffing(workspaceId, { [args.roleId]: toWire(args.patch) }), ['workspaces', 'tasks']);

  if (roles.isPending || staffing.isPending) return <SkeletonList rows={6} />;
  if (staffing.isError) return <ErrorState error={staffing.error} onRetry={() => void staffing.refetch()} />;
  if ((roles.data ?? []).length === 0) {
    return (
      <div className="card">
        <Empty icon="workforce" title="No roles yet" body="Staffing is set per role. Roles appear here once the project has them." />
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 'var(--s3)' }}>
      <div className="card card--flush">
        {(roles.data ?? []).map((role) => {
          const patch = staffing.data?.[role.id] ?? {};
          const recognised = presetOf({ ...patch, assignees: patch.assignees ?? builtInAssignees(role.id, actors) }, actors).preset;
          return (
            <div key={role.id} className="list__row staffrow">
              <div className="list__title">{role.name}</div>
              <select
                className="select"
                aria-label={`${role.name} staffing`}
                value={displayedPreset(recognised)}
                onChange={(event) => {
                  const next = event.target.value as StaffingPreset;
                  if (next === 'custom') {
                    setStart(null);
                    setStartCustom(true);
                    setEditing(role);
                    return;
                  }
                  const applied = applyPreset(next, patch, role.id, actors);
                  if (needsPick(next, applied)) {
                    setStart({ patch: applied, preset: next });
                    setStartCustom(false);
                    setEditing(role);
                  } else save.mutate({ roleId: role.id, patch: applied });
                }}
              >
                {STAFFING_PRESET_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {PRESET_LABELS[p]}
                  </option>
                ))}
              </select>
              <span className="muted truncate" style={{ fontSize: 'var(--fs-sm)' }} title={staffingSummary(patch, role.id, actors)}>
                {staffingSummary(patch, role.id, actors)}
              </span>
              <button type="button" className="btn btn--ghost" onClick={() => { setStart(null); setStartCustom(false); setEditing(role); }}>
                Edit
              </button>
            </div>
          );
        })}
      </div>
      {save.isError ? <ErrorState error={save.error} /> : null}
      <p className="dim" style={{ fontSize: 'var(--fs-xs)', margin: 0 }}>
        The project default. A mission or a single task can override it; changes apply to tasks that have not started.
      </p>

      {editing ? (
        <RoleStaffingDrawer
          role={editing}
          initial={staffing.data?.[editing.id] ?? {}}
          start={start ?? undefined}
          startCustom={startCustom}
          actors={actors}
          onClose={() => setEditing(null)}
          onSave={(patch) => save.mutate({ roleId: editing.id, patch }, { onSuccess: () => setEditing(null) })}
          saving={save.isPending}
          error={save.error}
        />
      ) : null}
    </div>
  );
}

function RoleStaffingDrawer({
  role,
  initial,
  start,
  startCustom,
  actors,
  onClose,
  onSave,
  saving,
  error,
}: {
  role: RoleTemplate;
  initial: StaffingPatch;
  start?: { patch: StaffingPatch; preset: 'person' | 'pool' };
  startCustom: boolean;
  actors: Actors;
  onClose: () => void;
  onSave: (patch: StaffingPatch | null) => void;
  saving: boolean;
  error: unknown;
}): JSX.Element {
  const [draft, setDraft] = useState<StaffingPatch>(start?.patch ?? initial);
  return (
    <Drawer
      title={`${role.name} staffing`}
      subtitle="The project default for this role."
      onClose={onClose}
      footer={
        <>
          {Object.keys(initial).length > 0 ? (
            <button type="button" className="btn btn--ghost" style={{ marginRight: 'auto' }} onClick={() => onSave(null)}>
              Reset to default
            </button>
          ) : null}
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={saving} onClick={() => onSave(draft)}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 'var(--s4)' }}>
        <StaffingEditor roleId={role.id} value={draft} onChange={(next) => setDraft(next ?? {})} actors={actors} level="workspace" startPreset={start?.preset} startCustom={startCustom} />
        {error ? <ErrorState error={error} /> : null}
      </div>
    </Drawer>
  );
}
