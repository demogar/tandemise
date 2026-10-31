/**
 * Drives a packaged desktop build the way a person who installed it would use it.
 *
 *   npm run build && npm run -w @tandemise/desktop package -- --linux AppImage
 *   node scratch/packaged-live-check.mjs --packaged apps/desktop/release/Tandemise-<v>-linux-x86_64.AppImage [--extract-and-run [--no-cleanup]] [--evidence <dir>]
 *
 * `--packaged` takes an AppImage or the app's executable (for example
 * `apps/desktop/release/linux-unpacked/tandemise`, or `/opt/Tandemise/tandemise`
 * after installing the .deb). `--extract-and-run` passes
 * `--appimage-extract-and-run`, for machines without FUSE; `--no-cleanup` sets
 * NO_CLEANUP=1, without which the AppImage runtime deletes the extracted app
 * from under the daemon when the window closes.
 *
 * What it proves, on a fresh TANDEMISE_HOME and a PATH with no `node` on it:
 *   - the app starts its own bundled daemon, on its own Electron binary in
 *     Node mode, and the window connects to it;
 *   - a new install asks for a project, and creating one works;
 *   - the hold terminal (node-pty, inside the bundled daemon) opens on a
 *     running step, shows its session, and takes typing that reaches it; the
 *     session (Electron's binary again) is told to run as Node;
 *   - closing the window quits the app and leaves the daemon, its files and
 *     the held session running.
 * `--simulate-upgrade` first starts a daemon that says it is release 0.8.0
 * (this checkout's apps/daemon build with TANDEMISE_VERSION=0.8.0) on the same
 * home, as an older install would have left it; the app must tell the person
 * it is restarting its background service, stop that daemon cleanly, and
 * start its own.
 * Unlike scratch/desktop-live-check.mjs, nothing here comes from the checkout
 * except this script: the daemon, its native modules and the renderer are the
 * packaged ones.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const packaged = option('--packaged') ? resolve(option('--packaged')) : null;
const evidence = option('--evidence') ? resolve(option('--evidence')) : null;
const extractAndRun = args.includes('--extract-and-run');
// The AppImage runtime deletes what it extracted when the app exits, under a
// daemon that is still running from it; NO_CLEANUP=1 keeps it.
const noCleanup = args.includes('--no-cleanup');
// Plays an update: a daemon of an older release is already running when the app starts.
const simulateUpgrade = args.includes('--simulate-upgrade');
if (packaged === null || !existsSync(packaged)) {
  console.error('usage: node scratch/packaged-live-check.mjs --packaged <AppImage or app executable> [--extract-and-run [--no-cleanup]] [--simulate-upgrade] [--evidence <dir>]');
  process.exit(2);
}

const PORT = 9351;
const scratch = mkdtempSync(join(tmpdir(), 'tdm-packaged-'));
const home = join(scratch, 'home');
const repo = join(scratch, 'repo');
const gitConfig = join(scratch, 'gitconfig');
if (evidence) mkdirSync(evidence, { recursive: true });

let passed = 0;
const failures = [];
const lines = [];
const say = (line) => { console.log(line); lines.push(line); };
const ok = (name, cond, detail = '') => {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  if (cond) { passed++; say(`  ok   ${name}${d ? `  ${d.slice(0, 300)}` : ''}`); }
  else { failures.push(name); say(`  FAIL ${name}${d ? `  ${d.slice(0, 600)}` : ''}`); }
};
const section = (t) => say(`\n== ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const poll = async (fn, ms = 30_000, every = 250) => {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(every)) { const v = await fn(); if (v) return v; }
  return undefined;
};

try {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
  if (res.ok) { console.error(`something is already debugging on port ${PORT}; stop it first.`); process.exit(1); }
} catch { /* free */ }

// ------------------------------------------------------------ a project to hold in
writeFileSync(gitConfig, '[user]\n\tname = Packaged Tester\n\temail = packaged@example.com\n[init]\n\tdefaultBranch = main\n');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig };
execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore', env: gitEnv });
writeFileSync(join(repo, 'README.md'), '# packaged check\n');
writeFileSync(join(repo, '.gitignore'), '.tandemise/out/\n');
mkdirSync(join(repo, '.tandemise', 'workflows'), { recursive: true });
writeFileSync(join(repo, '.tandemise', 'workflows', 'hold-packaged.yaml'), [
  'name: Hold packaged',
  'description: One design step, so holding it is holding the mission.',
  'steps:',
  '  - key: design',
  '    role: design',
  '    objective: Design the onboarding.',
  '    outputs: [DesignBrief]',
  '',
].join('\n'));
execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore', env: gitEnv });
execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore', env: gitEnv });

