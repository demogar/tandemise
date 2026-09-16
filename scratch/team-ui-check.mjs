/**
 * Drives the real desktop app against a real daemon to verify the Team screen
 * no longer offers an "add person" flow and the "add agent" flow still works.
 *
 * Mirrors desktop-live-check.mjs: a fresh TANDEMISE_HOME, a fresh daemon, the
 * electron-vite dev server (so the renderer gets a real http origin and the
 * daemon must satisfy CORS), and Chrome DevTools Protocol for assertions.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, 'apps/desktop');
const PORT = 9322;
const home = mkdtempSync(join(tmpdir(), 'tandemise-team-'));

let passed = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stale Electron from an earlier run would still be listening here, and we
// would happily attach to it and report on the wrong process.
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
  if (res.ok) {
    console.error(`\u2717 something is already debugging on port ${PORT}; kill it first:`);
    console.error('  pkill -f electron-vite; pkill -f "electron/dist/Electron.app"');
    process.exit(1);
  }
} catch { /* nothing listening, which is what we want */ }

const procs = [];
// Each child is its own process group leader (`detached`), so we signal the
// whole group. `electron-vite` spawns Electron as a child; SIGKILL rather than
// SIGTERM so a graceful-shutdown path cannot outlive the script and hold the
// debugging port for the next run.
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

  // ------------------------------------------------ first run + create project
  let body = await waitForText('Create your first project');
  ok('a new install asks for a project first', body.includes('Create your first project'));
  await setInput('.onboard input', 'Team check project');
  await clickButton('Create project');
  body = await waitForText('Daemon connected');
  ok('UI reports the daemon as connected', body.includes('Daemon connected'));

  // ------------------------------------------------------------------- team
  await evalJs(`window.location.hash = '#/team'`);
  body = await waitForText('You & agents');
  ok('team tab is labelled "You & agents"', body.includes('You & agents'));
  ok('no "Add person" button', !/Add person/i.test(body));
  ok('"Add agent" button is present', body.includes('Add agent'));
  ok('you are seated and shown as yourself', (await evalJs(`document.querySelectorAll('.chip--you').length`)) > 0,
    `chip--you count: ${await evalJs(`document.querySelectorAll('.chip--you').length`)}`);

  // ----------------------------------------------------------- add agent drawer
  await clickButton('Add agent');
  body = await waitForText('Roles it can perform');
  const drawerTitle = await evalJs(`document.querySelector('.drawer .modal__title')?.textContent ?? ''`);
  ok('drawer opens as "Add an agent"', drawerTitle === 'Add an agent', drawerTitle);
  ok('no person picker in the drawer', !/Someone new/.test(body));
  const labels = (await evalJs(`[...document.querySelectorAll('.drawer .field__label')].map((l) => l.textContent)`)) ?? [];
  ok('agent fields are shown', ['Name', 'Owner', 'Roles it can perform', 'Runtimes, in order'].every((l) => labels.includes(l)), labels.join(' | '));

  // ------------------------------------------------------------- create agent
  await setInput('.drawer input[data-autofocus]', 'Figma agent');
  const picked = await evalJs(`(() => {
    const field = [...document.querySelectorAll('.drawer .field')].find((f) => f.querySelector('.field__label')?.textContent === 'Roles it can perform');
    const pick = field?.querySelector('.pick');
    if (pick) pick.click();
    return !!pick;
  })()`);
  ok('a role can be picked', picked);
  await clickButton('Add');

  body = await waitForText('Figma agent');
  ok('the new agent appears in the team', body.includes('Figma agent'));
  ok('agent is owned by you', (await evalJs(`[...document.querySelectorAll('.list__subtitle')].some((s) => /Agent · yours/.test(s.textContent))`)));

  // ------------------------------------------------------ staffing presets copy
  await evalJs(`window.location.hash = '#/team/staffing'`);
  await waitFor(`document.querySelector('.staffrow select') !== null`);
  body = await text();
  const options = (await evalJs(`[...document.querySelector('.staffrow select').options].map((o) => o.textContent)`)) ?? [];
  ok('staffing picker hides "A person does it"', !options.includes('A person does it'), options.join(' | '));
  ok('staffing picker hides "Anyone from a group"', !options.includes('Anyone from a group'));
  ok('staffing picker keeps the agent presets',
    ['AI only', 'AI drafts, responsible approves', 'AI drafts, responsible checks later', 'AI with a safety net', 'Custom'].every((label) => options.includes(label)));
  ok('"person checks later" copy is gone', !options.includes('AI drafts, person checks later') && !/person checks later/i.test(body));

  ws.close();
} catch (error) {
  failures.push(`threw: ${error.message}`);
  console.log(`  FAIL threw  ${error.message}`);
}

stop();
console.log('\n' + '─'.repeat(60));
console.log(failures.length === 0
  ? `ALL ${passed} TEAM UI CHECKS PASSED`
  : `${passed} passed, ${failures.length} FAILED:\n  - ${failures.join('\n  - ')}`);
process.exit(failures.length === 0 ? 0 : 1);
