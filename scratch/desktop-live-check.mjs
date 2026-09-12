/**
 * Drives the real desktop app against a real daemon, the way `npm run dev` does.
 *
 * Every other suite exercises one side or the other: the daemon through `fetch`
 * from Node, the renderer against a mock. Neither notices that a browser refuses
 * a cross-origin response the daemon never granted - which is exactly how the
 * app once shipped showing "Daemon unreachable" against a perfectly healthy
 * daemon.
 *
 * It runs the Vite dev server deliberately. A packaged renderer loads from
 * `file://`, which Electron treats leniently, so the `file://` path stayed green
 * through the whole outage; the dev server gives the renderer a real
 * `http://localhost` origin and is therefore the configuration that actually
 * holds the daemon to its CORS contract - and the one every developer runs.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, 'apps/desktop');
const PORT = 9321;
const home = mkdtempSync(join(tmpdir(), 'tandemise-desktop-'));

let passed = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stale Electron from an earlier run would still be listening here, and we
// would happily attach to it and report on the wrong process - which is exactly
// how this check once "passed" against a build that did not contain the fix.
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
  if (res.ok) {
    console.error(`\u2717 something is already debugging on port ${PORT}; kill it first:`);
    console.error('  pkill -f electron-vite; pkill -f "electron/dist/Electron.app"');
    process.exit(1);
  }
} catch { /* nothing listening, which is what we want */ }

const procs = [];
// Each child is its own process group leader (`detached`), so we can signal the
// whole group. `electron-vite` spawns Electron as a child and killing only the
// wrapper orphans it - an orphan that then holds the debugging port and makes
// the next run attach to a stale build.
const stop = () => {
  for (const p of procs) {
    try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch {} }
  }
};
process.on('exit', () => { stop(); rmSync(home, { recursive: true, force: true }); });

try {
  const daemon = spawn(process.execPath, [join(root, 'apps/daemon/dist/main.js')], {
    cwd: root, stdio: 'ignore', detached: true,
    env: { ...process.env, TANDEMISE_HOME: home, TANDEMISE_LOG_LEVEL: 'error' },
  });
  procs.push(daemon);

  const connFile = join(home, 'daemon.json');
  for (let i = 0; i < 120 && !existsSync(connFile); i++) await sleep(250);
  const conn = JSON.parse(readFileSync(connFile, 'utf8'));
  ok('daemon is up', typeof conn.url === 'string', conn.url);

  const electron = spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${PORT}`], {
    cwd: desktop, stdio: 'ignore', detached: true, env: { ...process.env, TANDEMISE_HOME: home },
  });
  procs.push(electron);

  let page;
  for (let i = 0; i < 120 && !page; i++) {
    await sleep(500);
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = tabs.find((t) => t.type === 'page' && t.url.startsWith('http://'));
    } catch { /* not listening yet */ }
  }
  ok('renderer loaded from the dev server', !!page, page?.url ?? 'no page');
  if (!page) throw new Error('renderer never appeared');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  await new Promise((r) => ws.on('open', r));
  const evalJs = (expression) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, (r) => res(r?.result?.value));
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });

  let text = '';
  for (let i = 0; i < 40; i++) {
    text = (await evalJs('document.body.innerText')) ?? '';
    if (text.includes('Daemon connected') || text.includes('unreachable')) break;
    await sleep(500);
  }

  ok('UI reports the daemon as connected', text.includes('Daemon connected'), text.slice(0, 80).replace(/\n/g, ' / '));
  ok('UI does not show the unreachable screen', !/unreachable/i.test(text));
  ok('home screen rendered real data', text.includes('workspace'), 'workspace name present');
  ws.close();
} catch (error) {
  failures.push(`threw: ${error.message}`);
  console.log(`  FAIL threw  ${error.message}`);
}

stop();
console.log('\n' + '─'.repeat(60));
console.log(failures.length === 0
  ? `ALL ${passed} DESKTOP LIVE CHECKS PASSED`
  : `${passed} passed, ${failures.length} FAILED:\n  - ${failures.join('\n  - ')}`);
process.exit(failures.length === 0 ? 0 : 1);
