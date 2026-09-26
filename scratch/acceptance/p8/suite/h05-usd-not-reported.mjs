// H5 — A USD limit on a runtime that reports no cost: "Cost: not reported", no incident, and one note that the limit
// cannot be measured for this runtime. The mission runs to the end.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { cleanSlate, createWithLimit, incidents, limitSectionText, statusOf, timelineText } from '../common.mjs';

const c = await context();
const { page, until } = c;
const ev = new Evidence('H5', 'A USD limit that cannot be measured says so and never stops work');
await cleanSlate(c, ev);

const run = Date.now().toString(36);
const id = await createWithLimit(c, `H5 cost unknown ${run} SCRIPTED_USAGE_MIN=1`, { field: 'Cost (USD) for this mission', amount: 5, workflow: 'P2 solo' });
const title = (await c.api.get(`/v1/missions/${id}`)).mission.title;
await c.approvePlan(id, title);
await until(async () => (await statusOf(c, id)) === 'COMPLETE', { label: 'complete', timeoutMs: 120_000 });

const limit = await limitSectionText(c, id);
ev.check('Metrics → Limit: "not reported / $5.00"', limit.includes('not reported / $5.00'), limit);
ev.check('and "Cost: not reported"', limit.includes('Cost: not reported'), limit);
await page.screenshot(ev.shot('usd-not-reported'));
const timeline = await timelineText(c, id);
ev.check('timeline: "USD limit cannot be measured for this runtime"', timeline.includes('USD limit cannot be measured for this runtime'), timeline.slice(0, 500));
await page.screenshot(ev.shot('timeline-note'));
ev.check('the mission ran to the end', (await statusOf(c, id)) === 'COMPLETE');
ev.check('proof (SQL): no incident', (await incidents(c, id)).length === 0);
const detail = await c.api.get(`/v1/missions/${id}`);
ev.check('proof (API): cost stays null (never 0), tokens are measured', detail.limits.usage.costUsd === null && detail.metrics.costUsd === null && detail.limits.usage.tokens === 1500, detail.limits.usage);
c.close(); ev.save();
