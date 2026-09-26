// Shared by the P11 scenarios: Missions → Routines, the New routine dialog, and
// the daemon's test clock (the run starts it with TANDEMISE_CLOCK_OFFSET_MS=0).
import { readState, writeState } from '../p0/lib/ctx.mjs';

export { readState, writeState };
export { openBacklog, backlogRows, cancelInWindow, statusOf, timelineText } from '../p7/common.mjs';

export const DEPS = 'Weekly dependency updates';
export const REPORT = 'Weekly status report';
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** The daemon's clock now (epoch ms), read through the test clock route without moving it. */
export async function clockNow(c) {
  const r = await c.api.post('/v1/test/clock', { advanceMs: 0 });
  return Date.parse(r.now);
}

/** Moves the daemon's clock forward (the test knob) and gives the scheduler a few ticks. */
export async function advance(c, ms) {
  const r = await c.api.post('/v1/test/clock', { advanceMs: ms });
  await c.sleep(3500);
  return Date.parse(r.now);
}

/** "HH:MM" in this machine's local time (the daemon's zone: same machine). */
export const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** Missions → Routines. */
export async function openRoutines(c) {
  const { page, sleep, until } = c;
  await page.navigate('#/missions/routines');
  await until(() => page.evaluate(`Boolean(document.querySelector('section[aria-label="About routines"]'))`), { label: 'Routines tab', timeoutMs: 15_000 });
  await sleep(700);
}

const rowSel = (name) => `[...document.querySelectorAll('section[aria-label="Routine list"] .list__row')].find((r) => r.getAttribute('aria-label') === ${JSON.stringify(`Routine: ${name}`)})`;

/** One routine row's visible text on one line, or ''. */
export const routineRow = (c, name) => c.page.evaluate(`(${rowSel(name)}?.innerText ?? '').replace(/\\s+/g, ' ').trim()`);

/** Waits for the row to say `needle` (the list refreshes every 5 s and on every change). */
export async function waitRow(c, name, needle, timeoutMs = 20_000) {
  return c.until(async () => { const t = await routineRow(c, name); return t.includes(needle) && t; }, { label: `row "${name}" says "${needle}"`, timeoutMs, everyMs: 600 })
    .catch(async () => routineRow(c, name));
}

/** Clicks a button (visible text or aria-label) in a routine's row. */
export async function clickInRoutine(c, name, label) {
  const ok = await c.page.evaluate(`(() => {
    const row = ${rowSel(name)};
    const b = row && [...row.querySelectorAll('button, a')].find((x) => (x.innerText.trim() || x.getAttribute('aria-label')) === ${JSON.stringify(label)} && !x.disabled);
    if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true;
  })()`);
  if (!ok) throw new Error(`no "${label}" in routine row "${name}"`);
  await c.sleep(1000);
}

/** Clicks the link in a routine's "Last: …" line. */
export async function openLast(c, name) {
  const ok = await c.page.evaluate(`(() => { const a = ${rowSel(name)}?.querySelector('.list__main a'); if (!a) return false; a.click(); return true; })()`);
  if (!ok) throw new Error(`no link in routine row "${name}"`);
  await c.sleep(1200);
}

/** New routine → a starter template → edits → Create routine. */
export async function createRoutine(c, template, edit = async () => {}) {
  const { page, until, sleep } = c;
  await openRoutines(c);
  await page.click('New routine');
  await until(() => page.evaluate(`Boolean(document.querySelector('[role=dialog][aria-label="New routine"]'))`), { label: 'dialog', timeoutMs: 10_000 });
  await page.click(template, { within: 'section[aria-label="Starter templates"]' });
  await sleep(400);
  await edit();
  await page.click('Create routine');
  await until(() => page.evaluate(`!document.querySelector('[role=dialog]')`), { label: 'dialog closed', timeoutMs: 15_000 });
  await sleep(800);
}

/** The routine as the API reads it (proof only). */
export async function routineOf(c, name) {
  return (await c.api.get(`/v1/workspaces/${c.env.workspaceId}/routines`)).find((v) => v.routine.name === name);
}

/** Missions a routine created, oldest first (proof only). */
export const missionsFrom = (c, routineId) => c.sql('SELECT id, title, status, queued_at, priority FROM missions WHERE routine_id = ? ORDER BY created_at, rowid', routineId);

/**
 * A queued draft has no Cancel (only a started mission does): the person deletes it from its page, trash icon
 * then "Delete permanently".
 */
export async function deleteInWindow(c, id) {
  const { page, until, sleep } = c;
  await page.navigate(`#/missions/${id}`);
  await until(() => page.evaluate(`(() => { const b = document.querySelector('button[title="Delete mission"]'); if (!b) return false; b.click(); return true; })()`), { label: 'delete button', timeoutMs: 15_000 });
  await until(() => page.evaluate(`[...document.querySelectorAll('[role=dialog] button')].some((b) => b.innerText.trim() === 'Delete permanently')`), { label: 'delete dialog', timeoutMs: 10_000 });
  await page.evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim() === 'Delete permanently')?.click()`);
  await until(() => c.sql('SELECT COUNT(*) AS n FROM missions WHERE id = ?', id)[0].n === 0, { label: 'deleted', timeoutMs: 15_000 });
  await sleep(500);
}