// --------------------------------------------------- an environment with no Node
const noNodePath = (process.env.PATH ?? '').split(delimiter).filter((d) => d && !existsSync(join(d, 'node'))).join(delimiter);
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  // Nothing that points at, or was set by, a Node toolchain.
  if (/^(npm_|NODE_|NVM_|FNM_|VOLTA_)/.test(k) || k === 'ELECTRON_RUN_AS_NODE' || k === 'ELECTRON_RENDERER_URL') continue;
  env[k] = v;
}
Object.assign(env, {
  PATH: noNodePath,
  TANDEMISE_HOME: home,
  TANDEMISE_OFFLINE: '1',
  TANDEMISE_LOG_LEVEL: 'error',
  TANDEMISE_TICK_MS: '200',
  GIT_CONFIG_GLOBAL: gitConfig,
  ...(noCleanup ? { NO_CLEANUP: '1' } : {}),
});

const procs = [];
let daemonPid = null;
const stopAll = () => {
  for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch {} } }
  if (daemonPid !== null) { try { process.kill(-daemonPid, 'SIGTERM'); } catch { try { process.kill(daemonPid, 'SIGTERM'); } catch {} } }
};
process.on('exit', () => { stopAll(); rmSync(scratch, { recursive: true, force: true }); });

// ------------------------------------------------------------------- CDP client
async function attach(match) {
  let target;
  let seen = 'nothing listening';
  for (const until = Date.now() + 60_000; Date.now() < until && !target;) {
    await sleep(500);
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
      seen = JSON.stringify(tabs.map((t) => `${t.type} ${t.url}`));
      target = tabs.find((t) => t.type === 'page' && match(t.url));
    } catch (error) { seen = String(error); }
  }
  if (!target) { say(`  (CDP saw: ${seen})`); return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((r) => ws.on('open', r));
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  return { url: target.url, ws, send, evaluate };
}

