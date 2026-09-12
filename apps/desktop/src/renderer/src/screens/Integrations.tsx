import { useState } from 'react';
import type { IntegrationView } from '@tandemise/api-contract';
import { PageHeader } from '../components/PageHeader.js';
import { Icon } from '../components/Icon.js';
import { ConfirmDialog, Modal } from '../components/Modal.js';
import { Empty, ErrorState, Field, SkeletonList, StatusDot, Switch } from '../components/primitives.js';
import { useDaemonMutation, useIntegrations, useWorkspaces } from '../lib/queries.js';
import { dateTime, healthTone, titleCase } from '../lib/format.js';

const PROVIDERS: readonly { id: string; name: string; transport: string; hint: string }[] = [
  { id: 'github', name: 'GitHub', transport: 'cli', hint: 'Pull requests, issues and checks, through the gh CLI you are already signed in to.' },
  { id: 'mcp', name: 'MCP server', transport: 'mcp', hint: 'Any Model Context Protocol server, local or remote.' },
  { id: 'rest', name: 'REST endpoint', transport: 'rest', hint: 'A plain HTTP API described by an OpenAPI document.' },
  { id: 'browser', name: 'Browser profile', transport: 'browser', hint: 'A Playwright profile for QA and web automation.' },
];

export function Integrations(): JSX.Element {
  const integrations = useIntegrations();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<IntegrationView | null>(null);
  const remove = useDaemonMutation((daemon, id: string) => daemon.deleteIntegration(id), ['integrations']);

  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle="What the workforce may reach outside this machine, and with which permissions."
        actions={
          <button type="button" className="btn btn--primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} />
            Add integration
          </button>
        }
      />

      <div className="page">
        <div className="page__inner">
          {integrations.isError ? <ErrorState error={integrations.error} onRetry={() => void integrations.refetch()} /> : null}

          {integrations.isPending ? (
            <SkeletonList rows={3} />
          ) : (integrations.data ?? []).length === 0 ? (
            <div className="card">
              <Empty
                icon="integrations"
                title="No integrations yet"
                body="Without one, missions stay entirely local — which is a perfectly good place to start. Add GitHub when you want release candidates to become pull requests."
                action={
                  <button type="button" className="btn btn--primary btn--lg" onClick={() => setAdding(true)}>
                    <Icon name="plus" size={14} />
                    Add integration
                  </button>
                }
              />
            </div>
          ) : (
            <div className="stack" style={{ gap: 'var(--s4)' }}>
              {(integrations.data ?? []).map((view) => (
                <IntegrationCard key={view.integration.id} view={view} onRemove={() => setRemoving(view)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {adding ? <AddIntegrationModal onClose={() => setAdding(false)} /> : null}
      {removing ? (
        <ConfirmDialog
          title={`Remove ${removing.integration.name}?`}
          confirmLabel="Remove integration"
          destructive
          busy={remove.isPending}
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove.mutate(removing.integration.id, { onSuccess: () => setRemoving(null) })}
          body={
            <p>
              Its stored credential reference is released and any capability it granted is withdrawn. Missions that depended on it will ask
              for an alternative rather than failing silently.
            </p>
          }
        />
      ) : null}
    </>
  );
}

function IntegrationCard({ view, onRemove }: { view: IntegrationView; onRemove: () => void }): JSX.Element {
  const { integration, health } = view;
  const update = useDaemonMutation((daemon, body: Record<string, unknown>) => daemon.updateIntegration(integration.id, body), ['integrations']);

  const toggleCapability = (capability: string, on: boolean): void => {
    const next = on
      ? [...integration.enabledCapabilities, capability]
      : integration.enabledCapabilities.filter((value) => value !== capability);
    update.mutate({ enabledCapabilities: next });
  };

  return (
    <article className="card card--flush">
      <div className="card__head">
        <StatusDot tone={healthTone(health.state)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row" style={{ gap: 'var(--s2)' }}>
            <span style={{ fontWeight: 600, fontSize: 'var(--fs-base)' }}>{integration.name}</span>
            <span className="chip chip--muted">{integration.transport}</span>
            {integration.credentialRef ? (
              <span className="chip" title="The secret itself lives in the OS credential store.">
                <Icon name="shield" size={10} />
                credential stored
              </span>
            ) : null}
          </div>
          <div className="dim" style={{ fontSize: 'var(--fs-xs)', marginTop: 2 }}>
            {health.detail} · checked {dateTime(health.checkedAt)}
          </div>
        </div>
        <Switch checked={integration.enabled} label={`Enable ${integration.name}`} onChange={(enabled) => update.mutate({ enabled })} />
        <button type="button" className="btn btn--icon btn--ghost" aria-label="Remove integration" onClick={onRemove}>
          <Icon name="trash" size={14} />
        </button>
      </div>

      <div className="card__body">
        <div className="qa__q" style={{ marginBottom: 'var(--s2)' }}>
          Capabilities
        </div>
        {view.availableCapabilities.length === 0 ? (
          <span className="dim">This provider exposes no optional capabilities.</span>
        ) : (
          <div className="stack" style={{ gap: 4 }}>
            {view.availableCapabilities.map((capability) => {
              const on = integration.enabledCapabilities.includes(capability.capability);
              return (
                <div key={capability.capability} className="routing__row">
                  <Switch
                    checked={on}
                    label={capability.capability}
                    onChange={(next) => toggleCapability(capability.capability, next)}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span className="mono">{capability.capability}</span>
                    <div className="dim" style={{ fontSize: 'var(--fs-xs)' }}>
                      {capability.description}
                    </div>
                  </div>
                  <span className={`badge ${riskClass(capability.risk)}`}>{titleCase(capability.risk)}</span>
                </div>
              );
            })}
          </div>
        )}
        {update.isError ? <ErrorState error={update.error} /> : null}
      </div>
    </article>
  );
}

function AddIntegrationModal({ onClose }: { onClose: () => void }): JSX.Element {
  const workspaces = useWorkspaces();
  const workspaceId = workspaces.data?.[0]?.workspace.id ?? '';
  const [providerId, setProviderId] = useState(PROVIDERS[0]?.id ?? 'github');
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');

  const provider = PROVIDERS.find((candidate) => candidate.id === providerId);
  const create = useDaemonMutation(
    (daemon) =>
      daemon.createIntegration({
        workspaceId,
        providerId,
        name: name.trim() || (provider?.name ?? providerId),
        ...(secret ? { secret } : {}),
      }),
    ['integrations'],
  );

  return (
    <Modal
      title="Add an integration"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={create.isPending || !workspaceId} onClick={() => create.mutate(undefined, { onSuccess: onClose })}>
            {create.isPending ? 'Adding…' : 'Add integration'}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 'var(--s4)', color: 'var(--text)' }}>
        <Field label="Provider" hint={provider?.hint}>
          <select className="select" value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            {PROVIDERS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name" hint="How it appears in approval cards and mission timelines.">
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder={provider?.name} />
        </Field>
        <Field
          label="Token"
          hint="Stored in the OS credential store. Tandemise keeps only a reference — the secret is never written to the database, a log, or an event."
        >
          <input className="input mono" type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Leave blank to reuse an authenticated CLI" />
        </Field>
        {create.isError ? <ErrorState error={create.error} /> : null}
      </div>
    </Modal>
  );
}

function riskClass(risk: string): string {
  switch (risk) {
    case 'read':
      return 'badge';
    case 'write_reversible':
      return 'badge badge--running';
    case 'external_side_effect':
      return 'badge badge--blocked';
    case 'destructive':
    case 'financial':
      return 'badge badge--failed';
    default:
      return 'badge badge--release';
  }
}
