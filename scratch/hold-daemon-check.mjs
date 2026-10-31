// Hold and interact: the daemon half - the hold API and the terminal socket
// (docs/superpowers/specs/2026-10-30-hold-and-interact-design.md).
//
// Starts the daemon from `apps/daemon/dist` as its own process, against a
// fresh home, and drives it the way the desktop would: REST for hold and
// continue, a WebSocket for the terminal.
//
//   npm run build && node scratch/hold-daemon-check.mjs
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const poll = async (fn, ms = 30_000) => {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(150)) { const v = await fn(); if (v) return v; }
  return undefined;
};

// ------------------------------------------------------------------ project
const scratchDir = mkdtempSync(join(tmpdir(), 'thold-d-'));
const home = join(scratchDir, 'home');
const repo = join(scratchDir, 'repo');
const gitConfig = join(scratchDir, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Hold Tester\n\temail = hold@example.com\n[init]\n\tdefaultBranch = main\n');
execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
writeFileSync(join(repo, 'README.md'), '# hold daemon check\n');
writeFileSync(join(repo, '.gitignore'), '.tandemise/out/\n');
mkdirSync(join(repo, '.tandemise', 'workflows'), { recursive: true });
writeFileSync(join(repo, '.tandemise', 'workflows', 'hold-daemon.yaml'), [
  'name: Hold daemon',
  'description: One design step, so holding it is holding the mission.',
  'steps:',
  '  - key: design',
  '    role: design',
  '    objective: Design the onboarding.',
  '    outputs: [DesignBrief]',
  '',
].join('\n'));
execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig } });
execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig } });

// ------------------------------------------------------------------- daemon
const daemon = spawn(process.execPath, [join(root, 'apps/daemon/dist/main.js')], {
  cwd: root, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
  env: {
    ...process.env, TANDEMISE_HOME: home, TANDEMISE_OFFLINE: '1', TANDEMISE_LOG_LEVEL: 'error',
    TANDEMISE_TICK_MS: '200', GIT_CONFIG_GLOBAL: gitConfig,
  },
});
let daemonErr = '';
daemon.stderr.on('data', (d) => { daemonErr += d; });
// The daemon leads its own process group, so the PTYs it spawned go with it.
const stop = () => { try { process.kill(-daemon.pid, 'SIGTERM'); } catch { try { daemon.kill('SIGKILL'); } catch {} } };
process.on('exit', () => { stop(); rmSync(scratchDir, { recursive: true, force: true }); });

const connFile = join(home, 'daemon.json');
await poll(() => existsSync(connFile), 30_000);
const conn = existsSync(connFile) ? JSON.parse(readFileSync(connFile, 'utf8')) : null;
if (conn === null) {
  console.error(`daemon did not start:\n${daemonErr}`);
  process.exit(1);
}
const { url, token } = conn;
const wsUrl = url.replace('http', 'ws');

const api = async (method, path, body) => {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};

/** A terminal window: binary output collected as text, JSON control frames kept apart. */
const openTerminal = (taskId, query = `?token=${encodeURIComponent(token)}`) => new Promise((resolve) => {
  const socket = new WebSocket(`${wsUrl}/v1/tasks/${taskId}/terminal${query}`);
  const win = { socket, text: '', control: [], closed: false, status: null };
  socket.on('message', (data, isBinary) => {
    if (isBinary) win.text += Buffer.from(data).toString('utf8');
    else win.control.push(JSON.parse(data.toString()));
  });
  socket.on('close', () => { win.closed = true; });
  socket.on('unexpected-response', (_req, res) => { win.status = res.statusCode; win.closed = true; resolve(win); });
  socket.on('error', () => { win.closed = true; resolve(win); });
  socket.on('open', () => resolve(win));
});

