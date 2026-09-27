// Shared by the P13 scenarios: the Skills screen and its import dialog, the
// role editor's Skills section, the step drawer's Skills line, and read-only
// proof (what the scripted agent recorded for each run: the skills it found in
// its .claude/skills folder and in its prompt, and its working folder).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { SCRATCH, readState, writeState } from '../p0/lib/ctx.mjs';

export { readState, writeState, SCRATCH };
export { cleanSlate } from '../p7/common.mjs';
export { closeDrawer, settle } from '../p12/common.mjs';

/** Opens the Skills screen from the sidebar and waits for it. */
export async function openSkills(c) {
  const { page, until, sleep } = c;
  await page.click('Skills', { within: '.sidebar' });
  await until(() => page.evaluate(`document.querySelector('.topbar')?.innerText.includes('Skills')`), { label: 'Skills screen', timeoutMs: 15_000 });
  await sleep(600);
}

/** The Library rows as the window shows them: [{ name, text }]. */
export async function libraryRows(c) {
  return c.page.evaluate(`[...document.querySelectorAll('[aria-label^="Skill: "]')].map((r) => ({ name: r.getAttribute('aria-label').slice(7), text: r.innerText }))`);
}

export async function waitRow(c, name, predicate = () => true, label = name, timeoutMs = 20_000) {
  return c.until(async () => { const row = (await libraryRows(c)).find((r) => r.name === name); return row && predicate(row.text) ? row : false; }, { label, timeoutMs });
}

export async function clickRow(c, name) {
  const ok = await c.page.evaluate(`(() => { const r = document.querySelector('[aria-label="Skill: ${name}"]'); if (!r) return false; r.scrollIntoView({ block: 'center' }); r.click(); return true; })()`);
  if (!ok) throw new Error(`no library row ${name}`);
  await c.until(() => c.page.evaluate(`document.querySelector('.reader__title')?.innerText.trim() === ${JSON.stringify(name)}`), { label: `${name} detail`, timeoutMs: 10_000 });
  await c.sleep(400);
}

/** Text of a section by its aria-label ('' when absent). */
export function sectionText(c, label) {
  return c.page.evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]')?.innerText ?? ''`);
}

/** Opens the import dialog (from the header) on a tab. */
export async function openImport(c, tab = 'Your Claude skills') {
  const { page, until, sleep } = c;
  await page.click('Import skills', { within: '.topbar' });
  await until(async () => (await c.dialogText('Import skills')) !== '', { label: 'import dialog', timeoutMs: 10_000 });
  if (tab !== 'Your Claude skills') await page.click(tab, { within: '[role=dialog]' });
  await sleep(500);
}

/** Imports a folder by path through the dialog ("A folder" → Preview → Import); returns the preview text. */
export async function importFolder(c, path, shot) {
  const { page, until, sleep } = c;
  await openImport(c, 'A folder');
  await page.fill('Skill folder', path);
  await page.click('Preview', { within: '[role=dialog]' });
  await until(() => page.evaluate(`Boolean(document.querySelector('[role=dialog] [aria-label="Preview"]'))`), { label: 'preview', timeoutMs: 15_000 });
  await sleep(400);
  const preview = await sectionText(c, 'Preview');
  if (shot) await page.screenshot(shot);
  await page.click('Import', { within: '[role=dialog]' });
  await until(async () => (await c.dialogText('Import skills')) === '', { label: 'dialog closed', timeoutMs: 15_000 });
  await sleep(500);
  return preview;
}

/** Team → Roles → <role>; returns the editor's Skills section text. */
export async function openRole(c, roleName) {
  const { page, until, sleep } = c;
  await page.navigate('#/team/roles');
  await until(() => page.evaluate(`[...document.querySelectorAll('.reader__list .list__row')].some((r) => r.querySelector('.list__title')?.innerText.trim() === ${JSON.stringify(roleName)})`), { label: 'roles list', timeoutMs: 20_000 });
  await page.evaluate(`[...document.querySelectorAll('.reader__list .list__row')].find((r) => r.querySelector('.list__title')?.innerText.trim() === ${JSON.stringify(roleName)}).click()`);
  await until(() => page.evaluate(`document.querySelector('.reader__title')?.innerText.trim() === ${JSON.stringify(roleName)} && Boolean(document.querySelector('section[aria-label="Skills"]'))`), { label: `${roleName} editor`, timeoutMs: 10_000 });
  await sleep(500);
  return sectionText(c, 'Skills');
}

export async function saveRole(c) {
  await c.page.click('Save role');
  await c.until(() => c.page.evaluate(`[...document.querySelectorAll('.badge')].some((b) => b.innerText.trim() === 'Saved')`), { label: 'Saved', timeoutMs: 10_000 });
  await c.sleep(300);
}

/** Opens a step's drawer and returns its Skills line and whole text. */
export async function drawerSkills(c, missionId, stepTitle) {
  await c.openTaskDrawer(missionId, stepTitle);
  return c.page.evaluate(`(() => {
    const d = [...document.querySelectorAll('[role=dialog]')].pop();
    return { skills: d?.querySelector('[aria-label="Skills"]')?.innerText.trim() ?? '', text: d?.innerText ?? '' };
  })()`);
}

/** What the scripted agent recorded for every run whose mission goal contains `marker`, oldest first. */
export function records(marker) {
  const dir = `${SCRATCH}/args`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))).filter((r) => r.goal.includes(marker));
}

/** Read-only SQL proof: a mission's runs with the skills each received. */
export function runSkills(c, missionId) {
  return c.sql('SELECT t."key" AS "key", r.attempt, r.status, r.skills FROM runs r JOIN mission_tasks t ON t.id = r.task_id WHERE r.mission_id = ? ORDER BY r.started_at, r.rowid', missionId)
    .map((r) => ({ ...r, skills: r.skills === null ? null : JSON.parse(r.skills) }));
}

/** The skills library as the API reads it (proof only). */
export async function library(c) {
  return (await c.api.get(`/v1/workspaces/${c.env.workspaceId}/skills`)).skills;
}

/** Setup shortcut, as P12's setup gives the profile its model flag: whether the scripted runtime reads .claude/skills. */
export async function setSkillsFolder(c, on) {
  const profile = (await c.api.get('/v1/runtimes')).find((v) => (v.profile ?? v).id === c.env.scriptedProfileId);
  const settings = { ...(profile.profile ?? profile).settings, skillsFolder: on };
  await c.api.patch(`/v1/runtimes/${c.env.scriptedProfileId}`, { settings });
}
