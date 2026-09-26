// H3 — Another mission stops at 12 minutes; in the Inbox, raise the limit to 30: it is Executing again and reads "15 / 30 agent min".
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { answerLimitCard, cleanSlate, createWithLimit, incidents, limitSectionText, statusOf } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('H3', 'Raise the limit to 30 and the mission resumes');
await cleanSlate(c, ev);

const run = Date.now().toString(36);
const id = await createWithLimit(c, `H3 greeting ${run} SCRIPTED_USAGE_MIN=5`, { amount: 12 });
const title = (await c.api.get(`/v1/missions/${id}`)).mission.title;
await c.approvePlan(id, title);
await until(async () => (await statusOf(c, id)) === 'PAUSED', { label: 'paused', timeoutMs: 150_000 });

await c.ui.openItem(`“${title}” reached its limit`, 'Everyone');
const inbox = await page.text('body');
ev.check('the Inbox card: "reached its limit: 15 of 12 agent minutes", with a number to raise to', inbox.includes('reached its limit: 15 of 12 agent minutes') && inbox.includes('Raise limit to'), inbox.slice(0, 900));
await page.screenshot(ev.shot('inbox-card'));

// A number that would stop it again at once is refused, and the card stays.
await answerLimitCard(c, { raiseTo: 14, button: 'Raise limit and resume' });
const refused = await page.text('body');
ev.check('raising to 14 is refused: "Raise it above 15 agent minutes"', refused.includes('Raise it above 15 agent minutes'), refused.slice(0, 900));
ev.check('proof (API): still paused after the refusal', (await statusOf(c, id)) === 'PAUSED');

await answerLimitCard(c, { raiseTo: 30, button: 'Raise limit and resume' });
await until(async () => (await statusOf(c, id)) !== 'PAUSED', { label: 'resumed', timeoutMs: 15_000 });
const limit = await limitSectionText(c, id);
ev.check('Metrics → Limit reads against 30: "15 / 30 agent min"', limit.includes('15 / 30 agent min'), limit);
const header = await page.text('body');
ev.check('it is working again (Executing)', header.includes('Executing') || (await statusOf(c, id)) === 'EXECUTING', await statusOf(c, id));
await page.screenshot(ev.shot('resumed-15-of-30'));
ev.check('proof (API): the mission now has a 30-minute limit', (await c.api.get(`/v1/missions/${id}`)).mission.limits?.[0]?.amount === 30);
ev.check('proof (SQL): the incident at 12 is resolved', (await incidents(c, id)).find((i) => i.threshold === 'hard' && i.amount_limit === 12)?.status === 'resolved');
const events = await c.events(id);
const resumes = events.filter((r) => r.body.type === 'mission.status' && r.body.from === 'PAUSED' && r.body.to === 'EXECUTING');
ev.check('proof (API): resumed exactly once, "Limit raised to 30 agent minutes; resumed."', resumes.length === 1 && resumes[0].body.reason === 'Limit raised to 30 agent minutes; resumed.', resumes.map((r) => r.body.reason));

await until(async () => (await statusOf(c, id)) === 'COMPLETE', { label: 'complete', timeoutMs: 150_000 });
const done = await limitSectionText(c, id);
ev.check('it finishes under the raised limit: "25 / 30 agent min"', done.includes('25 / 30 agent min'), done);
c.close(); ev.save();
