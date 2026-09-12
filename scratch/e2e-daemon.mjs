/**
 * End-to-end daemon smoke test.
 *
 * Starts a real tandemd against a throwaway home directory, drives the real
 * HTTP + WebSocket API exactly as the desktop would, and runs a real mission
 * against the Taskly demo repository. Nothing here is mocked except the choice
 * of runtime, which defaults to the deterministic `fake` adapter so the test is
 * free and repeatable; pass --real to route the mission through Claude Code.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const REAL = process.argv.includes('--real');
const DEMO_REPO = '/Users/you/projects/tandemise-demo-app';
const home = mkdtempSync(join(tmpdir(), 'tandemise-e2e-'));

let passed = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n── ${t}`);

process.env.TANDEMISE_HOME = home;
process.env.TANDEMISE_LOG_LEVEL = process.env.TANDEMISE_LOG_LEVEL ?? 'warn';
process.env.TANDEMISE_TICK_MS = '400';

const { startDaemon } = await import('../apps/daemon/dist/main.js');

let daemon;
let token;
let base;

async function api(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-tandemise-api-version': 'v1',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, body: json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  section('daemon startup');
  daemon = await startDaemon({ home, logLevel: 'warn', tickIntervalMs: 400 });
  base = daemon.url;
  ok('daemon listens on loopback', base.startsWith('http://127.0.0.1:'), base);

  const conn = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8'));
  token = conn.token;
  ok('connection file written', typeof token === 'string' && token.length >= 32);
  ok('connection file records pid', conn.pid === process.pid);

  const health = await fetch(`${base}/v1/health`);
  ok('health needs no auth', health.status === 200);

  const noAuth = await fetch(`${base}/v1/system`);
  ok('other routes reject a missing token', noAuth.status === 403, `status=${noAuth.status}`);

  const badAuth = await fetch(`${base}/v1/system`, { headers: { authorization: 'Bearer wrong' } });
  ok('a wrong token is rejected', badAuth.status === 403);

  const badVersion = await fetch(`${base}/v1/system`, {
    headers: { authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v99' },
  });
  ok('an API version mismatch is refused', badVersion.status === 412);

  const system = await api('GET', '/v1/system');
  ok('system info', system.status === 200 && !!system.body?.daemonVersion, JSON.stringify(system.body?.daemonVersion ?? system.body));

  // The renderer is a browser context, so every call it makes is cross-origin:
  // `file://` sends `Origin: null` in production and the Vite dev server sends
  // its own http origin. Without CORS headers the browser rejects the response
  // before the renderer ever sees it, which surfaces as "failed to fetch".
  section('cross-origin access (the desktop renderer)');
  const ORIGINS = ['null', 'http://localhost:5173'];
  for (const origin of ORIGINS) {
    const pre = await fetch(`${base}/v1/system`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,x-tandemise-api-version',
      },
    });
    const allowOrigin = pre.headers.get('access-control-allow-origin');
    const allowHeaders = (pre.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    ok(`preflight from ${origin} is allowed`, pre.status < 300 && allowOrigin === origin,
      `status=${pre.status} allow-origin=${allowOrigin}`);
    ok(`preflight from ${origin} permits our headers`,
      allowHeaders.includes('authorization') && allowHeaders.includes('x-tandemise-api-version'),
      allowHeaders);

    const actual = await fetch(`${base}/v1/system`, {
      headers: { origin, authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v1' },
    });
    ok(`response to ${origin} is readable by the browser`,
      actual.status === 200 && actual.headers.get('access-control-allow-origin') === origin,
      `status=${actual.status} allow-origin=${actual.headers.get('access-control-allow-origin')}`);
    ok(`response to ${origin} varies on origin`,
      (actual.headers.get('vary') ?? '').toLowerCase().includes('origin'),
      actual.headers.get('vary') ?? '<none>');
  }

  // A real website must not be able to read the daemon, token or no token.
  const evil = await fetch(`${base}/v1/health`, { headers: { origin: 'https://evil.example' } });
  ok('an untrusted origin gets no CORS grant',
    evil.headers.get('access-control-allow-origin') === null,
    String(evil.headers.get('access-control-allow-origin')));

  section('websocket stream');
  const events = [];
  const invalidations = [];
  const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/stream?token=${encodeURIComponent(token)}`);
  let hello;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'hello') hello = m;
    if (m.type === 'event') events.push(m.record);
    if (m.type === 'invalidate') invalidations.push(m);
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 5000);
  });
  await sleep(200);
  ok('stream sends hello', hello?.apiVersion === 'v1');

  const unauthorized = new WebSocket(`${base.replace('http', 'ws')}/v1/stream?token=nope`);
  const wsRejected = await new Promise((resolve) => {
    unauthorized.once('error', () => resolve(true));
    unauthorized.once('open', () => resolve(false));
    setTimeout(() => resolve(false), 3000);
  });
  ok('stream rejects a bad token', wsRejected);

  section('workspace and repository');
  const ws1 = await api('POST', '/v1/workspaces', { name: 'E2E', repositoryPath: DEMO_REPO });
  ok('workspace created', ws1.status === 200 || ws1.status === 201, JSON.stringify(ws1.body).slice(0, 200));
  const workspaceId = ws1.body?.workspace?.id ?? ws1.body?.id;
  ok('workspace has an id', !!workspaceId, workspaceId);
  ok('built-in roles seeded', (ws1.body?.roles?.length ?? 0) >= 7, `roles=${ws1.body?.roles?.length}`);

  const probe = await api('POST', '/v1/repositories/probe', { path: DEMO_REPO });
  ok('repository probe works', probe.status === 200 && probe.body?.isGitRepository === true);
  ok('probe detects the test command', !!probe.body?.detectedChecks?.test, probe.body?.detectedChecks?.test);

  const repos = await api('GET', `/v1/workspaces/${workspaceId}/repositories`);
  ok('repository is attached', Array.isArray(repos.body) && repos.body.length >= 1);
  const repositoryId = repos.body?.[0]?.id;

  section('runtimes');
  const discovered = await api('POST', '/v1/runtimes/discover');
  ok('runtime discovery runs', discovered.status === 200 && Array.isArray(discovered.body));
  const claude = discovered.body?.find((d) => d.adapterId?.includes('claude'));
  ok('Claude Code is detected on this machine', !!claude?.detected, claude?.version ?? 'not detected');

  const adapterId = REAL ? (claude?.adapterId ?? 'claude-code') : 'fake';
  const profile = await api('POST', '/v1/runtimes', {
    adapterId,
    name: REAL ? 'Claude Code' : 'Deterministic fake',
    workspaceId,
    ...(REAL && claude?.executablePath ? { executablePath: claude.executablePath } : {}),
    ...(REAL ? { settings: { model: 'claude-haiku-4-5-20251001' } } : {}),
  });
  ok('runtime profile created', profile.status === 200 || profile.status === 201, JSON.stringify(profile.body).slice(0, 160));

  const runtimes = await api('GET', `/v1/runtimes?workspaceId=${workspaceId}`);
  ok('runtime list reports health', Array.isArray(runtimes.body) && runtimes.body.length >= 1,
     runtimes.body?.[0]?.health?.state);

  section('mission lifecycle');
  const mission = await api('POST', '/v1/missions', {
    workspaceId,
    repositoryId,
    goal: 'Add a "Clear completed" button to Taskly that removes all done tasks, with a confirmation and a test.',
    workflowPreset: 'quick-change',
    planNow: false,
  });
  ok('mission created', mission.status === 200 || mission.status === 201, JSON.stringify(mission.body).slice(0, 160));
  const missionId = mission.body?.id ?? mission.body?.mission?.id;
  ok('mission has an id', !!missionId, missionId);

  ws.send(JSON.stringify({ type: 'subscribe', missionId }));

  const planned = await api('POST', `/v1/missions/${missionId}/plan`);
  ok('planning returns a mission detail', planned.status === 200, `status=${planned.status}`);
  const taskCount = planned.body?.tasks?.length ?? 0;
  ok('plan produced tasks', taskCount > 0, `tasks=${taskCount}`);
  if (taskCount > 0) {
    const roles = planned.body.tasks.map((t) => t.roleId).join(' → ');
    console.log(`       plan: ${roles}`);
    ok('tasks carry a DAG level', planned.body.tasks.every((t) => typeof t.level === 'number'));
  }

  let started = await api('POST', `/v1/missions/${missionId}/start`);
  if (started.status === 428) {
    // Plan approval is required by default (MVP.md §18.3) - that is the product
    // working, not a failure. Approve it the way the user would.
    ok('starting without plan approval is refused', true, started.body?.error?.code);
    const planApprovalId = started.body?.error?.details?.approvalId;
    ok('the refusal names the approval to act on', !!planApprovalId, planApprovalId);
    const decided = await api('POST', `/v1/approvals/${planApprovalId}/decide`, { optionId: 'approve' });
    ok('the plan approval can be decided', decided.status === 200, JSON.stringify(decided.body).slice(0, 120));
    started = await api('POST', `/v1/missions/${missionId}/start`);
  }
  ok('mission starts once the plan is approved', started.status === 200, JSON.stringify(started.body).slice(0, 200));

  section('execution');
  const deadline = Date.now() + (REAL ? 900_000 : 180_000);
  let detail;
  let lastPrinted = '';
  while (Date.now() < deadline) {
    const res = await api('GET', `/v1/missions/${missionId}`);
    detail = res.body;
    const statuses = (detail?.tasks ?? []).map((t) => `${t.key}:${t.status}`).join(' ');
    if (statuses !== lastPrinted) { console.log(`       ${detail?.mission?.status} | ${statuses}`); lastPrinted = statuses; }
    const s = detail?.mission?.status;
    const settled = (detail?.tasks ?? []).every((t) =>
      ['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED', 'BLOCKED', 'AWAITING_APPROVAL'].includes(t.status));
    if (['COMPLETE', 'READY_TO_SHIP', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(s) || settled) break;
    await sleep(1500);
  }

  // Asserting `!!detail` was vacuous: it is true at any status, so this passed
  // even when the wait loop simply timed out. The mission must actually have
  // left EXECUTING under its own steam - no API call is made inside the loop
  // other than polling, so reaching a terminal state proves the scheduler's
  // tick loop is genuinely running.
  const finalStatus = detail?.mission?.status;
  const settledStatuses = ['COMPLETE', 'READY_TO_SHIP', 'RELEASED', 'FAILED', 'CANCELLED', 'BLOCKED'];
  ok('the mission ran to a settled state without further API calls',
     settledStatuses.includes(finalStatus), `status=${finalStatus}`);
  const tasks = detail?.tasks ?? [];
  const taskStates = tasks.map((t) => `${t.key}:${t.status}`).join(' ');
  // A task still PENDING is correct when an upstream task blocked or failed -
  // that is the DAG holding the line, not the scheduler stalling. What must not
  // happen is a task sitting READY or RUNNING once the mission has settled.
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const upstreamSettledBadly = (t) =>
    t.dependsOn.some((d) => ['BLOCKED', 'FAILED', 'CANCELLED', 'PENDING'].includes(byKey.get(d)?.status ?? ''));
  ok('no task is left mid-flight',
     tasks.every((t) => !['READY', 'RUNNING'].includes(t.status)), taskStates);
  ok('every PENDING task is waiting on an upstream that did not succeed',
     tasks.filter((t) => t.status === 'PENDING').every(upstreamSettledBadly), taskStates);
  ok('at least one task actually ran', (detail?.tasks ?? []).some((t) => t.runCount > 0), taskStates);
  ok('events streamed over the websocket', events.length > 0, `${events.length} events`);
  ok('event sequences are monotonic',
     events.every((e, i) => i === 0 || e.sequence > events[i - 1].sequence));
  ok('projection invalidations were sent', invalidations.length > 0, `${invalidations.length}`);

  const persistedEvents = await api('GET', `/v1/missions/${missionId}/events`);
  ok('events are durable', Array.isArray(persistedEvents.body) && persistedEvents.body.length > 0,
     `${persistedEvents.body?.length} persisted`);

  const artifacts = await api('GET', `/v1/missions/${missionId}/artifacts`);
  ok('artifacts were produced', Array.isArray(artifacts.body) && artifacts.body.length > 0,
     (artifacts.body ?? []).map((a) => a.type).join(', '));

  const targets = await api('GET', `/v1/targets?missionId=${missionId}`);
  const worktrees = (targets.body ?? []).filter((t) => t.kind === 'worktree');
  ok('an isolated worktree was provisioned', worktrees.length > 0,
     worktrees[0]?.workingDirectory ?? 'none');
  if (worktrees[0]) {
    ok('the worktree exists on disk', existsSync(worktrees[0].workingDirectory));
    ok('the worktree is on its own branch', !!worktrees[0].branch, worktrees[0].branch);
  }

  const home1 = await api('GET', `/v1/home?workspaceId=${workspaceId}`);
  ok('home view assembles', home1.status === 200 && !!home1.body?.workspace);

  const approvals = await api('GET', '/v1/approvals');
  ok('approvals endpoint works', approvals.status === 200);
  const pending = (approvals.body ?? []).filter((a) => a.approval?.status === 'PENDING');
  console.log(`       ${pending.length} pending approval(s)`);
  for (const a of pending) {
    const card = a.approval;
    ok(`approval "${card.title}" is decision-ready`,
       !!card.title && !!card.rationale && !!card.effect && card.options?.length > 0);
  }

  section('restart recovery');
  ws.close();
  await daemon.stop();
  daemon = undefined;

  const restarted = await startDaemon({ home, logLevel: 'warn', tickIntervalMs: 400 });
  daemon = restarted;
  base = restarted.url;
  token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;

  const after = await api('GET', `/v1/missions/${missionId}`);
  ok('mission survived a daemon restart', after.status === 200 && after.body?.mission?.id === missionId);
  ok('tasks survived', (after.body?.tasks?.length ?? 0) === taskCount);
  ok('artifacts survived', (after.body?.artifacts?.length ?? 0) === (artifacts.body?.length ?? 0));
  const afterEvents = await api('GET', `/v1/missions/${missionId}/events`);
  ok('event log survived', (afterEvents.body?.length ?? 0) >= (persistedEvents.body?.length ?? 0));

  section('cancellation');
  const cancelled = await api('POST', `/v1/missions/${missionId}/cancel`, { reason: 'e2e teardown' });
  ok('mission can be cancelled', cancelled.status === 200, cancelled.body?.status);
} catch (e) {
  failures.push(`threw: ${e?.message ?? e}`);
  console.error('\nE2E THREW:', e);
} finally {
  try { await daemon?.stop(); } catch { /* best effort */ }
  console.log(`\n${'─'.repeat(60)}`);
  console.log(failures.length === 0
    ? `ALL ${passed} E2E CHECKS PASSED`
    : `${passed} passed, ${failures.length} FAILED:\n  - ${failures.join('\n  - ')}`);
  console.log(`home: ${home}`);
  if (failures.length === 0 && !process.argv.includes('--keep')) rmSync(home, { recursive: true, force: true });
  process.exit(failures.length === 0 ? 0 : 1);
}
