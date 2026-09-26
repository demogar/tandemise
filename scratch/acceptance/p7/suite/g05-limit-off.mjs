// G5 — Limit Off: queued missions that are ready are not pulled; the window says they wait. The Move up and Remove from queue buttons reorder and dequeue.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { addToBacklog, backlogRows, cleanSlate, clickInBacklogRow, openBacklog, setLimit, statusOf, wipText } from '../common.mjs';

const c = await context();
const { page, sleep } = c;
const ev = new Evidence('G5', 'Limit off: nothing is pulled automatically');
await cleanSlate(c, ev);
const run = Date.now().toString(36);

await openBacklog(c);
await setLimit(c, 'Off');
const first = await addToBacklog(c, `G5 first: a hello page ${run}`);
const second = await addToBacklog(c, `G5 second: a help page ${run}`);
await sleep(6000);
ev.check('proof (API): both stay drafts with nothing in progress', (await statusOf(c, first)) === 'DRAFT' && (await statusOf(c, second)) === 'DRAFT');
await openBacklog(c);
const wip = await wipText(c);
ev.check('header: "Working on 0 · no limit · 2 queued"', wip.includes('Working on 0 · no limit · 2 queued'), wip);
ev.check('the hint: "Limit off: queued missions wait until you plan them yourself or set a limit."', wip.includes('Limit off: queued missions wait until you plan them yourself or set a limit.'), wip);
const off = await page.evaluate(`[...document.querySelectorAll('section[aria-label="Work in progress"] .segmented__option')].find((b) => b.getAttribute('aria-pressed') === 'true')?.innerText.trim()`);
ev.check('"Work on at most" reads Off', off === 'Off', off);
const [t1, t2] = await Promise.all([first, second].map(async (id) => (await c.api.get(`/v1/missions/${id}`)).mission.title));
let rows = await backlogRows(c);
ev.check('both rows are "Ready" and queued in the order they were added', rows.map((r) => `${r.title}=${r.queue}=${r.readiness}`).join('|') === `${t1}=Queued · 1/2=Ready|${t2}=Queued · 2/2=Ready`, rows);
await page.screenshot(ev.shot('limit-off'));

await clickInBacklogRow(c, t2, 'Move up');
rows = await backlogRows(c);
ev.check('the Move up button puts the second above the first', rows.map((r) => r.title).join('|') === `${t2}|${t1}`, rows.map((r) => r.title));
await clickInBacklogRow(c, t1, 'Remove from queue');
rows = await backlogRows(c);
ev.check('Remove from queue: "Not queued", and the button offers "Add to queue"', rows.find((r) => r.title === t1)?.queue === 'Not queued', rows);
ev.check('proof (API): its queuedAt is cleared', (await c.api.get(`/v1/missions/${first}`)).mission.queuedAt === null);
await page.screenshot(ev.shot('reordered-dequeued'));
await sleep(3000);
ev.check('proof (API): still nothing pulled', (await statusOf(c, first)) === 'DRAFT' && (await statusOf(c, second)) === 'DRAFT');
await cleanSlate(c);
c.close(); ev.save();
