/**
 * Baseline for P3: prove, in the real app, that mission creation is text-only
 * today — no file or link upload control exists. This is the "Problem" the P3
 * spec starts from, so it must be a fact observed in the window, not assumed.
 *
 * Mirrors team-ui-check.mjs: fresh TANDEMISE_HOME, fresh daemon, electron-vite
 * dev server, Chrome DevTools Protocol.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, 'apps/desktop');
const PORT = 9323;
const home = mkdtempSync(join(tmpdir(), 'tandemise-p3-'));

let passed = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
  if (res.ok) {
    console.error(`\u2717 something is already debugging on port ${PORT}; kill it first:`);
    console.error('  pkill -f electron-vite; pkill -f "electron/dist/Electron.app"');
    process.exit(1);
  }
} catch { /* nothing listening, which is what we want */ }

const procs = [];
const stop = () => {
  for (const p of procs) {
    try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch {} }
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
  const text = () => evalJs('document.body.innerText');
  const waitForText = async (needle, tries = 60, waitMs = 500) => {
    for (let i = 0; i < tries; i++) {
      const t = (await text()) ?? '';
      if (t.includes(needle)) return t;
      await sleep(waitMs);
    }
    return (await text()) ?? '';
  };
  const waitFor = async (expression, tries = 60, waitMs = 500) => {
    for (let i = 0; i < tries; i++) {
      if (await evalJs(expression)) return true;
      await sleep(waitMs);
    }
    return false;
  };
  const clickButton = (label) =>
    evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);
  const setInput = (selector, value) =>
    evalJs(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

  // ------------------------------------------------- first run + create project
  let body = await waitForText('Create your first project');
  ok('a new install asks for a project first', body.includes('Create your first project'));
  await setInput('.onboard input', 'P3 baseline project');
  await clickButton('Create project');
  body = await waitForText('Daemon connected');
  ok('UI reports the daemon as connected', body.includes('Daemon connected'));

  // ------------------------------------------------------------ new mission form
  await evalJs(`window.location.hash = '#/missions/new'`);
  body = await waitForText('What outcome do you want?');
  ok('new mission form opens on the goal field', body.includes('What outcome do you want?'));

  const fileInputs = await evalJs(`document.querySelectorAll('.page input[type=file]').length`);
  ok('no file input on mission creation', fileInputs === 0, `file inputs: ${fileInputs}`);

  const controls = (await evalJs(`[...document.querySelectorAll('.page input, .page textarea, .page select')].map((c) => c.tagName + (c.type ? ':' + c.type : ''))`)) ?? [];
  ok('creation controls are text/select only', controls.every((t) => !t.includes('file')), controls.join(' | '));

  const hasUploadCopy = /upload|attach|hand.?back|drop.?zone/i.test(body);
  ok('no upload/attach/hand-back copy in the form', !hasUploadCopy);

  const fieldLabels = (await evalJs(`[...document.querySelectorAll('.page .field__label')].map((l) => l.textContent)`)) ?? [];
  ok('form is the known text-only shape',
    ['What outcome do you want?', 'Repository', 'Workflow', 'Autonomy'].every((l) => fieldLabels.includes(l)),
    fieldLabels.join(' | '));

  ws.close();
} catch (error) {
  failures.push(`threw: ${error.message}`);
  console.log(`  FAIL threw  ${error.message}`);
}

stop();
console.log('\n' + '─'.repeat(60));
console.log(failures.length === 0
  ? `ALL ${passed} P3 BASELINE CHECKS PASSED`
  : `${passed} passed, ${failures.length} FAILED:\n  - ${failures.join('\n  - ')}`);
process.exit(failures.length === 0 ? 0 : 1);
