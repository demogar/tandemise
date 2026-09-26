// H2 — On H1's card, "Keep paused": the mission stays paused, the incident is resolved, no more runs.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { answerLimitCard, incidents, missionText, readState, runCount, statusOf } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('H2', 'Keep paused leaves the mission stopped');
const { h1 } = readState();
const before = await runCount(c, h1.id);

await missionText(c, h1.id);
await answerLimitCard(c, { button: 'Keep paused' });
await until(async () => (await incidents(c, h1.id)).find((i) => i.threshold === 'hard')?.status === 'resolved', { label: 'resolved', timeoutMs: 15_000 });
const text = await missionText(c, h1.id);
ev.check('still "Paused"', text.includes('Paused') && (await statusOf(c, h1.id)) === 'PAUSED');
ev.check('and says how to go on: "Kept paused at its limit: 15 of 12 agent minutes. Raise the limit to resume."', text.includes('Kept paused at its limit: 15 of 12 agent minutes. Raise the limit to resume.'), text.slice(0, 500));
ev.check('the card is gone from the mission page', !text.includes('Raise limit and resume'));
await page.screenshot(ev.shot('kept-paused'));
const card = (await c.approvals(h1.id)).find((a) => a.kind === 'intervention' && a.taskId === null);
ev.check('proof (API): the card was answered "Keep paused"', card?.status === 'REJECTED' && card.selectedOptionId === 'keep_paused' && card.decidedBy === c.me, card && { status: card.status, option: card.selectedOptionId });
ev.check('proof (SQL): the hard incident is resolved', (await incidents(c, h1.id)).find((i) => i.threshold === 'hard')?.status === 'resolved');

// Resume from the header is refused at the limit, with the reason.
await c.missionAction(h1.id, 'Resume');
await sleep(1500);
const after = await page.text('body');
ev.check('Resume is refused and says why: "Limit reached: 15 of 12 agent minutes. Raise the limit to resume this mission."', after.includes('Limit reached: 15 of 12 agent minutes. Raise the limit to resume this mission.'), after.slice(0, 500));
await page.screenshot(ev.shot('resume-refused'));
await sleep(5000);
ev.check('proof (SQL): no run after "Keep paused"', (await runCount(c, h1.id)) === before && (await statusOf(c, h1.id)) === 'PAUSED', { before, after: await runCount(c, h1.id) });
c.close(); ev.save();
