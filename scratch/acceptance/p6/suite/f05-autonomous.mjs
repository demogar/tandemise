// F5 — An autonomous mission accepts the proposals itself, but never answers a question: the open question still blocks planning.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { createDraft, rowsOf, planButton, refine, cancel } from '../common.mjs';

const c = await context();
const { page, api } = c;
const ev = new Evidence('F5', 'Autonomous accepts criteria, never answers questions');

const { id: missionId } = await createDraft(c, `F5 hello page ${Date.now().toString(36)}`, { autonomy: 'Autonomous' });
ev.check('the mission runs autonomously', (await api.get(`/v1/missions/${missionId}`)).mission.autonomy === 'autonomous');
await refine(c, missionId);
const done = await rowsOf(c, 'Done when');
ev.check('every proposal was "Accepted automatically", as U1-U3', done.length === 3 && done.every((r) => r.includes('Accepted automatically')) && done.map((r) => r.split(' ')[0]).join(',') === 'U1,U2,U3', done);
ev.check('nothing is left to decide among criteria', (await rowsOf(c, 'Proposed criteria')).length === 0);
const plan = await planButton(c);
ev.check('the question still blocks: "Answer 1 question to plan", disabled', plan?.disabled === true && plan.text.includes('Answer 1 question to plan'), plan);
await page.screenshot(ev.shot('accepted-automatically'));
const view = await api.get(`/v1/missions/${missionId}/refinement`);
ev.check('proof (API): decided by autonomy, question open', view.criteria.every((x) => x.decidedBy === 'autonomy') && view.questions.filter((q) => q.status === 'open').length === 1, { c: view.criteria.map((x) => [x.key, x.decidedBy]), q: view.questions.map((q) => q.status) });

await cancel(c, missionId, 'F5');
c.close(); ev.save();
