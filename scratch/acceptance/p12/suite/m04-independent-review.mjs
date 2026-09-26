// M4 — Independent review: the "P12 review" workflow's review step says `independentOf: implement`. With the
// Reviewer role on "shared-model", the same model the implement step used, its gate fails on review.independent
// and it blocks. After the Reviewer role is moved to "review-model" in Team → Roles, "Retry task" passes.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { argvs, cleanSlate, closeDrawer, drawerModel, runsOf, setRoleModels, settle, writeState } from '../common.mjs';

const c = await context();
const { page, until } = c;
const ev = new Evidence('M4', 'A review on the same model as the work fails its gate; on a different model it passes');
await cleanSlate(c, ev);

await setRoleModels(c, 'Reviewer', { model: 'shared-model' });
const run = Date.now().toString(36);
const goal = `M4 hello page ${run}`;
const id = await c.createMission(goal, { workflow: 'P12 review' });
const title = (await c.api.get(`/v1/missions/${id}`)).mission.title;
await c.approvePlan(id, title);
await until(async () => (await c.task(id, 'review'))?.status === 'BLOCKED', { label: 'review blocked', timeoutMs: 180_000, everyMs: 1000 });

const blocked = await drawerModel(c, id, 'Review');
ev.check('review drawer: "Model: shared-model · role model"', blocked.chip === 'Model: shared-model · role model', blocked.chip);
ev.check('the step is Blocked and its gate names review.independent', blocked.text.includes('Blocked') && blocked.text.includes('review.independent'), blocked.text.slice(0, 900));
const gate = (await c.task(id, 'review')).gate;
ev.check('proof (API): the gate failed on review.independent = false', gate?.passed === false && JSON.stringify(gate).includes('review.independent'), gate);
await page.screenshot(ev.shot('review-blocked'));
await closeDrawer(c);

await setRoleModels(c, 'Reviewer', { model: 'review-model' });
await c.openTaskDrawer(id, 'Review');
await page.click('Retry task');
const status = await settle(c, id, ['COMPLETE', 'FAILED', 'CANCELLED']);
ev.check('after "Retry task" on the new model the mission completes', status === 'COMPLETE', status);
await closeDrawer(c);
const passed = await drawerModel(c, id, 'Review');
ev.check('review drawer: "Model: review-model · role model"', passed.chip === 'Model: review-model · role model', passed.chip);
await page.screenshot(ev.shot('review-passed'));
await closeDrawer(c);

const a = argvs(goal);
ev.check('proof (agent argv): implement shared-model, review shared-model, review again review-model', JSON.stringify(a.map((x) => x.model)) === JSON.stringify(['shared-model', 'shared-model', 'review-model']), a.map((x) => x.argv));
ev.check('proof (SQL): runs and models', JSON.stringify(runsOf(c, id).map((x) => [x.key, x.model])) === JSON.stringify([['implement', 'shared-model'], ['review', 'shared-model'], ['review', 'review-model']]), runsOf(c, id));

await setRoleModels(c, 'Reviewer', {});
await setRoleModels(c, 'Developer', {});
writeState({ m4: { id } });
c.close(); ev.save();
