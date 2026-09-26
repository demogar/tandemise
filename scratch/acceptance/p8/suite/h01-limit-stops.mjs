// H1 — A mission with a 12 agent-minute limit whose runs each report 5 minutes: the timeline warns after run 2 (10 of 12, 83%),
// and after run 3 the mission is Paused with "Limit reached: 15 of 12 agent minutes" and a card to raise or keep paused.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { cleanSlate, createWithLimit, incidents, limitSectionText, missionText, runCount, statusOf, timelineText, writeState } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('H1', 'A 12-minute limit warns at 80% and stops the mission at 100%');
await cleanSlate(c, ev);

const run = Date.now().toString(36);
const id = await createWithLimit(c, `H1 hello page ${run} SCRIPTED_USAGE_MIN=5`, { amount: 12 });
const title = (await c.api.get(`/v1/missions/${id}`)).mission.title;
ev.check('proof (API): the mission carries its own 12-minute limit, warning at 80%', JSON.stringify((await c.api.get(`/v1/missions/${id}`)).mission.limits) === JSON.stringify([{ metric: 'agent_minutes', amount: 12, warnPercent: 80 }]));
await c.approvePlan(id, title);

// After run 2: the warning note, while the mission keeps working.
await until(async () => (await incidents(c, id)).some((i) => i.threshold === 'soft'), { label: 'soft incident', timeoutMs: 120_000 });
const afterTwo = await runCount(c, id);
const timeline = await timelineText(c, id);
ev.check('timeline: "Limit warning: 10 of 12 agent minutes used (83%). Work stops at 12 agent minutes."', timeline.includes('Limit warning: 10 of 12 agent minutes used (83%). Work stops at 12 agent minutes.'), timeline.slice(0, 400));
ev.check('proof (SQL): the warning came after run 2 (soft incident at 10 minutes)', (await incidents(c, id)).find((i) => i.threshold === 'soft')?.amount_observed === 10 && afterTwo >= 2, { afterTwo });
await page.screenshot(ev.shot('warning-note'));

// After run 3: stopped.
await until(async () => (await statusOf(c, id)) === 'PAUSED', { label: 'paused', timeoutMs: 120_000 });
const feed = await missionText(c, id);
ev.check('the mission reads "Paused"', feed.includes('Paused'), feed.slice(0, 300));
ev.check('and says "Limit reached: 15 of 12 agent minutes"', feed.includes('Limit reached: 15 of 12 agent minutes'));
ev.check('the limit card is on the mission page: "Raise limit and resume" / "Keep paused"', feed.includes('Raise limit and resume') && feed.includes('Keep paused') && feed.includes('Raise limit to'), feed.slice(0, 1200));
await page.screenshot(ev.shot('paused-with-card'));

const limit = await limitSectionText(c, id);
ev.check('Metrics → Limit: "15 / 12 agent min"', limit.includes('15 / 12 agent min'), limit);
await page.screenshot(ev.shot('metrics-limit'));

await page.navigate('#/');
await sleep(1500);
const home = await page.text('body');
ev.check('Home: a banner with the numbers', home.includes('Limit reached: 15 of 12 agent minutes'), home.slice(0, 600));
await page.screenshot(ev.shot('home-banner'));

const inc = await incidents(c, id);
ev.check('proof (SQL): one soft and one hard incident, the hard one open', JSON.stringify(inc.map((i) => [i.threshold, i.status, i.amount_limit, i.amount_observed])) === JSON.stringify([['soft', 'open', 12, 10], ['hard', 'open', 12, 15]]), inc.map((i) => [i.threshold, i.status, i.amount_limit, i.amount_observed]));
ev.check('proof (SQL): exactly three runs', (await runCount(c, id)) === 3, await runCount(c, id));
await sleep(6000);
ev.check('proof (SQL): nothing more runs while it is paused', (await runCount(c, id)) === 3 && (await statusOf(c, id)) === 'PAUSED');

writeState({ h1: { id, title } });
c.close(); ev.save();
