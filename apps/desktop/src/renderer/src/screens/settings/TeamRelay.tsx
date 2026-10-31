import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CoordinationStatusView } from '@tandemise/api-contract';
import type { EndpointView } from '@tandemise/api-contract/relay';
import { ErrorState, Field, SectionHead } from '../../components/primitives.js';
import { Icon } from '../../components/Icon.js';
import { useDaemon } from '../../lib/connection.js';
import { useCoordinationStatus, useDaemonMutation } from '../../lib/queries.js';
import { useWorkspaceId } from '../../lib/workspace.js';
import { dateTime, pluralize } from '../../lib/format.js';
import { showFlash } from '../../lib/notices.js';
import './TeamRelay.css';
import { Banner, Button, Card } from '@tandemise/design/react';

/** An `http://` address that is not this machine: the person must say they understand it is unencrypted. */
function isInsecure(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && !u.hostname.startsWith('127.');
  } catch {
    return false;
  }
}

/**
 * Settings → Team relay (relay spec, §What the desktop shows): local only,
 * connected, offline or refused, and, for admins, the team's webhook
 * addresses. The desktop never talks to the relay; the daemon does.
 */
export function TeamRelay(): JSX.Element {
  const status = useCoordinationStatus();
  const s = status.data;
  return (
    <section className="section team-relay" aria-label="Team relay" data-state={s?.kind ?? 'loading'}>
      <SectionHead title="Team relay" />
      {status.isError ? <ErrorState error={status.error} onRetry={() => void status.refetch()} /> : null}
      {s?.kind === 'local' ? <LocalOnly /> : null}
      {s && s.kind !== 'local' ? <Connected status={s} /> : null}
      {s && (s.kind === 'connected' || s.kind === 'offline') && s.role === 'admin' ? <Webhooks /> : null}
    </section>
  );
}

function LocalOnly(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [device, setDevice] = useState('');
  const [allowInsecure, setAllowInsecure] = useState(false);
  const connect = useDaemonMutation(
    (daemon) => daemon.connectRelay({ url: url.trim(), code: code.trim(), displayName: name.trim(), deviceLabel: device.trim(), allowInsecure }),
    ['coordination'],
  );
  const insecure = isInsecure(url);
  const ready = url.trim() !== '' && code.trim() !== '' && name.trim() !== '' && device.trim() !== '' && (!insecure || allowInsecure);
  return (
    <Card>
      <p className="team-relay__lead">Only this computer knows what you're working on.</p>
      <p className="muted team-relay__detail">
        A team relay tells everyone's Tandemise who is working on which tracker item, and holds webhooks for you to pick up. Your work stays on this computer.
      </p>
      {open ? (
        <form
          className="stack team-relay__form"
          onSubmit={(e) => { e.preventDefault(); if (ready) connect.mutate(undefined, { onSuccess: () => showFlash('Connected to the team relay.') }); }}
        >
          <Field label="Relay address" hint="It looks like https://relay.example.com.">
            <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://relay.example.com" autoFocus />
          </Field>
          <Field label="Invite code" hint="An admin gives you this. It works once.">
            <input className="input mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="TRI-…" />
          </Field>
          <Field label="Your name" hint="How the team sees you.">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="This computer's name" hint="So you can tell your computers apart.">
            <input className="input" value={device} onChange={(e) => setDevice(e.target.value)} />
          </Field>
          {insecure ? (
            <label className="row team-relay__insecure">
              <input type="checkbox" checked={allowInsecure} onChange={(e) => setAllowInsecure(e.target.checked)} />
              <span>I understand this is unencrypted</span>
            </label>
          ) : null}
          {connect.isError ? <ErrorState error={connect.error} /> : null}
          <div className="row">
            <Button type="submit" variant="primary" disabled={!ready || connect.isPending}>
              {connect.isPending ? 'Connecting…' : 'Connect to the relay'}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <Button variant="primary" onClick={() => setOpen(true)}>Connect</Button>
      )}
    </Card>
  );
}

function Connected({ status }: { status: Exclude<CoordinationStatusView, { kind: 'local' }> }): JSX.Element {
  const daemon = useDaemon();
  const disconnect = useDaemonMutation((d) => d.disconnectRelay(), ['coordination']);
  const bring = useDaemonMutation((d) => d.importToRelay(), ['coordination']);
  const failures = useQuery({ queryKey: ['coordination', 'failures'], queryFn: () => daemon.relayFailures(), refetchInterval: 10_000 });
  return (
    <Card>
      {status.kind === 'connected' ? (
        <p className="team-relay__lead">
          <span className="team-relay__dot" data-presence="online" /> Connected to {status.host}
          {status.teamName ? <span className="muted"> · {status.teamName}</span> : null}
        </p>
      ) : status.kind === 'offline' ? (
        <>
          <p className="team-relay__lead">
            <span className="team-relay__dot" data-presence="offline" /> Offline since {dateTime(status.since)}
          </p>
          <p className="muted team-relay__detail">
            {status.pendingOps > 0
              ? `${pluralize(status.pendingOps, 'change')} will be sent when you're back online.`
              : 'Your work carries on. The team hears from you again when the relay is back.'}
          </p>
        </>
      ) : (
        <p className="team-relay__lead team-relay__refused">{status.reason}</p>
      )}
      {(failures.data ?? []).length > 0 ? (
        <ul className="team-relay__failures" aria-label="Changes the relay refused">
          {(failures.data ?? []).map((f) => <li key={f.id}>{f.lastError}</li>)}
        </ul>
      ) : null}
      {status.kind === 'connected' && status.offerImport ? (
        <Banner
          className="team-relay__offer"
          action={
            <Button
              variant="primary"
              disabled={bring.isPending}
              onClick={() => bring.mutate(undefined, { onSuccess: (r) => showFlash(`Brought ${pluralize(r.claims.length, 'claim')}, ${pluralize(r.endpoints, 'webhook address', 'webhook addresses')} and ${pluralize(r.messages, 'webhook')}.`) })}
            >
              Bring my local data
            </Button>
          }
        >
          This relay is new. Bring what this computer knows: what you're working on, your webhook addresses and unread webhooks.
        </Banner>
      ) : null}
      {bring.isError ? <ErrorState error={bring.error} /> : null}
      {disconnect.isError ? <ErrorState error={disconnect.error} /> : null}
      <div className="row">
        <Button disabled={disconnect.isPending} onClick={() => disconnect.mutate(undefined)}>Disconnect</Button>
        <span className="muted">Disconnecting keeps what you're working on, on this computer.</span>
      </div>
    </Card>
  );
}

