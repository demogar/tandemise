// Shared by the P8 scenarios: missions with a limit created from the New
// mission form, and reading the limit where the window shows it.
import { readState, writeState } from '../p0/lib/ctx.mjs';

export { readState, writeState };
export { addToBacklog, backlogRows, cleanSlate, openBacklog, setLimit, statusOf, missionOf, timelineText } from '../p7/common.mjs';

export const WORKFLOW = 'P8 five steps';

/**
 * New mission from the window with its own limit, set under More options
 * ("Agent minutes for this mission", "Cost (USD) for this mission", …), then
 * "Plan mission …". The goal carries the scripted agent's usage knob.
 */
export async function createWithLimit(c, goal, { field = 'Agent minutes for this mission', amount, workflow = WORKFLOW } = {}) {
  const { page, until, sleep } = c;
  await page.navigate('#/missions/new');
  await page.waitForText('What outcome do you want?', { timeoutMs: 30_000 });
  await sleep(400);
  await page.fill('What outcome do you want?', goal);
  await page.fill('Done when', 'The acceptance scenario finishes its steps');
  await page.select('Repository', 'acceptance-project');
  await page.select('Workflow', workflow);
  await page.click('More options');
  await page.waitForText('Limit');
  await page.fill(field, String(amount));
  await page.click('Plan mission …');
  return until(async () => { const h = await page.evaluate('location.hash'); return /#\/missions\/msn_/.test(h) && h.split('/')[2]; }, { label: 'mission page', timeoutMs: 30_000 });
}

/** Read-only SQL proof: the mission's limit incidents. */
export async function incidents(c, missionId) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(`${c.env.home}/tandemise.db`, { readOnly: true });
  try {
    return missionId === null
      ? db.prepare('SELECT * FROM limit_incidents WHERE mission_id IS NULL ORDER BY created_at').all()
      : db.prepare('SELECT * FROM limit_incidents WHERE mission_id = ? ORDER BY created_at').all(missionId);
  } finally { db.close(); }
}

/** Read-only SQL proof: how many runs the mission has had. */
export async function runCount(c, missionId) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(`${c.env.home}/tandemise.db`, { readOnly: true });
  try { return db.prepare('SELECT count(*) AS n FROM runs WHERE mission_id = ?').get(missionId).n; } finally { db.close(); }
}

/** The mission page's visible text (any tab). */
export async function missionText(c, id, tab = '') {
  await c.page.navigate(`#/missions/${id}${tab ? `/${tab}` : ''}`);
  await c.sleep(1500);
  return c.page.text('body');
}

/** The "Limit" section of the Metrics tab. */
export async function limitSectionText(c, id) {
  await c.page.navigate(`#/missions/${id}/metrics`);
  await c.until(() => c.page.evaluate(`Boolean(document.querySelector('section[aria-label="Limit"]'))`), { label: 'limit section', timeoutMs: 15_000 });
  await c.sleep(800);
  return c.page.evaluate(`document.querySelector('section[aria-label="Limit"]').innerText`);
}

/** Types into the limit card's number field on the page (mission panel or Inbox) and clicks a button on it. */
export async function answerLimitCard(c, { raiseTo, button }) {
  const ok = await c.page.evaluate(`(() => {
    const card = [...document.querySelectorAll('.approval')].find((a) => a.offsetParent && [...a.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Raise limit and resume'));
    if (!card) return 'no limit card';
    ${raiseTo === undefined ? '' : `
    const input = [...card.querySelectorAll('label')].find((l) => l.innerText.trim().startsWith('Raise limit to'))?.querySelector('input');
    if (!input) return 'no number field';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(String(raiseTo))});
    input.dispatchEvent(new Event('input', { bubbles: true }));`}
    return true;
  })()`);
  if (ok !== true) throw new Error(`limit card: ${ok}`);
  await c.sleep(300);
  const clicked = await c.page.evaluate(`(() => {
    const card = [...document.querySelectorAll('.approval')].find((a) => a.offsetParent && [...a.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Raise limit and resume'));
    const b = card && [...card.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(button)} && !x.disabled);
    if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true;
  })()`);
  if (!clicked) throw new Error(`no enabled "${button}" on the limit card`);
  await c.sleep(1200);
}
