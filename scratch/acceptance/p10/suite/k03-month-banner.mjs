// K3 — A monthly limit of 30 agent minutes with 25.5 used: Home's banner reads "Monthly limit at 85% — only urgent
// and high work will be pulled", the This month card "85%" with "25.5 / 30 agent min", and the status report says the
// same. With both slots taken and a mission queued, the WIP banner says the queue waits for a free slot.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { addToBacklog, bannerTexts, deskCard, openHome, readState, readerText, statusOf, waitCard, writeReport } from '../common.mjs';

const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('K3', 'The month against its limit, on the desk and in the report');
const { k1 } = readState();
if (!k1) throw new Error('K3 needs K1 first');
const ws = c.env.workspaceId;

// This month's usage is brought to 25.52 agent minutes by one run that reports the rest (SCRIPTED_USAGE_MIN).
const used = (await api.get(`/v1/workspaces/${ws}/usage`)).usage.agentMinutes;
const topUp = Math.round((25.52 - used) * 1000) / 1000;
ev.note(`this month so far: ${used} agent minutes; one run reports ${topUp} more`);
const run = Date.now().toString(36);
const usage = await c.createMission(`K3 usage ${run} SCRIPTED_USAGE_MIN=${topUp}`, { workflow: 'P9 implement' });
await c.approvePlan(usage, (await api.get(`/v1/missions/${usage}`)).mission.title);
await until(async () => (await statusOf(c, usage)) === 'COMPLETE', { label: 'usage mission complete', timeoutMs: 90_000 });
const now = (await api.get(`/v1/workspaces/${ws}/usage`)).usage.agentMinutes;
ev.check('proof (API): 25.5 agent minutes used this month', Math.round(now * 10) / 10 === 25.5, now);

// The monthly limit, set in Repositories → Limits.
await page.navigate('#/project');
await until(() => page.evaluate(`Boolean(document.querySelector('section[aria-label="Limits"]'))`), { label: 'limits section', timeoutMs: 15_000 });
await sleep(800);
await page.fill('Agent minutes per month', '30');
await page.click('Save monthly limit');
await until(async () => (await api.get(`/v1/workspaces/${ws}`)).workspace.monthlyLimits?.[0]?.amount === 30, { label: 'monthly limit saved', timeoutMs: 10_000 });

// One more mission queued behind the two in progress (WIP 2 from K1).
await addToBacklog(c, `K3 queued: tidy the footer ${run}`, { workflow: 'P2 solo' });
await page.navigate('#/missions/backlog');
await sleep(1200);
ev.check('the backlog route opens Missions on its Backlog tab', (await page.text('main')).includes('Working on 2 of 2 · 1 queued'), (await page.text('main')).slice(0, 300));

await openHome(c);
const banners = await until(async () => { const b = await bannerTexts(c); return b.some((t) => t.includes('Monthly limit at')) && b; }, { label: 'month banner', timeoutMs: 20_000 }).catch(() => bannerTexts(c));
const monthBanner = banners.find((t) => t.startsWith('Monthly limit at')) ?? '';
ev.check('banner "Monthly limit at 85% — only urgent and high work will be pulled"', monthBanner.startsWith('Monthly limit at 85% — only urgent and high work will be pulled.') && monthBanner.includes('This project used 25.5 of 30 agent minutes this month; work stops at 30 agent minutes.'), banners);
ev.check('the project warning is said once (no second "Monthly limit warning" banner)', !(await page.text('main')).includes('Monthly limit warning'), banners);
const wip = banners.find((t) => t.startsWith('Working on')) ?? '';
ev.check('banner "Working on 2 of 2 — 1 queued mission waits for a free slot."', wip.startsWith('Working on 2 of 2 — 1 queued mission waits for a free slot.'), banners);
const month = await waitCard(c, 'This month', 'This month 85%');
ev.check('card "This month 85%" with "25.5 / 30 agent min this month"', month === 'This month 85% 25.5 / 30 agent min this month', month);
ev.check('card "Working on 2 of 2" with "1 queued"', (await deskCard(c, 'Working on')).startsWith('Working on 2 of 2 1 queued'), await deskCard(c, 'Working on'));
await page.screenshot(ev.shot('month-banner'));

await writeReport(c);
const text = await readerText(c);
ev.check('the report: "This month (YYYY-MM): 25.5 / 30 agent min (85%)"', /This month \(\d{4}-\d{2}\): 25\.5 \/ 30 agent min \(85%\)/.test(text), text.split('Missions')[0]);
ev.check('the report: the queued mission in the backlog, held by the monthly rule', text.includes(`K3 queued: tidy the footer ${run} · Normal · Ready to plan · Held: this project is over 80% of its monthly limit`), text.split('Backlog')[1]?.slice(0, 400));
await page.screenshot(ev.shot('report-month'));
void k1;
c.close(); ev.save();
