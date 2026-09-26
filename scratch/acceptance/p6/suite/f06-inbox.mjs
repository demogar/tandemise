// F6 — The Inbox has one row for a draft waiting on decisions, it opens the mission, and it disappears once everything is decided.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { createDraft, clickInRow, refine, answerWithOption, cancel } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('F6', 'The Inbox asks for refinement decisions until they are made');

const goal = `F6 hello page ${Date.now().toString(36)}`;
const { id: missionId } = await createDraft(c, goal);
const titleOf = (await c.api.get(`/v1/missions/${missionId}`)).mission.title;
await refine(c, missionId);

const rowFor = () => page.evaluate(`[...document.querySelectorAll('main .list__row')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim()).find((t) => t.includes(${JSON.stringify(titleOf)})) ?? ''`);
await page.navigate('#/inbox');
await sleep(1500);
const row = await until(async () => { const r = await rowFor(); return r.includes('Refinement: 4 to decide') && r; }, { label: 'refinement row', timeoutMs: 20_000 }).catch(rowFor);
ev.check('the Inbox shows "Refinement: 4 to decide" for the mission', row.includes('Refinement: 4 to decide') && row.includes('3 criteria to decide and 1 question to answer'), row);
await page.screenshot(ev.shot('inbox-row'));

await page.evaluate(`[...document.querySelectorAll('main button.list__row')].find((r) => r.innerText.includes(${JSON.stringify(titleOf)}))?.click()`);
const opened = await until(async () => (await page.evaluate('location.hash')).includes(missionId), { label: 'mission opened', timeoutMs: 10_000 }).catch(() => false);
ev.check('clicking the row opens the mission on "Get it ready"', Boolean(opened) && (await page.waitForText('Proposed criteria', { timeoutMs: 15_000 }).then(() => true).catch(() => false)));

for (const key of ['P1', 'P2', 'P3']) await clickInRow(c, 'Proposed criteria', key, 'Accept');
await answerWithOption(c, 'Q1', 'Every page');
await page.navigate('#/inbox');
await sleep(1500);
const gone = await until(async () => (await rowFor()) === '' && 'gone', { label: 'row gone', timeoutMs: 20_000 }).catch(rowFor);
ev.check('once everything is decided the row is gone', gone === 'gone', gone);
await page.screenshot(ev.shot('inbox-cleared'));
const inbox = await c.api.get(`/v1/inbox?workspaceId=${c.env.workspaceId}`);
ev.check('proof (API): no refinement row for the mission', !(inbox.refinements ?? []).some((r) => r.missionId === missionId), inbox.refinements);

await cancel(c, missionId, 'F6');
c.close(); ev.save();
