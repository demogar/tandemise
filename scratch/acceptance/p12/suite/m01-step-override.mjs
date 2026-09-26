// M1 — A step's own model wins: the Developer role is given "role-dev" in Team → Roles, but the "P12 models"
// workflow's implement step says `model: step-model`, so that run is started with --model step-model. The review
// step names none and its role none, so it runs on the runtime profile's default. Each drawer says which and why.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { argvs, cleanSlate, closeDrawer, drawerModel, roleOf, runsOf, setRoleModels, settle, usageByModelText, writeState } from '../common.mjs';

const c = await context();
const { page } = c;
const ev = new Evidence('M1', "A step's own model wins over its role's; each run records which model and why");
await cleanSlate(c, ev);

const models = await setRoleModels(c, 'Developer', { model: 'role-dev' }, ev.shot('developer-models'));
ev.check('Team → Roles → Developer shows the Models section', models.includes('Model') && models.includes('On retry, use') && models.includes('Economy model'), models.slice(0, 300));
ev.check('proof (API): the Developer role now has model role-dev', (await roleOf(c, 'development'))?.models?.model === 'role-dev', (await roleOf(c, 'development'))?.models);

const run = Date.now().toString(36);
const goal = `M1 hello page ${run}`;
const id = await c.createMission(goal, { workflow: 'P12 models' });
const title = (await c.api.get(`/v1/missions/${id}`)).mission.title;
await c.approvePlan(id, title);
const status = await settle(c, id);
ev.check('the mission completes', status === 'COMPLETE', status);

const impl = await drawerModel(c, id, 'Implement');
ev.check('implement drawer: "Model: step-model · step override"', impl.chip === 'Model: step-model · step override', impl.chip);
ev.check('and its own settings: "This step: model step-model · retries use strong-model"', impl.policy === 'This step: model step-model · retries use strong-model', impl.policy);
await page.screenshot(ev.shot('implement-drawer'));
await closeDrawer(c);
const review = await drawerModel(c, id, 'Review');
ev.check('review drawer: "Model: profile-model · runtime profile default"', review.chip === 'Model: profile-model · runtime profile default', review.chip);
ev.check('and "This step: must differ from implement"', review.policy === 'This step: must differ from implement', review.policy);
ev.check('its gate includes review.independent and passed', review.text.includes('review.independent'), review.text.slice(0, 600));
await page.screenshot(ev.shot('review-drawer'));
await closeDrawer(c);

const usage = await usageByModelText(c, id);
ev.check('Metrics → "Usage by model" lists step-model and profile-model, one run each', usage.includes('step-model') && usage.includes('profile-model') && (usage.match(/1 run\b/g) ?? []).length === 2, usage);
await page.screenshot(ev.shot('usage-by-model'));

const a = argvs(goal);
ev.check('proof (agent argv): run 1 got --model step-model, run 2 --model profile-model', JSON.stringify(a.map((x) => x.model)) === JSON.stringify(['step-model', 'profile-model']), a.map((x) => x.argv));
const r = runsOf(c, id);
ev.check('proof (SQL): runs.model / model_reason recorded', JSON.stringify(r.map((x) => [x.key, x.model, x.reason])) === JSON.stringify([['implement', 'step-model', 'step override'], ['review', 'profile-model', 'runtime profile default']]), r);

writeState({ m1: { id } });
c.close(); ev.save();
