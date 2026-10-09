// R3 — A paused mission with finished work. The old re-plan route (POST /plan) no longer replaces
// everything: it becomes a replan of the rest. And the window offers "Plan the rest again" on the header.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { docsSize, openFeed } from '../../p3/common.mjs';
import { CARD, history, keys, replanCard, stoppedForReplan } from '../common.mjs';

const c = await context();
const { page, api } = c;
await docsSize(c);
const ev = new Evidence('R3', 'A paused mission keeps what is done: the old re-plan route and the header both plan only the rest');

const { missionId, intake } = await stoppedForReplan(c, 'paused');
const before = history(c, intake.id);
await api.post(`/v1/missions/${missionId}/pause`);
await c.until(async () => (await api.get(`/v1/missions/${missionId}`)).mission.status === 'PAUSED', { label: 'paused' });

await api.post(`/v1/missions/${missionId}/plan`);
const viaRoute = await replanCard(c, missionId);
ev.check('proof (API): POST /plan with a finished step files a replan card, not a replace-all', viaRoute.evidence.some((e) => e.label === 'Replan'), viaRoute.evidence.map((e) => e.label));
ev.check('proof (API): intake is untouched, same id, runs and outputs', (await c.task(missionId, 'intake'))?.id === intake.id && JSON.stringify(history(c, intake.id)) === JSON.stringify(before));
await c.decideInInbox(viaRoute.title, { filter: 'For me', option: 'Reject' });
const back = await c.until(async () => { const m = (await api.get(`/v1/missions/${missionId}`)).mission; return m.status === 'PAUSED' && m; }, { label: 'paused again', timeoutMs: 20_000 }).catch(() => null);
ev.check('proof (API): rejected, it goes back to paused, not executing', back?.status === 'PAUSED', back?.status);

await openFeed(c, missionId);
await c.sleep(800);
const header = await page.evaluate(`[...document.querySelectorAll('.topbar button')].map(b => b.innerText.trim()).filter(Boolean)`);
ev.check('the header of a paused mission with finished work offers Plan the rest again', header.includes('Plan the rest again'), header);
await page.screenshot(ev.shot('paused-header-plan-the-rest'));
await page.evaluate(`[...document.querySelectorAll('.topbar button')].find(b => b.innerText.trim() === 'Plan the rest again').click()`);
const viaHeader = await replanCard(c, missionId);
ev.check('proof (API): the header button files a new replan card', viaHeader.id !== viaRoute.id);
await c.decideInInbox(viaHeader.title, { filter: 'For me' });
await c.until(async () => (await api.get(`/v1/missions/${missionId}`)).mission.status === 'COMPLETE', { label: 'complete', timeoutMs: 90_000 }).catch(() => undefined);
ev.check('proof (API): approved, the new steps ran and the mission completed', (await api.get(`/v1/missions/${missionId}`)).mission.status === 'COMPLETE' && (await keys(c, missionId)).join() === 'ask_first,intake,tailor', await keys(c, missionId));
ev.check('proof (API): intake is still untouched', JSON.stringify(history(c, intake.id)) === JSON.stringify(before));
const fit = (await c.approvals(missionId)).find((a) => a.title === CARD);
ev.check('proof (API): the new plan answered the stop card it left open', fit?.status !== 'PENDING' && fit?.selectedOptionId === 'replan_rest', { status: fit?.status, option: fit?.selectedOptionId });

c.close(); ev.save();
