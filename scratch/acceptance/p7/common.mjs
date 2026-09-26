// Shared by the P7 scenarios: missions added to the backlog from the New mission
// form, and reading and driving Missions → Backlog.
import { readState, writeState } from '../p0/lib/ctx.mjs';

export { readState, writeState };

/** Missions still in flight from an earlier scenario would hold a WIP slot: cancel them and turn the limit off (setup shortcut). */
export async function cleanSlate(c, ev) {
  const all = await c.api.get(`/v1/missions?workspaceId=${c.env.workspaceId}`);
  const open = all.filter((s) => !['COMPLETE', 'FAILED', 'CANCELLED'].includes(s.mission.status));
  for (const s of open) await c.api.post(`/v1/missions/${s.mission.id}/cancel`, { reason: 'acceptance: clean slate' }).catch(() => undefined);
  await c.api.patch(`/v1/workspaces/${c.env.workspaceId}`, { maxActiveMissions: null });
  if (open.length > 0) ev?.note(`setup: cancelled ${open.length} mission(s) left by earlier scenarios, limit off`);
}

/**
 * New mission from the window, then "Add to backlog". With `doneWhen` it is
 * ready to plan; without, it needs refinement. Priority is set under More options.
 */
export async function addToBacklog(c, goal, { priority = 'Normal', doneWhen = 'The acceptance scenario finishes its steps', workflow = 'P2 solo' } = {}) {
  const { page, until, sleep } = c;
  await page.navigate('#/missions/new');
  await page.waitForText('What outcome do you want?', { timeoutMs: 30_000 });
  await sleep(400);
  await page.fill('What outcome do you want?', goal);
  if (doneWhen) await page.fill('Done when', doneWhen);
  await page.select('Repository', 'acceptance-project');
  await page.select('Workflow', workflow);
  if (priority !== 'Normal') {
    await page.click('More options');
    await page.waitForText('Priority');
    await page.click(priority);
  }
  await page.click('Add to backlog');
  const id = await until(async () => { const h = await page.evaluate('location.hash'); return /#\/missions\/msn_/.test(h) && h.split('/')[2]; }, { label: 'mission page', timeoutMs: 30_000 });
  await sleep(500);
  return id;
}

/** Missions → Backlog. */
export async function openBacklog(c) {
  const { page, sleep, until } = c;
  await page.navigate('#/missions');
  await until(() => page.evaluate(`(() => { const t = [...document.querySelectorAll('.tab')].find((b) => b.innerText.trim().startsWith('Backlog')); if (!t) return false; t.click(); return true; })()`), { label: 'Backlog tab', timeoutMs: 15_000 });
  await until(() => page.evaluate(`Boolean(document.querySelector('section[aria-label="Work in progress"]'))`), { label: 'backlog panel', timeoutMs: 15_000 });
  await sleep(600);
}

/** Each backlog row as the window shows it. */
export const backlogRows = (c) => c.page.evaluate(`[...document.querySelectorAll('section[aria-label="Backlog"] .list__row')].map((r) => ({
  title: r.querySelector('.list__title a')?.innerText.trim() ?? '',
  priority: r.querySelector('select')?.selectedOptions[0]?.text ?? '',
  chip: r.firstElementChild?.innerText.trim() ?? '',
  readiness: r.querySelector('.list__aside .badge')?.innerText.trim() ?? '',
  queue: [...r.querySelectorAll('.list__aside > span')].map((s) => s.innerText.trim()).find((t) => t.startsWith('Queued') || t === 'Not queued') ?? '',
  subtitle: r.querySelector('.list__subtitle')?.innerText.trim() ?? '',
  selected: r.getAttribute('data-active') === 'true',
}))`);

/** The headline and the hint over the backlog. */
export const wipText = (c) => c.page.evaluate(`document.querySelector('section[aria-label="Work in progress"]')?.innerText ?? ''`);

/** "Work on at most": Off, 1, 2, 3 or 5. */
export async function setLimit(c, label) {
  const ok = await c.page.evaluate(`(() => { const b = [...document.querySelectorAll('section[aria-label="Work in progress"] .segmented__option')].find((x) => x.innerText.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`no limit option ${label}`);
  await c.sleep(800);
}

/** Clicks a button (by visible text or aria-label) in the backlog row titled `title`. */
export async function clickInBacklogRow(c, title, label) {
  const ok = await c.page.evaluate(`(() => {
    const row = [...document.querySelectorAll('section[aria-label="Backlog"] .list__row')].find((r) => r.querySelector('.list__title a')?.innerText.trim() === ${JSON.stringify(title)});
    const b = row && [...row.querySelectorAll('button')].find((x) => (x.innerText.trim() || x.getAttribute('aria-label')) === ${JSON.stringify(label)} && !x.disabled);
    if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true;
  })()`);
  if (!ok) throw new Error(`no enabled "${label}" in backlog row "${title}"`);
  await c.sleep(900);
}

/** A real key press through CDP (not a synthetic DOM event), with ⌥ when asked. */
export async function press(c, key, { alt = false } = {}) {
  const codes = { j: ['KeyJ', 74, 'j'], k: ['KeyK', 75, 'k'], ArrowUp: ['ArrowUp', 38, ''], ArrowDown: ['ArrowDown', 40, ''] };
  const [code, vk, text] = codes[key];
  await c.page.evaluate('document.activeElement?.blur?.()');
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: alt ? 1 : 0 };
  await c.page.send('Input.dispatchKeyEvent', { type: text && !alt ? 'keyDown' : 'rawKeyDown', ...base, ...(text && !alt ? { text } : {}) });
  await c.page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await c.sleep(700);
}

export const missionOf = async (c, id) => (await c.api.get(`/v1/missions/${id}`)).mission;
export const statusOf = async (c, id) => (await missionOf(c, id)).status;

/** A mission's Timeline tab text. */
export async function timelineText(c, id) {
  await c.page.navigate(`#/missions/${id}/timeline`);
  await c.sleep(1500);
  return c.page.text('body');
}

/** Cancels from the window: header "Cancel", then "Cancel mission" in the dialog. */
export async function cancelInWindow(c, id) {
  await c.missionAction(id, 'Cancel');
  await c.until(() => c.page.evaluate(`[...document.querySelectorAll('[role=dialog] button')].some((b) => b.innerText.trim() === 'Cancel mission')`), { label: 'cancel dialog', timeoutMs: 10_000 });
  await c.page.evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim() === 'Cancel mission')?.click()`);
  await c.until(async () => (await statusOf(c, id)) === 'CANCELLED', { label: 'cancelled', timeoutMs: 15_000 });
}
