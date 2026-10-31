// The relay server itself, from its build (docs/superpowers/specs/2026-10-30-relay-design.md,
// §Acceptance, relay-check): invites, claims racing, the stream, take-over, revocation, the
// TLS rule, the webhook mailbox and its limits, import, and the admin CLI.
//
//   npm run build && node scratch/relay-check.mjs
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const { startRelay, loadRelayConfig } = await import('../apps/relay/dist/main.js');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(30); } return fn(); };
const CODE_RE = /^TRI-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{6}$/;

const tmp = mkdtempSync(join(tmpdir(), 'tdm-relay-check-'));
const env = (extra = {}) => ({
  RELAY_DB: join(tmp, 'relay.db'), RELAY_PUBLIC_URL: 'http://127.0.0.1', RELAY_HOST: '127.0.0.1', RELAY_PORT: '0',
  RELAY_TEST_CLOCK: '1', RELAY_LOG_LEVEL: 'error', RELAY_TEAM_NAME: 'Check team', ...extra,
});
const relay = await startRelay(loadRelayConfig(env()));
const base = `http://127.0.0.1:${relay.port}`;

const call = async (method, path, { token, body, version = '1', raw, headers = {} } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(version === null ? {} : { 'x-tandemise-relay-api': version }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, body: json, text, headers: res.headers };
};
const reason = (r) => r.body?.error?.details?.reason;
const openStream = (token) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/relay/v1/stream`, { headers: { authorization: `Bearer ${token}`, 'x-tandemise-relay-api': '1' } });
  const frames = [];
  let closeCode = null;
  ws.on('message', (m) => frames.push(JSON.parse(m.toString())));
  ws.on('close', (code) => { closeCode = code; });
  ws.on('open', () => resolve({ ws, frames, closeCode: () => closeCode }));
  ws.on('error', reject);
});

section('1. bootstrap invite, redeem once');
check('the bootstrap invite is a code', CODE_RE.test(relay.bootstrapInvite ?? ''), relay.bootstrapInvite);
const health = await call('GET', '/relay/v1/health', { version: null });
check('health needs no auth and says the api version', health.status === 200 && health.body.ok === true && health.body.apiVersion === '1', health.body);
const redeemA = await call('POST', '/relay/v1/invites/redeem', { body: { code: relay.bootstrapInvite, displayName: 'Ana', deviceLabel: 'Ana laptop' } });
check('redeeming gives a device token', redeemA.status === 200 && /^trd_/.test(redeemA.body.deviceToken), redeemA.body);
const A = redeemA.body.deviceToken;
const again = await call('POST', '/relay/v1/invites/redeem', { body: { code: relay.bootstrapInvite, displayName: 'X', deviceLabel: 'x' } });
check('a second redeem is refused, invite_used', again.status === 400 && reason(again) === 'invite_used', again.body);

section('2. two members race for one item');
const inviteB = await call('POST', '/relay/v1/invites', { token: A, body: { role: 'member', displayName: 'Bruno' } });
check('the admin creates a member invite', inviteB.status === 200 && CODE_RE.test(inviteB.body.code), inviteB.body);
const redeemB = await call('POST', '/relay/v1/invites/redeem', { body: { code: inviteB.body.code, displayName: 'Bruno', deviceLabel: 'Bruno desktop' } });
const B = redeemB.body.deviceToken;
const item = { projectKey: 'p', itemRef: 'github:acme/app#7', itemTitle: 'Fix it', itemUrl: null };
const [ra, rb] = await Promise.all([
  call('POST', '/relay/v1/claims', { token: A, body: { ...item, localRef: 'm_a' } }),
  call('POST', '/relay/v1/claims', { token: B, body: { ...item, localRef: 'm_b' } }),
]);
const statuses = [ra.status, rb.status].sort();
check('exactly one 201 and one 409', statuses[0] === 201 && statuses[1] === 409, statuses);
const won = ra.status === 201 ? ra : rb;
const lost = ra.status === 201 ? rb : ra;
check('the 409 is claim_held and names the winner', reason(lost) === 'claim_held' && lost.body.error.details.claim.memberName === won.body.memberName && lost.body.error.message.startsWith(`${won.body.memberName} is working on acme/app#7 since`), lost.body);
check('…and hides the winner\'s local ref', lost.body.error.details.claim.localRef === null);
const winnerToken = won === ra ? A : B;

