// The relay's Docker proof (docs/superpowers/plans/2026-10-30-relay.md, Task 10 step 4), run by hand:
//
//   RELAY_PUBLIC_URL=http://127.0.0.1:18787 RELAY_INSECURE_HTTP=1 RELAY_PORT=18787 \
//     docker compose -p relayproof -f apps/relay/compose.yaml up -d --build
//   node scratch/relay-docker-proof.mjs connect <admin invite from `docker compose logs relay`>
//   docker compose -p relayproof -f apps/relay/compose.yaml down && … up -d
//   node scratch/relay-docker-proof.mjs check
//
// `connect` starts a daemon from this checkout in a fresh home, connects it to the containerised relay,
// starts an issue-linked mission and shows the claim on the relay. `check` reads the relay again
// with the same device token after a restart.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TANDEMISE_LOG_LEVEL = 'error';
process.env.TANDEMISE_OFFLINE = '1';
const RELAY = process.env.RELAY_URL ?? 'http://127.0.0.1:18787';
const STATE = join(tmpdir(), 'tandemise-relay-docker-proof.json');
const [cmd, code] = process.argv.slice(2);

const relayGet = async (token, path) => {
  const res = await fetch(`${RELAY}${path}`, { headers: { authorization: `Bearer ${token}`, 'x-tandemise-relay-api': '1' } });
  return { status: res.status, body: await res.json().catch(() => null) };
};

if (cmd === 'connect') {
  const app = await import('@tandemise/application');
  const D = await import('@tandemise/domain');
  const { ids, systemClock } = await import('@tandemise/shared');
  const { startDaemon } = await import('../apps/daemon/dist/main.js');
  const home = mkdtempSync(join(tmpdir(), 'tdm-docker-proof-'));
  const d = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 300 });
  const token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
  const api = async (method, path, body) => {
    const res = await fetch(`${d.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const r = (t) => d.container.resolve(t);
  const ws = (await api('POST', '/v1/workspaces', { name: 'Docker proof' })).body.workspace.id;
  const checkout = join(home, 'checkout');
  mkdirSync(checkout, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', checkout]);
  const repo = r(app.REPO_REPOSITORY).create({ id: 'rep_docker', workspaceId: ws, name: 'app', path: checkout, defaultBranch: 'main', remoteUrl: 'https://github.com/acme/app.git', checks: D.NO_CHECKS });
  const link = r(app.ISSUE_REPOSITORY).createLink({ workspaceId: ws, repositoryId: repo.id, githubRepo: 'acme/app', number: 42, url: 'https://github.com/acme/app/issues/42', title: 'Docker proof', body: '', author: 'sam', upstreamUpdatedAt: null, state: 'open', criteriaCount: 0 });
  const connected = await api('POST', '/v1/coordination/connect', { url: RELAY, code, displayName: 'Ana', deviceLabel: 'Docker proof', allowInsecure: false });
  console.log('connect:', connected.status, connected.body?.kind, connected.body?.teamName);
  const created = (await api('POST', '/v1/missions', { workspaceId: ws, goal: 'Prove the container', title: 'Docker proof' })).body;
  const id = created.mission?.id ?? created.id;
  const now = systemClock.now();
  r(app.TASK_REPOSITORY).add({
    id: ids.task(), missionId: id, key: 'work', title: 'work', objective: 'Do work', roleId: 'design', dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: [],
    executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false },
    retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'fail' }, completionGate: null, status: 'READY', statusReason: null, attempts: 0,
    remediatesTaskId: null, repositoryId: null, executor: 'human', waitPolicy: null, orderHint: 0, staffingOverride: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
  });
  r(app.MISSION_REPOSITORY).update(id, { status: 'AWAITING_PLAN_APPROVAL', issueLinkId: link.id });
  const started = await api('POST', `/v1/missions/${id}/start`);
  console.log('start:', started.status, started.body?.mission?.status);
  const settings = r(app.SETTINGS_STORE).read().coordination;
  const device = await r(app.SECRET_STORE).resolve(settings.deviceTokenRef);
  const snap = await relayGet(device, '/relay/v1/snapshot');
  const claim = snap.body?.claims?.find((c) => c.itemRef === 'github:acme/app#42');
  console.log('relay claim:', claim ? `${claim.memberName} on ${claim.itemRef} (${claim.state})` : 'missing');
  writeFileSync(STATE, JSON.stringify({ device, claimId: claim?.id ?? null }), { mode: 0o600 });
  await d.stop();
  process.exit(claim ? 0 : 1);
}

if (cmd === 'check') {
  if (!existsSync(STATE)) { console.error('run connect first'); process.exit(2); }
  const { device, claimId } = JSON.parse(readFileSync(STATE, 'utf8'));
  const snap = await relayGet(device, '/relay/v1/snapshot');
  const claim = snap.body?.claims?.find((c) => c.id === claimId);
  console.log('after restart:', snap.status, claim ? `${claim.memberName} still on ${claim.itemRef}` : 'claim missing');
  process.exit(claim ? 0 : 1);
}

console.error('usage: relay-docker-proof.mjs connect <invite> | check');
process.exit(2);
