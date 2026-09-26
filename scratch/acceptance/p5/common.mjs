// Shared by the P5 scenarios: a mission with Done-when lines, staffing with no
// reviews, and reading the "Done when" section of the feed.
export const WORKFLOW = 'P5 done when';

/** Every role the P5 workflow uses, back to "no agents, no reviews"; `product` may get a blocking review. */
export const resetStaffing = (c, { reviewSpec = false } = {}) => c.staff({
  product: { assignees: [], reviews: reviewSpec ? [{ by: 'responsible', mode: 'blocking', when: 'always' }] : [] },
  qa: { assignees: [], reviews: [] },
  release: { assignees: [], reviews: [] },
});

/** New mission from the window: the goal, the Done-when lines, the P5 workflow. */
export async function createMission(c, goal, lines) {
  const { page, sleep, until } = c;
  await page.navigate('#/missions/new');
  await page.waitForText('What outcome do you want?', { timeoutMs: 30_000 });
  await sleep(400);
  await page.fill('What outcome do you want?', goal);
  await page.fill('Done when', lines.join('\n'));
  await page.select('Repository', 'acceptance-project');
  await page.select('Workflow', WORKFLOW);
  await page.click('Plan mission …');
  return until(async () => { const h = await page.evaluate('location.hash'); return /#\/missions\/msn_/.test(h) && h.split('/')[2]; }, { label: 'mission page', timeoutMs: 30_000 });
}

export async function waitTask(c, missionId, key, pred, label, timeoutMs = 90_000) {
  return c.until(async () => { const t = await c.task(missionId, key); return t && pred(t) && t; }, { label, timeoutMs, everyMs: 700 });
}

/** The visible text of the feed's "Done when" section, or '' when it is not shown. */
export const doneWhenText = (c) => c.page.evaluate(`document.querySelector('section[aria-label="Done when"]')?.innerText ?? ''`);

/** One checklist row's text, by its key ("U2", "AC1"). */
export const rowText = (c, key) => c.page.evaluate(`(() => { const rows = [...document.querySelectorAll('section[aria-label="Done when"] .list__row')]; const r = rows.find((x) => x.querySelector('.mono')?.innerText.trim() === ${JSON.stringify(key)}); return r ? r.innerText.replace(/\\s+/g, ' ').trim() : ''; })()`);

/** Opens the mission's feed and waits for the checklist to read `needle`. */
export async function feedShows(c, missionId, needle, timeoutMs = 30_000) {
  const { page, sleep, until } = c;
  if (!(await page.evaluate('location.hash')).endsWith(missionId)) { await page.navigate(`#/missions/${missionId}`); await sleep(1200); }
  return until(async () => { const t = await doneWhenText(c); return (typeof needle === 'string' ? t.includes(needle) : needle.test(t)) && t; }, { label: `Done when shows ${needle}`, timeoutMs, everyMs: 600 }).catch(async () => doneWhenText(c));
}

export async function cancel(c, missionId, id) {
  await c.api.post(`/v1/missions/${missionId}/cancel`, { reason: `acceptance: ${id} proven` }).catch(() => undefined);
}

/** Every prompt the scripted agent saw for this mission (its title is in the goal). */
export const promptsFor = (c, title) => c.prompts().filter((p) => p.includes(title));

/** The Inbox card for a task that ran out of attempts, opened in the window; its visible text. */
export async function interventionText(c, key) {
  await c.ui.openItem(`${key} exhausted its retries`, 'For me');
  await c.sleep(600);
  return c.page.text('main');
}