try {
  section('setup: a project, a fake runtime, a running step');
  const wsRes = await api('POST', '/v1/workspaces', { name: 'Hold daemon', repositoryPath: repo });
  const workspaceId = wsRes.body?.workspace?.id;
  check('a workspace on the repository', typeof workspaceId === 'string', wsRes.body);
  const autonomy = wsRes.body.workspace.autonomy;
  await api('PATCH', `/v1/workspaces/${workspaceId}`, { autonomy: { ...autonomy, planApproval: 'auto' } });

  const brief = [
    '---', 'type: DesignBrief', 'title: Onboarding design', 'handoff:', '  headline: Onboarding designed',
    'flows:', '  - onboarding', '---', '', '# Onboarding', '', 'Onboarding designed.', '',
  ].join('\n');
  // A long first pass, so there is time to hold it; the continuation finishes at once.
  const fakeProfile = {
    adapterId: 'fake', name: 'Fake agent', workspaceId: null, maxConcurrent: 4, enabled: true,
    settings: {
      script: {
        resume: 'ok',
        steps: [
          { kind: 'checkpoint', sessionId: 'sess-hold', label: 'session.init' },
          { kind: 'write-file', path: '.tandemise/out/DesignBrief.md', content: brief },
          { kind: 'tool', tool: 'Bash', input: JSON.stringify({ command: 'npm test' }) },
          { kind: 'complete', summary: 'continued', when: { promptIncludes: 'A person held this task' } },
          { kind: 'delay', ms: 120_000 },
          { kind: 'complete', summary: 'done' },
        ],
      },
    },
  };
  const runtime = await api('POST', '/v1/runtimes', fakeProfile);
  check('a fake runtime profile', runtime.status === 200, runtime.body);

  const created = await api('POST', '/v1/missions', {
    workspaceId, goal: 'Design onboarding', workflowPreset: 'hold-daemon', successCriteria: ['The design is written'], planNow: true,
  });
  const missionId = created.body?.mission?.id;
  check('a mission', typeof missionId === 'string', created.body);
  await poll(async () => (await api('GET', `/v1/missions/${missionId}`)).body?.mission?.status !== 'PLANNING', 30_000);
  let started = await api('POST', `/v1/missions/${missionId}/start`);
  if (started.status === 428 && started.body?.error?.details?.approvalId) {
    await api('POST', `/v1/approvals/${started.body.error.details.approvalId}/decide`, { optionId: 'approve' });
    started = await api('POST', `/v1/missions/${missionId}/start`);
  }
  check('the mission starts', started.status === 200, started.body);

  const taskOf = async () => (await api('GET', `/v1/missions/${missionId}`)).body?.tasks?.[0];
  const running = await poll(async () => {
    const t = await taskOf();
    return t?.status === 'RUNNING' && t.latestRun?.status === 'RUNNING' && t.now !== 'Starting…' && t;
  }, 60_000);
  check('the step is running on the fake', running !== undefined, await taskOf());
  const taskId = running?.id;
  check('a running step says what it is doing, in words', running?.now === 'Running npm test', running?.now);
  check('a running step is holdable', running?.holdable?.ok === true, running?.holdable);
  check('a running step has no hold', running?.hold === null, running?.hold);
  const attemptsBefore = running?.attempts;

  section('hold');
  const held = await api('POST', `/v1/tasks/${taskId}/hold`);
  check('POST hold answers with the task view', held.status === 200, held.body);
  check('the task is HELD', held.body?.status === 'HELD', held.body?.status);
  check('its terminal is open', held.body?.hold?.terminalOpen === true, held.body?.hold);
  check('the hold names who holds it', typeof held.body?.hold?.heldBy === 'string' && typeof held.body?.hold?.heldByName === 'string'
    && typeof held.body?.hold?.holdId === 'string' && typeof held.body?.hold?.startedAt === 'string', held.body?.hold);
  check('a held step is not running, so it has no "now"', held.body?.now === null, held.body?.now);
  check('a held step is not holdable again, in words', held.body?.holdable?.ok === false && /^Held by .+ since \d\d:\d\d\.$/.test(held.body.holdable.reason), held.body?.holdable);
  const again = await api('POST', `/v1/tasks/${taskId}/hold`);
  check('a second hold is refused with the daemon\'s words', again.status === 409 && /^Held by /.test(again.body?.error?.message ?? ''), again.body);

  section('the terminal socket');
  const win = await openTerminal(taskId);
  check('the socket opens with ?token=', win.socket.readyState === WebSocket.OPEN, win.status);
  check('the session greets the window', await poll(() => win.text.includes('Fake session'), 10_000) === true, win.text);
  win.socket.send(Buffer.from('write c.txt\r'), { binary: true });
  const targets = (await api('GET', `/v1/targets?missionId=${missionId}`)).body ?? [];
  const worktree = targets.find((t) => t.taskId === taskId)?.workingDirectory ?? targets[0]?.workingDirectory;
  check('the step has a worktree', typeof worktree === 'string', targets);
  check('a keystroke reaches the session: the file appears in the worktree', await poll(() => existsSync(join(worktree, 'c.txt')), 10_000) === true, win.text);
  win.socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  win.socket.close();
  await poll(() => win.closed, 5_000);
  const view = await taskOf();
  check('closing the window does not end the hold', view?.status === 'HELD' && view.hold?.terminalOpen === true, view?.hold);

  const second = await openTerminal(taskId);
  check('a new window repaints the scrollback', await poll(() => second.text.includes('Fake session') && second.text.includes('wrote c.txt'), 10_000) === true, second.text);
  second.socket.close();

  const noToken = await openTerminal(taskId, '');
  check('an upgrade without a token gets a 401', noToken.status === 401, noToken.status);
  const badToken = await openTerminal(taskId, '?token=nope');
  check('an upgrade with a wrong token gets a 401', badToken.status === 401, badToken.status);
  const headerToken = await new Promise((resolve) => {
    const s = new WebSocket(`${wsUrl}/v1/tasks/${taskId}/terminal`, { headers: { authorization: `Bearer ${token}` } });
    s.on('open', () => { s.close(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('unexpected-response', () => resolve(false));
  });
  check('the token may also come as a header', headerToken === true);
  const otherPath = await openTerminal(`${taskId}/extra`);
  check('only the terminal path pattern is added', otherPath.status === 401, otherPath.status);
  // A task id is never percent-encoded; a malformed escape must not reach a decoder that throws.
  const malformed = await openTerminal('%E0%A4%A');
  await poll(() => malformed.closed, 5_000);
  const health = await fetch(`${url}/v1/health`).then((r) => r.status).catch(() => null);
  check('a malformed terminal path does not take the daemon down', health === 200 && daemon.exitCode === null, { health, exit: daemon.exitCode, control: malformed.control });
  check('it is told there is no terminal there', malformed.status === null && malformed.control.some((m) => m.type === 'error'), malformed);

  section('continue');
  const continued = await api('POST', `/v1/tasks/${taskId}/continue`);
  check('POST continue answers with the task view', continued.status === 200, continued.body);
  check('the task leaves HELD', continued.body?.status !== 'HELD' && continued.body?.hold === null, continued.body?.status);
  const done = await poll(async () => { const t = await taskOf(); return t?.status === 'SUCCEEDED' && t; }, 60_000);
  check('the continuation finishes the step', done !== undefined, await taskOf());
  check('continuing spends no attempt', done?.attempts === attemptsBefore, { before: attemptsBefore, after: done?.attempts });
  check('a finished step says why it cannot be held',
    done?.holdable?.ok === false && done.holdable.reason === 'This step is done; request changes instead.', done?.holdable);
  check('a finished step has no "now"', done?.now === null, done?.now);

  const late = await openTerminal(taskId);
  await poll(() => win.closed && late.closed, 5_000);
  const error = late.control.find((m) => m.type === 'error');
  check('with no open hold, the socket says so and closes', typeof error?.message === 'string' && late.closed, late.control);

  const refused = await api('POST', `/v1/tasks/${taskId}/release`);
  check('releasing with no hold is a conflict', refused.status === 409, refused.body);
  const reopen = await api('POST', `/v1/tasks/${taskId}/terminal/reopen`);
  check('reopening with no hold is a conflict', reopen.status === 409, reopen.body);

  section('a daemon whose terminal component does not load');
  {
    // node-pty is made to fail its load in the daemon process itself, the way a
    // missing native build would; nothing in the daemon is told about it.
    const preload = join(scratchDir, 'no-pty.cjs');
    writeFileSync(preload, [
      "const Module = require('module');",
      'const load = Module._load;',
      "Module._load = function (request, ...rest) { if (request === 'node-pty') throw new Error('no native build'); return load.call(this, request, ...rest); };",
    ].join('\n'));
    const home2 = join(scratchDir, 'home-no-pty');
    const second = spawn(process.execPath, ['--require', preload, join(root, 'apps/daemon/dist/main.js')], {
      cwd: root, detached: true, stdio: 'ignore',
      env: { ...process.env, TANDEMISE_HOME: home2, TANDEMISE_OFFLINE: '1', TANDEMISE_LOG_LEVEL: 'error', TANDEMISE_TICK_MS: '200', GIT_CONFIG_GLOBAL: gitConfig },
    });
    try {
      const file2 = join(home2, 'daemon.json');
      await poll(() => existsSync(file2), 30_000);
      check('the daemon still starts', existsSync(file2));
      const c2 = JSON.parse(readFileSync(file2, 'utf8'));
      const api2 = async (method, path, body) => {
        const res = await fetch(`${c2.url}${path}`, {
          method,
          headers: { authorization: `Bearer ${c2.token}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : undefined };
      };
      const ws2 = (await api2('POST', '/v1/workspaces', { name: 'No terminal', repositoryPath: repo })).body.workspace;
      await api2('PATCH', `/v1/workspaces/${ws2.id}`, { autonomy: { ...ws2.autonomy, planApproval: 'auto' } });
      await api2('POST', '/v1/runtimes', fakeProfile);
      const m2 = (await api2('POST', '/v1/missions', {
        workspaceId: ws2.id, goal: 'Design onboarding', workflowPreset: 'hold-daemon', successCriteria: ['The design is written'], planNow: true,
      })).body?.mission?.id;
      await poll(async () => (await api2('GET', `/v1/missions/${m2}`)).body?.mission?.status !== 'PLANNING', 30_000);
      await api2('POST', `/v1/missions/${m2}/start`);
      const step = await poll(async () => {
        const t = (await api2('GET', `/v1/missions/${m2}`)).body?.tasks?.[0];
        return t?.status === 'RUNNING' && t.latestRun?.status === 'RUNNING' && t;
      }, 60_000);
      const reason = step?.holdable?.reason ?? '';
      check('Hold is offered as unavailable, with the reason',
        step?.holdable?.ok === false && reason.startsWith("The terminal component didn't load on this machine"), step?.holdable);
      const refusedHold = await api2('POST', `/v1/tasks/${step?.id}/hold`);
      check('holding is refused in the same words, and the step keeps running',
        refusedHold.status === 409 && refusedHold.body?.error?.message === reason
          && (await api2('GET', `/v1/missions/${m2}`)).body?.tasks?.[0]?.status === 'RUNNING', refusedHold.body);
    } finally {
      try { process.kill(-second.pid, 'SIGTERM'); } catch {}
    }
  }
} catch (e) {
  failures.push(`threw: ${e?.stack ?? e}`);
  console.error(e);
} finally {
  stop();
  console.log(failures.length === 0
    ? `\nALL ${passed} HOLD DAEMON CHECKS PASSED`
    : `\n${passed} passed, ${failures.length} FAILED:\n  - ${failures.join('\n  - ')}${daemonErr ? `\n--- daemon stderr ---\n${daemonErr.slice(-3000)}` : ''}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
