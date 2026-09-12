/**
 * The real desktop app, connecting an account and answering a worker's question.
 *
 * Isolated from anything else running on this machine: its own TANDEMISE_HOME,
 * its own daemon, its own Vite port and debugging port. The consent page opens
 * in the real default browser - that is what the Connect button does - pointed
 * at a local OAuth fixture that approves immediately, so the round trip is
 * browser → authorization server → loopback listener → daemon → app, for real.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { startOAuthMcpServer } from './fixtures/oauth-mcp-server.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(root, 'scratch/out/connect-live');
mkdirSync(OUT, { recursive: true });
const PORT = 9431;
const home = mkdtempSync(join(tmpdir(), 'tandemise-connect-live-'));
let passed = 0; const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const procs = [];
const stop = () => { for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } } };
process.on('exit', () => { stop(); rmSync(home, { recursive: true, force: true }); });

const fixture = await startOAuthMcpServer();
try {
  const daemon = spawn(process.execPath, [join(root, 'apps/daemon/dist/main.js')], {
    cwd: root, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
    env: { ...process.env, TANDEMISE_HOME: home, TANDEMISE_LOG_LEVEL: 'error' },
  });
  let daemonErr = ''; daemon.stderr.on('data', (c) => { daemonErr += c; });
  procs.push(daemon);
  const connFile = join(home, 'daemon.json');
  for (let i = 0; i < 120 && !existsSync(connFile); i++) await sleep(250);
  if (!existsSync(connFile)) throw new Error(`daemon did not start: ${daemonErr.slice(0, 500)}`);
  ok('isolated daemon is up', true, JSON.parse(readFileSync(connFile, 'utf8')).url);

  const electron = spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${PORT}`], {
    cwd: join(root, 'apps/desktop'), stdio: 'ignore', detached: true, env: { ...process.env, TANDEMISE_HOME: home },
  });
  procs.push(electron);

  let page;
  for (let i = 0; i < 160 && !page; i++) {
    await sleep(500);
    try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith('http://')); } catch { /* not yet */ }
  }
  if (!page) throw new Error('renderer never appeared');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0; const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  await new Promise((r) => ws.on('open', r));
  const send = (method, params = {}) => new Promise((res) => { const i = ++seq; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
  const text = async () => (await evalJs('document.body.innerText')) ?? '';
  const waitFor = async (needle, ms = 20000) => {
    const end = Date.now() + ms; let t = '';
    while (Date.now() < end) { t = await text(); if (typeof needle === 'string' ? t.includes(needle) : needle.test(t)) return t; await sleep(300); }
    return t;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
  };
  const type = (selector, value) => evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    return el.value; })()`);
  const click = (label) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].reverse().find((b) => b.textContent.trim() === ${JSON.stringify(label)}); b?.click(); return !!b; })()`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });

  await waitFor('Create your first project');
  await type('.onboard input', 'Beveloce');
  await click('Create project');
  ok('project created in the app', (await waitFor('Daemon connected')).includes('Beveloce'));

  // ------------------------------------------------------------- gallery
  await evalJs(`location.hash = '#/integrations'`);
  await waitFor('Connect your tools');
  // The catalog is its own query and lands a moment after the page does.
  const gallery = await waitFor('Sentry');
  ok('the Integrations screen is a gallery', gallery.includes('Connect your tools'), gallery.slice(0, 80).replace(/\n/g, ' / '));
  for (const app of ['Figma', 'Canva', 'Linear', 'Notion', 'Supabase', 'Vercel', 'Sentry', 'GitHub']) {
    ok(`offers ${app}`, gallery.includes(app));
  }
  ok('design apps say who uses them', /Figma[\s\S]*For designers/.test(gallery));
  ok('who-uses-it keeps its capitals', gallery.includes('For release and QA'), (gallery.match(/For release[^\n]*/) ?? [''])[0]);
  ok('no fake permission switches', !gallery.includes('Capabilities'));
  await shot('1-gallery');

  // ------------------------------------------------------------- connect
  ok('opens the custom server dialog', await click('Custom server'));
  await sleep(300);
  await type('.modal input.mono', fixture.url);
  await evalJs(`(() => { const inputs = document.querySelectorAll('.modal input.mono'); const el = inputs[1];
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'tracker');
    el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await type('.modal select', 'planning');
  await shot('2-custom');
  ok('clicks Connect, which opens the real browser', await click('Connect'));
  const dialog = await waitFor(/tracker is connected|was not connected|Finish in your browser/, 15000);
  if (dialog.includes('Finish in your browser')) await shot('3-waiting');
  const connected = await waitFor('tracker is connected', 30000);
  ok('the dialog turns to connected once consent comes back', connected.includes('tracker is connected'),
     connected.slice(0, 120).replace(/\n/g, ' / '));
  ok('the real browser completed a registration and a code exchange', fixture.stats.registrations === 1 && fixture.stats.exchanges === 1,
     JSON.stringify(fixture.stats));
  await shot('4-connected');
  await click('Done');
  const list = await waitFor('Working', 15000);
  ok('it is listed as connected and working', list.includes('Connected') && list.includes('Working'));
  // A custom server's readOnlyHint is its own unverified claim, so both tools
  // count as changes; only curated connectors get the read split.
  ok('a custom server\'s read-only claims are not trusted', /0 read tools run freely, 2 that change things/.test(list));
  await shot('5-listed');

  // ------------------------------------------------------------- question
  const db = new Database(join(home, 'tandemise.db'));
  const ws1 = db.prepare('SELECT id FROM workspaces LIMIT 1').get().id;
  const now = new Date().toISOString();
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,created_at,updated_at)
    VALUES ('mis_live','${ws1}','Onboarding redesign','Redesign onboarding','[]','[]','EXECUTING','balanced','p',?,?)`).run(now, now);
  db.prepare(`INSERT INTO mission_tasks (id,mission_id,key,title,objective,role_id,required_capabilities,input_artifacts,expected_outputs,execution_policy,approval_policy,retry_policy,status,status_reason,created_at,updated_at)
    VALUES ('tsk_live','mis_live','design','Design onboarding','Produce it','design','[]','[]','["DesignBrief"]','{}','{}','{}','AWAITING_INPUT','Waiting for your answer: Which tool?',?,?)`).run(now, now);
  db.prepare(`INSERT INTO approvals (id,workspace_id,mission_id,task_id,run_id,kind,status,risk,title,rationale,effect,evidence,options,recommended_option_id,created_at)
    VALUES ('apr_live','${ws1}','mis_live','tsk_live',NULL,'choice','PENDING','read','Which tool should I design the onboarding flow in?',
      'The repo links no design file, and Figma and Canva are both connected.','Your answer goes straight back to the worker, which is waiting on it and will carry on.',
      ?, ?, 'figma', ?)`).run(
    JSON.stringify([{ kind: 'text', label: 'Question', value: 'Which tool should I design the onboarding flow in?' }]),
    JSON.stringify([{ id: 'figma', label: 'Figma', description: 'Where the component library lives.' }, { id: 'canva', label: 'Canva' },
      { id: 'reject', label: 'Decide without me', description: 'The worker continues on its own judgement and records the assumption it made.' }]),
    now);

  // Inserted behind the daemon's back, so the app has no event telling it to
  // refetch; ask the daemon first, then load the screen fresh.
  const conn = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8'));
  const apiList = await (await fetch(`${conn.url}/v1/approvals?status=PENDING`, {
    headers: { authorization: `Bearer ${conn.token}`, 'x-tandemise-api-version': 'v1' },
  })).json().catch((e) => ({ error: String(e) }));
  ok('the daemon lists the pending question', JSON.stringify(apiList).includes('apr_live'), JSON.stringify(apiList).slice(0, 200));
  await evalJs(`location.hash = '#/approvals'; location.reload()`);
  await sleep(2500);
  const inbox = await waitFor('Which tool should I design', 15000);
  ok('the question is in the inbox', inbox.includes('Which tool should I design'));
  ok('labelled as a question, not an approval', inbox.includes('Question') && inbox.includes('Your answer'));
  ok('asks what happens when you answer', /what happens when you answer\?/i.test(inbox));
  ok('no risk badge on a question', !/Read only/i.test(inbox));
  ok('the title is not repeated as evidence', !/EVIDENCE/i.test(inbox));
  await click('Decide without me');
  const declineStyle = await evalJs(`[...document.querySelectorAll('.approval__options .btn')].map((b) => b.className).join('|')`);
  ok('choosing "decide without me" is not styled as destructive', !/btn--danger/.test(declineStyle), declineStyle);
  await evalJs(`[...document.querySelectorAll('.option')].find((o) => o.textContent.includes('Figma'))?.click()`);
  await type('.approval__options textarea', 'Figma — file: figma.com/file/abc');
  await shot('6-question');
  ok('the button says it sends an answer', await click('Answer: Figma'));
  await sleep(1500);
  const decided = db.prepare(`SELECT status, selected_option_id, decision_note FROM approvals WHERE id='apr_live'`).get();
  ok('the answer is recorded as answered, not rejected', decided.status === 'APPROVED' && decided.selected_option_id === 'figma',
     JSON.stringify(decided));
  const after = await waitFor('Answered', 10000);
  ok('the inbox says Answered · Figma', /Answered · Figma/.test(after));
  await shot('7-answered');
  db.close();
  ws.close();
} catch (error) {
  failures.push(`threw: ${error.message}`);
  console.log(`  FAIL threw  ${error.message}`);
} finally {
  await fixture.close();
}
stop();
console.log(`\n${failures.length === 0 ? `ALL ${passed} CONNECT LIVE CHECKS PASSED` : `${passed} passed, ${failures.length} FAILED:\n  - ${failures.join('\n  - ')}`}`);
console.log(`screenshots: ${OUT}`);
process.exit(failures.length === 0 ? 0 : 1);
