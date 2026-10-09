// R1 — Plan the rest again from a stop. The planner gets what intake found and the note, proposes
// two new steps; nothing changes until the plan card is approved; then the unstarted steps are
// replaced, intake's runs and outputs are untouched, and the new steps run on what intake wrote.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { docsSize, openFeed, waitTask } from '../../p3/common.mjs';
import { CARD, OPTION, history, keys, replanCard, stoppedForReplan } from '../common.mjs';

const c = await context();
const { page, api } = c;
await docsSize(c);
const ev = new Evidence('R1', 'Plan the rest again from a stop: new steps for what is left, built on what is done');

const { missionId, intake } = await stoppedForReplan(c, 'replan');
const before = history(c, intake.id);
await c.decideInInbox(CARD, { filter: 'For me', option: OPTION, note: 'Ask Ashby whether Panama counts, then tailor the application for the Americas.' });
await page.screenshot(ev.shot('inbox-decided-plan-the-rest'));

const card = await replanCard(c, missionId);
const counts = card.evidence.find((e) => e.label === 'Replan')?.value;
ev.check('proof (API): a plan card for the rest, with what it keeps, replaces and adds', counts === 'Keeps 1 step already started · replaces 2 steps not started · adds 2 steps', counts);
const prompt = c.prompts().filter((p) => p.includes('# Already done: plan only the rest')).pop() ?? '';
ev.check('the planner was told what is done, what intake found and the note',
  prompt.includes('`intake` (product, succeeded)') && prompt.includes('Said the plan no longer fits:') && prompt.includes('Ask Ashby whether Panama counts'), prompt.slice(prompt.indexOf('# Already done'), prompt.indexOf('# Already done') + 600));
ev.check('proof (API): nothing changed yet: draft and polish are still there, held', (await keys(c, missionId)).join() === 'draft,intake,polish', await keys(c, missionId));

await openFeed(c, missionId);
await c.sleep(800);
const feed = await page.text('main');
ev.check('the feed asks for the new plan, with the line', feed.includes('Approve the new plan for the rest') || feed.includes('Keeps 1 step already started'), feed.slice(0, 900));
await page.screenshot(ev.shot('feed-new-plan-asks'));

await c.decideInInbox(card.title, { filter: 'For me' });
await page.screenshot(ev.shot('inbox-new-plan-approved'));
const tailor = await waitTask(c, missionId, 'tailor', (t) => t.status === 'SUCCEEDED', 'tailor finished', 90_000).catch(() => c.task(missionId, 'tailor'));
ev.check('proof (API): the new steps ran', tailor?.status === 'SUCCEEDED' && (await c.task(missionId, 'ask_first'))?.status === 'SUCCEEDED', tailor?.status);
ev.check('proof (API): the unstarted steps were replaced', (await keys(c, missionId)).join() === 'ask_first,intake,tailor', await keys(c, missionId));
ev.check('proof (API): intake kept its id, runs and outputs', (await c.task(missionId, 'intake'))?.id === intake.id && JSON.stringify(history(c, intake.id)) === JSON.stringify(before), { before, after: history(c, intake.id) });
const ask = await c.task(missionId, 'ask_first');
const inputs = c.sql('SELECT i.artifact_id FROM run_inputs i JOIN runs r ON r.id = i.run_id WHERE r.task_id = ?', ask.id).map((r) => r.artifact_id);
ev.check('proof (API): the first new step was handed intake\'s output', inputs.some((id) => before.artifacts.includes(id)), inputs);
const done = await c.until(async () => (await api.get(`/v1/missions/${missionId}`)).mission.status === 'COMPLETE', { label: 'complete', timeoutMs: 60_000 }).catch(() => false);
ev.check('proof (API): the mission completed', done === true);
await openFeed(c, missionId);
await c.sleep(800);
await page.screenshot(ev.shot('mission-finished-on-new-plan'));

c.close(); ev.save();
