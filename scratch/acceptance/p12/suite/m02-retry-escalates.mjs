// M2 — A retry escalates: the "P12 escalate" step says `model: step-model` and `escalate: [strong-model]`. The
// scripted agent writes nothing on its first run (SCRIPTED_FAIL_TIMES=1), the gate fails, and attempt 2 is started
// with --model strong-model. The drawer says "Model: strong-model · retry escalation (attempt 2)".
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { argvs, cleanSlate, closeDrawer, drawerModel, runsOf, settle, writeState } from '../common.mjs';

const c = await context();
const { page } = c;
const ev = new Evidence('M2', 'A step that fails once retries on the stronger model of its ladder');
await cleanSlate(c, ev);

const run = Date.now().toString(36);
const goal = `M2 decision ${run} SCRIPTED_FAIL_TIMES=1`;
const id = await c.createMission(goal, { workflow: 'P12 escalate' });
const title = (await c.api.get(`/v1/missions/${id}`)).mission.title;
await c.approvePlan(id, title);
const status = await settle(c, id);
ev.check('the mission completes on the second attempt', status === 'COMPLETE', status);

const d = await drawerModel(c, id, 'Record the decision');
ev.check('drawer: "Model: strong-model · retry escalation (attempt 2)"', d.chip === 'Model: strong-model · retry escalation (attempt 2)', d.chip);
ev.check('drawer: "This step: model step-model · retries use strong-model"', d.policy === 'This step: model step-model · retries use strong-model', d.policy);
await page.screenshot(ev.shot('drawer-escalated'));
await closeDrawer(c);

const a = argvs(`M2 decision ${run}`);
ev.check('proof (agent argv): run 1 --model step-model, run 2 --model strong-model', JSON.stringify(a.map((x) => x.argv.slice(x.argv.indexOf('--model'), x.argv.indexOf('--model') + 2))) === JSON.stringify([['--model', 'step-model'], ['--model', 'strong-model']]), a.map((x) => x.argv));
const r = runsOf(c, id);
ev.check('proof (SQL): attempt 1 failed its gate on step-model; attempt 2 on strong-model', JSON.stringify(r.map((x) => [x.attempt, x.model, x.reason])) === JSON.stringify([[1, 'step-model', 'step override'], [2, 'strong-model', 'retry escalation (attempt 2)']]), r);

writeState({ m2: { id } });
c.close(); ev.save();
