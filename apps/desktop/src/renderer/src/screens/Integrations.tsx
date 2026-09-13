import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ConnectionAttemptView, ConnectorView, IntegrationView } from '@tandemise/api-contract';
import { PageHeader } from '../components/PageHeader.js';
import { Icon } from '../components/Icon.js';
import { ConfirmDialog, Modal } from '../components/Modal.js';
import { ErrorState, Field, Segmented, SkeletonList, StatusDot, Switch } from '../components/primitives.js';
import { useConnectors, useDaemonMutation, useIntegrations } from '../lib/queries.js';
import { useDaemon } from '../lib/connection.js';
import { useWorkspace } from '../lib/workspace.js';
import { healthTone, relativeTime } from '../lib/format.js';

/** Gallery order: roughly the order work flows through a project. */
const CATEGORIES: readonly { id: string; title: string }[] = [
  { id: 'design', title: 'Design' },
  { id: 'planning', title: 'Plan and document' },
  { id: 'build', title: 'Build' },
  { id: 'deploy', title: 'Ship' },
  { id: 'observe', title: 'Watch production' },
];

/**
 * Who a custom server is for. A server's tools reach only the roles holding its
 * capability, so this is a real choice about which workers see it - not a label.
 */
const AUDIENCES: readonly { capability: string; label: string }[] = [
  { capability: 'design', label: 'Designers' },
  { capability: 'planning', label: 'Product, architecture and release' },
  { capability: 'database', label: 'Developers' },
  { capability: 'deploy', label: 'Release and QA' },
  { capability: 'monitoring', label: 'Developers, QA and release' },
];

/**
 * The project's connected apps, and the ones it could connect.
 *
 * Connecting is consent, not configuration: Connect opens the app's own sign-in
 * page in your browser, and when you allow access the app appears here with the
 * account it is connected as. No token is pasted and nothing is registered with
 * a vendor first.
 *
 * What an app can be used for is decided by who does that kind of work - Figma
 * reaches designers, Supabase reaches developers - so there is no per-app
 * permission grid to get wrong. How far workers may go without asking is the
 * project's autonomy setting, and it applies here like everywhere else.
 */
