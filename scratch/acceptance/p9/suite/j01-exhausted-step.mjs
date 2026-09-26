// J1 — A step fails its gate on both attempts: its "exhausted its retries" card is the one Inbox item (no Stalled row).
// "Leave blocked" leaves the mission with nothing moving and nothing asking: one "Stalled: <mission>" row with "Retry implement".
// Clicking it runs attempt 3, the mission completes, and the row is gone.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { WORKFLOW, cleanSlate, clickInRow, inboxText, inboxView, runsOf, statusOf, waitForRow } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('J1', 'An exhausted step left blocked gets one Stalled row that retries it');
await cleanSlate(c, ev);

const run = Date.now().toString(36);
const id = await c.createMission(`J1 hello ${run} SCRIPTED_FAIL_TIMES=2`, { workflow: WORKFLOW });
const title = (await c.api.get(`/v1/missions/${id}`)).mission.title;
await c.approvePlan(id, title);

const card = await until(async () => (await c.approvals(id, 'PENDING')).find((a) => a.kind === 'intervention'), { label: 'exhausted card', timeoutMs: 90_000 });
ev.check('proof (API): the step failed its gate twice and raised "… exhausted its retries"', card.title.endsWith('exhausted its retries') && (await runsOf(c, id)).length === 2, card.title);
const withCard = await inboxText(c);
ev.check('the Inbox shows the card', withCard.includes(card.title), withCard.slice(0, 600));
ev.check('and no "Stalled:" row while the card asks', !withCard.includes(`Stalled: ${title}`));
ev.check('proof (API): inbox.stalled is empty for it', !(await inboxView(c)).stalled.some((s) => s.missionId === id));
await page.screenshot(ev.shot('card-no-stalled-row'));

await c.decideInInbox(card.title, { option: 'Leave blocked' });
await until(async () => (await c.approvals(id)).find((a) => a.id === card.id)?.status === 'REJECTED', { label: 'left blocked', timeoutMs: 15_000 });
const row = await waitForRow(c, `Stalled: ${title}`, 30_000);
ev.check(`"Stalled: ${title}" appears`, row.includes(`Stalled: ${title}`), row);
ev.check('it says what is stuck: "\'implement\' is blocked: A human declined to retry this task."', row.includes("'implement' is blocked: A human declined to retry this task."), row);
ev.check('with one action: "Retry implement"', row.includes('Retry implement'), row);
const box = await inboxView(c);
ev.check('proof (API): exactly one stalled row, and no other item for the mission', box.stalled.filter((s) => s.missionId === id).length === 1 && !box.approvals.some((a) => a.approval.missionId === id) && !box.tasks.some((t) => t.missionId === id), box.stalled);
await page.screenshot(ev.shot('stalled-row'));

await page.navigate('#/');
await sleep(1500);
const home = await page.text('body');
ev.check('Home → Needs you now shows it once (no second blocked card)', home.split(`Stalled: ${title}`).length === 2 && !home.includes(`Blocked\n${title}`), home.slice(0, 900));
await page.screenshot(ev.shot('home-needs-you'));

await waitForRow(c, `Stalled: ${title}`);
await clickInRow(c, `Stalled: ${title}`, 'Retry implement');
await until(async () => (await statusOf(c, id)) === 'COMPLETE', { label: 'complete', timeoutMs: 60_000 });
const runs = await runsOf(c, id);
ev.check('proof (SQL): attempt 3 ran and succeeded', runs.length === 3 && runs[2].status === 'SUCCEEDED', runs);
await sleep(1000);
const after = await inboxText(c);
ev.check('the Stalled row is gone', !after.includes(`Stalled: ${title}`), after.slice(0, 400));
ev.check('proof (API): inbox.stalled is empty', (await inboxView(c)).stalled.length === 0);
await page.screenshot(ev.shot('row-gone'));
c.close(); ev.save();
