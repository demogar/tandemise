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

// Intake spec §3 (Ruling 22): one daemon of the team runs a source, under a
// short lease that lapses when its holder stops renewing.
section('source leases');
{
  const lease = (token, ttlSeconds = 120) => call('POST', '/relay/v1/leases', { token, body: { projectKey: 'p', scope: 'source', key: 'sentry-web', ttlSeconds } });
  const la = await lease(A);
  check('Ana takes the lease on sentry-web', la.status === 200 && la.body.granted === true && typeof la.body.expiresAt === 'string', la.body);
  const lb = await lease(B);
  check('…Bruno is refused while it is live, and told whose it is', lb.status === 200 && lb.body.granted === false && lb.body.holderName === 'Ana' && lb.body.deviceLabel === 'Ana laptop', lb.body);
  check('…Ana renews it', (await lease(A)).body.granted === true);
  await call('POST', '/relay/v1/test/advance-clock', { token: A, body: { ms: 121_000 } });
  const lb2 = await lease(B);
  check('after 2 minutes without a renewal it lapses, and Bruno takes it', lb2.body.granted === true, lb2.body);
  check('…and now Ana is refused', (await lease(A)).body.granted === false);
  const bad = await call('POST', '/relay/v1/leases', { token: A, body: { projectKey: 'p', scope: 'item', key: 'x', ttlSeconds: 120 } });
  check('only the source scope is leased', bad.status === 400, bad.body);
  // A device holds at most 200 live leases (Ruling 27): Bruno holds sentry-web, so 199 more fit.
  const many = (i) => call('POST', '/relay/v1/leases', { token: B, body: { projectKey: 'p', scope: 'source', key: `s-${i}`, ttlSeconds: 120 } });
  let granted = 0;
  for (let i = 0; i < 199; i++) if ((await many(i)).body.granted === true) granted++;
  const over = await many(199);
  check('a device past 200 live leases is refused with 429', granted === 199 && over.status === 429 && over.body.error?.code === 'RATE_LIMITED', { granted, status: over.status, body: over.body });
  check('…while renewing one it holds still works', (await many(0)).body.granted === true);
}

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

section('5. a webhook is stored, leased to one device, acked by the lease holder');
const inviteC = await call('POST', '/relay/v1/invites', { token: A, body: { role: 'member', displayName: 'Cy' } });
const C = (await call('POST', '/relay/v1/invites/redeem', { body: { code: inviteC.body.code, displayName: 'Cy', deviceLabel: 'Cy laptop' } })).body.deviceToken;
const ep = await call('POST', '/relay/v1/endpoints', { token: A, body: { projectKey: 'p', name: 'Sentry', source: 'sentry', handshake: 'none' } });
check('the admin creates an endpoint with a public URL', ep.status === 200 && ep.body.url === `http://127.0.0.1/hooks/${ep.body.slug}`, ep.body);
const notAdmin = await call('POST', '/relay/v1/endpoints', { token: C, body: { projectKey: 'p', name: 'x', source: 'x', handshake: 'none' } });
check('a member may not create one: 403 admin_only', notAdmin.status === 403 && reason(notAdmin) === 'admin_only', notAdmin.body);
const hint = await openStream(C);
hint.ws.send(JSON.stringify({ type: 'watch', projects: ['p'] }));
await sleep(50);
const posted = await fetch(`${base}/hooks/${ep.body.slug}?a=1`, { method: 'POST', headers: { 'content-type': 'application/json', 'sentry-hook-signature': 's', cookie: 'secret', authorization: 'Bearer nope' }, body: '{"x":1}' });
check('POST /hooks/<slug> answers 202, empty', posted.status === 202 && (await posted.text()) === '', posted.status);
check('…and connected daemons get a mailbox hint, never the payload', Boolean(await until(() => hint.frames.find((f) => f.type === 'mailbox' && f.project === 'p' && f.pending === 1 && !('body' in f)))), hint.frames.filter((f) => f.type === 'mailbox'));
hint.ws.close();
const pullA = await call('POST', '/relay/v1/mailbox/pull', { token: A, body: { project: 'p', max: 10, leaseSeconds: 30 } });
const msg = pullA.body?.[0];
check('device A leases it: the body as sent, the signature header kept', pullA.status === 200 && pullA.body.length === 1 && Buffer.from(msg.bodyBase64, 'base64').toString() === '{"x":1}' && msg.headers['sentry-hook-signature'] === 's' && msg.query === 'a=1', pullA.body);
check('…cookie and authorization were dropped', msg && !('cookie' in msg.headers) && !('authorization' in msg.headers), msg?.headers);
const pullC = await call('POST', '/relay/v1/mailbox/pull', { token: C, body: { project: 'p', max: 10, leaseSeconds: 30 } });
check('device C gets nothing while A holds the lease', pullC.status === 200 && pullC.body.length === 0, pullC.body);
await call('POST', '/relay/v1/test/advance-clock', { token: A, body: { ms: 31_000 } });
const pullC2 = await call('POST', '/relay/v1/mailbox/pull', { token: C, body: { project: 'p', max: 10, leaseSeconds: 30 } });
check('after the lease runs out, C gets it', pullC2.body.length === 1 && pullC2.body[0].id === msg.id && pullC2.body[0].attempts === 2, pullC2.body);
const ackA = await call('POST', '/relay/v1/mailbox/ack', { token: A, body: { ids: [msg.id] } });
check('A\'s ack is ignored (its lease is gone)', ackA.status === 200 && ackA.body.ignored[0] === msg.id && ackA.body.acked.length === 0, ackA.body);
const ackC = await call('POST', '/relay/v1/mailbox/ack', { token: C, body: { ids: [msg.id] } });
check('C\'s ack lands', ackC.status === 200 && ackC.body.acked[0] === msg.id, ackC.body);

