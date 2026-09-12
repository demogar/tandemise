import { useEffect, useMemo, useState } from 'react';
import type { RoleTemplate } from '@tandemise/domain';
import { ARTIFACT_TYPES } from '../lib/domain.js';
import { PageHeader } from '../components/PageHeader.js';
import { Icon } from '../components/Icon.js';
import { Empty, ErrorState, Field, SkeletonList } from '../components/primitives.js';
import { useDaemonMutation, useRoles, useRuntimes } from '../lib/queries.js';
import { useWorkspace } from '../lib/workspace.js';
import { titleCase } from '../lib/format.js';

/**
 * Roles and routing.
 *
 * A role declares a responsibility; routing says which runtimes may carry it,
 * in order of preference. Keeping both on one screen makes the relationship
 * legible - the ordered list *is* the fallback behaviour (MVP.md §P2).
 */
export function Workforce(): JSX.Element {
  const roles = useRoles();
  const runtimes = useRuntimes();
  const workspace = useWorkspace().current?.workspace;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => (roles.data ?? []).find((role) => role.id === selectedId) ?? roles.data?.[0] ?? null, [roles.data, selectedId]);

  return (
    <>
      <PageHeader title="Workforce" subtitle="Role templates, their contracts, and which runtimes carry them." />

      {roles.isError ? (
        <div style={{ padding: 'var(--s4) var(--s7)' }}>
          <ErrorState error={roles.error} onRetry={() => void roles.refetch()} />
        </div>
      ) : roles.isPending ? (
        <div className="page">
          <div className="page__inner">
            <SkeletonList rows={6} />
          </div>
        </div>
      ) : (roles.data ?? []).length === 0 ? (
        <div className="page">
          <div className="page__inner">
            <div className="card">
              <Empty icon="workforce" title="No roles configured" body="The workspace ships with eight built-in roles. If this is empty, the daemon has not seeded the workspace yet." />
            </div>
          </div>
        </div>
      ) : (
        <div className="reader">
          <div className="reader__list">
            <div className="sidebar__section">Roles</div>
            {(roles.data ?? []).map((role) => (
              <button
                key={role.id}
                type="button"
                className="list__row"
                data-active={role.id === selected?.id}
                style={{ border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent' }}
                onClick={() => setSelectedId(role.id)}
              >
                <div className="list__main">
                  <div className="list__title">{role.name}</div>
                  <div className="list__subtitle truncate" title={role.summary}>{role.summary}</div>
                </div>
                {role.builtIn ? <span className="chip chip--muted">built-in</span> : null}
              </button>
            ))}
          </div>

          <div className="reader__pane">
            {selected ? (
              <RoleEditor
                key={selected.id}
                role={selected}
                workspaceId={workspace?.id ?? ''}
                routing={workspace?.routing[selected.id] ?? []}
                runtimes={(runtimes.data ?? []).map((view) => ({ id: view.profile.id, name: view.profile.name, healthy: view.health.state === 'healthy' }))}
              />
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

interface RuntimeOption {
  readonly id: string;
  readonly name: string;
  readonly healthy: boolean;
}

function RoleEditor({
  role,
  workspaceId,
  routing,
  runtimes,
}: {
  role: RoleTemplate;
  workspaceId: string;
  routing: readonly string[];
  runtimes: readonly RuntimeOption[];
}): JSX.Element {
  const [instructions, setInstructions] = useState(role.instructions);
  const [outputContract, setOutputContract] = useState(role.outputContract);
  const [capabilities, setCapabilities] = useState(role.defaultCapabilities.join('\n'));
  const [produces, setProduces] = useState<readonly string[]>(role.producesArtifacts);
  const [consumes, setConsumes] = useState<readonly string[]>(role.consumesArtifacts);
  const [order, setOrder] = useState<readonly string[]>(() => mergeRouting(routing, runtimes));

  useEffect(() => setOrder(mergeRouting(routing, runtimes)), [routing, runtimes]);

  const save = useDaemonMutation(
    (daemon) =>
      daemon.upsertRole(role.id, {
        workspaceId,
        id: role.id,
        name: role.name,
        summary: role.summary,
        instructions,
        defaultCapabilities: capabilities.split('\n').map((line) => line.trim()).filter(Boolean),
        producesArtifacts: produces as never,
        consumesArtifacts: consumes as never,
        defaultIsolation: role.defaultIsolation,
        outputContract,
      }),
    ['workspaces'],
  );

  const saveRouting = useDaemonMutation(
    (daemon, next: readonly string[]) => daemon.updateWorkspace(workspaceId, { routing: { [role.id]: [...next] } }),
    ['workspaces'],
  );

  const move = (index: number, delta: number): void => {
    const next = [...order];
    const target = index + delta;
    const a = next[index];
    const b = next[target];
    if (a === undefined || b === undefined) return;
    next[index] = b;
    next[target] = a;
    setOrder(next);
    saveRouting.mutate(next);
  };

  const dirty = instructions !== role.instructions || outputContract !== role.outputContract || capabilities !== role.defaultCapabilities.join('\n');

  return (
    <div className="stack" style={{ gap: 'var(--s5)' }}>
      <header className="reader__head">
        <h1 className="reader__title">{role.name}</h1>
        <div className="reader__meta">
          <span className="chip">{role.id}</span>
          <span className="chip chip--muted">{role.defaultIsolation} isolation</span>
          <span>{role.summary}</span>
        </div>
      </header>

      <Field label="Instructions" hint="Trusted system instructions for this role. Never sourced from external content.">
        <textarea className="textarea" style={{ minHeight: 180 }} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
      </Field>

      <Field label="Output contract" hint="The quality bar an evaluator checks this role's output against.">
        <textarea className="textarea" style={{ minHeight: 96 }} value={outputContract} onChange={(event) => setOutputContract(event.target.value)} />
      </Field>

      <Field label="Default capabilities" hint="One per line. Dotted and hierarchical — `github` implies `github.pr.create`.">
        <textarea className="textarea" style={{ minHeight: 84, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' }} value={capabilities} onChange={(event) => setCapabilities(event.target.value)} />
      </Field>

      <div className="grid grid--2">
        <ArtifactPicker label="Produces" selected={produces} onChange={setProduces} />
        <ArtifactPicker label="Consumes" selected={consumes} onChange={setConsumes} />
      </div>

      {save.isError ? <ErrorState error={save.error} /> : null}

      <div className="row">
        <button type="button" className="btn btn--primary" disabled={save.isPending} onClick={() => save.mutate(undefined)}>
          {save.isPending ? 'Saving…' : 'Save role'}
        </button>
        {dirty ? <span className="dim" style={{ fontSize: 'var(--fs-xs)' }}>Unsaved changes</span> : null}
        {save.isSuccess && !dirty ? (
          <span className="badge badge--succeeded">
            <Icon name="check" size={11} />
            Saved
          </span>
        ) : null}
      </div>

      <section>
        <div className="section__head">
          <h2 className="section__title">Runtime preference</h2>
          <span className="section__meta">The scheduler takes the first healthy, capable, non-saturated runtime.</span>
        </div>
        {order.length === 0 ? (
          <div className="card">
            <Empty icon="runtimes" title="No runtimes to route to" body="Add a runtime first and it will appear here." />
          </div>
        ) : (
          <div className="routing">
            {order.map((runtimeId, index) => {
              const runtime = runtimes.find((candidate) => candidate.id === runtimeId);
              return (
                <div key={runtimeId} className="routing__row">
                  <span className="routing__rank">{index + 1}</span>
                  <span className={`dot dot--${runtime?.healthy ? 'succeeded' : 'pending'}`} />
                  <span style={{ flex: 1 }}>{runtime?.name ?? runtimeId}</span>
                  {index === 0 ? <span className="badge badge--accent">Preferred</span> : null}
                  <button type="button" className="btn btn--icon btn--ghost" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up">
                    <Icon name="arrowUp" size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn--icon btn--ghost"
                    disabled={index === order.length - 1}
                    onClick={() => move(index, 1)}
                    aria-label="Move down"
                  >
                    <Icon name="arrowDown" size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function ArtifactPicker({
  label,
  selected,
  onChange,
}: {
  label: string;
  selected: readonly string[];
  onChange: (next: readonly string[]) => void;
}): JSX.Element {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="row row--wrap" style={{ gap: 4 }}>
        {ARTIFACT_TYPES.map((type) => {
          const on = selected.includes(type);
          return (
            <button
              key={type}
              type="button"
              className={`chip${on ? '' : ' chip--muted'}`}
              style={on ? { borderColor: 'var(--accent-line)', background: 'var(--accent-soft)', color: 'var(--accent)' } : undefined}
              onClick={() => onChange(on ? selected.filter((value) => value !== type) : [...selected, type])}
            >
              {titleCase(type)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Routing may name runtimes that no longer exist; keep order, append the rest. */
function mergeRouting(routing: readonly string[], runtimes: readonly RuntimeOption[]): readonly string[] {
  const known = new Set(runtimes.map((runtime) => runtime.id));
  const ordered = routing.filter((id) => known.has(id));
  return [...ordered, ...runtimes.filter((runtime) => !ordered.includes(runtime.id)).map((runtime) => runtime.id)];
}
