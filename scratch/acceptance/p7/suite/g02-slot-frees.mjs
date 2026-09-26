// G2 — Approve the urgent mission's plan in the Inbox; when it completes, the next queued mission (Normal) is pulled, and its timeline says so.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { backlogRows, openBacklog, readState, statusOf, timelineText, wipText } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('G2', 'A freed slot pulls the next queued mission');
const { g } = readState();

await c.approvePlan(g.urgent, g.titles.urgent);
await until(async () => (await statusOf(c, g.urgent)) === 'COMPLETE', { label: 'urgent complete', timeoutMs: 180_000 });
ev.check('the urgent mission completes', (await statusOf(c, g.urgent)) === 'COMPLETE');
await until(async () => (await statusOf(c, g.normal)) !== 'DRAFT', { label: 'normal pulled', timeoutMs: 30_000 });
ev.check('proof (API): Normal is pulled once the slot is free; Low still waits', (await statusOf(c, g.normal)) !== 'DRAFT' && (await statusOf(c, g.low)) === 'DRAFT', [await statusOf(c, g.normal), await statusOf(c, g.low)]);

const timeline = await timelineText(c, g.normal);
ev.check('its timeline: "Pulled from the backlog (1 of 1)"', timeline.includes('Pulled from the backlog (1 of 1)'), timeline.slice(0, 600));
ev.check('and why: "It was first in the queue. This project works on at most 1 mission at a time."', timeline.includes('It was first in the queue. This project works on at most 1 mission at a time.'));
await page.screenshot(ev.shot('pulled-timeline'));

await openBacklog(c);
const rows = await backlogRows(c);
const wip = await wipText(c);
ev.check('the backlog now holds only Low, "Queued · 1/1"', rows.length === 1 && rows[0].title === g.titles.low && rows[0].queue === 'Queued · 1/1', rows);
ev.check('header: "Working on 1 of 1 · 1 queued"', wip.includes('Working on 1 of 1 · 1 queued'), wip);
await page.screenshot(ev.shot('backlog-after'));
await sleep(200);
c.close(); ev.save();
