import { useMemo, useState } from 'react';
import type { RoleTemplate } from '@tandemise/domain';
import { ARTIFACT_TYPES, modelList } from '../../lib/domain.js';
import { Icon } from '../../components/Icon.js';
import { Empty, ErrorState, Field, SkeletonList } from '../../components/primitives.js';
import { useDaemonMutation, useRoles } from '../../lib/queries.js';
import { useWorkspace } from '../../lib/workspace.js';
import { titleCase } from '../../lib/format.js';

/**
 * What each role is: its instructions, contract and hand-offs.
 *
 * Moved here from the old Workforce screen. Which runtime carries a role now
 * belongs to the agent that does it (ranked in the agent's form), not the role.
 */
export function RolesPane(): JSX.Element {
  const roles = useRoles();
  const workspaceId = useWorkspace().current?.workspace.id ?? '';
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => (roles.data ?? []).find((role) => role.id === selectedId) ?? roles.data?.[0] ?? null, [roles.data, selectedId]);

  if (roles.isError) {
    return (
      <div className="page">
        <div className="page__inner">
          <ErrorState error={roles.error} onRetry={() => void roles.refetch()} />
        </div>
      </div>
    );
  }
  if (roles.isPending) {
    return (
      <div className="page">
        <div className="page__inner">
          <SkeletonList rows={6} />
        </div>
      </div>
    );
  }
  if ((roles.data ?? []).length === 0) {
    return (
      <div className="page">
        <div className="page__inner">
          <div className="card">
            <Empty icon="workforce" title="No roles configured" body="The project ships with built-in roles. If this is empty, the daemon has not seeded it yet." />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="reader">
      <div className="reader__list">
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
      <div className="reader__pane">{selected ? <RoleEditor key={selected.id} role={selected} workspaceId={workspaceId} /> : null}</div>
    </div>
  );
}

function RoleEditor({ role, workspaceId }: { role: RoleTemplate; workspaceId: string }): JSX.Element {
  const [instructions, setInstructions] = useState(role.instructions);
  const [outputContract, setOutputContract] = useState(role.outputContract);
  const [capabilities, setCapabilities] = useState(role.defaultCapabilities.join('\n'));
  const [produces, setProduces] = useState<readonly string[]>(role.producesArtifacts);
  const [consumes, setConsumes] = useState<readonly string[]>(role.consumesArtifacts);
  const [model, setModel] = useState(role.models?.model ?? '');
  const [escalate, setEscalate] = useState((role.models?.escalate ?? []).join(', '));
  const [economyModel, setEconomyModel] = useState(role.models?.economyModel ?? '');

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
        models: { model: model.trim() || null, escalate: modelList(escalate), economyModel: economyModel.trim() || null },
      }),
    ['workspaces'],
  );

  const modelsDirty = model !== (role.models?.model ?? '') || escalate !== (role.models?.escalate ?? []).join(', ') || economyModel !== (role.models?.economyModel ?? '');
  const dirty = instructions !== role.instructions || outputContract !== role.outputContract || capabilities !== role.defaultCapabilities.join('\n') || modelsDirty;

  return (
    <div className="stack" style={{ gap: 'var(--s5)' }}>
      <header className="reader__head">
        <h1 className="reader__title">{role.name}</h1>
        <div className="reader__meta">
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
        <textarea
          className="textarea"
          style={{ minHeight: 84, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' }}
          value={capabilities}
          onChange={(event) => setCapabilities(event.target.value)}
        />
      </Field>

      <section className="stack" aria-label="Models" style={{ gap: 'var(--s3)' }}>
        <div>
          <h2 className="section__title">Models</h2>
          <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
            Names are passed to the runtime exactly as you type them. A workflow step's own model wins over these; leave a field empty to use the runtime's model.
          </p>
        </div>
        <div className="grid grid--3">
          <Field label="Model" hint="Every run of this role, unless a step says otherwise.">
            <input className="input" aria-label="Model" value={model} placeholder="Runtime default" onChange={(event) => setModel(event.target.value)} />
          </Field>
          <Field label="On retry, use" hint="Attempt 2 uses the first, attempt 3 and later the next. Comma-separated.">
            <input className="input" aria-label="On retry, use" value={escalate} placeholder="e.g. a stronger model, then the strongest" onChange={(event) => setEscalate(event.target.value)} />
          </Field>
          <Field label="Economy model" hint="Used for new runs once a limit on the mission or this month passes its warning level.">
            <input className="input" aria-label="Economy model" value={economyModel} placeholder="e.g. a cheaper model" onChange={(event) => setEconomyModel(event.target.value)} />
          </Field>
        </div>
      </section>

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
    </div>
  );
}

function ArtifactPicker({ label, selected, onChange }: { label: string; selected: readonly string[]; onChange: (next: readonly string[]) => void }): JSX.Element {
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
              className="pick"
              aria-pressed={on}
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
