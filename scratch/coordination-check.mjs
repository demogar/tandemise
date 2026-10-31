// The optional relay's shared pieces: the wire contract, the coordination
// schema and rules, the store, the mailbox and the local mode
// (docs/superpowers/specs/2026-10-30-relay-design.md).
//
//   npm run build && node scratch/coordination-check.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);

const R = await import('../packages/api-contract/dist/relay.js');

section('contract');
{
  check('RELAY_API_VERSION is 1', R.RELAY_API_VERSION === '1');
  check('the relay api header', R.RELAY_API_HEADER === 'x-tandemise-relay-api');
  check('a pull of 51 is refused', R.mailboxPullRequest.safeParse({ project: 'p', max: 51, leaseSeconds: 10 }).success === false);
  check('a pull of 50 passes', R.mailboxPullRequest.safeParse({ project: 'p', max: 50, leaseSeconds: 10 }).success === true);
  check('a watch frame parses', R.relayClientFrame.safeParse({ type: 'watch', projects: ['a'] }).success === true);
  check('a chat frame does not', R.relayClientFrame.safeParse({ type: 'chat' }).success === false);
  check('an invite for 31 days is refused', R.createInviteRequest.safeParse({ role: 'member', displayName: 'Bo', expiresInDays: 31 }).success === false);
}

const C = await import('../packages/coordination/dist/index.js');
const Database = (await import('better-sqlite3')).default;
const tmp = mkdtempSync(join(tmpdir(), 'tdm-coord-'));
let dbn = 0;
const openDb = () => {
  const db = new Database(join(tmp, `c${++dbn}.db`));
  db.pragma('journal_mode = WAL');
  return db;
};
const H = 3_600_000;

section('rules');
{
  check('github refs lowercase the repo', C.itemKey(C.githubItemRef('Acme/App', 7)) === 'acme/app#7', C.githubItemRef('Acme/App', 7));
  check('a youtrack key keeps its case', C.itemKey('youtrack:GAR-123') === 'GAR-123');
  check('normalising lowercases the tracker only', C.normalizeItemRef(' YouTrack:GAR-1 ') === 'youtrack:GAR-1');
  let threw = null;
  try { C.normalizeItemRef('nope'); } catch (e) { threw = e.message; }
  check('a ref with no tracker throws', threw === 'Not a tracker item: nope', threw);
  check('held by someone else', C.heldBySentence({ holderName: 'Ana', itemRef: 'youtrack:GAR-123', startedAt: '2026-10-30T10:42:00Z', self: false, deviceLabel: 'x', timeZone: 'UTC' }) === 'Ana is working on GAR-123 since 10:42.');
  check('held by you elsewhere', C.heldBySentence({ holderName: 'Ana', itemRef: 'youtrack:GAR-123', startedAt: '2026-10-30T10:42:00Z', self: true, deviceLabel: 'Work laptop' }) === "You're already working on this on Work laptop.");
  const now = new Date('2026-10-30T20:00:00');
  const ago = (ms) => new Date(now.getTime() - ms).toISOString();
  const base = { holderMemberId: 'ana', holderName: 'Ana', itemRef: 'youtrack:GAR-123', now, staleAfterMs: C.DEFAULT_STALE_AFTER_MS };
  const member = { memberId: 'bo', role: 'member' };
  const fresh = C.takeOverRefusal({ ...base, actor: member, holderLastSeenAt: ago(H) });
  check('a member may not take over a fresh claim', fresh === 'Only an admin can take over GAR-123 while Ana is around. Anyone can once Ana has been away for 24 hours.', fresh);
  check('a member may take over a stale one', C.takeOverRefusal({ ...base, actor: member, holderLastSeenAt: ago(25 * H) }) === null);
  check('an admin may take over a fresh one', C.takeOverRefusal({ ...base, actor: { memberId: 'cy', role: 'admin' }, holderLastSeenAt: ago(H) }) === null);
  check('nobody takes over their own', C.takeOverRefusal({ ...base, actor: { memberId: 'ana', role: 'admin' }, holderLastSeenAt: ago(H) }) === 'This is already yours.');
  check('never seen', C.lastSeenLabel(null, now) === 'never seen');
  check('minutes ago', C.lastSeenLabel(ago(5 * 60_000), now) === 'last seen 5 minutes ago', C.lastSeenLabel(ago(5 * 60_000), now));
  check('yesterday', C.lastSeenLabel(ago(30 * H), now) === 'last seen yesterday', C.lastSeenLabel(ago(30 * H), now));
  check('days ago', C.lastSeenLabel(ago(72 * H), now) === 'last seen 3 days ago', C.lastSeenLabel(ago(72 * H), now));
  check('the most present device wins', C.presenceOf([{ deviceId: 'a', memberId: 'm', status: 'away', lastSeenAt: '' }, { deviceId: 'b', memberId: 'm', status: 'online', lastSeenAt: '' }], 'm') === 'online');
  check('no device is offline', C.presenceOf([], 'm') === 'offline');
  const t1 = C.newDeviceToken();
  check('device token format', /^trd_[A-Za-z0-9_-]{43}$/.test(t1), t1);
  check('two tokens differ', t1 !== C.newDeviceToken());
  const code = C.newInviteCode();
  check('invite code format (128 bits)', /^TRI-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{6}$/.test(code), code);
  check('a pasted code is normalised', C.normalizeInviteCode(` ${code.toLowerCase()} `) === code);
  check('slug is 128-bit base64url', /^[A-Za-z0-9_-]{22}$/.test(C.newSlug()));
  check('hash compare', C.safeEqualHex(C.hashSecret('x'), C.hashSecret('x')) && !C.safeEqualHex(C.hashSecret('x'), C.hashSecret('y')));
  const db = openDb();
  const first = C.migrateCoordination(db);
  const second = C.migrateCoordination(db);
  check('migrations run once', first.from === 0 && first.to === 1 && second.from === 1 && second.to === 1, { first, second });
  check('the version is recorded', db.prepare(`SELECT value FROM coord_meta WHERE key='schema_version'`).get().value === '1');
}

