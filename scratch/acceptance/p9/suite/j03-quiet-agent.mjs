// J3 — The agent hangs. The step's drawer reads "Last activity … ago" and "Quiet" (quiet after 3 s); after 9 s the Inbox
// shows "Quiet for …: implement" with "Stop and retry" and "Keep waiting". Keep waiting hides it; it comes back; Stop and
// retry stops the run and attempt 2 runs and succeeds; the row is gone. Tandemise never stopped the run on its own.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { WORKFLOW, cleanSlate, clickInRow, inboxText, inboxView, runsOf, statusOf, timelineText, waitForRow } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('J3', 'A quiet agent is reported; keep waiting, then stop and retry');
await cleanSlate(c, ev);

const run = Date.now().toString(36);
const id = await c.createMission(`J3 hello ${run} SCRIPTED_HANG_ONCE`, { workflow: WORKFLOW });
const title = (await c.api.get(`/v1/missions/${id}`)).mission.title;
await c.approvePlan(id, title);
const task = await until(async () => (await c.tasks(id)).implement?.status === 'RUNNING' && (await c.tasks(id)).implement, { label: 'running', timeoutMs: 30_000 });

await c.openTaskDrawer(id, task.title);
const drawer = await until(async () => { const t = await c.dialogText(task.title); return t.includes('Quiet') && t; }, { label: 'drawer quiet', timeoutMs: 20_000 });
ev.check('the drawer reads "Last activity … ago"', /Last activity \d+ s ago/.test(drawer), drawer.slice(0, 600));
ev.check('and "Quiet"', drawer.includes('Quiet'));
await page.screenshot(ev.shot('drawer-quiet'));
await page.evaluate(`document.querySelector('[role=dialog] .modal__close, [role=dialog] button[aria-label="Close"]')?.click()`);

const label = 'Quiet: implement';
const row = await waitForRow(c, label, 30_000);
ev.check('the Inbox row reads "Quiet for … s: implement" with the mission', /Quiet for \d+ s: implement/.test(row) && row.includes(title), row);
ev.check('it offers "Stop and retry" and "Keep waiting"', row.includes('Stop and retry') && row.includes('Keep waiting'), row);
ev.check('proof (API): the mission is moving, not stalled', !(await inboxView(c)).stalled.some((s) => s.missionId === id));
await page.screenshot(ev.shot('quiet-row'));

await clickInRow(c, label, 'Keep waiting');
const hidden = await inboxText(c);
ev.check('Keep waiting hides the row', !hidden.includes('Quiet for') , hidden.slice(0, 400));
await page.screenshot(ev.shot('kept-waiting'));
// A run that never printed anything is still STARTING: its first event is what marks it RUNNING.
ev.check('proof (SQL): still one run, still live (never stopped by Tandemise)', (await runsOf(c, id)).length === 1 && ['STARTING', 'RUNNING'].includes((await runsOf(c, id))[0].status), await runsOf(c, id));

const back = await waitForRow(c, label, 30_000);
ev.check('it comes back after another quiet spell', /Quiet for \d+ s: implement/.test(back), back);
await clickInRow(c, label, 'Stop and retry');
await until(async () => (await statusOf(c, id)) === 'COMPLETE', { label: 'complete', timeoutMs: 60_000 });
const runs = await runsOf(c, id);
ev.check('proof (SQL): run 1 cancelled, attempt 2 succeeded', runs.length === 2 && runs[0].status === 'CANCELLED' && runs[1].status === 'SUCCEEDED', runs);
await sleep(1000);
const after = await inboxText(c);
ev.check('the row is gone', !after.includes('Quiet for'), after.slice(0, 400));
await page.screenshot(ev.shot('row-gone'));
const timeline = await timelineText(c, id);
ev.check('the timeline said it was quiet, and that it was kept waiting', timeline.includes("'implement' has been quiet for") && timeline.includes("Kept waiting for 'implement'"), timeline.slice(0, 1200));
await page.screenshot(ev.shot('timeline'));
c.close(); ev.save();
