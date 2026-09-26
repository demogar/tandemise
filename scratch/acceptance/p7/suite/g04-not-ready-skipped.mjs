// G4 — A queued Urgent that still needs refinement is skipped: the next ready mission is pulled, and the Urgent waits in the queue saying what it needs.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { addToBacklog, backlogRows, cleanSlate, openBacklog, setLimit, statusOf, timelineText, wipText } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('G4', 'A queued mission that is not ready is skipped');
await cleanSlate(c, ev);
const run = Date.now().toString(36);

await openBacklog(c);
await setLimit(c, '1');
const rough = await addToBacklog(c, `G4 urgent but rough: make onboarding nicer ${run}`, { priority: 'Urgent', doneWhen: null });
await sleep(3000);
ev.check('a queued mission with no Done-when line is not pulled, even with a free slot', (await statusOf(c, rough)) === 'DRAFT');
await openBacklog(c);
let rows = await backlogRows(c);
const tRough = (await c.api.get(`/v1/missions/${rough}`)).mission.title;
const roughRow = rows.find((r) => r.title === tRough);
ev.check('its row: Urgent, "Needs refinement", "Queued · 1/1"', roughRow?.chip === 'Urgent' && roughRow.readiness === 'Needs refinement' && roughRow.queue === 'Queued · 1/1', roughRow);
ev.check('and what it needs: "Add at least one Done-when criterion to plan"', roughRow?.subtitle === 'Add at least one Done-when criterion to plan', roughRow?.subtitle);
await page.screenshot(ev.shot('rough-waits'));

const ready = await addToBacklog(c, `G4 normal and ready: a hello page ${run}`);
await until(async () => (await statusOf(c, ready)) !== 'DRAFT', { label: 'ready one pulled', timeoutMs: 30_000 });
ev.check('proof (API): the ready Normal is pulled; the rough Urgent stays a draft', (await statusOf(c, ready)) !== 'DRAFT' && (await statusOf(c, rough)) === 'DRAFT');
const timeline = await timelineText(c, ready);
ev.check('its timeline says it was second, and why', timeline.includes('Pulled from the backlog (1 of 1)') && timeline.includes('It was number 2 in the queue; 1 mission ahead of it is not ready to plan yet.'), timeline.slice(0, 500));
await page.screenshot(ev.shot('ready-pulled-timeline'));

await openBacklog(c);
rows = await backlogRows(c);
const wip = await wipText(c);
ev.check('the rough Urgent is still "Queued · 1/1", "Needs refinement"', rows.length === 1 && rows[0].title === tRough && rows[0].queue === 'Queued · 1/1' && rows[0].readiness === 'Needs refinement', rows);
ev.check('header: "Working on 1 of 1 · 1 queued"', wip.includes('Working on 1 of 1 · 1 queued'), wip);
await page.screenshot(ev.shot('backlog-after'));
c.close(); ev.save();
