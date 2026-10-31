// Shared by the planner scenarios (#53): the fake GitHub, missions the factory
// plans, "Why these steps" on the Plan tab and the ship card in the ship step's
// drawer. Screenshots go to docs/superpowers/evidence/2026-10-30-planner/.
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calls, pullRequests } from '../../fake-gh.mjs';
import { SCRATCH } from '../p0/lib/ctx.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = 'acme/web';
const GH = `${SCRATCH}/gh`;
const SHOTS = resolve(here, '../../../docs/superpowers/evidence/2026-10-30-planner');

export const ghCalls = () => calls(GH);
export const prs = () => pullRequests(GH, REPO);

/** A screenshot into the evidence folder, recorded on the scenario's evidence. */
export async function shot(c, ev, name) {
  mkdirSync(SHOTS, { recursive: true });
  const path = join(SHOTS, `${ev.id.toLowerCase()}-${name}.png`);
  await c.page.screenshot(path);
  ev.shots.push(path);
  return path;
}

export async function repositoryId(c) {
  const view = await c.api.get(`/v1/workspaces/${c.env.workspaceId}`);
  return (view.repositories ?? [])[0]?.id ?? view.workspace?.defaultRepositoryId;
}

/** A draft the factory plans (`auto`), with no Done-when line, made through the API. */
export async function autoDraft(c, goal) {
  const mission = await c.api.post('/v1/missions', {
    workspaceId: c.env.workspaceId, repositoryId: await repositoryId(c), goal, workflowPreset: 'auto',
  });
  return mission.id ?? mission.mission?.id;
}

export const mission = async (c, id) => (await c.api.get(`/v1/missions/${id}`)).mission;
export const statusOf = async (c, id) => (await mission(c, id)).status;
export const ship = (c, id) => c.api.get(`/v1/missions/${id}/ship`);

export async function waitStatus(c, id, statuses, timeoutMs = 90_000) {
  return c.until(async () => { const s = await statusOf(c, id); return statuses.includes(s) && s; }, { label: `mission ${statuses.join('|')}`, timeoutMs });
}

/** Opens a mission tab and waits for the header. */
export async function openMission(c, id, tab = '') {
  await c.page.navigate(`#/missions/${id}${tab ? `/${tab}` : ''}`);
  await c.until(() => c.page.evaluate(`Boolean(document.querySelector('.topbar__title'))`), { label: 'mission header', timeoutMs: 30_000 });
  await c.sleep(800);
}

/** A header action by its exact label ("Plan", "Plan quick", "Plan careful"). */
export async function headerAction(c, label) {
  await c.until(() => c.page.evaluate(`[...document.querySelectorAll('.topbar button')].some((b) => b.offsetParent && !b.disabled && b.innerText.trim() === ${JSON.stringify(label)})`), { label: `enabled header ${label}`, timeoutMs: 20_000 });
  await c.page.click(label, { within: '.topbar' });
}

export const headerButtons = (c) => c.page.evaluate(`[...document.querySelectorAll('.topbar button')].filter((b) => b.offsetParent).map((b) => (b.disabled ? '(disabled) ' : '') + b.innerText.trim())`);

/** "Why these steps" on the Plan tab, once it is there. */
export async function whyText(c, id, predicate = () => true) {
  await openMission(c, id, 'plan');
  return c.until(async () => {
    const t = await c.page.evaluate(`document.querySelector('section[aria-label="Why these steps"]')?.innerText ?? ''`);
    return t !== '' && predicate(t) && t;
  }, { label: 'Why these steps', timeoutMs: 30_000 });
}

/** The ship step's drawer from the Plan tab; answers with the ship card's text. */
export async function shipCardText(c, id, predicate = () => true) {
  await c.openTaskDrawer(id, 'Ship');
  return c.until(async () => {
    const t = await c.page.evaluate(`document.querySelector('[role=dialog] section[aria-label="Pull request"]')?.innerText ?? ''`);
    return t !== '' && predicate(t) && t;
  }, { label: 'ship card', timeoutMs: 30_000 });
}

export const closeDrawer = (c) => c.page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
