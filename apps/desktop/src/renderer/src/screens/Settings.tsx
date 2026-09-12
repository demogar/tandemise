import { useState } from 'react';
import type { AutonomySettings, Repository } from '@tandemise/domain';
import { PageHeader } from '../components/PageHeader.js';
import { Icon } from '../components/Icon.js';
import { ConfirmDialog } from '../components/Modal.js';
import { Empty, ErrorState, Field, SectionHead, Segmented, SkeletonList, Switch } from '../components/primitives.js';
import { useDaemonMutation, useSettings, useSystem, useWorkspaces } from '../lib/queries.js';
import { useWorkspace } from '../lib/workspace.js';
import { useConnection } from '../lib/connection.js';
import { useThemePreference, type ThemePreference } from '../lib/theme.js';
import { dateTime, shortenPath } from '../lib/format.js';

const AUTONOMY_ROWS: readonly { key: keyof AutonomySettings; label: string; hint: string; options: readonly string[] }[] = [
  { key: 'planApproval', label: 'Plan approval', hint: 'Show the proposed task graph before anything runs.', options: ['ask', 'auto'] },
  { key: 'localCodeChanges', label: 'Local code changes', hint: 'Edits inside an isolated worktree, never your checkout.', options: ['auto', 'ask'] },
  { key: 'externalWrites', label: 'Writes that leave this machine', hint: 'Pull requests, issue comments, API calls.', options: ['auto', 'policy', 'ask', 'deny'] },
  { key: 'productionRelease', label: 'Production release', hint: 'Merging, deploying, publishing.', options: ['ask', 'deny'] },
  { key: 'financialActions', label: 'Financial actions', hint: 'Locked to deny. Tandemise never spends money on your behalf.', options: ['deny'] },
];

