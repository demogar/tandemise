// Retry starts the daemon with a Node that can open the database.
//
// Drives the real desktop (`electron-vite dev`, CDP on 9365) against a fresh
// TANDEMISE_HOME with no daemon running, so every daemon in this run is one the
// window started itself:
//
//   R1  launch with no daemon: the window starts one, and it connects
//   R2  the daemon stops under the window: the not-running screen, Retry, Home
//   R3  no usable Node (TANDEMISE_NODE_SEARCH_PATH=""): a plain message, no stack
//   R4  TANDEMISE_NODE points nowhere: the message names the setting
//
//   npm run build && node scratch/acceptance/daemon-retry/run-all.mjs
//
// Evidence: docs/superpowers/evidence/2026-09-26-daemon-retry/.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../p0/lib/cdp.mjs';
import { sleep, until } from '../p0/lib/api.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const PORT = 9365;
const ROOT = '/tmp/tdm-retry';
const EVIDENCE = process.env.ACCEPTANCE_EVIDENCE ?? join(repoRoot, 'docs/superpowers/evidence/2026-09-26-daemon-retry');
mkdirSync(EVIDENCE, { recursive: true });

const results = [];
const log = (...a) => console.log('[retry]', ...a);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Nothing may already be answering on the port: attaching to a stale window
// would report on the wrong build.
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
  if (res.ok) { console.error(`something is already debugging on port ${PORT}; kill it first`); process.exit(1); }
} catch { /* free */ }

const started = { desktops: [], daemons: new Set() };

