// Shared by the P14 scenarios: the fake GitHub (issues, comments, recorded
// calls), Repositories → Issues in the window, and the 1360x900 captures the
// guide uses.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calls, commentsOf, patchIssue, putIssue, readState } from '../../fake-gh.mjs';
import { SCRATCH, readState as readScenarioState, writeState as writeScenarioState } from '../p0/lib/ctx.mjs';

export { readScenarioState, writeScenarioState, SCRATCH };
export { openBacklog, backlogRows, clickInBacklogRow, timelineText, statusOf } from '../p7/common.mjs';
export { settle } from '../p12/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = 'example/hello-site';
const GH = `${SCRATCH}/gh`;

export const fileIssue = (issue) => putIssue(GH, REPO, issue);
export const editIssue = (number, patch) => patchIssue(GH, REPO, number, patch);
export const issueComments = (number) => commentsOf(GH, REPO, number);
export const ghCalls = () => calls(GH);
export const issueState = (number) => readState(GH).repos[REPO]?.issues.find((i) => i.number === number)?.state;

/** Repositories → the Issues section; answers with its text. */
export async function openIssues(c) {
  const { page, until, sleep } = c;
  await page.navigate('#/project');
  await until(() => page.evaluate(`Boolean(document.querySelector('section[aria-label="Issues"]'))`), { label: 'Issues section', timeoutMs: 20_000 });
  await page.evaluate(`document.querySelector('section[aria-label="Issues"]').scrollIntoView({ block: 'start' })`);
  await sleep(500);
  return issuesText(c);
}

export const issuesText = (c) => c.page.evaluate(`document.querySelector('section[aria-label="Issues"]')?.innerText ?? ''`);
export const statusLine = (c) => c.page.evaluate(`document.querySelector('section[aria-label="Issues"] [aria-label="Issue status"]')?.innerText.trim() ?? ''`);

/** A switch in the Issues section, by its label; clicks it only when it is not already `on`. */
export async function setSwitch(c, label, on) {
  const state = await c.page.evaluate(`document.querySelector('section[aria-label="Issues"] [role=switch][aria-label=${JSON.stringify(label)}]')?.getAttribute('aria-checked') ?? 'missing'`);
  if (state === 'missing') throw new Error(`no switch ${label}`);
  if ((state === 'true') !== on) {
    await c.page.click(label, { within: 'section[aria-label="Issues"]' });
    await c.until(() => c.page.evaluate(`document.querySelector('section[aria-label="Issues"] [role=switch][aria-label=${JSON.stringify(label)}]')?.getAttribute('aria-checked') === ${JSON.stringify(String(on))}`), { label: `${label} ${on ? 'on' : 'off'}`, timeoutMs: 10_000 });
  }
  await c.sleep(500);
}

/** "Check now", then waits for the status line to read `predicate`. */
export async function checkNow(c, predicate = (t) => t.startsWith('Last checked'), label = 'checked') {
  await c.page.click('Check now', { within: 'section[aria-label="Issues"]' });
  return c.until(async () => { const t = await statusLine(c); return predicate(t) && !(await c.page.evaluate(`[...document.querySelectorAll('section[aria-label="Issues"] button')].some((b) => b.innerText.trim() === 'Checking…')`)) && t; }, { label, timeoutMs: 30_000 });
}

/** The issue a mission came from, by number (API, read only). */
export async function missionForIssue(c, number) {
  const overview = await c.api.get(`/v1/workspaces/${c.env.workspaceId}/issues`);
  return overview.links.find((l) => l.number === number)?.missionId ?? null;
}

export const missionCount = async (c) => (await c.api.get(`/v1/missions?workspaceId=${c.env.workspaceId}`)).length;

/** A 1360x900 capture for the guide, into apps/desktop/screenshots/. */
export async function docShot(c, name) {
  const path = resolve(here, '../../../apps/desktop/screenshots', `${name}.png`);
  await c.page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.sleep(900);
  try { await c.page.screenshot(path); } finally { await c.page.send('Emulation.clearDeviceMetricsOverride'); }
  await c.sleep(300);
  return path;
}

export { join };
