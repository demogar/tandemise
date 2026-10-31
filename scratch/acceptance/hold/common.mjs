// Shared by the hold scenarios: the fake runtime profiles, the terminal panel
// over CDP (its xterm rows, typing into it), the hold buttons, and the
// daemon-side records (holds, runs, worktrees) used as proof.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readState, writeState } from '../p0/lib/ctx.mjs';

export { readState, writeState };

/** The member every hold workflow step goes to (role `design`). */
export const AGENT = 'Design agent';

/** A DesignBrief the fake writes; the run id keeps each version's content its own. */
export const BRIEF = [
  '---', 'type: DesignBrief', 'title: Onboarding design', 'handoff:', '  headline: Onboarding designed',
  'flows:', '  - onboarding', '---', '', '# Onboarding', '', 'Onboarding designed in {{runId}}.', '',
].join('\n');

/** The words the daemon's continuation pass starts with (spec "Continue"). */
export const CONTINUATION = 'A person held this task';

/**
 * Fake scripts. `long` works for a while, saying what it does, then waits ten
 * minutes, so there is time to hold it; a continuation finishes at once.
 * `quick` writes its brief and finishes.
 */
export const SCRIPTS = {
  long: {
    resume: 'ok',
    steps: [
      { kind: 'checkpoint', sessionId: 'sess-hold-{{runId}}', label: 'session.init' },
      { kind: 'message', text: 'Reading the onboarding flow' },
      { kind: 'delay', ms: 5000, when: { promptIncludes: 'HOLD_SLOW_NOW' } },
      { kind: 'tool', tool: 'Bash', input: JSON.stringify({ command: 'npm test' }) },
      { kind: 'delay', ms: 5000, when: { promptIncludes: 'HOLD_SLOW_NOW' } },
      { kind: 'write-file', path: '.tandemise/out/DesignBrief.md', content: BRIEF },
      { kind: 'complete', summary: 'continued', when: { promptIncludes: CONTINUATION } },
      { kind: 'delay', ms: 600_000 },
      { kind: 'complete', summary: 'done' },
    ],
  },
  quick: {
    resume: 'ok',
    steps: [
      { kind: 'checkpoint', sessionId: 'sess-quick-{{runId}}', label: 'session.init' },
      { kind: 'message', text: 'Writing the brief' },
      { kind: 'write-file', path: '.tandemise/out/DesignBrief.md', content: BRIEF },
      { kind: 'complete', summary: 'done' },
    ],
  },
};

/** The profile named `name`, created on first use with `script`; returns its id. */
export async function fakeProfile(c, name, script, { maxConcurrent = 4 } = {}) {
  const existing = (await c.api.get('/v1/runtimes')).map((r) => r.profile ?? r).find((p) => p.name === name);
  if (existing) return existing.id;
  const created = await c.api.post('/v1/runtimes', { adapterId: 'fake', name, workspaceId: null, maxConcurrent, enabled: true, settings: { script } });
  return (created.profile ?? created).id;
}

/** Puts the Design agent on exactly these runtime profiles (adding it, yours, on first use); returns what it had. */
export async function useRuntimes(c, profileIds) {
  const existing = (await c.team()).find((m) => m.name === AGENT);
  if (!existing) {
    await c.api.post(`/v1/workspaces/${c.env.workspaceId}/members`, { kind: 'agent', name: AGENT, reportsTo: c.me, roleIds: ['design'], runtimeProfileIds: profileIds });
    return [];
  }
  await c.api.patch(`/v1/members/${existing.id}`, { runtimeProfileIds: profileIds });
  return existing.runtimeProfileIds;
}

/** A mission from the window on one of the hold workflows, its plan approved in the Inbox; returns its id. */
export async function newMission(c, goal, workflow) {
  const missionId = await c.createMission(goal, { workflow });
  const title = (await c.api.get(`/v1/missions/${missionId}`)).mission.title;
  await c.approvePlan(missionId, title);
  return missionId;
}

/** The one task of a single-step mission, from the mission view (with now, hold, holdable). */
export async function stepOf(c, missionId, key = 'design') {
  return (await c.api.get(`/v1/missions/${missionId}`)).tasks.find((t) => t.key === key);
}

/** Waits until the step satisfies `fn`; returns it. */
export function waitStep(c, missionId, fn, label, { key = 'design', timeoutMs = 60_000 } = {}) {
  return c.until(async () => { const t = await stepOf(c, missionId, key); return t && fn(t) && t; }, { label, timeoutMs, everyMs: 400 });
}