section('6. the Meta hub handshake');
const hub = await call('POST', '/relay/v1/endpoints', { token: A, body: { projectKey: 'p', name: 'WhatsApp', source: 'whatsapp', handshake: 'meta_hub', handshakeSecret: 'vt' } });
const okHub = await fetch(`${base}/hooks/${hub.body.slug}?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`);
check('the right verify token: 200 and the challenge', okHub.status === 200 && (await okHub.text()) === '42');
const badHub = await fetch(`${base}/hooks/${hub.body.slug}?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42`);
check('a wrong one: 403', badHub.status === 403);
const echo = await call('POST', '/relay/v1/endpoints', { token: A, body: { projectKey: 'p', name: 'Slack', source: 'slack', handshake: 'echo_challenge' } });
const echoed = await fetch(`${base}/hooks/${echo.body.slug}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"url_verification","challenge":"abc"}' });
check('an echo challenge is answered and not stored', echoed.status === 200 && (await echoed.text()) === 'abc' && (await call('POST', '/relay/v1/mailbox/pull', { token: A, body: { project: 'p', max: 10, leaseSeconds: 5 } })).body.length === 0);
const getPlain = await fetch(`${base}/hooks/${ep.body.slug}`);
check('a GET that is no handshake: 405', getPlain.status === 405, getPlain.status);

section('7. limits');
const big = await fetch(`${base}/hooks/${ep.body.slug}`, { method: 'POST', body: Buffer.alloc(1_048_577, 97) });
check('1 MiB + 1 byte: 413', big.status === 413, big.status);
const burst = await Promise.all(Array.from({ length: 121 }, () => fetch(`${base}/hooks/${ep.body.slug}`, { method: 'POST', body: 'x' }).then((r) => r.status)));
check('121 rapid posts: some 429', burst.includes(429) && burst.filter((s) => s === 202).length <= 120, burst.filter((s) => s === 429).length);
const disabling = await call('POST', `/relay/v1/endpoints/${hub.body.id}/disable`, { token: A });
check('the admin disables the Meta endpoint', disabling.status === 204, disabling.status);
const unknown = await fetch(`${base}/hooks/AAAAAAAAAAAAAAAAAAAAAA`, { method: 'POST', body: 'x' });
const disabled = await fetch(`${base}/hooks/${hub.body.slug}`, { method: 'POST', body: 'x' });
const ub = await unknown.text();
const db = await disabled.text();
check('an unknown slug and a disabled slug answer the same 404, byte for byte', unknown.status === 404 && disabled.status === 404 && ub === db && unknown.headers.get('content-type') === disabled.headers.get('content-type'), { ub, db });

section('import');
const fresh = await startRelay(loadRelayConfig(env({ RELAY_DB: join(tmp, 'fresh.db') })));
const freshBase = `http://127.0.0.1:${fresh.port}`;
const fcall = (method, path, opts) => fetch(`${freshBase}${path}`, { method, headers: { 'x-tandemise-relay-api': '1', 'content-type': 'application/json', ...(opts?.token ? { authorization: `Bearer ${opts.token}` } : {}) }, ...(opts?.body ? { body: JSON.stringify(opts.body) } : {}) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const admin = (await fcall('POST', '/relay/v1/invites/redeem', { body: { code: fresh.bootstrapInvite, displayName: 'Dee', deviceLabel: 'Dee laptop' } })).body.deviceToken;
const lines = [
  JSON.stringify({ kind: 'meta', schemaVersion: 1, teamName: 'Solo' }),
  JSON.stringify({ kind: 'member', id: 'local', displayName: 'Dee', handles: {}, role: 'admin', status: 'active', createdAt: '2026-10-30T09:00:00.000Z' }),
  JSON.stringify({ kind: 'claim', id: 'c1', projectKey: 'p', itemRef: 'github:acme/app#7', itemTitle: 'Fix it', itemUrl: null, memberId: 'local', memberName: 'Dee', localRef: 'msn_1', startedAt: '2026-10-30T09:30:00.000Z' }),
  JSON.stringify({ kind: 'endpoint', id: 'e1', projectKey: 'p', slug: 'importedslug0000000000', name: 'Sentry', source: 'sentry', handshake: 'none', handshakeSecret: null, createdAt: '2026-10-30T09:00:00.000Z', disabledAt: null }),
  JSON.stringify({ kind: 'message', id: '1', endpointId: 'e1', receivedAt: '2026-10-30T09:40:00.000Z', method: 'POST', query: '', headers: {}, contentType: 'application/json', bodyBase64: Buffer.from('{"y":2}').toString('base64'), attempts: 0 }),
];
const imported = await fcall('POST', '/relay/v1/import', { token: admin, body: { lines } });
check('import into a fresh relay: 200, one claim, one endpoint, one message', imported.status === 200 && imported.body.claims.length === 1 && imported.body.claims[0].result === 'claimed' && imported.body.endpoints === 1 && imported.body.messages === 1, imported.body);
const fsnap = await fcall('GET', '/relay/v1/snapshot', { token: admin });
check('the claim is in the snapshot, the importer\'s', fsnap.body.claims.length === 1 && fsnap.body.claims[0].memberName === 'Dee' && fsnap.body.claims[0].localRef === 'msn_1', fsnap.body.claims);
const twice = await fcall('POST', '/relay/v1/import', { token: admin, body: { lines } });
check('a second import is 409 relay_not_empty', twice.status === 409 && twice.body.error.details.reason === 'relay_not_empty', twice.body);
await fresh.close();

section('import: bigger than a JSON body, and malformed');
const bigRelay = await startRelay(loadRelayConfig(env({ RELAY_DB: join(tmp, 'big.db') })));
const bigBase = `http://127.0.0.1:${bigRelay.port}`;
const bcall = (method, path, opts) => fetch(`${bigBase}${path}`, { method, headers: { 'x-tandemise-relay-api': '1', 'content-type': 'application/json', ...(opts?.token ? { authorization: `Bearer ${opts.token}` } : {}) }, ...(opts?.raw ? { body: opts.raw } : opts?.body ? { body: JSON.stringify(opts.body) } : {}) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const bigAdmin = (await bcall('POST', '/relay/v1/invites/redeem', { body: { code: bigRelay.bootstrapInvite, displayName: 'Dee', deviceLabel: 'Dee laptop' } })).body.deviceToken;
const garbage = await bcall('POST', '/relay/v1/import', { token: bigAdmin, body: { lines: ['{"kind":"meta","schemaVersion":1,"teamName":"x"}', '{"kind":"claim","itemRef":42}'] } });
check('a malformed export line is a 400, not a 500', garbage.status === 400 && garbage.body?.error?.details?.reason === 'import_invalid', garbage);
const bigLines = [
  JSON.stringify({ kind: 'meta', schemaVersion: 1, teamName: 'Solo' }),
  JSON.stringify({ kind: 'endpoint', id: 'e1', projectKey: 'p', slug: 'bigslug000000000000000', name: 'Sentry', source: 'sentry', handshake: 'none', handshakeSecret: null, createdAt: '2026-10-30T09:00:00.000Z', disabledAt: null }),
  ...[1, 2].map((n) => JSON.stringify({ kind: 'message', id: String(n), endpointId: 'e1', receivedAt: '2026-10-30T09:40:00.000Z', method: 'POST', query: '', headers: {}, contentType: 'text/plain', bodyBase64: Buffer.alloc(900_000, 97).toString('base64'), attempts: 0 })),
];
const bigImport = await bcall('POST', '/relay/v1/import', { token: bigAdmin, raw: JSON.stringify({ lines: bigLines }) });
check('an import over 1 MiB (two 900 KB webhooks) goes through', bigImport.status === 200 && bigImport.body?.messages === 2, { status: bigImport.status, body: bigImport.body });
await bigRelay.close();

section('cli');
const cli = (...args) => execFileSync(process.execPath, ['apps/relay/dist/cli.js', ...args], { env: { ...process.env, RELAY_DB: join(tmp, 'relay.db'), RELAY_LOG_LEVEL: 'error' } }).toString();
const cliCode = cli('invite', '--role', 'admin', '--name', 'Ops').trim();
check('`invite --role admin` prints one line, a code', CODE_RE.test(cliCode) && cliCode.split('\n').length === 1, cliCode);
const viaCli = await call('POST', '/relay/v1/invites/redeem', { body: { code: cliCode, displayName: 'Ops', deviceLabel: 'Ops box' } });
check('…which redeems on the running relay, as an admin', viaCli.status === 200 && (await call('GET', '/relay/v1/snapshot', { token: viaCli.body.deviceToken })).body.you.role === 'admin', viaCli.body);
const out = join(tmp, 'backup.jsonl');
cli('export', '--out', out);
const first = JSON.parse(readFileSync(out, 'utf8').split('\n')[0]);
check('`export` writes JSON lines, meta first', first.kind === 'meta' && first.schemaVersion === 1 && first.teamName === 'Check team', first);
cli('revoke', viaCli.body.deviceId);
const revokedByCli = await call('GET', '/relay/v1/snapshot', { token: viaCli.body.deviceToken });
check('`revoke <id>` makes that device\'s next request 401', revokedByCli.status === 401 && reason(revokedByCli) === 'device_revoked', revokedByCli.body);
const restoreDb = join(tmp, 'restore.db');
writeFileSync(join(tmp, 'restore.jsonl'), readFileSync(out, 'utf8'));
const restored = execFileSync(process.execPath, ['apps/relay/dist/cli.js', 'import', join(tmp, 'restore.jsonl')], { env: { ...process.env, RELAY_DB: restoreDb, RELAY_LOG_LEVEL: 'error' } }).toString();
check('`import <file>` restores an export into an empty database', /claims/.test(restored), restored);

section('failed auth is rate-limited per IP (last: it locks this client out)');
// Earlier refusals in this run (a used invite, a token in a query) age out of the one-minute window first.
await call('POST', '/relay/v1/test/advance-clock', { token: A, body: { ms: 120_000 } });
const bad = [];
for (let i = 0; i < 11; i++) bad.push((await call('GET', '/relay/v1/snapshot', { token: `trd_bad${i}` })).status);
check('ten bad tokens are 401, the eleventh 429', bad.slice(0, 10).every((s) => s === 401) && bad[10] === 429, bad);
const spoofed = await call('GET', '/relay/v1/snapshot', { token: 'trd_bad', headers: { 'x-forwarded-for': '203.0.113.9' } });
check('a forged X-Forwarded-For does not escape the lock (proxy not trusted)', spoofed.status === 429, spoofed.status);

section('trusted proxy and a bounded limiter');
const H = await import('../apps/relay/dist/http.js');
const RL = await import('../apps/relay/dist/rate-limit.js');
const fakeReq = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, socket: { remoteAddress: '172.18.0.3' } };
check('without RELAY_TRUST_PROXY the socket address counts', H.clientIp(fakeReq, false) === '172.18.0.3');
check('with it, the first X-Forwarded-For hop', H.clientIp(fakeReq, true) === '203.0.113.9' && loadRelayConfig(env({ RELAY_TRUST_PROXY: '1' })).trustProxy === true && loadRelayConfig(env()).trustProxy === false);
let fakeNow = 0;
const limiter = new RL.FailedAuthLimiter(() => fakeNow);
for (let i = 0; i < 500; i++) limiter.fail(`198.51.100.${i}`);
for (let i = 0; i < 10; i++) limiter.fail('192.0.2.1');
check('the limiter tracks what failed', limiter.size >= 500 && limiter.locked('192.0.2.1'), limiter.size);
fakeNow += 11 * 60_000;
limiter.sweep();
check('…and forgets it once the windows and locks are over', limiter.size === 0 && !limiter.locked('192.0.2.1'), limiter.size);

await relay.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