const clockAt = (iso) => {
  let t = Date.parse(iso);
  const clock = () => new Date(t);
  clock.advance = (ms) => { t += ms; };
  return clock;
};
const reasonOf = (fn) => { try { fn(); return null; } catch (e) { return e.reason ?? e.message; } };

section('store');
{
  const db = openDb();
  C.migrateCoordination(db);
  const clock = clockAt('2026-10-30T10:00:00Z');
  const s = new C.CoordinationStore(db, clock);
  const team = s.ensureTeam('Team');
  check('ensureTeam is idempotent', s.ensureTeam('Other').id === team.id && s.team().name === 'Team');
  const adminInvite = s.createInvite({ role: 'admin', displayName: 'Ana', createdBy: null });
  const ana = s.redeemInvite({ code: adminInvite.code, displayName: 'Ana', deviceLabel: 'Ana laptop' });
  check('an admin invite redeems', ana.deviceToken.startsWith('trd_') && s.member(ana.memberId).role === 'admin');
  check('a second redeem is refused', reasonOf(() => s.redeemInvite({ code: adminInvite.code, displayName: 'X', deviceLabel: 'x' })) === 'invite_used');
  const late = s.createInvite({ role: 'member', displayName: 'Late', createdBy: ana.memberId });
  clock.advance(8 * 24 * H);
  check('an expired invite is refused', reasonOf(() => s.redeemInvite({ code: late.code, displayName: 'L', deviceLabel: 'l' })) === 'invite_expired');
  check('a garbage code is refused', reasonOf(() => s.redeemInvite({ code: 'TRI-NOPE', displayName: 'L', deviceLabel: 'l' })) === 'invite_invalid');
  const bo = s.redeemInvite({ code: s.createInvite({ role: 'member', displayName: 'Bo', createdBy: ana.memberId }).code, displayName: 'Bo', deviceLabel: 'Bo desktop' });
  const anaAuth = s.deviceByToken(ana.deviceToken);
  check('a token finds its device', anaAuth?.id === ana.deviceId && anaAuth.role === 'admin', anaAuth);
  check('a wrong token finds nothing', s.deviceByToken('trd_nope') === null);
  const seq0 = s.seq();
  const item = { projectKey: 'p', itemRef: 'github:Acme/App#7', itemTitle: 'Fix it', itemUrl: 'https://github.com/acme/app/issues/7' };
  const a1 = s.claim({ ...item, localRef: 'm_a', memberId: ana.memberId, deviceId: ana.deviceId });
  check('the first claim wins', a1.kind === 'claimed' && a1.claim.itemRef === 'github:acme/app#7', a1);
  const seq1 = s.seq();
  const b1 = s.claim({ ...item, localRef: 'm_b', memberId: bo.memberId, deviceId: bo.deviceId });
  check('the second is held by the first, by name', b1.kind === 'held' && b1.self === false && b1.claim.memberName === 'Ana', b1);
  const anaPhone = s.createDevice(ana.memberId, 'Ana phone');
  const a2 = s.claim({ ...item, localRef: 'm_a2', memberId: ana.memberId, deviceId: anaPhone.device.id });
  check('the same person on another computer is held, self', a2.kind === 'held' && a2.self === true, a2);
  check('only the holder or an admin releases', reasonOf(() => s.release(a1.claim.id, 'released', { memberId: bo.memberId, role: 'member' })) === 'not_holder');
  const released = s.release(a1.claim.id, 'released', { memberId: ana.memberId, role: 'admin' });
  check('the holder releases', released.state === 'ended' && released.endedReason === 'released');
  const b2 = s.claim({ ...item, localRef: 'm_b', memberId: bo.memberId, deviceId: bo.deviceId });
  check('then a fresh claim succeeds', b2.kind === 'claimed', b2);
  s.touchDevice(bo.deviceId);
  check('a member may not take over a fresh claim', reasonOf(() => s.takeOver(b2.claim.id, { memberId: ana.memberId, deviceId: ana.deviceId, role: 'member', localRef: 'x' })) === 'take_over_refused');
  const taken = s.takeOver(b2.claim.id, { memberId: ana.memberId, deviceId: ana.deviceId, role: 'admin', localRef: 'm_a3' });
  const old = s.claimById(b2.claim.id);
  check('an admin takes over: old ended taken_over, by the admin', old.state === 'ended' && old.endedReason === 'taken_over' && old.endedBy === ana.memberId, old);
  check('exactly one active claim', s.activeClaims(['p']).length === 1 && s.activeClaims(['p'])[0].id === taken.id);
  clock.advance(25 * H);
  const back = s.takeOver(taken.id, { memberId: bo.memberId, deviceId: bo.deviceId, role: 'member', localRef: 'm_b2' });
  check('a member takes over a stale claim', back.memberId === bo.memberId);
  check('history lists the item\'s claims', s.claimHistory('p', 'github:acme/app#7').length === 4);
  check('claimByLocalRef', s.claimByLocalRef('m_b2')?.id === back.id);
  const seqP = s.seq();
  s.setPresence(ana.deviceId, 'online');
  check('presence is per device, member online', s.members().find((m) => m.id === ana.memberId).presence === 'online');
  const seqM = s.seq();
  const ended = s.removeMember(bo.memberId, ana.memberId);
  check('removing a member ends their claims as removed', ended.length === 1 && ended[0].endedReason === 'removed', ended);
  check('and revokes their devices', s.devices(bo.memberId).every((d) => d.revokedAt !== null) && s.deviceByToken(bo.deviceToken)?.revokedAt);
  check('seq strictly increases across claim, presence and member writes', seq0 < seq1 && seq1 < seqP && seqP < seqM && seqM < s.seq(), [seq0, seq1, seqP, seqM, s.seq()]);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
