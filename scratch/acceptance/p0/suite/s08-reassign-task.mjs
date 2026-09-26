// A18 — a task that has not started is handed to another agent from its "Change" drawer, for that task only;
// a task that already ran refuses a staffing change.
// Agents-only since 0.4.0: A17 (a person's own work reviewed and signed off by their lead) needed a second
// person and is retired (see the suite README); A18 used to hand a person's step to another person.
import { context, writeState } from '../lib/ctx.mjs';
import { Evidence } from '../lib/evidence.mjs';

const c = await context();
const { page, api, env, sleep, until } = c;
const releaseAgent = await c.id('Release agent'); const qaAgent = await c.id('QA agent');
const pickState = () => page.evaluate(`Object.fromEntries([...document.querySelectorAll('[role=dialog] button.pick')].filter(b=>b.offsetParent).map(b=>[b.innerText.trim().replace(/^\\d+\\s*/,''), b.getAttribute('aria-pressed')]))`);
async function pickOnly(names) {
  for (const [name, state] of Object.entries(await pickState())) {
    const want = names.includes(name);
    if (state !== String(want)) { await page.evaluate(`[...document.querySelectorAll('[role=dialog] button.pick')].find(b=>b.offsetParent && b.innerText.trim().replace(/^\\d+\\s*/,'') === ${JSON.stringify(name)})?.click()`); await sleep(250); }
  }
  return pickState();
}

const a18 = new Evidence('A18', 'Hand a task that has not started to another agent');
const projectQa = (await api.get(`/v1/workspaces/${env.workspaceId}/staffing`)).qa;
const title = `Reassign ${Date.now().toString(36)}`;
const missionId = await c.createMission(title);
writeState({ reassign: missionId });
await c.approvePlan(missionId, title);

const qa = await c.task(missionId, 'qa');
a18.check('qa has not started and would go to the QA agent', qa.status === 'PENDING' && qa.wouldBe?.assignee?.id === qaAgent, { status: qa.status, wouldBe: qa.wouldBe?.assignee?.name });
await c.openTaskDrawer(missionId, qa.title);
await page.click('Change', { within: '[role=dialog]' }); await sleep(800);
await page.select('How this role is staffed', 'AI only'); await sleep(500);
await pickOnly(['Release agent']);
await page.screenshot(a18.shot('change'));
await page.click('Save for this task', { within: '[role=dialog]' }); await sleep(1200);
const moved = await until(async () => { const t = await c.task(missionId, 'qa'); return t.wouldBe?.assignee?.id === releaseAgent && t; }, { label: 'qa reassigned', timeoutMs: 15_000 });
a18.check('qa now would go to the Release agent, through an override on this task', JSON.stringify(moved.staffingOverride?.assignees) === JSON.stringify([releaseAgent]), moved.staffingOverride);
a18.check('the drawer marks the task "override"', /\boverride\b/.test(await c.dialogText(qa.title)));
a18.check('the project staffing for QA is unchanged', JSON.stringify((await api.get(`/v1/workspaces/${env.workspaceId}/staffing`)).qa) === JSON.stringify(projectQa));
await page.screenshot(a18.shot('override'));

for (const key of ['spec', 'design']) {
  await until(async () => (await c.approvals(missionId, 'PENDING')).some((a) => a.title === `Approve the output of ${key}?`), { label: `${key} approval`, timeoutMs: 120_000, everyMs: 1500 });
  await c.decideInInbox(`Approve the output of ${key}?`, { filter: 'For me' });
}
const ran = await until(async () => { const t = await c.task(missionId, 'qa'); return t.status === 'SUCCEEDED' && t; }, { label: 'qa done', timeoutMs: 240_000, everyMs: 2000 });
a18.check('qa ran on the Release agent', ran.assignee?.id === releaseAgent, ran.assignee?.name);
const art = (await api.get(`/v1/missions/${missionId}/artifacts`)).find((a) => a.taskId === ran.id);
a18.check('its QAPlan is by the Release agent, you responsible', art?.author?.id === releaseAgent && art?.responsible?.id === c.me, { author: art?.author?.name });

const spec = await c.task(missionId, 'spec');
const refused = await api.patch(`/v1/tasks/${spec.id}/staffing`, { assignees: [qaAgent] }).then(() => null, (e) => e.status);
a18.check('a task that already ran refuses a staffing change (409)', refused === 409, refused);
await c.openTaskDrawer(missionId, spec.title);
a18.check('and its drawer offers no "Change"', !(await c.dialogText(spec.title)).split('\n').some((l) => l.trim() === 'Change'));
await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: A18 proven' });
c.close(); a18.save();