section('3. the stream');
const snap0 = await call('GET', '/relay/v1/snapshot?projects=p', { token: A });
check('the snapshot carries the active claim', snap0.status === 200 && snap0.body.claims.length === 1 && snap0.body.you.role === 'admin', snap0.body);
const sA = await openStream(A);
await until(() => sA.frames.some((f) => f.type === 'hello'));
check('hello on connect, with seq', sA.frames[0]?.type === 'hello' && typeof sA.frames[0].seq === 'number' && sA.frames[0].apiVersion === '1', sA.frames[0]);
sA.ws.send(JSON.stringify({ type: 'watch', projects: ['p'] }));
await sleep(50);
await call('POST', `/relay/v1/claims/${won.body.id}/release`, { token: winnerToken, body: { reason: 'released' } });
const claimFrame = await until(() => sA.frames.find((f) => f.type === 'claim' && f.claim.id === won.body.id && f.claim.state === 'ended'));
check('a claim frame arrives after the release, seq > the snapshot\'s', claimFrame && claimFrame.seq > snap0.body.seq, claimFrame);
sA.ws.close();
const snap1 = await call('GET', '/relay/v1/snapshot?projects=p', { token: A });
check('a fresh snapshot is at least as new as the last frame, and consistent', snap1.body.seq >= claimFrame.seq && snap1.body.claims.length === 0, snap1.body);
const ping = await openStream(A);
ping.ws.send(JSON.stringify({ type: 'ping', t: 42 }));
check('ping gets pong', Boolean(await until(() => ping.frames.find((f) => f.type === 'pong' && f.t === 42))));
ping.ws.close();

section('4. take-over');
const bClaim = (await call('POST', '/relay/v1/claims', { token: B, body: { ...item, localRef: 'm_b' } })).body;
const anaClaim = await call('POST', '/relay/v1/claims', { token: A, body: { ...item, itemRef: 'github:acme/app#9', localRef: 'm_a9' } });
const refused = await call('POST', `/relay/v1/claims/${anaClaim.body.id}/take-over`, { token: B, body: { localRef: 'm_b9' } });
check('a member on a fresh claim: 403 take_over_refused, the pinned sentence', refused.status === 403 && reason(refused) === 'take_over_refused'
  && refused.body.error.message === 'Only an admin can take over acme/app#9 while Ana is around. Anyone can once Ana has been away for 24 hours.', refused.body);
const adminTake = await call('POST', `/relay/v1/claims/${bClaim.id}/take-over`, { token: A, body: { localRef: 'm_a7' } });
const history = await call('GET', '/relay/v1/claims?project=p&item=github:acme/app%237', { token: A });
check('an admin takes over: 200, the old claim ended taken_over', adminTake.status === 200 && history.body.some((c) => c.id === bClaim.id && c.state === 'ended' && c.endedReason === 'taken_over'), { adminTake: adminTake.body, history: history.body });
const adv = await call('POST', '/relay/v1/test/advance-clock', { token: A, body: { ms: 25 * 3_600_000 } });
check('the test clock moves 25 h', adv.status === 200, adv.body);
const memberTake = await call('POST', `/relay/v1/claims/${anaClaim.body.id}/take-over`, { token: B, body: { localRef: 'm_b9' } });
check('a member takes over once the holder has been away 24 h', memberTake.status === 200 && memberTake.body.memberName === 'Bruno', memberTake.body);
const heldDetails = await call('POST', '/relay/v1/claims', { token: A, body: { ...item, itemRef: 'github:acme/app#9', localRef: 'x' } });
check('a 409 says whether the caller may take over', heldDetails.status === 409 && heldDetails.body.error.details.takeOver === true, heldDetails.body.error?.details);

