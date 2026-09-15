// A12 — changing staffing mid-mission moves only tasks that have not reached READY.
// Needs the daemon started with SCRIPTED_DELAY_MS=20000 (run-all.mjs restarts it).
import { context, writeState } from '../lib/ctx.mjs';
import { Evidence } from '../lib/evidence.mjs';

const c = await context();
const { page, api, env, sleep, until } = c;
const ana = await c.id('Ana Ruiz'); const finAgent = await c.id('Finance agent');
const ev = new Evidence('A12', 'Staffing change mid-mission');

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
ev.check('finance is READY, snapshotted to the Finance agent', moment.finance.staffing?.agentCandidateIds?.[0] === finAgent);

await page.navigate('#/team/staffing'); await sleep(900);
await page.select('Finance Analyst staffing', 'A person does it'); await sleep(900);
await page.select('QA Engineer staffing', 'AI only'); await sleep(900);
await page.navigate(`#/missions/${missionId}/plan`); await sleep(1200);
await page.screenshot(ev.shot('plan-after-change'));
const qaBefore = await c.task(missionId, 'qa');
ev.check('qa (still PENDING) would now go to a runtime instead of the Ana/Bo pool', qaBefore.status === 'PENDING' && qaBefore.wouldBe?.executor === 'agent', qaBefore.wouldBe);

const fin = await until(async () => { const t = await c.task(missionId, 'finance'); return ['SUCCEEDED', 'AWAITING_HUMAN', 'AWAITING_APPROVAL'].includes(t.status) && t; }, { label: 'finance settled', timeoutMs: 300_000, everyMs: 2000 });
ev.check('finance (already READY) still ran on the Finance agent', fin.status === 'SUCCEEDED' && fin.assignee?.id === finAgent, { status: fin.status, by: fin.assignee?.name });

for (const who of ['Ana Ruiz', 'Maria Lopez']) {
  await until(async () => (await c.approvals(missionId, 'PENDING')).some((a) => a.title === 'Approve the output of design?'), { label: `design card (${who})`, timeoutMs: 180_000, everyMs: 2000 });
  await c.decideInInbox('Approve the output of design?', { recordingFor: who });
  await sleep(1500);
}
const qa = await until(async () => { const t = await c.task(missionId, 'qa'); return t.status !== 'PENDING' && t; }, { label: 'qa leaves PENDING', timeoutMs: 400_000, everyMs: 2000 });
ev.check('qa resolved with the new staffing: an agent run, not a human pool', qa.executor === 'agent' && qa.staffing?.executor === 'agent', { status: qa.status, executor: qa.executor });

await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: A12 proven' });
await api.patch(`/v1/workspaces/${env.workspaceId}`, { concurrency: { maxTotalWorkers: 3, perRuntime: {} } });
c.close(); ev.save();
