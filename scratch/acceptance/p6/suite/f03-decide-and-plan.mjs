// F3 — Accept two proposals, reject one, answer the question: the Plan button turns into "Plan", planning starts, and the planner is told the answer and the accepted criteria, never the rejected one.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { createDraft, sectionText, rowsOf, planButton, clickInRow, refine, answerWithOption, cancel } from '../common.mjs';

const c = await context();
const { page, api, until, sleep } = c;
const ev = new Evidence('F3', 'Decisions make it ready; the planner reads them');

const goal = `F3 hello page ${Date.now().toString(36)}`;
const { id: missionId } = await createDraft(c, goal);
await refine(c, missionId);
const view = await api.get(`/v1/missions/${missionId}/refinement`);
const [p1, p2, p3] = view.criteria.filter((x) => x.status === 'proposed');

await clickInRow(c, 'Proposed criteria', 'P1', 'Accept');
await clickInRow(c, 'Proposed criteria', 'P2', 'Accept');
await clickInRow(c, 'Proposed criteria', 'P3', 'Reject');
let done = await rowsOf(c, 'Done when');
ev.check('accepted proposals become U1 and U2 under "Done when"', done.length === 2 && done[0].startsWith('U1') && done[0].includes(p1.statement) && done[1].startsWith('U2') && done.every((r) => r.includes('Accepted')), done);
const earlier = await rowsOf(c, 'Earlier proposals');
ev.check('the rejected one moves to "Earlier proposals" as Rejected', earlier.length === 1 && earlier[0].includes(p3.statement) && earlier[0].includes('Rejected'), earlier);
let plan = await planButton(c);
ev.check('only the question is left: "Answer 1 question to plan"', plan?.disabled === true && plan.text.includes('Answer 1 question to plan'), plan);
await page.screenshot(ev.shot('criteria-decided'));

await answerWithOption(c, 'Q1', 'Only the home page');
const questions = await sectionText(c, 'Questions');
ev.check('the question shows its answer', questions.includes('Answered: Only the home page'), questions);
plan = await until(async () => { const p = await planButton(c); return p && !p.disabled && p; }, { label: 'Plan enabled', timeoutMs: 15_000 }).catch(() => planButton(c));
ev.check('the button now reads "Plan" and is enabled', plan?.disabled === false && plan.text === 'Plan', plan);
ev.check('the panel says it is ready', (await sectionText(c, 'Get it ready')).includes('Ready to plan'));
await page.screenshot(ev.shot('ready-to-plan'));

const promptsBefore = c.prompts().length;
await page.evaluate(`document.querySelector('.topbar__actions .btn--primary')?.click()`);
const planning = await until(async () => { const t = await page.text('.topbar'); return /Planning|Awaiting plan approval/i.test(t) && t; }, { label: 'Planning in the header', timeoutMs: 30_000 }).catch(() => page.text('.topbar'));
ev.check('clicking Plan starts planning', /Planning|Awaiting plan approval/i.test(planning), planning.slice(0, 300));
await page.screenshot(ev.shot('planning'));
const plannerPrompt = await until(() => c.prompts().slice(promptsBefore).find((p) => p.includes('You are the Planner') && p.includes(goal)), { label: 'planner prompt', timeoutMs: 60_000 }).catch(() => undefined);
ev.check('the planner prompt holds the answer to Q1', plannerPrompt?.includes('Which pages should greet the visitor by name?') && plannerPrompt.includes('Answer: Only the home page'), plannerPrompt?.slice(0, 1800));
ev.check('and both accepted criteria, as U1 and U2', plannerPrompt?.includes(`- U1: ${p1.statement}`) && plannerPrompt.includes(`- U2: ${p2.statement}`));
ev.check('and not the rejected one', plannerPrompt !== undefined && !plannerPrompt.includes(p3.statement), p3.statement);
const status = (await api.get(`/v1/missions/${missionId}`)).mission.status;
ev.check('proof (API): the mission left DRAFT', status !== 'DRAFT', status);
// Cancelled only once planning has settled: a plan still being made would otherwise land on a cancelled mission.
await until(async () => (await api.get(`/v1/missions/${missionId}`)).mission.status !== 'PLANNING', { label: 'planning settled', timeoutMs: 120_000 }).catch(() => undefined);
await sleep(500);

await cancel(c, missionId, 'F3');
c.close(); ev.save();
