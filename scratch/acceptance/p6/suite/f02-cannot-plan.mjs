// F2 — A draft that is not ready cannot be planned: the button is disabled, and the API refuses with the gate's own words.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { createDraft, planButton, refine, cancel } from '../common.mjs';

const c = await context();
const { page, api, sleep } = c;
const ev = new Evidence('F2', 'Planning is refused until the request is ready');

const { id: missionId } = await createDraft(c, `F2 hello page ${Date.now().toString(36)}`);
await refine(c, missionId);
const plan = await planButton(c);
ev.check('the Plan button is disabled with the readiness sentence', plan?.disabled === true && plan.text.startsWith('Answer 1 question and decide 3 criteria'), plan);
// A disabled button does nothing when clicked; the daemon would refuse anyway.
await page.evaluate(`document.querySelector('.topbar__actions .btn--primary')?.click()`);
await sleep(2000);
ev.check('clicking it anyway leaves the mission a draft', (await api.get(`/v1/missions/${missionId}`)).mission.status === 'DRAFT');
await page.screenshot(ev.shot('plan-disabled'));

let refused = null;
try { await api.post(`/v1/missions/${missionId}/plan`); } catch (e) { refused = e; }
ev.check('API bypass: POST /v1/missions/:id/plan is 412 PRECONDITION_FAILED', refused?.status === 412 && refused.body?.error?.code === 'PRECONDITION_FAILED', refused?.body);
const message = refused?.body?.error?.message ?? '';
ev.check('it says what to do, then the gate\'s explanation', message.startsWith('Not ready to plan: answer 1 question and decide 3 criteria first.') && message.includes('ready.open_questions is 1, needs 0') && message.includes('ready.proposed_pending is 3, needs 0'), message);

let planNow = null;
const before = c.sql('SELECT count(*) AS n FROM missions')[0].n;
try { await api.post('/v1/missions', { workspaceId: c.env.workspaceId, goal: 'F2 plan me now without saying what done means', planNow: true }); } catch (e) { planNow = e; }
ev.check('API: planNow with no Done-when line is refused too', planNow?.status === 412 && (planNow.body?.error?.message ?? '').includes('ready.criteria is 0, needs >= 1'), planNow?.body);
ev.check('proof (SQL): and it wrote no mission', c.sql('SELECT count(*) AS n FROM missions')[0].n === before);

const row = c.sql('SELECT status FROM missions WHERE id = ?', missionId)[0];
const tasks = c.sql('SELECT count(*) AS n FROM mission_tasks WHERE mission_id = ?', missionId)[0].n;
ev.check('proof (SQL): the mission is still DRAFT with no tasks', row?.status === 'DRAFT' && tasks === 0, { row, tasks });

await cancel(c, missionId, 'F2');
c.close(); ev.save();
