// The relay through real daemons: solo by default, then one relay and two
// daemons (docs/superpowers/specs/2026-10-30-relay-design.md, §Acceptance,
// coordination-daemon-check).
//
//   npm run build && node scratch/coordination-daemon-check.mjs
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

process.env.TANDEMISE_LOG_LEVEL = process.env.TANDEMISE_LOG_LEVEL ?? 'error';
process.env.TANDEMISE_OFFLINE = '1';

const app = await import('@tandemise/application');
const D = await import('@tandemise/domain');
const { ids, systemClock } = await import('@tandemise/shared');
const { startDaemon } = await import('../apps/daemon/dist/main.js');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000, every = 50) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return fn();
};

/** One daemon in its own home, with a workspace, a repository and helpers to make issue-linked missions. */
export async function daemonFor(name, displayName) {
  const home = mkdtempSync(join(tmpdir(), `tcd-${name}-`));
  const d = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 300 });
  const token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
  const api = async (method, path, body, opts = {}) => {
    const res = await fetch(`${d.url}${path}`, {
      method,
      headers: {
        ...(opts.noAuth ? {} : { authorization: `Bearer ${token}` }),
        ...(body !== undefined ? { 'content-type': opts.contentType ?? 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  const r = (t) => d.container.resolve(t);
  // The local person's name, as `git config user.name` would give it.
  const people = r(app.PERSON_REPOSITORY);
  const me = r(app.IDENTITY).localPerson();
  people.update(me.id, { displayName });
  const ws = (await api('POST', '/v1/workspaces', { name: `${name} space` })).body.workspace.id;
  const checkout = join(home, 'checkout');
  mkdirSync(checkout, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', checkout]);
  execFileSync('git', ['-C', checkout, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  // Both installs check out the same GitHub repository, so their projects match (the remote names it).
  const repository = r(app.REPO_REPOSITORY).create({ id: `rep_${name}`, workspaceId: ws, name: 'app', path: checkout, defaultBranch: 'main', remoteUrl: 'https://github.com/acme/app.git', checks: D.NO_CHECKS });
  const links = new Map();
  const linkFor = (number) => {
    if (!links.has(number)) {
      links.set(number, r(app.ISSUE_REPOSITORY).createLink({
        workspaceId: ws, repositoryId: repository.id, githubRepo: 'acme/app', number, url: `https://github.com/acme/app/issues/${number}`,
        title: `Issue ${number}`, body: '', author: 'sam', upstreamUpdatedAt: null, state: 'open', criteriaCount: 0,
      }));
    }
    return links.get(number);
  };
  /** A mission on issue #n with one person step, waiting to start. */
  const mission = async (number) => {
    const created = (await api('POST', '/v1/missions', { workspaceId: ws, goal: `Work on #${number}`, title: `#${number}` })).body;
    const id = created.mission?.id ?? created.id;
    const missions = r(app.MISSION_REPOSITORY);
    const now = systemClock.now();
    r(app.TASK_REPOSITORY).add({
      id: ids.task(), missionId: id, key: 'work', title: 'work', objective: 'Do work', roleId: 'design',
      dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: [],
      executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
      approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'fail' },
      completionGate: null, status: 'READY', statusReason: null, attempts: 0, remediatesTaskId: null, repositoryId: null,
      executor: 'human', waitPolicy: null, orderHint: 0, staffingOverride: null,
      createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
    });
    missions.update(id, { status: 'AWAITING_PLAN_APPROVAL', issueLinkId: linkFor(number).id });
    return id;
  };
  const status = (id) => r(app.MISSION_REPOSITORY).get(id).status;
  /** Finishes the person step, which completes the mission. */
  const complete = async (id) => {
    const task = r(app.TASK_REPOSITORY).listByMission(id)[0];
    await until(() => r(app.TASK_REPOSITORY).get(task.id).status === 'AWAITING_HUMAN');
    const done = await api('POST', `/v1/tasks/${task.id}/complete`, { result: 'done' });
    await until(() => status(id) === 'COMPLETE');
    return done;
  };
  const stream = () => new Promise((resolve, reject) => {
    const ws2 = new WebSocket(`${d.url.replace('http', 'ws')}/v1/stream?token=${token}`);
    const frames = [];
    ws2.on('message', (m) => frames.push(JSON.parse(m.toString())));
    ws2.on('open', () => resolve({ frames, close: () => ws2.close() }));
    ws2.on('error', reject);
  });
  return { home, url: d.url, stop: d.stop, api, ws, mission, status, complete, stream, token, container: d.container };
}

const onlyRelay = process.argv.includes('--relay-only');

if (!onlyRelay) {
  section('solo');
  const a = await daemonFor('solo', 'Dee');
  const st = await a.api('GET', '/v1/coordination/status');
  check('status is local', st.status === 200 && st.body.kind === 'local', st);
  const live = await a.stream();
  const m1 = await a.mission(7);
  const started = await a.api('POST', `/v1/missions/${m1}/start`);
  check('an issue-linked mission starts', started.status === 200 && a.status(m1) === 'EXECUTING', started);
  const rows = await a.api('GET', `/v1/coordination/claims?workspaceId=${a.ws}`);
  check('one claim row, yours, for the issue', rows.body?.length === 1 && rows.body[0].mine === true && rows.body[0].itemKey === 'acme/app#7', rows.body);
  const sawInvalidate = await until(() => live.frames.some((f) => f.type === 'invalidate' && f.topic === 'coordination'), 2000);
  check('the stream says coordination changed within 2 s', sawInvalidate);
  live.close();
  const m2 = await a.mission(7);
  const refused = await a.api('POST', `/v1/missions/${m2}/start`);
  check('a second mission on the same issue is a 409, claim_held', refused.status === 409 && refused.body?.error?.details?.reason === 'claim_held', refused.body);
  check('in plain words', /^You're already working on this on /.test(refused.body?.error?.message ?? ''), refused.body?.error?.message);

  const ep = await a.api('POST', '/v1/coordination/endpoints', { workspaceId: a.ws, name: 'Sentry', source: 'sentry', handshake: 'none' });
  check('an endpoint is created with a local URL', ep.status === 200 && ep.body.url === `${a.url}/v1/hooks/${ep.body.slug}`, ep.body);
  const hook = await a.api('POST', `/v1/hooks/${ep.body.slug}`, '{"x":1}', { contentType: 'application/json' });
  check('a local hook is accepted with 202', hook.status === 202, hook);
  const pulled = await a.api('POST', '/v1/coordination/mailbox/pull', { workspaceId: a.ws, max: 10, leaseSeconds: 30 });
  check('a local runner pulls it', pulled.status === 200 && pulled.body.length === 1 && Buffer.from(pulled.body[0].bodyBase64, 'base64').toString() === '{"x":1}', pulled.body);
  const acked = await a.api('POST', '/v1/coordination/mailbox/ack', { ids: [pulled.body[0].id] });
  check('and acks it', acked.status === 200 && acked.body.acked[0] === pulled.body[0].id, acked.body);
  const noToken = await a.api('POST', `/v1/hooks/${ep.body.slug}`, '{"x":2}', { noAuth: true });
  check('without the daemon token the hook is refused', noToken.status === 403, noToken.status);
  const exp = await fetch(`${a.url}/v1/coordination/export`, { headers: { authorization: `Bearer ${a.token}` } });
  const first = JSON.parse((await exp.text()).split('\n')[0]);
  check('export is JSON lines with the meta line first', exp.headers.get('content-type')?.startsWith('application/x-ndjson') && first.kind === 'meta' && first.schemaVersion === 1, first);
  check('the daemon still listens on loopback only', a.url.startsWith('http://127.0.0.1:'));
  await a.complete(m1);
  const after = await until(async () => (await a.api('GET', `/v1/coordination/claims?workspaceId=${a.ws}`)).body.length === 0, 3000);
  check('completing the mission releases the claim', after);
  await a.stop();
}

{
  const { startRelay, loadRelayConfig } = await import('../apps/relay/dist/main.js');
  const relayDb = join(mkdtempSync(join(tmpdir(), 'tcd-relay-')), 'relay.db');
  const relayEnv = (port) => ({ RELAY_DB: relayDb, RELAY_HOST: '127.0.0.1', RELAY_PORT: String(port), RELAY_TEST_CLOCK: '1', RELAY_LOG_LEVEL: 'error', RELAY_TEAM_NAME: 'Acme' });
  let relay = await startRelay(loadRelayConfig(relayEnv(0)));
  const port = relay.port;
  const relayUrl = `http://127.0.0.1:${port}`;
  const relayCall = async (token, method, path) => {
    const res = await fetch(`${relayUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'x-tandemise-relay-api': '1' } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  section('relay: connect, import, and a held item across two daemons');
  const a = await daemonFor('a', 'Ana');
  const b = await daemonFor('b', 'Bruno');
  const projectKey = (await a.api('GET', `/v1/coordination/project-key?workspaceId=${a.ws}`)).body.projectKey;
  check('both installs name the project by its repository', projectKey === 'github.com/acme/app' && (await b.api('GET', `/v1/coordination/project-key?workspaceId=${b.ws}`)).body.projectKey === projectKey, projectKey);
  const a7 = await a.mission(7);
  await a.api('POST', `/v1/missions/${a7}/start`);
  check('A, solo, holds #7 locally', (await a.api('GET', `/v1/coordination/claims?workspaceId=${a.ws}`)).body?.[0]?.itemKey === 'acme/app#7');
  const connectA = await a.api('POST', '/v1/coordination/connect', { url: relayUrl, code: relay.bootstrapInvite, displayName: 'Ana', deviceLabel: 'Ana laptop', allowInsecure: false });
  check('A connects with the bootstrap invite', connectA.status === 200 && connectA.body.kind === 'connected' && connectA.body.role === 'admin', connectA.body);
  check('…and is offered to bring its local data', connectA.body.offerImport === true, connectA.body);
  const imported = await a.api('POST', '/v1/coordination/import');
  check('import goes through', imported.status === 200, imported.body);
  const settingsA = a.container.resolve(app.SETTINGS_STORE).read().coordination;
  const tokenA = await a.container.resolve(app.SECRET_STORE).resolve(settingsA.deviceTokenRef);
  const snapA = await relayCall(tokenA, 'GET', '/relay/v1/snapshot');
  check('the relay shows #7 held by Ana', snapA.body?.claims?.some((c) => c.itemRef === 'github:acme/app#7' && c.memberName === 'Ana' && c.localRef === a7), snapA.body?.claims);
  check('A\'s person carries a relay handle', /^127\.0\.0\.1:\d+\/cm_/.test(a.container.resolve(app.IDENTITY).localPerson().handles.relay ?? ''), a.container.resolve(app.IDENTITY).localPerson().handles);

  const invite = await a.api('POST', '/v1/coordination/invites', { role: 'member', displayName: 'Bruno' });
  check('A invites Bruno through its daemon', invite.status === 200 && /^TRI-/.test(invite.body.code), invite.body);
  const connectB = await b.api('POST', '/v1/coordination/connect', { url: relayUrl, code: invite.body.code, displayName: 'Bruno', deviceLabel: 'Bruno desktop', allowInsecure: false });
  check('B connects as a member', connectB.body?.kind === 'connected' && connectB.body.role === 'member', connectB.body);
  const b7 = await b.mission(7);
  const refusedB = await b.api('POST', `/v1/missions/${b7}/start`);
  check('B starting #7 is refused with Ana\'s name', refusedB.status === 409 && refusedB.body.error.message.startsWith('Ana is working on acme/app#7 since'), refusedB.body);
  check('…with no take-over for a member on a fresh claim', refusedB.body.error.details.takeOver === false, refusedB.body.error.details);
  const seenByB = await until(async () => (await b.api('GET', `/v1/coordination/claims?workspaceId=${b.ws}`)).body?.find((r) => r.itemKey === 'acme/app#7' && r.memberName === 'Ana'), 2000);
  check('B\'s Home lists Ana on #7', Boolean(seenByB), seenByB);

  section('offline: both claim #8 while the relay is down (Review Focus 2)');
  await relay.close();
  const bOffline = await until(async () => (await b.api('GET', '/v1/coordination/status')).body.kind === 'offline', 5000);
  check('B goes offline', bOffline);
  const b8 = await b.mission(8);
  const startB8 = await b.api('POST', `/v1/missions/${b8}/start`);
  check('B starts #8 anyway: the claim queues', startB8.status === 200 && b.status(b8) === 'EXECUTING', startB8.body);
  const b8Detail = await b.api('GET', `/v1/missions/${b8}`);
  check('…and its mission says pending', b8Detail.body.claim?.state === 'pending', b8Detail.body.claim);
  const a8 = await a.mission(8);
  const startA8 = await a.api('POST', `/v1/missions/${a8}/start`);
  check('A, offline too, starts #8 and queues', startA8.status === 200 && a.status(a8) === 'EXECUTING', startA8.body);
  relay = await startRelay(loadRelayConfig(relayEnv(port)));
  const settled = await until(async () => {
    const snap = await relayCall(tokenA, 'GET', '/relay/v1/snapshot');
    const holders = (snap.body?.claims ?? []).filter((c) => c.itemRef === 'github:acme/app#8');
    const da = (await a.api('GET', `/v1/missions/${a8}`)).body.claim;
    const db = (await b.api('GET', `/v1/missions/${b8}`)).body.claim;
    return holders.length === 1 && da && db && da.state !== 'pending' && db.state !== 'pending' && { holder: holders[0], da, db };
  }, 25_000);
  check('back online: exactly one of them holds #8 on the relay', Boolean(settled), settled);
  if (settled) {
    const loserIsA = settled.holder.memberName === 'Bruno';
    const loser = loserIsA ? settled.da : settled.db;
    const winnerName = settled.holder.memberName;
    check('the loser\'s mission shows Unclaimed with the conflict sentence', loser.state === 'unclaimed' && new RegExp(`^${winnerName} started acme/app#8 at \\d\\d:\\d\\d, while you were offline\\.$`).test(loser.sentence), loser);
    check('…and is still running', (loserIsA ? a.status(a8) : b.status(b8)) === 'EXECUTING');
  }

  section('completion releases on the relay');
  await a.complete(a7);
  const released = await until(async () => !(await relayCall(tokenA, 'GET', '/relay/v1/snapshot')).body?.claims?.some((c) => c.itemRef === 'github:acme/app#7'), 5000);
  check('completing A\'s #7 mission ends its claim on the relay', released);

  section('webhook: pulled and acked by exactly one daemon');
  const ep = await a.api('POST', '/v1/coordination/endpoints', { workspaceId: a.ws, name: 'Sentry', source: 'sentry', handshake: 'none' });
  check('A (admin) creates a relay endpoint', ep.status === 200 && ep.body.url === `${relayUrl}/hooks/${ep.body.slug}`, ep.body);
  const hook = await fetch(`${relayUrl}/hooks/${ep.body.slug}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"issue":"boom"}' });
  check('Sentry posts to the relay: 202', hook.status === 202);
  const [pa, pb] = await Promise.all([
    a.api('POST', '/v1/coordination/mailbox/pull', { workspaceId: a.ws, max: 10, leaseSeconds: 60 }),
    b.api('POST', '/v1/coordination/mailbox/pull', { workspaceId: b.ws, max: 10, leaseSeconds: 60 }),
  ]);
  const got = [pa, pb].filter((p) => p.body?.length === 1);
  check('exactly one daemon gets it', got.length === 1 && [pa, pb].some((p) => p.body?.length === 0), [pa.body, pb.body]);
  const taker = got[0] === pa ? a : b;
  const ack = await taker.api('POST', '/v1/coordination/mailbox/ack', { ids: [got[0]?.body?.[0]?.id] });
  check('that one acks it', ack.body?.acked?.length === 1, ack.body);
  const later = await Promise.all([a, b].map((d) => d.api('POST', '/v1/coordination/mailbox/pull', { workspaceId: d.ws, max: 10, leaseSeconds: 60 })));
  check('a later pull on either gets nothing', later.every((p) => p.body?.length === 0), later.map((p) => p.body));

  section('disconnect falls back to local and keeps your claims');
  const a9 = await a.mission(9);
  await a.api('POST', `/v1/missions/${a9}/start`);
  const off = await a.api('POST', '/v1/coordination/disconnect');
  check('A disconnects: local', off.body?.kind === 'local', off.body);
  const mine = (await a.api('GET', `/v1/coordination/claims?workspaceId=${a.ws}`)).body;
  check('A\'s own active claims are still listed, as yours', mine.some((r) => r.itemKey === 'acme/app#9' && r.mine), mine);
  const settingsText = readFileSync(join(a.home, 'settings.json'), 'utf8');
  check('the device token never reached settings.json', !settingsText.includes(tokenA) && !settingsText.includes('trd_'), settingsText.slice(0, 300));
  const statusText = JSON.stringify((await b.api('GET', '/v1/coordination/status')).body);
  check('status does not leak a token', !statusText.includes('trd_'), statusText);
  check('A\'s relay handle is gone after disconnect', a.container.resolve(app.IDENTITY).localPerson().handles.relay === undefined);

  await a.stop();
  await b.stop();
  await relay.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
