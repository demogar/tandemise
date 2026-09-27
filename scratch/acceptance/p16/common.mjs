// Shared by the P16 scenarios: the notification recorder in the desktop main
// process (TANDEMISE_NOTIFY_RECORD), reached through the window's bridge, and
// the daemon's settings file as proof of what was recorded.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export { cleanSlate } from '../p7/common.mjs';
export { createDraft, refine } from '../p6/common.mjs';

/** One call into the main process's notification debug hook (list, click, hide, window, focus, pause, resume, poll). */
export const debug = (c, op, arg) =>
  c.page.evaluate(`window.tandemise.notificationsDebug(${JSON.stringify(op)}${arg === undefined ? '' : `, ${JSON.stringify(arg)}`})`);

/** Every notification the main process has shown this run, oldest first. */
export const shown = (c) => debug(c, 'list');

/** Waits until more than `count` notifications were shown; returns the list. */
export async function waitShown(c, count, timeoutMs = 20_000) {
  return c.until(async () => { const list = await shown(c); return list.length > count && list; }, { label: `notification #${count + 1}`, timeoutMs, everyMs: 500 });
}

/** Polls the daemon `times` times from the main process; returns how many notices came back in total. */
export async function pollTimes(c, times = 3) {
  let total = 0;
  for (let i = 0; i < times; i++) { total += await debug(c, 'poll'); await c.sleep(300); }
  return total;
}

/** The daemon's settings file: the notification state it recorded (proof only). */
export function notifyState(c) {
  const settings = JSON.parse(readFileSync(join(c.env.home ?? join(process.env.ACCEPTANCE_SCRATCH, 'home'), 'settings.json'), 'utf8'));
  return settings.notificationState ?? { notified: [], held: [] };
}

/**
 * A mission from the window on the one-step "P2 solo" workflow, left at its
 * plan card: one "Decision needed" item in the Inbox. Returns its id, title and card.
 */
export async function missionAtPlanCard(c, goal) {
  const id = await c.createMission(goal, { workflow: 'P2 solo' });
  const card = await c.until(async () => (await c.approvals(id, 'PENDING')).find((a) => a.kind === 'plan'), { label: 'plan card', timeoutMs: 60_000 });
  const title = (await c.api.get(`/v1/missions/${id}`)).mission.title;
  return { id, title, card };
}

/** The Notifications section in Settings, freshly opened. */
export async function openNotificationSettings(c) {
  await c.page.navigate('#/settings');
  await c.until(() => c.page.evaluate(`Boolean(document.querySelector('section[aria-label="Notifications"] [role=switch]'))`), { label: 'Notifications section', timeoutMs: 20_000 });
  await c.page.evaluate(`document.querySelector('section[aria-label="Notifications"]').scrollIntoView({ block: 'center' })`);
  await c.sleep(500);
}

export const SECTION = 'section[aria-label="Notifications"]';

/** A switch's state in the Notifications section, by its label. */
export const switchOn = (c, label) => c.page.evaluate(`document.querySelector('${SECTION} [role=switch][aria-label=${JSON.stringify(label)}]')?.getAttribute('aria-checked') === 'true'`);

/** Local HH:MM of an instant, as the daemon (same machine) reads it. */
export const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** The page at the documentation size (1360x900), for the guide's screenshots. */
export async function docSize(c) {
  await c.page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.sleep(400);
}
export const clearSize = (c) => c.page.send('Emulation.clearDeviceMetricsOverride');
