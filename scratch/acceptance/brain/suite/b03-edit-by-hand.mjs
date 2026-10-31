// B3 — Someone edits factory/roles/development.md in their own clone and pushes; home 2 presses Sync now.
// Team → Roles shows the new model, and no preview or choice appears: the brain is the source of truth.
import { Evidence } from '../../p0/lib/evidence.mjs';
import { brainSectionText, clickIn, editBrainByHand, home2, openBrainSection, roleModelInWindow } from '../common.mjs';

const c = await home2();
const ev = new Evidence('B3', 'An edit pushed to the brain reaches the app on Sync, with no prompt to choose');
editBrainByHand({ 'factory/roles/development.md': (t) => t.replace('model: brain-model', 'model: edited-model') }, 'chore: try the edited model');
ev.note('pushed by hand: factory/roles/development.md model brain-model → edited-model');
await openBrainSection(c);
await clickIn(c, 'section[aria-label="Brain"]', 'Sync now');
await c.until(async () => !(await brainSectionText(c)).includes('Syncing…'), { label: 'synced', timeoutMs: 60_000 });
await c.sleep(800);
ev.check('no preview dialog is shown', !(await c.page.evaluate(`Boolean(document.querySelector('[aria-label="Brain preview"]'))`)));
await c.page.screenshot(ev.shot('synced'));
const model = await roleModelInWindow(c, 'Developer');
ev.check('Team → Roles → Developer shows edited-model', model === 'edited-model', model);
await c.page.screenshot(ev.shot('team-roles'));
c.close(); ev.save();
