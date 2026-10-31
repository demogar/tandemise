import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CoordMemberView } from '@tandemise/api-contract/relay';
import { Drawer } from '../../components/Modal.js';
import { ErrorState, Field, SectionHead } from '../../components/primitives.js';
import { useDaemon } from '../../lib/connection.js';
import { useCoordinationClaims, useCoordinationStatus, useDaemonMutation } from '../../lib/queries.js';
import { dateTime, relativeTime } from '../../lib/format.js';
import { showFlash } from '../../lib/notices.js';
import '../settings/TeamRelay.css';
import { Button, Card } from '@tandemise/design/react';

const PRESENCE_WORDS: Readonly<Record<CoordMemberView['presence'], string>> = { online: 'Online', away: 'Away', offline: 'Offline' };

/**
 * The Team screen's "Team relay" block (relay spec, §What the desktop shows):
 * the relay's members with their presence and what they hold, and for admins
 * their computers and the invite flow. Local agents and roles are unchanged.
 */
export function RelayTeam(): JSX.Element | null {
  const status = useCoordinationStatus().data;
  const daemon = useDaemon();
  const connected = status !== undefined && (status.kind === 'connected' || status.kind === 'offline');
  const roster = useQuery({ queryKey: ['coordination', 'members'], queryFn: () => daemon.relayMembers(), enabled: connected, refetchInterval: 10_000 });
  const claims = useCoordinationClaims();
  const [inviting, setInviting] = useState(false);
  const revoke = useDaemonMutation((d, id: string) => d.revokeDevice(id), ['coordination']);
  const remove = useDaemonMutation((d, id: string) => d.removeRelayMember(id), ['coordination']);
  if (!connected) return null;
  const admin = status.role === 'admin';
  const members = (roster.data?.members ?? []).filter((m) => m.status === 'active');
  const devices = roster.data?.devices ?? [];
  const rows = claims.data ?? [];
  return (
    <section className="section" aria-label="Team relay members" style={{ marginTop: 'var(--s6)' }}>
      <SectionHead
        title="Team relay"
        meta={status.teamName || undefined}
        action={admin ? <Button variant="primary" onClick={() => setInviting(true)}>Invite someone</Button> : undefined}
      />
      {roster.isError ? <ErrorState error={roster.error} onRetry={() => void roster.refetch()} /> : null}
      {revoke.isError ? <ErrorState error={revoke.error} /> : null}
      {remove.isError ? <ErrorState error={remove.error} /> : null}
      <Card flush>
        {members.map((m) => {
          const holding = rows.filter((r) => (r.mine ? m.id === status.memberId : r.memberName === m.displayName)).map((r) => r.itemKey);
          return (
            <div key={m.id} className="relay-team__member">
              <div className="relay-team__row" data-member={m.displayName}>
                <span className="team-relay__dot" data-presence={m.presence} title={PRESENCE_WORDS[m.presence]} aria-label={PRESENCE_WORDS[m.presence]} />
                <span className="relay-team__name">{m.displayName}</span>
                {m.role === 'admin' ? <span className="chip chip--muted">admin</span> : null}
                <span className="relay-team__claims">{holding.length ? `Working on ${holding.join(', ')}` : m.presence === 'offline' && m.lastSeenAt ? `Last seen ${relativeTime(m.lastSeenAt)}` : ''}</span>
                {admin && m.id !== status.memberId ? (
                  <Button variant="ghost" onClick={() => remove.mutate(m.id)}>Remove</Button>
                ) : null}
              </div>
              {admin ? devices.filter((d) => d.memberId === m.id).map((d) => (
                <div key={d.id} className="relay-team__row relay-team__device">
                  <span className="muted" style={{ flex: 1 }}>
                    {d.label} · {d.revokedAt ? 'revoked' : d.lastSeenAt ? `last seen ${relativeTime(d.lastSeenAt)}` : 'never seen'}
                  </span>
                  {d.revokedAt === null ? <Button variant="ghost" onClick={() => revoke.mutate(d.id)}>Revoke</Button> : null}
                </div>
              )) : null}
            </div>
          );
        })}
      </Card>
      {inviting ? <InviteDrawer onClose={() => setInviting(false)} /> : null}
    </section>
  );
}

function InviteDrawer({ onClose }: { onClose: () => void }): JSX.Element {
  const [name, setName] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const invite = useDaemonMutation((d) => d.createRelayInvite({ role, displayName: name.trim() || 'Teammate' }), ['coordination']);
  const made = invite.data;
  return (
    <Drawer title="Invite someone" subtitle="They paste the code into Settings → Team relay → Connect." onClose={onClose}>
      {made ? (
        <div className="stack" aria-label="Invite code">
          <div className="relay-team__code" data-invite-code>{made.code}</div>
          <p className="muted" style={{ margin: 0 }}>This code works once and expires on {dateTime(made.expiresAt)}. It is shown only now.</p>
          <div className="row">
            <Button variant="primary" onClick={() => { void navigator.clipboard.writeText(made.code); showFlash('Invite code copied.'); }}>Copy</Button>
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); invite.mutate(undefined); }}>
          <Field label="Their name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} data-autofocus /></Field>
          <Field label="Role" hint="Admins invite people, remove them and manage webhooks.">
            <select className="input" value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          {invite.isError ? <ErrorState error={invite.error} /> : null}
          <div><Button type="submit" variant="primary" disabled={invite.isPending}>Make an invite code</Button></div>
        </form>
      )}
    </Drawer>
  );
}