export function Settings(): JSX.Element {
  const workspaces = useWorkspaces();
  const settings = useSettings();
  const system = useSystem();
  const { status } = useConnection();
  const [theme, setTheme] = useThemePreference();
  const [removingRepository, setRemovingRepository] = useState<Repository | null>(null);

  const workspaceView = useWorkspace().current;
  const workspace = workspaceView?.workspace;

  const updateWorkspace = useDaemonMutation(
    (daemon, body: Parameters<typeof daemon.updateWorkspace>[1]) => daemon.updateWorkspace(workspace?.id ?? '', body),
    ['workspaces'],
  );
  const updateSettings = useDaemonMutation((daemon, body: Parameters<typeof daemon.updateSettings>[0]) => daemon.updateSettings(body), ['workspaces']);
  const addRepository = useDaemonMutation(
    (daemon, path: string) => daemon.addRepository(workspace?.id ?? '', { path }),
    ['workspaces'],
  );
  const removeRepository = useDaemonMutation((daemon, id: string) => daemon.removeRepository(id), ['workspaces']);

  const pickRepository = async (): Promise<void> => {
    const path = await window.tandemise.selectDirectory('Choose a repository');
    if (path) addRepository.mutate(path);
  };

  return (
    <>
      <PageHeader narrow title="Settings" subtitle="Workspace defaults, paths, and what the daemon is doing." />

      <div className="page">
        <div className="page__inner page__inner--narrow">
          {workspaces.isPending ? (
            <SkeletonList rows={5} />
          ) : (
            <>
              <section className="section">
                <SectionHead title="Appearance" />
                <div className="card">
                  <Field label="Theme" hint="System follows macOS. An explicit choice overrides it everywhere.">
                    <Segmented<ThemePreference>
                      value={theme}
                      onChange={setTheme}
                      options={[
                        { value: 'system', label: 'System' },
                        { value: 'light', label: 'Light' },
                        { value: 'dark', label: 'Dark' },
                      ]}
                    />
                  </Field>
                </div>
              </section>

              <section className="section">
                <SectionHead title="Autonomy" meta="Per action class, not one global dial" />
                <div className="card card--flush">
                  {AUTONOMY_ROWS.map((row) => {
                    const current = workspace?.autonomy[row.key] ?? row.options[0] ?? 'ask';
                    const locked = row.options.length === 1;
                    return (
                      <div key={row.key} className="list__row" style={{ alignItems: 'flex-start' }}>
                        <div className="list__main">
                          <div className="list__title">{row.label}</div>
                          <div className="list__subtitle">{row.hint}</div>
                        </div>
                        <div className="list__aside">
                          {locked ? (
                            <span className="badge badge--failed">
                              <Icon name="shield" size={11} />
                              Denied
                            </span>
                          ) : (
                            <Segmented
                              value={current}
                              options={row.options.map((option) => ({ value: option, label: capitalise(option) }))}
                              onChange={(next) =>
                                workspace &&
                                updateWorkspace.mutate({
                                  autonomy: { ...workspace.autonomy, [row.key]: next } as AutonomySettings,
                                })
                              }
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {updateWorkspace.isError ? <ErrorState error={updateWorkspace.error} /> : null}
              </section>

              <section className="section">
                <SectionHead title="Concurrency" meta="How many workers may run at once" />
                <div className="card">
                  <Field label="Maximum total workers" hint="Each worker is a child process with its own worktree. Three is a sane default on a laptop.">
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={16}
                      style={{ width: 96 }}
                      defaultValue={workspace?.concurrency.maxTotalWorkers ?? 3}
                      onBlur={(event) => {
                        const next = Number(event.target.value);
                        if (workspace && Number.isFinite(next) && next !== workspace.concurrency.maxTotalWorkers) {
                          updateWorkspace.mutate({ concurrency: { ...workspace.concurrency, maxTotalWorkers: next } });
                        }
                      }}
                    />
                  </Field>
                </div>
              </section>

              <section className="section">
                <SectionHead
                  title="Repositories"
                  action={
                    <button type="button" className="btn" onClick={() => void pickRepository()} disabled={addRepository.isPending}>
                      <Icon name="folder" size={13} />
                      {addRepository.isPending ? 'Adding…' : 'Add repository'}
                    </button>
                  }
                />
                {(workspaceView?.repositories.length ?? 0) === 0 ? (
                  <div className="card">
                    <Empty
                      icon="folder"
                      title="No repositories yet"
                      body="Tandemise never edits your checkout directly — it cuts a git worktree per task. Point it at a repository to get started."
                      action={
                        <button type="button" className="btn btn--primary" onClick={() => void pickRepository()}>
                          Choose a folder
                        </button>
                      }
                    />
                  </div>
                ) : (
                  <div className="list">
                    {(workspaceView?.repositories ?? []).map((repository) => (
                      <div key={repository.id} className="list__row">
                        <Icon name="folder" size={15} className="dim" />
                        <div className="list__main">
                          <div className="list__title">{repository.name}</div>
                          <div className="list__subtitle mono truncate" title={repository.path}>
                            {shortenPath(repository.path, 4)}
                          </div>
                        </div>
                        <div className="list__aside">
                          <span className="chip chip--muted">{repository.defaultBranch}</span>
                          <button
                            type="button"
                            className="btn btn--icon btn--ghost"
                            aria-label={`Reveal ${repository.name} in Finder`}
                            onClick={() => void window.tandemise.revealInFinder(repository.path)}
                          >
                            <Icon name="externalLink" size={13} />
                          </button>
                          <button
                            type="button"
                            className="btn btn--icon btn--ghost"
                            aria-label={`Remove ${repository.name}`}
                            onClick={() => setRemovingRepository(repository)}
                          >
                            <Icon name="trash" size={13} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {addRepository.isError ? <ErrorState error={addRepository.error} /> : null}
              </section>

              <section className="section">
                <SectionHead title="Daemon" meta={status.phase === 'connected' ? 'Running' : 'Not connected'} />
                <div className="card card--flush">
                  <table className="table">
                    <tbody>
                      <InfoRow label="Version" value={system.data?.daemonVersion ?? '—'} />
                      <InfoRow label="API version" value={system.data?.apiVersion ?? '—'} />
                      <InfoRow label="Schema version" value={system.data ? String(system.data.schemaVersion) : '—'} />
                      <InfoRow label="Process id" value={system.data ? String(system.data.pid) : '—'} />
                      <InfoRow label="Started" value={system.data ? dateTime(system.data.startedAt) : '—'} />
                      <InfoRow label="Address" value={status.connection?.url ?? '—'} mono />
                      <InfoRow label="Home" value={system.data?.home ?? settings.data?.home ?? '—'} mono />
                      <InfoRow label="Node" value={system.data?.nodeVersion ?? '—'} />
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="section">
                <SectionHead title="Developer" />
                <div className="card card--flush">
                  <div className="list__row">
                    <div className="list__main">
                      <div className="list__title">Log level</div>
                      <div className="list__subtitle">Written as structured JSON with correlation ids. Secrets are redacted before anything is written.</div>
                    </div>
                    <div className="list__aside">
                      <Segmented
                        value={settings.data?.logLevel ?? 'info'}
                        options={[
                          { value: 'debug', label: 'Debug' },
                          { value: 'info', label: 'Info' },
                          { value: 'warn', label: 'Warn' },
                          { value: 'error', label: 'Error' },
                        ]}
                        onChange={(logLevel) => updateSettings.mutate({ logLevel })}
                      />
                    </div>
                  </div>
                  <div className="list__row">
                    <div className="list__main">
                      <div className="list__title">Developer mode</div>
                      <div className="list__subtitle">Shows raw runtime output, adapter timings, and the unfiltered event stream by default.</div>
                    </div>
                    <div className="list__aside">
                      <Switch
                        checked={settings.data?.developerMode ?? false}
                        label="Developer mode"
                        onChange={(developerMode) => updateSettings.mutate({ developerMode })}
                      />
                    </div>
                  </div>
                  <div className="list__row">
                    <div className="list__main">
                      <div className="list__title">Logs</div>
                      <div className="list__subtitle mono truncate">{settings.data?.home ? `${settings.data.home}/logs` : '~/.tandemise/logs'}</div>
                    </div>
                    <div className="list__aside">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void window.tandemise.revealInFinder(`${settings.data?.home ?? ''}/logs`)}
                      >
                        Reveal
                      </button>
                    </div>
                  </div>
                </div>
                {updateSettings.isError ? <ErrorState error={updateSettings.error} /> : null}
              </section>
            </>
          )}
        </div>
      </div>

      {removingRepository ? (
        <ConfirmDialog
          title={`Remove ${removingRepository.name}?`}
          confirmLabel="Remove repository"
          destructive
          busy={removeRepository.isPending}
          onCancel={() => setRemovingRepository(null)}
          onConfirm={() => removeRepository.mutate(removingRepository.id, { onSuccess: () => setRemovingRepository(null) })}
          body={
            <p>
              Tandemise forgets this repository and its detected check commands. Nothing on disk is touched — your checkout, its branches and
              any existing worktrees stay exactly as they are.
            </p>
          }
        />
      ) : null}
    </>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <tr>
      <td style={{ width: 160, color: 'var(--text-tertiary)' }}>{label}</td>
      <td className={mono ? 'mono' : undefined}>{value}</td>
    </tr>
  );
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
