// J4 — A mission the person paused mid-step has no Inbox row at all; a mission paused at its limit has only its
// "Limit reached" card. Nothing in the project is stalled.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { cleanSlate, createWithLimit, inboxText, inboxView, statusOf } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('J4', 'Paused, and paused at a limit, are not stalled');
await cleanSlate(c, ev);

const run = Date.now().toString(36);
const paused = await c.createMission(`J4 paused ${run}`, { workflow: 'P8 five steps' });
const pausedTitle = (await c.api.get(`/v1/missions/${paused}`)).mission.title;
await c.approvePlan(paused, pausedTitle);
await until(async () => Object.values(await c.tasks(paused)).some((t) => t.status === 'RUNNING'), { label: 'a step running', timeoutMs: 30_000 });
await c.missionAction(paused, 'Pause');
await until(async () => (await statusOf(c, paused)) === 'PAUSED', { label: 'paused', timeoutMs: 15_000 });
// The step that was running finishes; nothing else starts.
await until(async () => !Object.values(await c.tasks(paused)).some((t) => t.status === 'RUNNING'), { label: 'step settled', timeoutMs: 30_000 });
await sleep(2000);
const text = await inboxText(c);
ev.check(`the Inbox has nothing for "${pausedTitle}"`, !text.includes(pausedTitle), text.slice(0, 500));
const box = await inboxView(c);
ev.check('proof (API): no Stalled row, card or quiet row for the paused mission', !box.stalled.some((s) => s.missionId === paused) && !box.approvals.some((a) => a.approval.missionId === paused) && !box.silentRuns.some((s) => s.missionId === paused), box.stalled);
await page.screenshot(ev.shot('paused-no-row'));

const limited = await createWithLimit(c, `J4 limit ${run} SCRIPTED_USAGE_MIN=5`, { amount: 4, workflow: 'P8 five steps' });
const limitedTitle = (await c.api.get(`/v1/missions/${limited}`)).mission.title;
await c.approvePlan(limited, limitedTitle);
await until(async () => (await statusOf(c, limited)) === 'PAUSED', { label: 'paused at limit', timeoutMs: 60_000 });
await sleep(1500);
const text2 = await inboxText(c);
ev.check('the limit-paused mission shows its "Limit reached" card', text2.includes('Limit reached') && text2.includes(`reached its limit: 5 of 4 agent minutes`), text2.slice(0, 600));
ev.check('and no "Stalled:" row', !text2.includes('Stalled:'));
const box2 = await inboxView(c);
ev.check('proof (API): its card is its only item, and nothing in the project is stalled', box2.approvals.filter((a) => a.approval.missionId === limited).length === 1 && box2.stalled.length === 0, { stalled: box2.stalled, cards: box2.approvals.map((a) => a.approval.title) });
await page.screenshot(ev.shot('limit-card-only'));
await c.api.post(`/v1/missions/${paused}/cancel`, { reason: 'acceptance: J4 done' });
await c.api.post(`/v1/missions/${limited}/cancel`, { reason: 'acceptance: J4 done' });
c.close(); ev.save();