/** The hold records of a task, oldest first. */
export const holdsOf = (c, taskId) => c.sql(
  'SELECT id, held_by AS heldBy, from_status AS fromStatus, runtime_profile_id AS profileId, session_before AS sessionBefore, session_after AS sessionAfter, ended_at AS endedAt, ending, consumed_at AS consumedAt, diff_stat AS diffStat, dir FROM task_holds WHERE task_id = ? ORDER BY started_at, rowid',
  taskId,
);

/** The worktree a task works in. */
export async function worktreeOf(c, missionId, taskId) {
  const targets = await c.api.get(`/v1/targets?missionId=${missionId}`);
  return targets.find((t) => t.taskId === taskId)?.workingDirectory ?? null;
}

// ------------------------------------------------------------------- the panel

const PANEL = '.terminal-panel';

/** Whether the terminal panel is open, and for which step (its dialog label). */
export const panelLabel = (c) => c.page.evaluate(`document.querySelector('${PANEL}')?.getAttribute('aria-label') ?? ''`);

/** The panel's visible text outside the terminal: title, holder, buttons, banners, "The session ended." */
export const panelText = (c) => c.page.evaluate(`(() => { const p = document.querySelector('${PANEL}'); if (!p) return ''; const clone = p.cloneNode(true); clone.querySelector('.terminal-panel__xterm')?.remove(); return clone.innerText; })()`);

/**
 * Asks the window for a frame. This test window is not on screen, so it
 * paints (and runs requestAnimationFrame) only when a frame is asked for; xterm
 * draws its rows in an animation frame, and the panel's fade-in runs on frames.
 */
export const paint = (c) => c.page.send('Page.captureScreenshot', { format: 'jpeg', quality: 1, clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } });

/** An evidence screenshot, after a frame and a moment for the fade-in to finish. */
export async function shoot(c, ev, name) {
  await paint(c);
  await c.sleep(400);
  await paint(c);
  await c.sleep(100);
  return c.page.screenshot(ev.shot(name));
}

/** What the terminal shows: xterm's rendered rows, one line each. */
export const screenText = async (c) => (await paint(c), c.page.evaluate(`[...document.querySelectorAll('${PANEL} .xterm-rows > div')].map((r) => r.textContent.replace(/\\u00a0/g, ' ').trimEnd()).join('\\n')`));

/** Waits until the terminal shows `needle`; returns its text. */
export function waitScreen(c, needle, { timeoutMs = 20_000 } = {}) {
  return c.until(async () => { const t = await screenText(c); return t.includes(needle) && t; }, { label: `terminal shows "${needle}"`, timeoutMs, everyMs: 300 });
}

/** Types a line into the terminal the way a person does: focus it, type, press Enter. */
export async function typeLine(c, text) {
  const focused = await c.page.evaluate(`(() => { const t = document.querySelector('${PANEL} .xterm-helper-textarea'); if (!t) return false; t.focus(); return document.activeElement === t; })()`);
  if (!focused) throw new Error('the terminal could not be focused');
  if (text !== '') await c.page.send('Input.insertText', { text });
  await c.sleep(150);
  await c.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await c.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await c.sleep(300);
}

/** Presses one key in the terminal (ArrowDown, Enter, …), as a person would. */
export async function pressKey(c, key) {
  const codes = { Enter: [13, '\r'], ArrowDown: [40, ''], ArrowUp: [38, ''], Escape: [27, ''] };
  const [code, text] = codes[key];
  await c.page.evaluate(`document.querySelector('${PANEL} .xterm-helper-textarea')?.focus()`);
  await c.page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  if (text) await c.page.send('Input.dispatchKeyEvent', { type: 'char', key, text, unmodifiedText: text });
  await c.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  await c.sleep(300);
}

