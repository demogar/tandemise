// H4 — The project is at 85% of its monthly limit, WIP 1, a Normal and a High mission queued: High is pulled, Normal waits
// with "Held: this project is over 80% of its monthly limit …".
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { addToBacklog, backlogRows, cleanSlate, openBacklog, setLimit, statusOf } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('H4', 'Over 80% of the monthly limit, only urgent and high work is pulled');
await cleanSlate(c, ev);
await c.api.patch(`/v1/workspaces/${c.env.workspaceId}`, { monthlyLimits: [] });

const run = Date.now().toString(36);
const normal = await addToBacklog(c, `H4 normal: tidy the footer ${run}`, { workflow: 'P2 solo' });
const high = await addToBacklog(c, `H4 high: fix the sign-in crash ${run}`, { workflow: 'P2 solo', priority: 'High' });

// Set the monthly limit in Repositories → Limits so this month's usage sits at about 85% of it.
const used = (await c.api.get(`/v1/workspaces/${c.env.workspaceId}/usage`)).usage.agentMinutes;
const amount = Math.ceil(used / 0.85);
ev.note(`this month so far: ${used} agent minutes; monthly limit set to ${amount}`);
await page.navigate('#/project');
await until(() => page.evaluate(`Boolean(document.querySelector('section[aria-label="Limits"]'))`), { label: 'limits section', timeoutMs: 15_000 });
await sleep(800);
await page.fill('Agent minutes per month', String(amount));
await page.click('Save monthly limit');
await until(async () => (await c.api.get(`/v1/workspaces/${c.env.workspaceId}`)).workspace.monthlyLimits?.[0]?.amount === amount, { label: 'monthly limit saved', timeoutMs: 10_000 });
await sleep(5500);
const limits = await page.evaluate(`document.querySelector('section[aria-label="Limits"]').innerText`);
ev.check(`Repositories → Limits: "${Math.round(used)} / ${amount} agent min" this month, over 80%`, limits.includes(`/ ${amount} agent min`) && limits.includes('Over 80%'), limits);
await page.screenshot(ev.shot('project-limits'));

await page.navigate('#/');
await sleep(1500);
const home = await page.text('body');
// P10: the desk's month banner replaced the P8 wording on Home (same numbers, the rule first).
ev.check('Home: "Monthly limit at 8x% — only urgent and high work will be pulled. This project used … this month …"', /Monthly limit at 8\d% — only urgent and high work will be pulled\. This project used /.test(home), home.slice(0, 700));
await page.screenshot(ev.shot('home-month-warning'));

await openBacklog(c);
await setLimit(c, '1');
await until(async () => (await statusOf(c, high)) !== 'DRAFT', { label: 'high pulled', timeoutMs: 30_000 });
await sleep(3000);
const rows = await backlogRows(c);
const normalTitle = (await c.api.get(`/v1/missions/${normal}`)).mission.title;
const row = rows.find((r) => r.title === normalTitle);
ev.check('the High mission is pulled', (await statusOf(c, high)) !== 'DRAFT', await statusOf(c, high));
ev.check('the Normal mission waits, and its row says "Held: this project is over 80% of its monthly limit"', (await statusOf(c, normal)) === 'DRAFT' && row?.subtitle.startsWith('Held: this project is over 80% of its monthly limit'), row);
await page.screenshot(ev.shot('normal-held'));

// Free the slot: Normal is still held, because the month is still over 80%.
await c.api.post(`/v1/missions/${high}/cancel`, { reason: 'acceptance: free the slot' });
await sleep(4000);
ev.check('with the slot free, Normal is still held (setup shortcut: High cancelled via API)', (await statusOf(c, normal)) === 'DRAFT');
const view = await c.api.get(`/v1/workspaces/${c.env.workspaceId}/backlog`);
ev.check('proof (API): the backlog item carries the held reason', /^Held: this project is over 80% of its monthly limit/.test(view.items.find((i) => i.summary.mission.id === normal)?.held ?? ''), view.items.map((i) => i.held));

await setLimit(c, 'Off');
await c.api.patch(`/v1/workspaces/${c.env.workspaceId}`, { monthlyLimits: [] });
ev.note('teardown: limit off, monthly limit removed');
c.close(); ev.save();