function launchDesktop(home, extraEnv = {}) {
  const child = spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${PORT}`, `--user-data-dir=${ROOT}/electron`,
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
    cwd: join(repoRoot, 'apps/desktop'),
    env: { ...process.env, TANDEMISE_HOME: home, ...extraEnv },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  child.unref();
  started.desktops.push(child);
  return child;
}

async function stopDesktop(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
  try { execFileSync('pkill', ['-f', `user-data-dir=${ROOT}/electron`]); } catch { /* none */ }
  await until(async () => {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; }
  }, { timeoutMs: 20_000, label: 'the window to close' });
}

function handshake(home) {
  const file = join(home, 'daemon.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

async function system(conn) {
  const res = await fetch(`${conn.url}/v1/system`, { headers: { authorization: `Bearer ${conn.token}` } });
  return { status: res.status, body: res.ok ? await res.json() : await res.text() };
}

function launchLog(home) {
  const file = join(home, 'logs/daemon-launch.log');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

async function scenario(id, title, fn) {
  const facts = { id, title, checks: [] };
  const ok = (label, cond, detail) => {
    facts.checks.push({ label, pass: !!cond, ...(detail === undefined ? {} : { detail }) });
    log(`${cond ? 'ok  ' : 'FAIL'} ${id} ${label}`);
  };
  try {
    await fn(ok, facts);
  } catch (error) {
    facts.checks.push({ label: 'threw', pass: false, detail: String(error.stack ?? error).slice(0, 1500) });
    log(`FAIL ${id} threw ${error.message}`);
  }
  facts.pass = facts.checks.length > 0 && facts.checks.every((c) => c.pass);
  // Evidence is committed: the person's home directory becomes ~.
  writeFileSync(join(EVIDENCE, `${id}.json`), JSON.stringify(facts, null, 2).split(homedir()).join('~'));
  results.push(facts);
}

const NOT_RUNNING = 'The Tandemise daemon is not running';
const STACK = /\n\s+at |Error: |node:internal|\.js:\d+:\d+/;

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

try {
  // ---------------------------------------------------------------- R1 + R2
  const home = `${ROOT}/home`;
  let desktop = launchDesktop(home);
  let page = await connect(PORT, { timeoutMs: 120_000 });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {});

  await scenario('R1', 'launch with no daemon: the window starts one on a real Node, and it connects', async (ok, facts) => {
    ok('no daemon was running before launch', handshake(home) === null || !alive(handshake(home).pid));
    const text = await page.waitForText(/Create your first project|Daemon connected/, { timeoutMs: 60_000 });
    ok('the window connected without the not-running screen', !text.includes(NOT_RUNNING), text.slice(0, 200));
    const conn = await until(() => handshake(home), { label: 'handshake' });
    started.daemons.add(conn.pid);
    const sys = await system(conn);
    ok('/v1/system answers', sys.status === 200, sys);
    facts.system = sys.body;
    const launch = launchLog(home);
    facts.launchLog = launch;
    const m = /with Node (\S+) at (\S+) \(from (\S+)\)/.exec(launch);
    ok('the launch log names the Node path and version', m !== null, launch);
    ok('it is not Electron\'s Node', m !== null && !/Electron/.test(m[2]) && m[3] !== 'electron', m?.slice(1));
    ok('it meets the Node 22 floor', m !== null && Number(m[1].split('.')[0]) >= 22, m?.[1]);
    facts.node = m ? { version: m[1], path: m[2], source: m[3] } : null;

    // Give the Home screen a project to show, the way a person would.
    await page.evaluate(`(() => { const i = document.querySelector('.onboard input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Retry check project'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await page.click('Create project');
    const home1 = await page.waitForText('Daemon connected', { timeoutMs: 30_000 });
    ok('Home renders with the new project', home1.includes('Retry check project'), home1.slice(0, 200));
    await page.screenshot(join(EVIDENCE, 'R1-home-connected.png'));
  });

  await scenario('R2', 'the daemon stops under the window: not-running screen, Retry, Home', async (ok, facts) => {
    const before = handshake(home);
    process.kill(before.pid, 'SIGTERM');
    await until(() => !alive(before.pid), { timeoutMs: 20_000, label: 'the daemon to stop' });
    const down = await page.waitForText(NOT_RUNNING, { timeoutMs: 30_000 });
    ok('the not-running screen appears', down.includes(NOT_RUNNING) && down.includes('Retry'), down.slice(0, 300));
    await page.screenshot(join(EVIDENCE, 'R2-not-running.png'));

    const logBefore = launchLog(home).length;
    await page.click('Retry');
    const back = await page.waitForText('Daemon connected', { timeoutMs: 45_000 });
    ok('Retry connects and Home renders', back.includes('Retry check project') && !back.includes(NOT_RUNNING), back.slice(0, 200));
    const after = await until(() => { const h = handshake(home); return h && h.pid !== before.pid ? h : null; }, { label: 'a new daemon' });
    started.daemons.add(after.pid);
    ok('a new daemon was started', after.pid !== before.pid, { before: before.pid, after: after.pid });
    const sys = await system(after);
    ok('/v1/system answers from the new daemon', sys.status === 200, sys);
    facts.system = sys.body;
    const newLog = launchLog(home).slice(logBefore);
    facts.launchLog = newLog;
    ok('the retry was logged with its Node path and version', /with Node \d+\.\d+\.\d+ at \S+ \(from (PATH|TANDEMISE_NODE)\)/.test(newLog), newLog);
    ok('no database error anywhere in the launch log', !/Cannot open database/.test(launchLog(home)));
    await page.screenshot(join(EVIDENCE, 'R2-after-retry.png'));
  });

  page.close();
  await stopDesktop(desktop);
  for (const pid of started.daemons) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }

  // ---------------------------------------------------------------- R3
  const home3 = `${ROOT}/home-no-node`;
  desktop = launchDesktop(home3, { TANDEMISE_NODE_SEARCH_PATH: '' });
  page = await connect(PORT, { timeoutMs: 120_000 });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {});
  await scenario('R3', 'no usable Node: the not-running screen says what is missing and how to fix it', async (ok, facts) => {
    const text = await page.waitForText(NOT_RUNNING, { timeoutMs: 60_000 });
    facts.screen = text;
    ok('says Node 22+ is needed and none was found', text.includes('needs Node.js 22 or newer') && text.includes('none was found'), text);
    ok('says how to fix it', text.includes('brew install node') && text.includes('TANDEMISE_NODE') && text.includes('press Retry'), text);
    ok('no stack trace on screen', !STACK.test(text), text);
    ok('no daemon was started', handshake(home3) === null);
    await page.screenshot(join(EVIDENCE, 'R3-no-node.png'));
    await page.click('Retry');
    await sleep(1500);
    const again = await page.waitForText(NOT_RUNNING, { timeoutMs: 30_000 });
    ok('Retry gives the same plain message', again.includes('none was found') && !STACK.test(again), again);
    const launch = launchLog(home3);
    facts.launchLog = launch;
    ok('the launch log records what was tried', /no usable Node: .*Tried: .*electron: it is Node 20/.test(launch), launch);
  });
  page.close();
  await stopDesktop(desktop);

  // ---------------------------------------------------------------- R4
  const home4 = `${ROOT}/home-bad-override`;
  desktop = launchDesktop(home4, { TANDEMISE_NODE: '/nonexistent/bin/node' });
  page = await connect(PORT, { timeoutMs: 120_000 });
  await scenario('R4', 'TANDEMISE_NODE points nowhere: the message names the setting, not a crash', async (ok, facts) => {
    const text = await page.waitForText(NOT_RUNNING, { timeoutMs: 60_000 });
    facts.screen = text;
    ok('names TANDEMISE_NODE and the path', text.includes('TANDEMISE_NODE is set to /nonexistent/bin/node') && text.includes('no runnable file'), text);
    ok('no stack trace on screen', !STACK.test(text), text);
    ok('no daemon was started', handshake(home4) === null);
    await page.screenshot(join(EVIDENCE, 'R4-bad-override.png'));
  });
  page.close();
  await stopDesktop(desktop);
} finally {
  for (const d of started.desktops) { try { process.kill(-d.pid, 'SIGTERM'); } catch { /* gone */ } }
  try { execFileSync('pkill', ['-f', `user-data-dir=${ROOT}/electron`]); } catch { /* none */ }
  for (const pid of started.daemons) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  for (const h of ['home', 'home-no-node', 'home-bad-override']) {
    const conn = handshake(`${ROOT}/${h}`);
    if (conn) { try { process.kill(conn.pid, 'SIGTERM'); } catch { /* gone */ } }
  }
}

const lines = [
  '# Daemon retry: acceptance report',
  '',
  `Run: ${new Date().toISOString()}  ·  CDP ${PORT}  ·  TANDEMISE_HOME under ${ROOT}`,
  '',
  '| ID | Scenario | Result |',
  '| --- | --- | --- |',
  ...results.map((r) => `| ${r.id} | ${r.title} | ${r.pass ? 'PASS' : 'FAIL'} |`),
  '',
  ...results.flatMap((r) => [`## ${r.id}: ${r.title}`, '', ...r.checks.map((c) => `- ${c.pass ? 'ok' : 'FAIL'}: ${c.label}`), '']),
];
writeFileSync(join(EVIDENCE, 'REPORT.md'), lines.join('\n'));
const allPass = results.length === 4 && results.every((r) => r.pass);
log(allPass ? 'ALL 4 SCENARIOS PASSED' : 'SOME SCENARIOS FAILED');
process.exit(allPass ? 0 : 1);
