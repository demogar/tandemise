// Shared by the intake scenarios (plan 2026-10-30-intake Task 14): the fakes
// run-all started (YouTrack, Sentry, Slack, each a child process with a
// `/_fake/…` door), the CLI, and the Board, its Intake tab, the Inbox and
// Settings → Intake in the window.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCRATCH, readState as readScenarioState, writeState as writeScenarioState } from '../p0/lib/ctx.mjs';

export { readScenarioState, writeScenarioState, SCRATCH };
export { settle } from '../p12/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../../..');

/** `--real-youtrack` (opt-in): the tracker is a real YouTrack and nothing is seeded or edited in it. */
export const REAL_YOUTRACK = process.env.INTAKE_REAL_YOUTRACK === '1';

const urlOf = (name) => readFileSync(join(SCRATCH, name, 'url'), 'utf8').trim();
const fake = async (name, method, path, body) => {
  const res = await fetch(`${urlOf(name)}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`fake ${name} ${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
};

// ------------------------------------------------------------------ the fakes
export const yt = {
  state: () => fake('youtrack', 'GET', '/_fake/state'),
  put: (issue) => fake('youtrack', 'POST', '/_fake/issues', issue),
  /** A person edits the item in YouTrack (state, description, …). */
  edit: (key, patch) => fake('youtrack', 'POST', `/_fake/issues/${encodeURIComponent(key)}`, patch),
  async issue(key) { return (await yt.state()).issues.find((i) => i.idReadable === key); },
  async comments(key) { return (await yt.state()).comments[key] ?? []; },
  async creates() { return (await yt.state()).calls.filter((x) => x.method === 'POST' && x.path === '/api/issues'); },
};
export const sentry = {
  state: () => fake('sentry', 'GET', '/_fake/state'),
  put: (issue) => fake('sentry', 'POST', '/_fake/issues', issue),
};
export const slack = {
  state: () => fake('slack', 'GET', '/_fake/state'),
  post: (message) => fake('slack', 'POST', '/_fake/messages', message),
  emit: (event) => fake('slack', 'POST', '/_fake/emit', { event }),
};

/** Runs `tandemise …` from this checkout's build, as a shell would. */
export function cli(args, env = {}) {
  return new Promise((done) => {
    execFile(process.execPath, [join(repoRoot, 'apps/daemon/dist/cli.js'), ...args], { env: { ...process.env, ...env }, timeout: 30_000 }, (err, stdout, stderr) => {
      done({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
    });
  });
}

// ------------------------------------------------------------------ the window
/** Opens the Board (or its Intake tab) and waits for it to render. */
export async function openBoard(c, tab = 'board') {
  await c.page.navigate(tab === 'intake' ? '#/board/intake' : '#/board');
  await c.until(() => c.page.evaluate(`Boolean(document.querySelector(${JSON.stringify(tab === 'intake' ? '[aria-label="Intake signals"]' : '[aria-label="Board"]')}))`), { label: `the ${tab} tab`, timeoutMs: 20_000 });
  await c.sleep(600);
}

/** The Board's groups as rendered: `{ ready: [{ key, title, chips, text }], … }`. */
export const boardGroups = (c) => c.page.evaluate(`(() => {
  const out = {};
  for (const g of document.querySelectorAll('[data-board-group]')) {
    out[g.getAttribute('data-board-group')] = {
      heading: g.querySelector('h2')?.innerText.trim() ?? '',
      rows: [...g.querySelectorAll('[data-board-item]')].map((r) => ({
        key: r.getAttribute('data-board-item'),
        title: r.querySelector('.board__title')?.innerText.trim() ?? '',
        chips: [...r.querySelectorAll('.board__chip')].map((x) => x.innerText.trim()),
        text: r.innerText,
      })),
    };
  }
  return out;
})()`);

export async function boardRow(c, key) {
  const groups = await boardGroups(c);
  for (const g of Object.values(groups)) for (const r of g.rows) if (r.key === key) return r;
  return undefined;
}

/** The Intake tab's rows: `[{ fingerprint, title, source, status, text }]`. */
export const intakeRows = (c) => c.page.evaluate(`[...document.querySelectorAll('[data-intake-signal]')].map((r) => ({
  fingerprint: r.getAttribute('data-intake-signal'),
  title: r.querySelector('.intake-list__title')?.innerText.trim() ?? '',
  source: r.querySelector('.intake-list__source')?.innerText.trim() ?? '',
  status: r.querySelector('.intake-list__status')?.innerText.trim() ?? '',
  text: r.innerText,
}))`);

/** "Check sources now", then waits until the button reads it again (not "Checking…"). */
export async function checkSourcesNow(c) {
  // Clicked and read in one go: a quick check is over before a separate read would see "Checking…".
  // A quick check is over before a separate read would see "Checking…", so the page itself watches the button.
  const sawChecking = await c.page.evaluate(`(async () => {
    const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && x.innerText.trim() === 'Check sources now');
    if (!b) throw new Error('no Check sources now button');
    let saw = false;
    const look = () => { if ([...document.querySelectorAll('button')].some((x) => x.textContent.trim() === 'Checking…' && x.disabled)) saw = true; };
    const watch = new MutationObserver(look);
    watch.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    b.click();
    for (let i = 0; i < 40 && !saw; i++) await new Promise((r) => setTimeout(r, 25));
    watch.disconnect();
    return saw;
  })()`);
  await c.until(() => c.page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Check sources now' && !b.disabled)`), { label: 'Check sources now again', timeoutMs: 60_000 });
  await c.sleep(800);
  return sawChecking;
}

/** Waits until the Intake tab shows a row for `fingerprint` whose status passes `test`. */
export async function intakeStatus(c, fingerprint, test, label) {
  return c.until(async () => {
    const row = (await intakeRows(c)).find((r) => r.fingerprint === fingerprint);
    return row !== undefined && test(row.status) && row;
  }, { label, timeoutMs: 60_000 });
}

export const workflowId = async (c, name) => (await c.api.get(`/v1/workflows?workspaceId=${c.env.workspaceId}`)).find((w) => w.name === name)?.id;