/** Clicks a button in the panel's header or body by its text. */
export async function panelButton(c, label) {
  const ok = await c.page.evaluate(`(() => { const b = [...document.querySelectorAll('${PANEL} button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)} && !x.disabled); if (!b) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`no enabled "${label}" in the terminal panel`);
  await c.sleep(400);
}

/** The Hold-family button on a feed card ("Hold", "Open terminal"), as { text, disabled, title }, or null. */
export const cardHold = (c, key) => c.page.evaluate(`(() => { const card = document.querySelector('[data-feed-card=${JSON.stringify(key)}]'); const b = card && [...card.querySelectorAll('button')].find((x) => /^(Hold|Holding…|Open terminal)$/.test(x.innerText.trim())); return b ? { text: b.innerText.trim(), disabled: b.disabled, title: b.title } : null; })()`);

/** The Hold-family button in the open task drawer's footer, as { text, disabled, title }, or null. */
export const drawerHold = (c) => c.page.evaluate(`(() => { const d = document.querySelector('.modal'); const b = d && [...d.querySelectorAll('.modal__foot button')].find((x) => /^(Hold|Holding…|Open terminal)$/.test(x.innerText.trim())); return b ? { text: b.innerText.trim(), disabled: b.disabled, title: b.title } : null; })()`);

/** Clicks a button in the open task drawer's footer by its text. */
export async function drawerButton(c, label) {
  const ok = await c.page.evaluate(`(() => { const d = document.querySelector('.modal'); const b = d && [...d.querySelectorAll('.modal__foot button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)} && !x.disabled); if (!b) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`no enabled "${label}" in the task drawer`);
  await c.sleep(400);
}

/** The "Now" line on a Plan card, on a feed card, and in the open drawer, read as "Now <what>" ('' when none). */
const NOW = `(el) => el ? [...el.children].map((x) => x.textContent.trim()).join(' ') : ''`;
export const nowOnPlanCard = (c, title) => c.page.evaluate(`(${NOW})([...document.querySelectorAll('button.taskcard')].find((x) => x.querySelector('.taskcard__title')?.innerText.trim() === ${JSON.stringify(title)})?.querySelector('[aria-label="Now"]'))`);
export const nowOnFeedCard = (c, key) => c.page.evaluate(`(${NOW})(document.querySelector('[data-feed-card=${JSON.stringify(key)}] [aria-label="Now"]'))`);
export const nowInDrawer = (c) => c.page.evaluate(`(${NOW})(document.querySelector('.modal [aria-label="Now"]'))`);

/** Opens a mission's feed and waits for the step's card. */
export async function openFeed(c, missionId, key = 'design') {
  await c.page.navigate(`#/missions/${missionId}`);
  await c.until(() => c.page.evaluate(`Boolean(document.querySelector('[data-feed-card=${JSON.stringify(key)}]'))`), { label: `feed card ${key}`, timeoutMs: 20_000 });
  await c.sleep(500);
}

/** Holds a step from its feed card, as a person would; waits for the panel. */
export async function holdFromCard(c, missionId, key = 'design') {
  await openFeed(c, missionId, key);
  const button = await c.until(async () => { const b = await cardHold(c, key); return b && b.text === 'Hold' && !b.disabled && b; }, { label: 'an enabled Hold on the card', timeoutMs: 20_000 });
  await c.page.evaluate(`[...document.querySelector('[data-feed-card=${JSON.stringify(key)}]').querySelectorAll('button')].find((x) => x.innerText.trim() === 'Hold').click()`);
  await c.until(async () => (await panelLabel(c)) !== '', { label: 'the terminal panel', timeoutMs: 60_000 });
  return button;
}

/** Holds a step from its task drawer (Plan tab); waits for the panel. */
export async function holdFromDrawer(c, missionId, title) {
  await c.openTaskDrawer(missionId, title);
  await c.until(async () => { const b = await drawerHold(c); return b && b.text === 'Hold' && !b.disabled; }, { label: 'an enabled Hold in the drawer', timeoutMs: 20_000 });
  await drawerButton(c, 'Hold');
  await c.until(async () => (await panelLabel(c)) !== '', { label: 'the terminal panel', timeoutMs: 60_000 });
}

/** Finds the run's MCP gateway config under the home, for acting as the agent would. */
export function mcpConfigOf(home, runId) {
  const walk = (dir, depth) => {
    if (depth > 6 || !existsSync(dir)) return null;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === runId && existsSync(join(path, 'mcp.json'))) return join(path, 'mcp.json');
      if (statSync(path).isDirectory()) { const found = walk(path, depth + 1); if (found) return found; }
    }
    return null;
  };
  const file = walk(join(home, 'workspaces'), 0) ?? walk(home, 0);
  return file === null ? null : JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * The agent's own `ask_human` call, made over the run's MCP gateway exactly as
 * the runtime would make it. Returns the child, so the scenario can let it go
 * once the hold has taken over; the call itself waits for an answer.
 */
export async function askHuman(config, question) {
  const server = config.mcpServers.tandemise;
  const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) { if (line.trim()) { const msg = JSON.parse(line); waiting.get(msg.id)?.(msg); } }
  });
  const rpc = (id, method, params) => new Promise((resolve) => { waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hold-acceptance', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = (await rpc(2, 'tools/list', {})).result.tools.map((t) => t.name);
  const name = tools.find((t) => /ask_human/.test(t));
  if (!name) { child.kill(); throw new Error(`no ask_human tool on the gateway: ${tools.join(', ')}`); }
  void rpc(3, 'tools/call', { name, arguments: { question, options: [{ id: 'cards', label: 'Cards' }, { id: 'list', label: 'A list' }] } });
  return child;
}
