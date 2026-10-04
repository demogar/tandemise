// F2 — A step says the plan no longer fits, and the person skips the rest. Intake's handoff says stop: it
// succeeds, the steps after it wait with the reason, the card is in the Inbox and on intake's feed card, and
// "Skip the steps after it" in the window skips both and finishes the mission.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { card, docsSize, openFeed, waitTask } from '../../p3/common.mjs';
import { CARD, HELD, STOP, stoppedMission } from '../common.mjs';

const c = await context();
const { page, api } = c;
await docsSize(c);
const ev = new Evidence('F2', 'A stop holds the steps after it; skipping them finishes the mission');

const { missionId, intake, draft, card: pending } = await stoppedMission(c, 'skip');
ev.check('proof (API): intake succeeded, its handoff says stop', intake.status === 'SUCCEEDED'
  && (await api.get(`/v1/missions/${missionId}`)).artifacts.some((a) => a.taskId === intake.id && a.handoff?.stop === STOP));
ev.check(`proof (API): draft waits, PENDING with "${HELD}"`, draft.status === 'PENDING' && draft.statusReason === HELD, { status: draft.status, reason: draft.statusReason });
ev.check('proof (API): one card, offering skip, send back and continue',
  JSON.stringify(pending.options.map((o) => o.label)) === JSON.stringify(['Skip the steps after it', 'Send it back with a note', 'Continue as planned']), pending.options);

await openFeed(c, missionId);
const intakeCard = await c.until(async () => { const t = await card(c, 'intake'); return t.includes('Skip the steps after it') && t; }, { label: 'decision on the intake card', timeoutMs: 15_000 }).catch(async () => card(c, 'intake'));
ev.check('the intake card in the feed carries the decision and the stop', intakeCard.includes('Skip the steps after it') && intakeCard.includes(STOP), intakeCard.slice(0, 700));
await page.evaluate(`document.querySelector('[data-feed-card="intake"]')?.scrollIntoView({ block: 'center' })`);
await page.screenshot(ev.shot('feed-plan-no-longer-fits'));
// A step that has not started has no feed card: the Plan tab and its drawer say why it waits.
await page.navigate(`#/missions/${missionId}/plan`);
await c.sleep(1200);
await c.openTaskDrawer(missionId, 'draft');
const drawer = await c.dialogText('draft');
ev.check(`draft's drawer says "${HELD}"`, drawer.includes(HELD), drawer.slice(0, 500));
await page.screenshot(ev.shot('draft-held-drawer'));
await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

await page.navigate('#/inbox');
await c.sleep(1200);
const inbox = await page.text('body');
ev.check('the Inbox lists it as "Plan no longer fits"', inbox.includes(CARD) && inbox.includes('Plan no longer fits'), inbox.slice(0, 800));
await c.decideInInbox(CARD, { filter: 'For me', option: 'Skip the steps after it' });
await page.screenshot(ev.shot('inbox-decided-skip'));

const draftAfter = await waitTask(c, missionId, 'draft', (t) => t.status === 'SKIPPED', 'draft skipped', 30_000).catch(() => c.task(missionId, 'draft'));
const polish = await c.task(missionId, 'polish');
const reason = "Skipped: 'intake' said the plan no longer fits.";
ev.check(`proof (API): draft and polish are SKIPPED with "${reason}"`,
  [draftAfter, polish].every((t) => t.status === 'SKIPPED' && t.statusReason === reason), [draftAfter, polish].map((t) => [t.key, t.status, t.statusReason]));
const mission = await c.until(async () => { const m = (await api.get(`/v1/missions/${missionId}`)).mission; return m.status === 'COMPLETE' && m; }, { label: 'mission complete', timeoutMs: 30_000 }).catch(async () => (await api.get(`/v1/missions/${missionId}`)).mission);
ev.check('proof (API): the mission finished on what was done', mission.status === 'COMPLETE', mission.status);
ev.check('proof (API): nothing after intake ever ran', c.runs(draftAfter.id).length === 0 && c.runs(polish.id).length === 0);
await openFeed(c, missionId);
await page.screenshot(ev.shot('mission-finished-after-skip'));

c.close(); ev.save();