section('8. revoking a device closes its socket');
const sB = await openStream(B);
await until(() => sB.frames.some((f) => f.type === 'hello'));
const snapB = await call('GET', '/relay/v1/snapshot', { token: B });
const bDevice = snapB.body.you.deviceId;
check('a member\'s snapshot hides endpoints and shows only their devices', snapB.body.endpoints.length === 0 && snapB.body.devices.every((d) => d.memberId === snapB.body.you.memberId), snapB.body.devices);
const revoke = await call('DELETE', `/relay/v1/devices/${bDevice}`, { token: A });
check('the admin revokes Bruno\'s device', revoke.status === 204 || revoke.status === 200, revoke.status);
const closed = await until(() => sB.closeCode() === 4401, 1000);
check('his open socket closes with 4401 within 1 s', closed, sB.closeCode());
const afterRevoke = await call('GET', '/relay/v1/snapshot', { token: B });
check('and his next request is 401 device_revoked', afterRevoke.status === 401 && reason(afterRevoke) === 'device_revoked', afterRevoke.body);
const memberInvite = await call('POST', '/relay/v1/invites', { token: B, body: { role: 'member', displayName: 'C' } });
check('a revoked member cannot create invites either', memberInvite.status === 401, memberInvite.status);

section('9. TLS rule');
let refusedStart = null;
try { loadRelayConfig(env({ RELAY_HOST: '0.0.0.0', RELAY_PUBLIC_URL: 'http://relay.lan', RELAY_DB: join(tmp, 'other.db') })); } catch (e) { refusedStart = e.message; }
check('a non-loopback bind with an http:// public URL refuses to start', refusedStart === 'RELAY_PUBLIC_URL must be https:// unless the relay only listens on loopback. Set RELAY_INSECURE_HTTP=1 for a LAN-only setup.', refusedStart);
const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(' ')); };
const lan = await startRelay(loadRelayConfig(env({ RELAY_HOST: '0.0.0.0', RELAY_PUBLIC_URL: 'http://relay.lan', RELAY_INSECURE_HTTP: '1', RELAY_DB: join(tmp, 'lan.db') })));
console.warn = origWarn;
check('with RELAY_INSECURE_HTTP=1 it starts and warns', lan.port > 0 && warnings.some((w) => /unencrypted|insecure/i.test(w)), warnings);
await lan.close();

section('extras');
const noVersion = await call('GET', '/relay/v1/snapshot', { token: A, version: null });
check('no version header: 412 version_mismatch', noVersion.status === 412 && reason(noVersion) === 'version_mismatch' && noVersion.body.error.message === "This daemon speaks relay API none; this relay speaks 1. Update Tandemise or the relay so they match.", noVersion.body);
const wrongVersion = await call('GET', '/relay/v1/snapshot', { token: A, version: '7' });
check('a wrong version: 412, in plain words', wrongVersion.status === 412 && wrongVersion.body.error.message.startsWith('This daemon speaks relay API 7; this relay speaks 1.'), wrongVersion.body);
check('no CORS headers, anywhere', [health, snap0, lost, noVersion].every((r) => r.headers.get('access-control-allow-origin') === null));
const tokenInQuery = await new Promise((resolve) => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/relay/v1/stream?token=${A}`, { headers: { 'x-tandemise-relay-api': '1' } });
  ws.on('open', () => { ws.close(); resolve('open'); });
  ws.on('error', () => resolve('refused'));
  ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
});
check('a token in the query is not accepted on the stream', tokenInQuery !== 'open', tokenInQuery);

// ---- (Task 9 adds the mailbox, Task 10 the CLI, above this line)

section('failed auth is rate-limited per IP (last: it locks this client out)');
// Earlier refusals in this run (a used invite, a token in a query) age out of the one-minute window first.
await call('POST', '/relay/v1/test/advance-clock', { token: A, body: { ms: 120_000 } });
const bad = [];
for (let i = 0; i < 11; i++) bad.push((await call('GET', '/relay/v1/snapshot', { token: `trd_bad${i}` })).status);
check('ten bad tokens are 401, the eleventh 429', bad.slice(0, 10).every((s) => s === 401) && bad[10] === 429, bad);

await relay.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