try {
  section('a machine with no Node');
  const which = spawnSync('sh', ['-c', 'command -v node || echo none'], { env, encoding: 'utf8' });
  ok('`node` is not on the PATH the app is started with', which.stdout.trim() === 'none', which.stdout.trim());

  let oldDaemon = null;
  let oldExit = null;
  if (simulateUpgrade) {
    section('an older release left its daemon running');
    const repoRoot = resolve(import.meta.dirname, '..');
    oldDaemon = spawn(process.execPath, [join(repoRoot, 'apps/daemon/dist/main.js')], {
      cwd: scratch, detached: true, stdio: 'ignore',
      env: { ...env, PATH: process.env.PATH, TANDEMISE_VERSION: '0.8.0' },
    });
    oldDaemon.on('exit', (code, signal) => { oldExit = code ?? signal; });
    procs.push(oldDaemon);
    await poll(() => existsSync(join(home, 'daemon.json')), 30_000);
    const old = existsSync(join(home, 'daemon.json')) ? JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) : null;
    ok('a daemon of release 0.8.0 is running on this home', old?.version === '0.8.0' && old.pid === oldDaemon.pid, old);
  }

  section('the packaged app starts its own daemon');
  const appArgs = [...(extractAndRun ? ['--appimage-extract-and-run'] : []), `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(scratch, 'electron')}`];
  const app = spawn(packaged, appArgs, { cwd: scratch, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let appErr = '';
  app.stderr.on('data', (d) => { appErr += d; });
  procs.push(app);
  say(`  (started ${packaged} ${appArgs.join(' ')})`);

  const page = await attach((url) => url.startsWith('file://'));
  ok('the window loads the packaged renderer from file://', page !== null, page?.url ?? `app exit ${app.exitCode ?? app.signalCode}; stderr: ${appErr.slice(-800)}`);
  if (page === null) throw new Error('no window');

  if (simulateUpgrade) {
    // Watch the window while the old daemon is replaced.
    let told = '';
    for (const until = Date.now() + 15_000; Date.now() < until && !told; await sleep(50)) {
      const text = (await page.evaluate('document.body.innerText')) ?? '';
      if (text.includes('Tandemise was updated; restarting its background service')) told = text;
    }
    await poll(() => oldExit !== null, 30_000);
    ok('the window tells the person: "Tandemise was updated; restarting its background service…"', told !== '', told.slice(0, 160).replace(/\n/g, ' / '));
    ok('the old daemon stopped cleanly (exit 0, its coordinated shutdown)', oldExit === 0, String(oldExit));
    if (evidence && told) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      if (shot.result?.data) writeFileSync(join(evidence, 'upgrade-restarting.png'), Buffer.from(shot.result.data, 'base64'));
    }
    await poll(() => { try { return JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).version === '0.9.0'; } catch { return false; } }, 30_000);
  }

  const connFile = join(home, 'daemon.json');
  await poll(() => existsSync(connFile), 30_000);
  const conn = existsSync(connFile) ? JSON.parse(readFileSync(connFile, 'utf8')) : null;
  ok('the daemon published its handshake', conn !== null, conn?.url ?? '');
  if (conn === null) throw new Error(`no daemon; launch log:\n${(() => { try { return readFileSync(join(home, 'logs', 'daemon-launch.log'), 'utf8'); } catch { return '(none)'; } })()}`);
  daemonPid = conn.pid;
  if (simulateUpgrade) {
    ok('the new daemon is the app\'s release, in a new process', conn.version === '0.9.0' && conn.pid !== oldDaemon?.pid, { version: conn.version, pid: conn.pid });
    const log = readFileSync(join(home, 'logs', 'daemon-launch.log'), 'utf8');
    ok('the launch log records the replacement', /replacing the daemon of version 0\.8\.0 \(pid \d+\) with this app's 0\.9\.0/.test(log) && /the old daemon \(pid \d+\) stopped/.test(log),
      log.split('\n').filter((l) => /replacing|old daemon/.test(l)).join(' | '));
  }

  const launchLog = readFileSync(join(home, 'logs', 'daemon-launch.log'), 'utf8');
  const started = launchLog.split('\n').find((l) => l.includes('desktop: starting')) ?? '';
  ok('the desktop started the bundled daemon, on its own Node (from bundled)', /resources\/daemon\/dist\/main\.js with Node \d+\.\d+\.\d+ at .+ \(from bundled\)/.test(started), started);
  if (process.platform === 'linux') {
    const exe = readlinkSync(`/proc/${conn.pid}/exe`);
    const cmdline = readFileSync(`/proc/${conn.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const environ = readFileSync(`/proc/${conn.pid}/environ`, 'utf8').split('\0');
    ok('the daemon process is the app\'s own binary, not a system node', !/\/node$/.test(exe) && /tandemise$/.test(exe), exe);
    ok('it runs resources/daemon/dist/main.js', cmdline.some((a) => a.endsWith('resources/daemon/dist/main.js')), cmdline.join(' '));
    ok('it was started in Node mode (ELECTRON_RUN_AS_NODE=1)', environ.includes('ELECTRON_RUN_AS_NODE=1'));
    ok('its PATH has no node either', !environ.find((e) => e.startsWith('PATH='))?.split(delimiter).some((d) => existsSync(join(d.replace(/^PATH=/, ''), 'node'))));
  }
  const api = async (method, path, body) => {
    const res = await fetch(`${conn.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${conn.token}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const health = await api('GET', '/v1/health');
  ok('the daemon answers health', health.status === 200, health.body);

  section('the window connects');
  let text = '';
  for (let i = 0; i < 60; i++) {
    text = (await page.evaluate('document.body.innerText')) ?? '';
    if (text.includes('Create your first project') || /unreachable|not running/i.test(text)) break;
    await sleep(500);
  }
  ok('a new install asks for a project first', text.includes('Create your first project'), text.slice(0, 120).replace(/\n/g, ' / '));
  await page.evaluate(`(() => {
    const input = document.querySelector('.onboard input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Packaged check');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Create project')?.click()`);
  for (let i = 0; i < 40; i++) {
    text = (await page.evaluate('document.body.innerText')) ?? '';
    if (text.includes('Daemon connected')) break;
    await sleep(500);
  }
  ok('the UI reports the daemon as connected', text.includes('Daemon connected'));
  ok('the new project is shown', text.includes('Packaged check'));

  // Opening the app again focuses this window rather than starting a second app.
  const again = spawn(packaged, [...(extractAndRun ? ['--appimage-extract-and-run'] : []), `--user-data-dir=${join(scratch, 'electron')}`], { cwd: scratch, env, stdio: 'ignore', detached: true });
  const againExit = await new Promise((r) => { again.on('exit', (code, signal) => r(code ?? signal)); setTimeout(() => r('still running'), 20_000); });
  if (againExit === 'still running') { try { process.kill(-again.pid, 'SIGTERM'); } catch {} }
  ok('a second launch exits at once and leaves the first window', againExit === 0 && (await page.evaluate('document.body.innerText'))?.includes('Packaged check'), String(againExit));
  if (evidence) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) writeFileSync(join(evidence, 'connected.png'), Buffer.from(shot.result.data, 'base64'));
  }

  section('the hold terminal (node-pty in the bundled daemon)');
  const ws = await api('POST', '/v1/workspaces', { name: 'Hold packaged', repositoryPath: repo });
  const workspace = ws.body?.workspace;
  ok('a project on a git repository', typeof workspace?.id === 'string', ws.body);
  await api('PATCH', `/v1/workspaces/${workspace.id}`, { autonomy: { ...workspace.autonomy, planApproval: 'auto' } });
  const brief = ['---', 'type: DesignBrief', 'title: Onboarding design', 'handoff:', '  headline: Onboarding designed', 'flows:', '  - onboarding', '---', '', '# Onboarding', '', 'Onboarding designed.', ''].join('\n');
  const runtime = await api('POST', '/v1/runtimes', {
    adapterId: 'fake', name: 'Fake agent', workspaceId: null, maxConcurrent: 4, enabled: true,
    settings: { script: { resume: 'ok', steps: [
      { kind: 'checkpoint', sessionId: 'sess-packaged', label: 'session.init' },
      { kind: 'write-file', path: '.tandemise/out/DesignBrief.md', content: brief },
      { kind: 'tool', tool: 'Bash', input: JSON.stringify({ command: 'npm test' }) },
      { kind: 'complete', summary: 'continued', when: { promptIncludes: 'A person held this task' } },
      { kind: 'delay', ms: 120_000 },
      { kind: 'complete', summary: 'done' },
    ] } },
  });
  ok('a fake runtime stands in for the agent', runtime.status === 200, runtime.body);
  const created = await api('POST', '/v1/missions', { workspaceId: workspace.id, goal: 'Design onboarding', workflowPreset: 'hold-packaged', successCriteria: ['The design is written'], planNow: true });
  const missionId = created.body?.mission?.id;
  await poll(async () => (await api('GET', `/v1/missions/${missionId}`)).body?.mission?.status !== 'PLANNING', 30_000);
  let start = await api('POST', `/v1/missions/${missionId}/start`);
  if (start.status === 428 && start.body?.error?.details?.approvalId) {
    await api('POST', `/v1/approvals/${start.body.error.details.approvalId}/decide`, { optionId: 'approve' });
    start = await api('POST', `/v1/missions/${missionId}/start`);
  }
  ok('the mission starts', start.status === 200, start.body);
  const taskOf = async () => (await api('GET', `/v1/missions/${missionId}`)).body?.tasks?.[0];
  const running = await poll(async () => { const t = await taskOf(); return t?.status === 'RUNNING' && t.latestRun?.status === 'RUNNING' && t.holdable?.ok === true && t; }, 60_000);
  ok('its step is running and holdable (the terminal component loaded)', running !== undefined, await taskOf());

  await page.evaluate(`location.hash = ${JSON.stringify(`#/missions/${missionId}`)}`);
  const card = await poll(() => page.evaluate(`Boolean([...(document.querySelector('[data-feed-card="design"]')?.querySelectorAll('button') ?? [])].find((x) => x.innerText.trim() === 'Hold' && !x.disabled))`), 20_000);
  ok('its card offers Hold', card === true);
  await page.evaluate(`[...document.querySelector('[data-feed-card="design"]').querySelectorAll('button')].find((x) => x.innerText.trim() === 'Hold').click()`);
  const label = await poll(() => page.evaluate(`document.querySelector('.terminal-panel')?.getAttribute('aria-label') ?? ''`), 60_000);
  ok('Hold opens the terminal panel', typeof label === 'string' && label.startsWith('Terminal: '), label);

  const screen = async () => {
    await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 1, clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } });
    return page.evaluate(`[...document.querySelectorAll('.terminal-panel .xterm-rows > div')].map((r) => r.textContent.replace(/\\u00a0/g, ' ').trimEnd()).join('\\n')`);
  };
  const greeting = await poll(async () => { const t = await screen(); return t.includes('Fake session') && t; }, 20_000, 300);
  const squeeze = (t) => (t ?? '').split('\n').filter((l) => l.trim() !== '').join(' / ');
  ok('the terminal shows the held session, running on a PTY', typeof greeting === 'string', squeeze(greeting ?? await screen()));

  const typeLine = async (line) => {
    await page.evaluate(`document.querySelector('.terminal-panel .xterm-helper-textarea')?.focus()`);
    await page.send('Input.insertText', { text: line });
    await sleep(150);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  };
  await typeLine('hello from the packaged app');
  const echoed = await poll(async () => { const t = await screen(); return t.includes('> hello from the packaged app') && t; }, 15_000, 300);
  ok('what you type reaches the session (it echoes it back)', typeof echoed === 'string', squeeze(await screen()));
  await typeLine('write packaged.txt');
  const targets = (await api('GET', `/v1/targets?missionId=${missionId}`)).body ?? [];
  const worktree = targets.find((t) => t.taskId === running?.id)?.workingDirectory ?? targets[0]?.workingDirectory;
  ok('a typed command writes into the step\'s worktree', await poll(() => worktree && existsSync(join(worktree, 'packaged.txt')), 15_000) === true, worktree);
  if (evidence) {
    await sleep(500);
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) writeFileSync(join(evidence, 'hold-terminal.png'), Buffer.from(shot.result.data, 'base64'));
    writeFileSync(join(evidence, 'hold-terminal.txt'), `${await screen()}\n`);
  }
  if (process.platform === 'linux') {
    const children = spawnSync('ps', ['-o', 'pid=,args=', '--ppid', String(conn.pid)], { encoding: 'utf8' }).stdout.trim();
    const session = children.split('\n').find((l) => l.includes(' -e ')) ?? '';
    const sessionPid = Number(session.trim().split(/\s+/)[0]);
    ok('the held session is the app\'s binary in Node mode too', Number.isInteger(sessionPid) && sessionPid > 0
      && readFileSync(`/proc/${sessionPid}/environ`, 'utf8').split('\0').includes('ELECTRON_RUN_AS_NODE=1'), children);
  }

  section('the daemon outlives the window');
  // Closing the last window quits the app on Linux and Windows (the tray keeps it on macOS).
  const exited = () => app.exitCode !== null || app.signalCode !== null;
  void page.send('Runtime.evaluate', { expression: 'window.close()' });
  if (process.platform === 'darwin' || !await poll(exited, 20_000)) { try { process.kill(-app.pid, 'SIGTERM'); } catch { /* gone */ } }
  await poll(exited, 20_000);
  ok('closing the window quits the app', exited(), `exit ${app.exitCode ?? app.signalCode}`);
  await sleep(5000);
  if (process.platform === 'linux') {
    // An AppImage's files exist only while its FUSE mount does; the daemon,
    // started from inside it, must keep it mounted after the app has gone.
    const exe = (() => { try { return readlinkSync(`/proc/${conn.pid}/exe`); } catch { return null; } })();
    ok('the daemon\'s own files are still there after the app quit', exe !== null && existsSync(exe) && existsSync(join(exe, '..', 'resources', 'daemon', 'dist', 'main.js')), exe);
  }
  const after = await api('GET', '/v1/health').catch((e) => ({ status: String(e) }));
  ok('the daemon still answers after the app quit', after.status === 200, after);
  const still = await taskOf().catch(() => null);
  ok('the held step is still held', still?.status === 'HELD', still?.status);
  // The terminal socket the window used, reopened with no window: its session
  // still runs, and still takes typing.
  const socket = new WebSocket(`${conn.url.replace('http', 'ws')}/v1/tasks/${running?.id}/terminal?token=${encodeURIComponent(conn.token)}`);
  let scrollback = '';
  socket.on('message', (data, isBinary) => { if (isBinary) scrollback += Buffer.from(data).toString('utf8'); });
  const opened = await new Promise((r) => { socket.on('open', () => r(true)); socket.on('error', () => r(false)); socket.on('unexpected-response', () => r(false)); });
  ok('its terminal reopens without the window and repaints the scrollback', opened && await poll(() => scrollback.includes('> hello from the packaged app'), 10_000) === true, scrollback.slice(-200));
  socket.send(Buffer.from('write after-quit.txt\r'), { binary: true });
  ok('and typing still reaches the session', await poll(() => worktree && existsSync(join(worktree, 'after-quit.txt')), 15_000) === true);
  socket.close();
} catch (error) {
  failures.push(`threw: ${error.message}`);
  say(`  FAIL threw  ${error.message}`);
}

stopAll();
say('\n' + '─'.repeat(60));
say(failures.length === 0
  ? `ALL ${passed} PACKAGED LIVE CHECKS PASSED`
  : `${passed} passed, ${failures.length} FAILED:\n  - ${failures.join('\n  - ')}`);
if (evidence) writeFileSync(join(evidence, `packaged-live-check${extractAndRun ? '-extract-and-run' : ''}${noCleanup ? '-no-cleanup' : ''}${simulateUpgrade ? '-upgrade' : ''}.txt`), `${lines.join('\n')}\n`);
process.exit(failures.length === 0 ? 0 : 1);
