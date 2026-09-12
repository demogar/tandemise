import { useState } from 'react';
import type { RuntimeDiscoveryView, RuntimeView } from '@tandemise/api-contract';
import { PageHeader } from '../components/PageHeader.js';
import { Icon } from '../components/Icon.js';
import { ConfirmDialog, Modal } from '../components/Modal.js';
import { Empty, ErrorState, Field, SkeletonList, StatusDot, Switch } from '../components/primitives.js';
import { useDaemonMutation, useRuntimes } from '../lib/queries.js';
import { dateTime, healthTone, pluralize, shortenPath, titleCase } from '../lib/format.js';

export function Runtimes(): JSX.Element {
  const runtimes = useRuntimes();
  const [discovered, setDiscovered] = useState<readonly RuntimeDiscoveryView[] | null>(null);
  const [addingCli, setAddingCli] = useState(false);
  const [removing, setRemoving] = useState<RuntimeView | null>(null);

  const discover = useDaemonMutation((daemon) => daemon.discoverRuntimes(), ['runtimes']);
  const remove = useDaemonMutation((daemon, id: string) => daemon.deleteRuntime(id), ['runtimes']);

  return (
    <>
      <PageHeader
        title="Runtimes"
        subtitle="The agent CLIs on this machine, and how much work each may take."
        actions={
          <>
            <button type="button" className="btn" onClick={() => setAddingCli(true)}>
              <Icon name="plus" size={13} />
              Add CLI runtime
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={discover.isPending}
              onClick={() => discover.mutate(undefined, { onSuccess: setDiscovered })}
            >
              <Icon name="search" size={13} />
              {discover.isPending ? 'Scanning…' : 'Discover runtimes'}
            </button>
          </>
        }
      />

      <div className="page">
        <div className="page__inner">
          {runtimes.isError ? <ErrorState error={runtimes.error} onRetry={() => void runtimes.refetch()} /> : null}
          {discover.isError ? <ErrorState error={discover.error} /> : null}

          {runtimes.isPending ? (
            <SkeletonList rows={3} />
          ) : (runtimes.data ?? []).length === 0 ? (
            <div className="card">
              <Empty
                icon="runtimes"
                title="No runtimes configured"
                body="Tandemise routes roles to runtimes, never the other way round. Run discovery to find the agent CLIs already installed, or add a generic CLI runtime by hand."
                action={
                  <button type="button" className="btn btn--primary btn--lg" onClick={() => discover.mutate(undefined, { onSuccess: setDiscovered })}>
                    <Icon name="search" size={14} />
                    Discover runtimes
                  </button>
                }
              />
            </div>
          ) : (
            <div className="stack" style={{ gap: 'var(--s4)' }}>
              {(runtimes.data ?? []).map((view) => (
                <RuntimeCard key={view.profile.id} view={view} onRemove={() => setRemoving(view)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {discovered ? <DiscoveryModal results={discovered} onClose={() => setDiscovered(null)} /> : null}
      {addingCli ? <GenericCliModal onClose={() => setAddingCli(false)} /> : null}
      {removing ? (
        <ConfirmDialog
          title={`Remove ${removing.profile.name}?`}
          confirmLabel="Remove runtime"
          destructive
          busy={remove.isPending}
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove.mutate(removing.profile.id, { onSuccess: () => setRemoving(null) })}
          body={
            <>
              <p>Roles routed to this runtime fall through to the next one in their preference list.</p>
              {removing.rolesRouted.length > 0 ? (
                <p style={{ marginTop: 'var(--s3)' }}>
                  Currently preferred by {removing.rolesRouted.map(titleCase).join(', ')}.
                </p>
              ) : null}
            </>
          }
        />
      ) : null}
    </>
  );
}

function RuntimeCard({ view, onRemove }: { view: RuntimeView; onRemove: () => void }): JSX.Element {
  const { profile, health } = view;
  const tone = healthTone(health.state);
  const update = useDaemonMutation((daemon, body: { enabled?: boolean; maxConcurrent?: number }) => daemon.updateRuntime(profile.id, body), ['runtimes']);
  const check = useDaemonMutation((daemon) => daemon.checkRuntimeHealth(profile.id), ['runtimes']);

  return (
    <article className="card card--flush">
      <div className="card__head">
        <StatusDot tone={tone} live={view.activeRuns > 0} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row" style={{ gap: 'var(--s2)' }}>
            <span style={{ fontWeight: 600, fontSize: 'var(--fs-base)' }}>{profile.name}</span>
            <span className="chip chip--muted">{view.adapterDisplayName}</span>
            {health.version ? <span className="chip">v{health.version}</span> : null}
          </div>
          <div className="dim" style={{ fontSize: 'var(--fs-xs)', marginTop: 2 }}>
            {health.detail} · checked {dateTime(health.checkedAt)}
          </div>
        </div>
        <button type="button" className="btn btn--ghost" disabled={check.isPending} onClick={() => check.mutate(undefined)}>
          <Icon name="refresh" size={13} />
          {check.isPending ? 'Checking…' : 'Check health'}
        </button>
        <Switch checked={profile.enabled} label={`Enable ${profile.name}`} onChange={(enabled) => update.mutate({ enabled })} />
        <button type="button" className="btn btn--icon btn--ghost" aria-label="Remove runtime" onClick={onRemove}>
          <Icon name="trash" size={14} />
        </button>
      </div>

      <div className="card__body" style={{ display: 'grid', gap: 'var(--s4)' }}>
        {health.quotaWarning ? (
          <div className="banner banner--warn">
            <Icon name="alert" size={14} />
            <span>{health.quotaWarning}</span>
          </div>
        ) : null}

        <div className="grid grid--2">
          <Detail label="Executable">
            <span className="mono" title={profile.executablePath ?? undefined}>
              {profile.executablePath ? shortenPath(profile.executablePath, 4) : 'resolved from PATH'}
            </span>
          </Detail>
          <Detail label="Concurrency">
            <div className="row">
              <input
                className="input"
                type="number"
                min={1}
                max={8}
                style={{ width: 72 }}
                defaultValue={profile.maxConcurrent}
                onBlur={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next) && next !== profile.maxConcurrent) update.mutate({ maxConcurrent: next });
                }}
              />
              <span className="dim" style={{ fontSize: 'var(--fs-xs)' }}>
                {view.activeRuns} running now
              </span>
            </div>
          </Detail>
        </div>

        <Detail label="Capabilities">
          <div className="row row--wrap" style={{ gap: 4 }}>
            {profile.capabilities.length === 0 ? (
              <span className="dim">None reported</span>
            ) : (
              profile.capabilities.map((capability) => (
                <span key={capability} className="chip">
                  {capability}
                </span>
              ))
            )}
          </div>
        </Detail>

        {view.rolesRouted.length > 0 ? (
          <Detail label={`Preferred by ${pluralize(view.rolesRouted.length, 'role')}`}>
            <div className="row row--wrap" style={{ gap: 4 }}>
              {view.rolesRouted.map((role) => (
                <span key={role} className="chip chip--muted">
                  {titleCase(role)}
                </span>
              ))}
            </div>
          </Detail>
        ) : null}

        {update.isError ? <ErrorState error={update.error} /> : null}
      </div>
    </article>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="qa__q" style={{ marginBottom: 5 }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--fs-sm)' }}>{children}</div>
    </div>
  );
}

function DiscoveryModal({ results, onClose }: { results: readonly RuntimeDiscoveryView[]; onClose: () => void }): JSX.Element {
  const create = useDaemonMutation(
    (daemon, discovery: RuntimeDiscoveryView) =>
      daemon.createRuntime({
        adapterId: discovery.adapterId,
        name: discovery.displayName,
        executablePath: discovery.executablePath,
        settings: discovery.suggestedSettings as Record<string, unknown>,
        enabled: true,
      }),
    ['runtimes'],
  );

  return (
    <Modal title="Runtimes on this machine" wide onClose={onClose} footer={<button type="button" className="btn btn--primary" onClick={onClose}>Done</button>}>
      <div className="stack">
        {results.length === 0 ? (
          <p>No agent runtimes were found on this machine. Install one, or add a generic CLI runtime by hand.</p>
        ) : (
          results.map((discovery) => (
            <div key={discovery.adapterId} className="list__row" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
              <StatusDot tone={discovery.detected ? 'succeeded' : 'pending'} />
              <div className="list__main">
                <div className="list__title">{discovery.displayName}</div>
                <div className="list__subtitle truncate">
                  {discovery.detected
                    ? `${discovery.version ? `v${discovery.version} · ` : ''}${discovery.executablePath ?? 'on PATH'}`
                    : discovery.detail}
                </div>
              </div>
              {discovery.configured ? (
                <span className="badge badge--succeeded">Configured</span>
              ) : discovery.detected ? (
                <button type="button" className="btn btn--primary" disabled={create.isPending} onClick={() => create.mutate(discovery)}>
                  Add
                </button>
              ) : (
                <span className="chip chip--muted">not found</span>
              )}
            </div>
          ))
        )}
        {create.isError ? <ErrorState error={create.error} /> : null}
      </div>
    </Modal>
  );
}

/**
 * Wiring an arbitrary CLI is the escape hatch that makes "add a new runtime"
 * configuration rather than code (MVP.md §P2) - Codex, Gemini and opencode all
 * arrive this way.
 */
function GenericCliModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [promptVia, setPromptVia] = useState<'stdin' | 'arg' | 'file'>('stdin');

  const create = useDaemonMutation(
    (daemon) =>
      daemon.createRuntime({
        adapterId: 'generic-cli',
        name: name.trim(),
        executablePath: command.trim(),
        args: args.split(/\s+/).filter(Boolean),
        settings: { promptVia },
        enabled: true,
      }),
    ['runtimes'],
  );

  return (
    <Modal
      title="Add a CLI runtime"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!name.trim() || !command.trim() || create.isPending}
            onClick={() => create.mutate(undefined, { onSuccess: onClose })}
          >
            {create.isPending ? 'Adding…' : 'Add runtime'}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 'var(--s4)', color: 'var(--text)' }}>
        <p className="muted">
          Any agent CLI that accepts a prompt and writes to stdout can be a Tandemise runtime. No new code is needed — the generic adapter
          normalizes its output into the shared event vocabulary.
        </p>
        <Field label="Name">
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Codex" autoFocus />
        </Field>
        <Field label="Command" hint="Absolute path, or a name resolved from PATH.">
          <input className="input mono" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="/usr/local/bin/codex" />
        </Field>
        <Field label="Arguments" hint="Space separated. Added before the prompt.">
          <input className="input mono" value={args} onChange={(event) => setArgs(event.target.value)} placeholder="exec --json" />
        </Field>
        <Field label="How does it receive the prompt?">
          <select className="select" value={promptVia} onChange={(event) => setPromptVia(event.target.value as typeof promptVia)}>
            <option value="stdin">On stdin</option>
            <option value="arg">As the final argument</option>
            <option value="file">In a temporary file, path passed as the final argument</option>
          </select>
        </Field>
        {create.isError ? <ErrorState error={create.error} /> : null}
      </div>
    </Modal>
  );
}
