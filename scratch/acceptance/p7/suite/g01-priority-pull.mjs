// G1 — Limit off, three missions added to the backlog (Normal, Urgent, Low); setting "Work on at most 1" pulls Urgent into planning, and the other two wait in order.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { addToBacklog, backlogRows, cleanSlate, openBacklog, setLimit, statusOf, wipText, writeState } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('G1', 'The urgent mission is pulled first; the rest wait in order');
await cleanSlate(c, ev);

const run = Date.now().toString(36);
const normal = await addToBacklog(c, `G1 normal: a hello page ${run}`);
const urgent = await addToBacklog(c, `G1 urgent: fix the sign-in crash ${run}`, { priority: 'Urgent' });
const low = await addToBacklog(c, `G1 low: tidy the footer ${run}`, { priority: 'Low' });
ev.check('"Add to backlog" leaves each one a queued draft', (await Promise.all([normal, urgent, low].map((id) => statusOf(c, id)))).every((s) => s === 'DRAFT'));

await openBacklog(c);
await setLimit(c, 'Off');
let rows = await backlogRows(c);
const titleOf = async (id) => (await c.api.get(`/v1/missions/${id}`)).mission.title;
const [tn, tu, tl] = await Promise.all([normal, urgent, low].map(titleOf));
ev.check('the backlog lists Urgent, Normal, Low in that order', rows.map((r) => r.title).join('|') === [tu, tn, tl].join('|'), rows.map((r) => `${r.chip} ${r.title}`));
ev.check('each row: priority chip, "Ready", and its place in the queue', rows[0]?.chip === 'Urgent' && rows[2]?.chip === 'Low' && rows.every((r) => r.readiness === 'Ready') && rows.map((r) => r.queue).join('|') === 'Queued · 1/3|Queued · 2/3|Queued · 3/3', rows);
let wip = await wipText(c);
ev.check('limit off: "Working on 0 · no limit · 3 queued"', wip.includes('Working on 0 · no limit · 3 queued'), wip);
await page.screenshot(ev.shot('backlog-limit-off'));

await setLimit(c, '1');
await until(async () => (await statusOf(c, urgent)) !== 'DRAFT', { label: 'urgent pulled', timeoutMs: 30_000 });
await until(async () => (await backlogRows(c)).length === 2, { label: 'backlog of two', timeoutMs: 15_000 }).catch(() => undefined);
await sleep(800);
rows = await backlogRows(c);
wip = await wipText(c);
ev.check('the urgent mission leaves the backlog', !rows.some((r) => r.title === tu), rows.map((r) => r.title));
ev.check('Normal reads "Queued · 1/2", Low "Queued · 2/2"', rows.map((r) => `${r.title}=${r.queue}`).join('|') === `${tn}=Queued · 1/2|${tl}=Queued · 2/2`, rows);
ev.check('header: "Working on 1 of 1 · 2 queued"', wip.includes('Working on 1 of 1 · 2 queued'), wip);
ev.check('the hint says it is full and what happens next', wip.includes('Full: the next queued mission that is ready is planned as soon as one in progress finishes.'), wip);
await page.screenshot(ev.shot('urgent-pulled'));

await page.navigate(`#/missions/${urgent}`);
const header = await until(async () => { const t = await page.text('.topbar'); return /Planning|Awaiting plan approval/.test(t) && t; }, { label: 'urgent header', timeoutMs: 20_000 }).catch(() => page.text('.topbar'));
ev.check('the urgent mission is being planned (Planning, then its plan approval)', /Planning|Awaiting plan approval/.test(header), header.slice(0, 200));
const statuses = await Promise.all([urgent, normal, low].map((id) => statusOf(c, id)));
ev.check('proof (API): urgent left DRAFT; normal and low are still DRAFT', statuses[0] !== 'DRAFT' && statuses[1] === 'DRAFT' && statuses[2] === 'DRAFT', statuses);
const pulled = c.sql(`SELECT body FROM run_events WHERE mission_id = ? AND type = 'mission.pulled'`, urgent).map((r) => JSON.parse(r.body));
ev.check('proof (SQL): one mission.pulled {position 1, limit 1, active 1}', pulled.length === 1 && pulled[0].position === 1 && pulled[0].limit === 1 && pulled[0].active === 1, pulled);
await page.screenshot(ev.shot('urgent-planning'));

writeState({ g: { run, normal, urgent, low, titles: { normal: tn, urgent: tu, low: tl } } });
c.close(); ev.save();
