// R2 — Reject the new plan: the mission is exactly as it was, and the plan-fit card is open again,
// still holding the steps after the stop.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { docsSize } from '../../p3/common.mjs';
import { CARD, HELD, OPTION, keys, replanCard, stoppedForReplan } from '../common.mjs';

const c = await context();
const { page, api } = c;
await docsSize(c);
const ev = new Evidence('R2', 'Rejecting the new plan leaves the mission as it was, still waiting on the stop');

const { missionId } = await stoppedForReplan(c, 'reject');
await c.decideInInbox(CARD, { filter: 'For me', option: OPTION });
const card = await replanCard(c, missionId);
await c.decideInInbox(card.title, { filter: 'For me', option: 'Reject', note: 'Not like that.' });
await page.screenshot(ev.shot('inbox-new-plan-rejected'));

const mission = await c.until(async () => { const m = (await api.get(`/v1/missions/${missionId}`)).mission; return m.status === 'EXECUTING' && m; }, { label: 'executing', timeoutMs: 20_000 }).catch(() => null);
ev.check('proof (API): the mission is back to executing, saying so', mission?.statusReason?.startsWith('The new plan for the rest was rejected: Not like that.'), mission?.statusReason);
ev.check('proof (API): the steps are as they were', (await keys(c, missionId)).join() === 'draft,intake,polish', await keys(c, missionId));
const draft = await c.task(missionId, 'draft');
ev.check('proof (API): draft is still held behind the stop', draft.status === 'PENDING' && draft.statusReason === HELD, { s: draft.status, r: draft.statusReason });
const fit = (await c.approvals(missionId)).find((a) => a.title === CARD);
ev.check('proof (API): the plan-fit card is open again', fit?.status === 'PENDING', fit?.status);
await page.navigate('#/inbox');
await c.sleep(900);
const inbox = await page.text('main');
ev.check('the Inbox lists the plan-fit card again', inbox.includes('says the plan no longer fits'), inbox.slice(0, 600));
await page.screenshot(ev.shot('inbox-stop-card-open-again'));

c.close(); ev.save();
