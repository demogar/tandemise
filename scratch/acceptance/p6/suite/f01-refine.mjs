// F1 — A goal with no Done-when line is created as a draft; Refine brings back three proposed criteria and one question, and the Plan button says what is left.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { createDraft, sectionText, rowsOf, planButton, refine, cancel } from '../common.mjs';

const c = await context();
const { page, api } = c;
const ev = new Evidence('F1', 'A rough request is refined into proposals and a question');

const goal = `F1 a friendlier hello page ${Date.now().toString(36)}`;
const { id: missionId, createLabel } = await createDraft(c, goal);
ev.note(`mission ${missionId}`);
ev.check('with no Done-when line New mission offers "Create and refine", not "Plan mission"', createLabel.startsWith('Create and refine'), createLabel);
const mission = (await api.get(`/v1/missions/${missionId}`)).mission;
ev.check('the mission is created as a draft, not planned', mission.status === 'DRAFT', mission.status);
let intro = await sectionText(c, 'Get it ready');
ev.check('the draft opens on "Get it ready", explaining what Refine does', intro.includes('Get it ready') && intro.includes('Before anything is planned, say what done means') && intro.includes('Refine'), intro);
let plan = await planButton(c);
ev.check('the Plan button is disabled and asks for a criterion', plan?.disabled === true && plan.text.includes('Add at least one Done-when criterion to plan'), plan);
await page.screenshot(ev.shot('draft-before-refine'));

await refine(c, missionId);
const proposed = await rowsOf(c, 'Proposed criteria');
ev.check('three proposed criteria, each with Accept and Reject', proposed.length === 3 && proposed.every((r) => r.includes('Accept') && r.includes('Reject') && r.includes('Edit')), proposed);
ev.check('numbered P1, P2, P3 by the daemon', proposed.map((r) => r.split(' ')[0]).join(',') === 'P1,P2,P3', proposed);
const questions = await sectionText(c, 'Questions');
ev.check('one question, Q1, with its reason and one-click options', questions.includes('Q1') && questions.includes('Which pages should greet the visitor by name?') && questions.includes('Why it matters:') && questions.includes('Only the home page') && questions.includes('Every page'), questions);
plan = await planButton(c);
ev.check('the Plan button reads "Answer 1 question and decide 3 criteria to plan", disabled', plan?.disabled === true && plan.text.includes('Answer 1 question and decide 3 criteria to plan'), plan);
intro = await sectionText(c, 'Get it ready');
ev.check('the panel says 4 to decide and offers Refine again', intro.includes('4 to decide') && intro.includes('Refine again'), intro);
await page.screenshot(ev.shot('proposals-and-question'));

const view = await api.get(`/v1/missions/${missionId}/refinement`);
ev.check('proof (API): 3 proposed, 1 open question, a Refinement artifact', view.criteria.filter((x) => x.status === 'proposed').length === 3 && view.questions.filter((q) => q.status === 'open').length === 1 && typeof view.artifactId === 'string', { criteria: view.criteria.map((x) => [x.key, x.status]), q: view.questions.map((q) => [q.key, q.status]), artifactId: view.artifactId });
ev.check('proof (SQL): proposals are not on the ledger yet', c.sql("SELECT count(*) AS n FROM mission_criteria WHERE mission_id = ? AND status = 'accepted'", missionId)[0].n === 0);

await cancel(c, missionId, 'F1');
c.close(); ev.save();
