// A12 — changing staffing mid-mission moves only tasks that have not reached READY.
// Needs the daemon started with SCRIPTED_DELAY_MS=20000 (run-all.mjs restarts it).
// Agents-only since 0.4.0: the change hands QA to a different agent and puts an approval on Finance,
// where it used to hand them to people.
import { context, writeState } from '../lib/ctx.mjs';
import { Evidence } from '../lib/evidence.mjs';

const c = await context();
const { page, api, env, sleep, until } = c;
const finAgent = await c.id('Finance agent'); const archAgent = await c.id('Architecture agent');
const ev = new Evidence('A12', 'Staffing change mid-mission');
const staffingBefore = await api.get(`/v1/workspaces/${env.workspaceId}/staffing`);

await api.patch(`/v1/workspaces/${env.workspaceId}`, { concurrency: { maxTotalWorkers: 1, perRuntime: {} } });
const title = `Midway ${Date.now().toString(36)}`;
const missionId = await c.createMission(title);
writeState({ midway: missionId });
await c.approvePlan(missionId, title);
await until(async () => (await c.approvals(missionId, 'PENDING')).some((a) => a.title === 'Approve the output of spec?'), { label: 'spec approval', timeoutMs: 90_000 });
await c.decideInInbox('Approve the output of spec?', { filter: 'For me' });

const moment = await until(async () => {
  const ts = await c.tasks(missionId);
  return Object.values(ts).some((t) => t.status === 'RUNNING') && ts.finance.status === 'READY' && ts.qa.status === 'PENDING' && ts;
}, { label: 'finance READY while another task runs', timeoutMs: 120_000, everyMs: 700 });
ev.note(Object.values(moment).map((t) => `${t.key}:${t.status}`).join(' '));
ev.check('finance is READY, snapshotted to the Finance agent with the safety net', moment.finance.staffing?.agentCandidateIds?.[0] === finAgent && moment.finance.staffing?.staffing?.reviews?.[0]?.when === 'task.risk_level >= 2', moment.finance.staffing?.staffing?.reviews);

// In the window: Finance now always needs your approval; QA goes to the Architecture agent instead.
await page.navigate('#/team/staffing'); await sleep(900);
await page.select('Finance Analyst staffing', 'AI drafts, responsible approves'); await sleep(900);
await page.clickIn('QA Engineer', 'Edit'); await sleep(700);
const pickState = () => page.evaluate(`Object.fromEntries([...document.querySelectorAll('button.pick')].filter(b=>b.offsetParent).map(b=>[b.innerText.trim().replace(/^\\d+\\s*/,''), b.getAttribute('aria-pressed')]))`);
for (const [name, want] of Object.entries({ 'QA agent': false, 'Coding agent': false, 'Architecture agent': true })) {
  if ((await pickState())[name] !== String(want)) { await page.evaluate(`[...document.querySelectorAll('button.pick')].find(b=>b.offsetParent && b.innerText.trim().replace(/^\\d+\\s*/,'') === ${JSON.stringify(name)})?.click()`); await sleep(250); }
}
await page.click('Save'); await sleep(1000);
const changed = await api.get(`/v1/workspaces/${env.workspaceId}/staffing`);
ev.check('the project staffing changed: finance always approved, qa on the Architecture agent', changed.finance?.reviews?.[0]?.when === 'always' && JSON.stringify(changed.qa?.assignees) === JSON.stringify([archAgent]), { finance: changed.finance?.reviews, qa: changed.qa?.assignees });
await page.navigate(`#/missions/${missionId}/plan`); await sleep(1200);
await page.screenshot(ev.shot('plan-after-change'));
const qaBefore = await c.task(missionId, 'qa');
ev.check('qa (still PENDING) would now go to the Architecture agent', qaBefore.status === 'PENDING' && qaBefore.wouldBe?.executor === 'agent' && qaBefore.wouldBe?.assignee?.id === archAgent, qaBefore.wouldBe);

const fin = await until(async () => { const t = await c.task(missionId, 'finance'); return ['SUCCEEDED', 'AWAITING_HUMAN', 'AWAITING_APPROVAL'].includes(t.status) && t; }, { label: 'finance settled', timeoutMs: 300_000, everyMs: 2000 });
ev.check('finance (already READY) still ran on the Finance agent', fin.status === 'SUCCEEDED' && fin.assignee?.id === finAgent, { status: fin.status, by: fin.assignee?.name });
ev.check('finance kept its safety net: no approval was asked for it', (await c.approvals(missionId)).every((a) => a.taskId !== fin.id));

await until(async () => (await c.approvals(missionId, 'PENDING')).some((a) => a.title === 'Approve the output of design?'), { label: 'design card', timeoutMs: 180_000, everyMs: 2000 });
await c.decideInInbox('Approve the output of design?', { filter: 'For me' });
const qa = await until(async () => { const t = await c.task(missionId, 'qa'); return t.status !== 'PENDING' && t; }, { label: 'qa leaves PENDING', timeoutMs: 400_000, everyMs: 2000 });
ev.check('qa resolved with the new staffing: the Architecture agent, not the QA agent', qa.executor === 'agent' && qa.staffing?.agentCandidateIds?.[0] === archAgent, { status: qa.status, candidates: qa.staffing?.agentCandidateIds });

await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: A12 proven' });
// Setup only: put the project back the way s02 left it for the scenarios after this one.
await api.patch(`/v1/workspaces/${env.workspaceId}/staffing`, { finance: staffingBefore.finance, qa: staffingBefore.qa });
await api.patch(`/v1/workspaces/${env.workspaceId}`, { concurrency: { maxTotalWorkers: 3, perRuntime: {} } });
c.close(); ev.save();