const HANDSHAKE_WORDS: Readonly<Record<EndpointView['handshake'], string>> = {
  none: 'No handshake',
  meta_hub: 'Meta (WhatsApp) verify token',
  echo_challenge: 'Echo a challenge',
};

function Webhooks(): JSX.Element {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  const endpoints = useQuery({ queryKey: ['coordination', 'endpoints'], queryFn: () => daemon.endpoints(), refetchInterval: 10_000 });
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [handshake, setHandshake] = useState<EndpointView['handshake']>('none');
  const [secret, setSecret] = useState('');
  const create = useDaemonMutation(
    (d) => d.createEndpoint({ workspaceId: workspaceId ?? '', name: name.trim(), source: source.trim(), handshake, ...(handshake === 'meta_hub' ? { handshakeSecret: secret } : {}) }),
    ['coordination'],
  );
  const disable = useDaemonMutation((d, id: string) => d.disableEndpoint(id), ['coordination']);
  const parked = useQuery({ queryKey: ['coordination', 'parked'], queryFn: () => daemon.parkedMessages(), refetchInterval: 10_000 });
  const retry = useDaemonMutation((d, id: string) => d.retryMessage(id), ['coordination']);
  const drop = useDaemonMutation((d, id: string) => d.dropMessage(id), ['coordination']);
  const list = endpoints.data ?? [];
  const dropped = list.some((e) => e.dropFlag);
  return (
    <Card className="team-relay__webhooks" aria-label="Webhooks">
      <h3 className="team-relay__subhead">Webhooks</h3>
      {dropped ? <Banner tone="warn" icon={<Icon name="alert" size={15} />}>Webhooks were dropped because nobody picked them up.</Banner> : null}
      {list.length === 0 ? <p className="muted">No webhook addresses yet.</p> : (
        <ul className="team-relay__endpoints">
          {list.map((e) => (
            <li key={e.id} className="team-relay__endpoint" data-disabled={e.disabledAt !== null}>
              <div className="team-relay__endpoint-main">
                <strong>{e.name}</strong> <span className="muted">{e.source} · {HANDSHAKE_WORDS[e.handshake]}</span>
                <div className="mono team-relay__url">{e.url}</div>
                <div className="muted">
                  {e.lastReceivedAt ? `Last received ${dateTime(e.lastReceivedAt)}` : 'Nothing received yet'}
                  {` · ${e.pending} waiting · ${e.parked} couldn't be processed · ${e.droppedCount} dropped`}
                </div>
              </div>
              <Button onClick={() => { void navigator.clipboard.writeText(e.url); showFlash('Webhook address copied.'); }}>Copy</Button>
              {e.disabledAt === null ? <Button variant="ghost" onClick={() => disable.mutate(e.id)}>Turn off</Button> : <span className="muted">Off</span>}
            </li>
          ))}
        </ul>
      )}
      {(parked.data ?? []).length > 0 ? (
        <ul className="team-relay__endpoints" aria-label="Webhooks that couldn't be processed">
          {(parked.data ?? []).map((p) => (
            <li key={p.id} className="team-relay__endpoint">
              <span className="team-relay__endpoint-main">
                Couldn't be processed: {list.find((e) => e.id === p.endpointId)?.name ?? 'a webhook'}, received {dateTime(p.receivedAt)}
              </span>
              <Button onClick={() => retry.mutate(p.id)}>Retry</Button>
              <Button variant="ghost" onClick={() => drop.mutate(p.id)}>Drop</Button>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="stack" onSubmit={(ev) => { ev.preventDefault(); create.mutate(undefined, { onSuccess: () => { setName(''); setSource(''); setSecret(''); } }); }}>
        <div className="row row--wrap">
          <Field label="Webhook name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sentry errors" /></Field>
          <Field label="Source"><input className="input" value={source} onChange={(e) => setSource(e.target.value)} placeholder="sentry" /></Field>
          <Field label="Handshake">
            <select className="input" value={handshake} onChange={(e) => setHandshake(e.target.value as EndpointView['handshake'])}>
              {(['none', 'meta_hub', 'echo_challenge'] as const).map((h) => <option key={h} value={h}>{HANDSHAKE_WORDS[h]}</option>)}
            </select>
          </Field>
          {handshake === 'meta_hub' ? <Field label="Verify token"><input className="input" value={secret} onChange={(e) => setSecret(e.target.value)} /></Field> : null}
        </div>
        {create.isError ? <ErrorState error={create.error} /> : null}
        <div><Button type="submit" disabled={!name.trim() || !source.trim() || create.isPending}>Add a webhook address</Button></div>
      </form>
    </Card>
  );
}
