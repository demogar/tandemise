// One team's coordination, shared in process by several engines: what the
// relay holds (its `CoordinationStore` over one database, and its source
// leases), with each engine seeing it as its own member and device, connected.
// It stands in for the relay's HTTP round trip so two containers on separate
// databases can share claims and leases in one check (intake spec §3,
// acceptance "Claims"; Ruling 22).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const C = await import('@tandemise/coordination');
const Database = (await import('better-sqlite3')).default;

/** The shared team: one store, one lease table, on `clock` (`{ now(): iso }`). */
export function sharedTeam(clock) {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'tdi-team-')), 'relay.db'));
  db.pragma('journal_mode = WAL');
  C.migrateCoordination(db);
  const now = () => new Date(clock.now());
  const store = new C.CoordinationStore(db, now);
  store.ensureTeam('Acme');
  const leases = typeof C.LeaseTable === 'function' ? new C.LeaseTable(now) : null;
  /** One member on one device, as their daemon's `COORDINATION` port. */
  const join_ = (displayName, deviceLabel) => {
    const member = store.createMember({ displayName, role: 'member' });
    const { device } = store.createDevice(member.id, deviceLabel);
    const me = { memberId: member.id, deviceId: device.id, role: 'member', displayName, deviceLabel };
    const listeners = new Set();
    const emit = (topic) => { for (const l of listeners) l(topic); };
    return {
      mode: 'relay',
      status: () => ({ kind: 'connected', host: 'relay.test', teamName: 'Acme' }),
      me: () => me,
      async claim(input) {
        const out = store.claim({ ...input, memberId: me.memberId, deviceId: me.deviceId });
        emit('claims');
        if (out.kind === 'claimed') return { kind: 'claimed', claim: out.claim };
        return C.heldBy(store, out.claim, out.self, { memberId: me.memberId, role: me.role });
      },
      async release(id, reason) { store.release(id, reason, { memberId: me.memberId, role: me.role }); emit('claims'); },
      async takeOver(id, localRef) { return { kind: 'claimed', claim: store.takeOver(id, { ...me, localRef }) }; },
      claims: (projectKey) => store.activeClaims(projectKey === undefined ? undefined : [projectKey]).map((c) => C.claimForViewer(c, me.memberId)),
      claimByLocalRef: (localRef) => store.claimByLocalRef(localRef),
      members: () => store.members(),
      presence: () => store.presence(),
      holderLastSeenAt: (memberId) => store.holderLastSeenAt(memberId),
      claimSync: () => ({ sync: 'confirmed', note: null, decided: null }),
      keepGoing: () => {},
      markLost: () => {},
      onChange: (l) => { listeners.add(l); return () => listeners.delete(l); },
      ...(leases === null ? {} : {
        lease: async (input) => C.leaseView(leases.take({
          projectKey: input.projectKey, scope: input.scope, key: input.key, ttlMs: input.ttlSeconds * 1000,
          holder: { memberId: me.memberId, memberName: displayName, deviceId: me.deviceId, deviceLabel },
        })),
      }),
      // The relay's mailbox, leased to this device (Ruling 24).
      mailbox: {
        pull: async (projectKey, max, leaseSeconds = 60) => store.pull(projectKey, me.deviceId, max, leaseSeconds),
        ack: async (ids) => store.ack(ids, me.deviceId),
      },
    };
  };
  return { store, leases, join: join_, close: () => db.close() };
}

/** A real event bus, so the coordination service hears mission status changes. */
export function eventBus() {
  const subs = new Set();
  return { publish: (r) => { for (const s of subs) s(r); }, subscribe: (l) => { subs.add(l); return () => subs.delete(l); } };
}