export function Integrations(): JSX.Element {
  const integrations = useIntegrations();
  const connectors = useConnectors();
  const [connecting, setConnecting] = useState<ConnectTarget | null>(null);
  const [custom, setCustom] = useState(false);
  const [removing, setRemoving] = useState<IntegrationView | null>(null);
  const remove = useDaemonMutation((daemon, id: string) => daemon.deleteIntegration(id), ['integrations']);

  const connected = integrations.data ?? [];
  const byConnector = (id: string): IntegrationView[] => connected.filter((view) => view.connectorId === id);
  const hasGithub = connected.some((view) => view.integration.providerId === 'github');

  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle="Connect the tools this project already uses. Each one reaches the workers who do that kind of work."
        actions={
          <button type="button" className="btn" onClick={() => setCustom(true)}>
            <Icon name="plus" size={13} />
            Custom server
          </button>
        }
      />

      <div className="page">
        <div className="page__inner">
          {integrations.isError ? <ErrorState error={integrations.error} onRetry={() => void integrations.refetch()} /> : null}

          {integrations.isPending ? (
            <SkeletonList rows={2} />
          ) : connected.length > 0 ? (
            <section className="section">
              <div className="section__head">
                <h2 className="section__title">Connected</h2>
              </div>
              <div className="stack" style={{ gap: 'var(--s3)' }}>
                {connected.map((view) => (
                  <ConnectedCard
                    key={view.integration.id}
                    view={view}
                    connector={connectors.data?.find((c) => c.id === view.connectorId)}
                    onReconnect={() => setConnecting({ kind: 'reconnect', view })}
                    onRemove={() => setRemoving(view)}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section className="section">
            <div className="section__head">
              <h2 className="section__title">{connected.length > 0 ? 'Connect more' : 'Connect your tools'}</h2>
              <span className="section__meta">Opens the app's sign-in page in your browser</span>
            </div>

            {connectors.isError ? <ErrorState error={connectors.error} /> : null}

            <div className="stack" style={{ gap: 'var(--s5)' }}>
              {CATEGORIES.map((category) => {
                const apps = (connectors.data ?? []).filter((c) => c.category === category.id);
                const github = category.id === 'build';
                if (apps.length === 0 && !github) return null;
                return (
                  <div key={category.id}>
                    <div className="qa__q" style={{ marginBottom: 'var(--s2)' }}>{category.title}</div>
                    <div className="grid grid--3">
                      {github ? <GithubCard connected={hasGithub} /> : null}
                      {apps.map((connector) => (
                        <ConnectorCard
                          key={connector.id}
                          connector={connector}
                          accounts={byConnector(connector.id)}
                          onConnect={() => setConnecting({ kind: 'connector', connector })}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>

      {connecting ? <ConnectDialog target={connecting} onClose={() => setConnecting(null)} /> : null}
      {custom ? (
        <CustomServerDialog
          onClose={() => setCustom(false)}
          onConnect={(target) => {
            setCustom(false);
            setConnecting(target);
          }}
        />
      ) : null}
      {removing ? (
        <ConfirmDialog
          title={`Disconnect ${removing.integration.name}?`}
          confirmLabel="Disconnect"
          destructive
          busy={remove.isPending}
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove.mutate(removing.integration.id, { onSuccess: () => setRemoving(null) })}
          body={
            <p>
              Its tools are withdrawn from every worker and the stored credential is deleted from your keychain. To revoke
              Tandemise's access entirely, also remove it in the app's own settings.
            </p>
          }
        />
      ) : null}
    </>
  );
}

type ConnectTarget =
  | { readonly kind: 'connector'; readonly connector: ConnectorView }
  | { readonly kind: 'reconnect'; readonly view: IntegrationView }
  | { readonly kind: 'custom'; readonly name: string; readonly url: string; readonly capability: string };

function ConnectedCard({
  view,
  connector,
  onReconnect,
  onRemove,
}: {
  view: IntegrationView;
  connector: ConnectorView | undefined;
  onReconnect: () => void;
  onRemove: () => void;
}): JSX.Element {
  const { integration, health } = view;
  const update = useDaemonMutation(
    (daemon, enabled: boolean) => daemon.updateIntegration(integration.id, { enabled }),
    ['integrations'],
  );
  const reads = view.availableCapabilities.filter((c) => c.risk === 'read').length;
  const writes = view.availableCapabilities.length - reads;
  const needsReconnect = view.reconnectable && health.state === 'unavailable';

  return (
    <article className="card">
      <div className="row" style={{ gap: 'var(--s3)', alignItems: 'flex-start' }}>
        <AppMark name={connector?.name ?? integration.name} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row row--wrap" style={{ gap: 'var(--s2)' }}>
            <span style={{ fontWeight: 600 }}>{connector?.name ?? integration.name}</span>
            {connector !== undefined && connector.name.toLowerCase() !== integration.name ? (
              <span className="chip chip--muted mono">{integration.name}</span>
            ) : null}
            {view.account ? <span className="dim">{view.account}</span> : null}
          </div>
          <div className="row" style={{ gap: 6, marginTop: 4, fontSize: 'var(--fs-xs)' }}>
            <StatusDot tone={needsReconnect ? 'blocked' : healthTone(health.state)} />
            <span className="dim truncate" title={health.detail}>
              {needsReconnect ? health.detail : health.state === 'healthy' ? `Working · checked ${relativeTime(health.checkedAt)}` : health.detail}
            </span>
          </div>
          {view.availableCapabilities.length > 0 || connector ? (
            <div className="dim" style={{ fontSize: 'var(--fs-xs)', marginTop: 6 }}>
              {connector ? `Used by ${lowerFirst(connector.usedBy)}` : null}
              {connector && view.availableCapabilities.length > 0 ? ' · ' : null}
              {view.availableCapabilities.length > 0
                ? `${reads} read tool${reads === 1 ? '' : 's'} run freely, ${writes} that change things follow your autonomy setting`
                : null}
            </div>
          ) : null}
        </div>
        <div className="row" style={{ gap: 'var(--s2)' }}>
          {view.reconnectable ? (
            <button type="button" className={needsReconnect ? 'btn btn--primary' : 'btn btn--ghost'} onClick={onReconnect}>
              {needsReconnect ? 'Reconnect' : 'Reconnect…'}
            </button>
          ) : null}
          <Switch
            checked={integration.enabled}
            label={integration.enabled ? `Turn off ${integration.name}` : `Turn on ${integration.name}`}
            onChange={(enabled) => update.mutate(enabled)}
          />
          <button type="button" className="btn btn--icon btn--ghost" aria-label={`Disconnect ${integration.name}`} onClick={onRemove}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
      {update.isError ? <ErrorState error={update.error} /> : null}
    </article>
  );
}

function ConnectorCard({
  connector,
  accounts,
  onConnect,
}: {
  connector: ConnectorView;
  accounts: readonly IntegrationView[];
  onConnect: () => void;
}): JSX.Element {
  return (
    <article className="card stack" style={{ gap: 'var(--s2)' }}>
      <div className="row" style={{ gap: 'var(--s3)' }}>
        <AppMark name={connector.name} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{connector.name}</div>
          <div className="dim" style={{ fontSize: 'var(--fs-xs)' }}>For {lowerFirst(connector.usedBy)}</div>
        </div>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-sm)', flex: 1 }}>{connector.description}</p>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        {accounts.length > 0 ? (
          <span className="chip">
            <Icon name="check" size={10} />
            Connected
          </span>
        ) : <span />}
        <button type="button" className={accounts.length > 0 ? 'btn btn--ghost' : 'btn btn--primary'} onClick={onConnect}>
          {accounts.length > 0 ? 'Add account' : 'Connect'}
        </button>
      </div>
    </article>
  );
}

/**
 * GitHub goes through the `gh` CLI rather than a consent screen: it is already
 * signed in on most developers' machines, and GitHub's hosted MCP server does not
 * let apps register themselves. So "connect" here means "use your gh login".
 */
function GithubCard({ connected }: { connected: boolean }): JSX.Element {
  const workspaceId = useWorkspace().current?.workspace.id ?? '';
  const add = useDaemonMutation(
    (daemon) => daemon.createIntegration({ workspaceId, providerId: 'github', name: 'github' }),
    ['integrations'],
  );
  return (
    <article className="card stack" style={{ gap: 'var(--s2)' }}>
      <div className="row" style={{ gap: 'var(--s3)' }}>
        <AppMark name="GitHub" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>GitHub</div>
          <div className="dim" style={{ fontSize: 'var(--fs-xs)' }}>For developers and release</div>
        </div>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-sm)', flex: 1 }}>
        Pull requests, issues and checks — through the <span className="mono">gh</span> CLI you are already signed in to.
      </p>
      {add.isError ? <ErrorState error={add.error} /> : null}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        {connected ? (
          <span className="chip">
            <Icon name="check" size={10} />
            Connected
          </span>
        ) : <span className="dim" style={{ fontSize: 'var(--fs-xs)' }}>Run <span className="mono">gh auth login</span> first</span>}
        {connected ? null : (
          <button type="button" className="btn btn--primary" disabled={add.isPending || !workspaceId} onClick={() => add.mutate(undefined)}>
            {add.isPending ? 'Connecting…' : 'Use gh login'}
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * The whole consent round trip, as one dialog.
 *
 * The daemon returns a URL; the dialog opens it in the browser, then watches the
 * attempt until the browser comes back. The user never copies anything: they
 * click Allow in a page they recognise, and this dialog turns green.
 */
function ConnectDialog({ target, onClose }: { target: ConnectTarget; onClose: () => void }): JSX.Element {
  const daemon = useDaemon();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspace().current?.workspace.id ?? '';
  const [attempt, setAttempt] = useState<ConnectionAttemptView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);
  const title = target.kind === 'connector' ? target.connector.name
    : target.kind === 'reconnect' ? target.view.integration.name : target.name;

  const start = async (): Promise<void> => {
    setError(null);
    setAttempt(null);
    try {
      const view = await daemon.connectIntegration(
        target.kind === 'connector' ? { workspaceId, connectorId: target.connector.id }
          : target.kind === 'reconnect' ? { workspaceId, integrationId: target.view.integration.id }
            : {
              workspaceId,
              providerId: 'mcp',
              name: target.name,
              config: { url: target.url, auth: 'oauth', capability: target.capability },
            },
      );
      setAttempt(view);
      if (view.authorizationUrl) await window.tandemise.openExternal(view.authorizationUrl);
    } catch (e) {
      setError(e);
    }
  };

  useEffect(() => {
    // Strict mode mounts twice in development; one click must be one attempt.
    if (started.current) return;
    started.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const attemptId = attempt?.id;
  const waiting = attempt?.status === 'waiting' || attempt?.status === 'connecting';
  useEffect(() => {
    if (attemptId === undefined || !waiting) return;
    const timer = setInterval(() => {
      void daemon.connectionAttempt(attemptId).then((view: ConnectionAttemptView) => {
        setAttempt(view);
        if (view.status === 'connected') void queryClient.invalidateQueries({ queryKey: ['integrations'] });
      }, setError);
    }, 1000);
    return () => clearInterval(timer);
  }, [attemptId, waiting, daemon, queryClient]);

  const cancel = (): void => {
    if (attemptId !== undefined && waiting) void daemon.cancelConnection(attemptId).catch(() => undefined);
    onClose();
  };

  return (
    <Modal
      title={attempt?.status === 'connected' ? `${title} is connected` : `Connect ${title}`}
      onClose={cancel}
      footer={
        attempt?.status === 'connected' ? (
          <button type="button" className="btn btn--primary" onClick={onClose}>Done</button>
        ) : attempt?.status === 'failed' || error !== null ? (
          <>
            <button type="button" className="btn btn--ghost" onClick={onClose}>Close</button>
            <button type="button" className="btn btn--primary" onClick={() => void start()}>Try again</button>
          </>
        ) : (
          <button type="button" className="btn btn--ghost" onClick={cancel}>Cancel</button>
        )
      }
    >
      <div className="stack" style={{ gap: 'var(--s3)', color: 'var(--text)' }}>
        {error !== null ? (
          <ErrorState error={error} />
        ) : attempt === null ? (
          <p className="muted" style={{ margin: 0 }}>Preparing a secure sign-in…</p>
        ) : attempt.status === 'connected' ? (
          <p style={{ margin: 0 }}>
            {target.kind === 'connector'
              ? `${target.connector.usedBy} can use ${title} from their next task.`
              : `Workers can use ${title} from their next task.`}{' '}
            Anything that changes data in {title} follows this project's autonomy setting.
          </p>
        ) : attempt.status === 'failed' ? (
          <div className="banner banner--warn">
            <Icon name="alert" size={14} />
            <span>{attempt.error ?? 'The connection did not complete.'}</span>
          </div>
        ) : (
          <>
            <div className="row" style={{ gap: 'var(--s3)' }}>
              <span className="dot dot--running dot--pulse" />
              <span>
                {attempt.status === 'connecting'
                  ? 'Finishing up…'
                  : `Finish in your browser: sign in to ${title} and allow access.`}
              </span>
            </div>
            {attempt.authorizationUrl ? (
              <button
                type="button"
                className="btn btn--ghost"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => void window.tandemise.openExternal(attempt.authorizationUrl!)}
              >
                <Icon name="externalLink" size={12} />
                Open the sign-in page again
              </button>
            ) : null}
            <p className="dim" style={{ margin: 0, fontSize: 'var(--fs-xs)' }}>
              Tandemise never sees your password. The access it receives is stored in your keychain, and you can disconnect at any
              time.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

function CustomServerDialog({ onClose, onConnect }: { onClose: () => void; onConnect: (target: ConnectTarget) => void }): JSX.Element {
  const workspaceId = useWorkspace().current?.workspace.id ?? '';
  const [mode, setMode] = useState<'hosted' | 'command'>('hosted');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [capability, setCapability] = useState(AUDIENCES[0]!.capability);
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [cwd, setCwd] = useState('');
  const [trustReadOnly, setTrustReadOnly] = useState(false);
  // A server that runs on this machine has no sign-in to go through: it is
  // added directly, and the daemon starts it once to read its tool list.
  const add = useDaemonMutation(
    (daemon) => daemon.createIntegration({
      workspaceId,
      providerId: 'mcp',
      name: name.trim(),
      config: {
        command: command.trim(),
        args: lines(args),
        env: parseEnv(env),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        capability,
        risk: 'external_side_effect',
        trustAnnotations: trustReadOnly,
      },
    }),
    ['integrations'],
  );

  const nameValid = /^[a-z0-9][a-z0-9_-]*$/.test(name.trim());
  // Same rule as the daemon: https, or plain http only to a server on this machine.
  const valid = nameValid && (mode === 'hosted'
    ? /^(https:\/\/\S+|http:\/\/(127\.0\.0\.1|localhost)[:/]\S*)$/.test(url.trim())
    : command.trim().length > 0 && lines(env).every((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)));

  return (
    <Modal
      title="Connect a custom MCP server"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!valid || add.isPending || !workspaceId}
            onClick={() => {
              if (mode === 'hosted') onConnect({ kind: 'custom', url: url.trim(), name: name.trim(), capability });
              else add.mutate(undefined, { onSuccess: onClose });
            }}
          >
            {mode === 'command' ? (add.isPending ? 'Starting it…' : 'Add server') : 'Connect'}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 'var(--s4)', color: 'var(--text)' }}>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'hosted', label: 'Hosted (sign in)' },
            { value: 'command', label: 'Run a command' },
          ]}
        />
        {mode === 'hosted' ? (
          <>
            <p className="muted" style={{ margin: 0 }}>
              Any hosted MCP server that signs in with OAuth. You will be sent to its sign-in page, like the apps above.
            </p>
            <Field label="Server URL">
              <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
            </Field>
          </>
        ) : (
          <>
            <p className="muted" style={{ margin: 0 }}>
              A server Tandemise starts on this machine and talks to over stdio - the kind an MCP client config
              lists as <span className="mono">command</span> and <span className="mono">args</span>.
            </p>
            <Field label="Command" hint="An absolute path is safest: the daemon may not share your shell's PATH.">
              <input className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="/usr/local/bin/node" />
            </Field>
            <Field label="Arguments" hint="One per line, exactly as the server's install instructions give them.">
              <textarea className="textarea mono" rows={4} value={args} onChange={(e) => setArgs(e.target.value)} placeholder={'/path/to/cli.js\nmcp\n--daemon-url\nhttp://127.0.0.1:7456'} />
            </Field>
            <Field label="Environment" hint="KEY=value, one per line. Stored in Tandemise's database, not your keychain - never put a token here.">
              <textarea className="textarea mono" rows={2} value={env} onChange={(e) => setEnv(e.target.value)} placeholder="OD_DATA_DIR=/path/to/.od" />
            </Field>
            <Field label="Working directory" hint="Optional.">
              <input className="input mono" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/server" />
            </Field>
            <Field
              label="Trust its read-only labels"
              hint="On: tools the server marks read-only run without asking, and only its other tools follow your autonomy setting. Leave off for a server you did not write or install yourself."
            >
              <Switch checked={trustReadOnly} onChange={setTrustReadOnly} label="Trust read-only labels" />
            </Field>
          </>
        )}
        <Field label="Short name" hint="Lowercase. Its tools appear to workers as name.tool.">
          <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="example" />
        </Field>
        <Field label="Who uses it" hint="Only these workers see its tools. Changes to data follow your autonomy setting.">
          <select className="select" value={capability} onChange={(e) => setCapability(e.target.value)}>
            {AUDIENCES.map((audience) => (
              <option key={audience.capability} value={audience.capability}>{audience.label}</option>
            ))}
          </select>
        </Field>
        {add.isError ? <ErrorState error={add.error} /> : null}
      </div>
    </Modal>
  );
}

function lines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of lines(text)) {
    const at = line.indexOf('=');
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  return env;
}

/**
 * A monogram tile. Vendor logos are trademarks this app has no licence to ship.
 * The tint is picked from the name so a vendor keeps its colour between visits.
 */
function AppMark({ name }: { name: string }): JSX.Element {
  const tint = ([...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 5) + 1;
  return (
    <span aria-hidden className="monogram" data-tint={tint}>
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/** "Release and QA" → "release and QA": sentence case without flattening acronyms. */
function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}
