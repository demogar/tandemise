// Shared by the P12 scenarios: a role's models set in Team → Roles, the model a
// step's run was given as the step drawer shows it, and the argv the scripted
// agent recorded for each run (setup gives it SCRIPTED_ARGS_DIR=<scratch>/args).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { SCRATCH, readState, writeState } from '../p0/lib/ctx.mjs';

export { readState, writeState };
export { cleanSlate, statusOf, missionOf } from '../p7/common.mjs';

/** Team → Roles → <role>: types the three model fields and saves. Empty strings clear a field. */
export async function setRoleModels(c, roleName, { model = '', escalate = '', economy = '' } = {}, shot) {
  const { page, until, sleep } = c;
  await page.navigate('#/team/roles');
  await until(() => page.evaluate(`[...document.querySelectorAll('.reader__list .list__row')].some((r) => r.querySelector('.list__title')?.innerText.trim() === ${JSON.stringify(roleName)})`), { label: 'roles list', timeoutMs: 20_000 });
  await page.evaluate(`[...document.querySelectorAll('.reader__list .list__row')].find((r) => r.querySelector('.list__title')?.innerText.trim() === ${JSON.stringify(roleName)}).click()`);
  await until(() => page.evaluate(`document.querySelector('.reader__title')?.innerText.trim() === ${JSON.stringify(roleName)} && Boolean(document.querySelector('section[aria-label="Models"]'))`), { label: `${roleName} editor`, timeoutMs: 10_000 });
  await sleep(400);
  await page.fill('Model', model);
  await page.fill('On retry, use', escalate);
  await page.fill('Economy model', economy);
  if (shot) { await page.evaluate(`document.querySelector('section[aria-label="Models"]').scrollIntoView({ block: 'center' })`); await sleep(400); await page.screenshot(shot); }
  await page.click('Save role');
  await until(() => page.evaluate(`[...document.querySelectorAll('.badge')].some((b) => b.innerText.trim() === 'Saved')`), { label: 'Saved', timeoutMs: 10_000 });
  await sleep(300);
  return page.evaluate(`document.querySelector('section[aria-label="Models"]').innerText`);
}

/** The role as the API reads it (proof only). */
export async function roleOf(c, id) {
  return (await c.api.get(`/v1/roles?workspaceId=${c.env.workspaceId}`)).find((r) => r.id === id);
}

/** Opens a step's drawer from the Plan tab and returns its "Model" chip, its policy line and its whole text. */
export async function drawerModel(c, missionId, stepTitle) {
  await c.openTaskDrawer(missionId, stepTitle);
  const read = () => c.page.evaluate(`(() => {
    const d = [...document.querySelectorAll('[role=dialog]')].pop();
    return { chip: d?.querySelector('[aria-label="Model"]')?.innerText.trim() ?? '', policy: d?.querySelector('[aria-label="Step models"]')?.innerText.trim() ?? '', text: d?.innerText ?? '' };
  })()`);
  return read();
}

export async function closeDrawer(c) {
  await c.page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await c.sleep(400);
}

/** Every argv the scripted agent recorded whose mission goal contains `marker`, oldest first. */
export function argvs(marker) {
  const dir = `${SCRATCH}/args`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))).filter((r) => r.goal.includes(marker));
}

/** Read-only SQL proof: a mission's runs with their model, reason and step key. */
export function runsOf(c, missionId) {
  return c.sql('SELECT r.attempt, r.status, r.model, r.model_reason AS reason, t."key" AS "key" FROM runs r JOIN mission_tasks t ON t.id = r.task_id WHERE r.mission_id = ? ORDER BY r.started_at, r.rowid', missionId);
}

/** The Metrics tab's "Usage by model" section text. */
export async function usageByModelText(c, id) {
  await c.page.navigate(`#/missions/${id}/metrics`);
  await c.until(() => c.page.evaluate(`Boolean(document.querySelector('section[aria-label="Usage by model"]'))`), { label: 'Usage by model', timeoutMs: 15_000 });
  await c.sleep(600);
  return c.page.evaluate(`(() => { const s = document.querySelector('section[aria-label="Usage by model"]'); s.scrollIntoView({ block: 'start' }); return s.innerText; })()`);
}

/** Waits for the mission to finish (or block), polling the API. */
export async function settle(c, id, states = ['COMPLETE', 'BLOCKED', 'FAILED', 'PAUSED', 'CANCELLED'], timeoutMs = 180_000) {
  return c.until(async () => { const s = (await c.api.get(`/v1/missions/${id}`)).mission.status; return states.includes(s) && s; }, { label: `mission ${states.join('/')}`, timeoutMs, everyMs: 1000 });
}
