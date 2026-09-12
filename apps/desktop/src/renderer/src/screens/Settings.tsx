import { PageHeader } from '../components/PageHeader.js';
import { ErrorState, Field, SectionHead, Segmented, SkeletonList, Switch } from '../components/primitives.js';
import { useDaemonMutation, useSettings, useSystem } from '../lib/queries.js';
import { useConnection } from '../lib/connection.js';
import { useThemePreference, type ThemePreference } from '../lib/theme.js';
import { dateTime } from '../lib/format.js';

export function Settings(): JSX.Element {
  const settings = useSettings();
  const system = useSystem();
  const { status } = useConnection();
  const [theme, setTheme] = useThemePreference();

  const updateSettings = useDaemonMutation((daemon, body: Parameters<typeof daemon.updateSettings>[0]) => daemon.updateSettings(body), ['workspaces']);

  return (
    <>
      <PageHeader narrow title="Settings" subtitle="How the app looks, and what the daemon is doing." />

      <div className="page">
        <div className="page__inner page__inner--narrow">
          {settings.isPending ? (
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

