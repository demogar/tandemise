// Shared by the P9 scenarios: missions on the one-step "P9 implement" workflow,
// and reading and acting on the Inbox's Stalled and Quiet rows in the window.
import { readState, writeState } from '../p0/lib/ctx.mjs';

export { readState, writeState };
export { cleanSlate, statusOf, missionOf, timelineText } from '../p7/common.mjs';
export { createWithLimit } from '../p8/common.mjs';

export const WORKFLOW = 'P9 implement';

/** The Inbox's visible text: what is waiting, without the "Decided" history under it (a solo project has no filter). */
export async function inboxText(c) {
  await c.page.navigate('#/inbox');
  await c.sleep(1500);
  return (await c.page.text('main')).split('\nDecided\n')[0];
}

/** The visible text of one Inbox row by its aria-label ("Stalled: <mission>", "Quiet: <step>"), or ''. */
export const rowText = (c, label) => c.page.evaluate(`[...document.querySelectorAll('[aria-label]')].find((r) => r.getAttribute('aria-label') === ${JSON.stringify(label)} && r.offsetParent)?.innerText ?? ''`);

/** Waits on the Inbox until the row is shown, and returns its text. */
export async function waitForRow(c, label, timeoutMs = 60_000) {
  await c.page.navigate('#/inbox');
  return c.until(async () => { const t = await rowText(c, label); return t.length > 0 && t; }, { label: `row "${label}"`, timeoutMs });
}

/** Clicks a button in the Inbox row labelled `label`. */
export async function clickInRow(c, label, button) {
  const ok = await c.page.evaluate(`(() => {
    const row = [...document.querySelectorAll('[aria-label]')].find((r) => r.getAttribute('aria-label') === ${JSON.stringify(label)} && r.offsetParent);
    const b = row && [...row.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(button)} && !x.disabled);
    if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true;
  })()`);
  if (!ok) throw new Error(`no enabled "${button}" in row "${label}"`);
  await c.sleep(1200);
}

/** Read-only proof: the Inbox as the daemon derives it. */
export const inboxView = (c) => c.api.get(`/v1/inbox?workspaceId=${c.env.workspaceId}`);

/** Read-only SQL proof: the mission's runs, oldest first. */
export const runsOf = (c, missionId) => c.sql('SELECT id, status, attempt FROM runs WHERE mission_id = ? ORDER BY started_at, rowid', missionId);
