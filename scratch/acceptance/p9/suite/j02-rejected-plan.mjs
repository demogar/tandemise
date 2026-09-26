// J2 — Rejecting a plan leaves the mission blocked with nothing asking: "Stalled: <mission>" says "The plan was rejected…"
// and offers "Re-plan"; clicking it plans again, and the new plan card replaces the Stalled row.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { WORKFLOW, cleanSlate, clickInRow, inboxText, inboxView, statusOf, waitForRow } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('J2', 'A rejected plan gets one Stalled row that re-plans it');
await cleanSlate(c, ev);

const run = Date.now().toString(36);
const id = await c.createMission(`J2 hello ${run}`, { workflow: WORKFLOW });
const title = (await c.api.get(`/v1/missions/${id}`)).mission.title;
const plan = await until(async () => (await c.approvals(id, 'PENDING')).find((a) => a.kind === 'plan'), { label: 'plan card', timeoutMs: 60_000 });
ev.check('proof (API): the plan card is pending and nothing is stalled', !(await inboxView(c)).stalled.some((s) => s.missionId === id));
ev.note(`plan card options: ${plan.options.map((o) => o.label).join(' / ')}`);
await c.decideInInbox(plan.title, { option: plan.options.find((o) => o.id === 'reject')?.label ?? 'Reject', filter: 'For me' });
await until(async () => (await statusOf(c, id)) === 'BLOCKED', { label: 'blocked', timeoutMs: 15_000 });

const row = await waitForRow(c, `Stalled: ${title}`, 30_000);
ev.check(`"Stalled: ${title}" appears`, row.includes(`Stalled: ${title}`), row);
ev.check('it says "The plan was rejected. Re-plan or change the mission goal."', row.includes('The plan was rejected. Re-plan or change the mission goal.'), row);
ev.check('with one action: "Re-plan"', row.includes('Re-plan'), row);
await page.screenshot(ev.shot('stalled-replan'));

await clickInRow(c, `Stalled: ${title}`, 'Re-plan');
const flash = await c.flash();
ev.check('the window says it is planning again', flash.includes(`Planning “${title}” again.`), flash);
const again = await until(async () => (await c.approvals(id, 'PENDING')).find((a) => a.kind === 'plan' && a.id !== plan.id), { label: 'new plan card', timeoutMs: 60_000 });
ev.check('proof (API): a new plan card', again !== undefined);
await sleep(1000);
const after = await inboxText(c);
ev.check('the Inbox shows the new plan card', after.includes(again.title), after.slice(0, 500));
ev.check('and no Stalled row for it', !after.includes(`Stalled: ${title}`));
await page.screenshot(ev.shot('new-plan-card'));
await c.api.post(`/v1/missions/${id}/cancel`, { reason: 'acceptance: J2 done' });
c.close(); ev.save();
