// M3 — Economy past the warning level: the Product Manager role is given the economy model "economy-model" in
// Team → Roles. A "P12 economy" mission with a 20 agent-minute limit that warns at 25% reports 6 minutes per run,
// so its second step starts at 30% of its limit and runs on the economy model.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { argvs, cleanSlate, closeDrawer, drawerModel, roleOf, runsOf, setRoleModels, settle, usageByModelText, writeState } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('M3', 'Past its warning level a mission runs on the role\'s economy model');
await cleanSlate(c, ev);

await setRoleModels(c, 'Product Manager', { economy: 'economy-model' });
ev.check('proof (API): Product Manager economy model saved', (await roleOf(c, 'product'))?.models?.economyModel === 'economy-model', (await roleOf(c, 'product'))?.models);

const run = Date.now().toString(36);
const goal = `M3 decisions ${run} SCRIPTED_USAGE_MIN=6`;
await page.navigate('#/missions/new');
await page.waitForText('What outcome do you want?', { timeoutMs: 30_000 });
await sleep(400);
await page.fill('What outcome do you want?', goal);
await page.fill('Done when', 'The acceptance scenario finishes its steps');
await page.select('Repository', 'acceptance-project');
await page.select('Workflow', 'P12 economy');
await page.click('More options');
await page.waitForText('Limit');
await page.fill('Agent minutes for this mission', '20');
await page.fill('Warn at', '25');
await page.click('Plan mission …');
const id = await until(async () => { const h = await page.evaluate('location.hash'); return /#\/missions\/msn_/.test(h) && h.split('/')[2]; }, { label: 'mission page', timeoutMs: 30_000 });
const mission = (await c.api.get(`/v1/missions/${id}`)).mission;
ev.check('proof (API): a 20-minute limit warning at 25%', JSON.stringify(mission.limits) === JSON.stringify([{ metric: 'agent_minutes', amount: 20, warnPercent: 25 }]), mission.limits);
await c.approvePlan(id, mission.title);
const status = await settle(c, id);
ev.check('the mission completes', status === 'COMPLETE', status);

const first = await drawerModel(c, id, 'First decision');
ev.check('step 1 (under the warning level): "Model: profile-model · runtime profile default"', first.chip === 'Model: profile-model · runtime profile default', first.chip);
await closeDrawer(c);
const second = await drawerModel(c, id, 'Second decision');
ev.check('step 2 (6 of 20 minutes used): "Model: economy-model · economy: 30% of limit"', second.chip === 'Model: economy-model · economy: 30% of limit', second.chip);
await page.screenshot(ev.shot('drawer-economy'));
await closeDrawer(c);

const usage = await usageByModelText(c, id);
ev.check('Metrics → "Usage by model": profile-model and economy-model, 6 min each', usage.includes('profile-model') && usage.includes('economy-model') && (usage.match(/6m|6 min/g) ?? []).length >= 2, usage);
await page.screenshot(ev.shot('usage-by-model'));

const a = argvs(`M3 decisions ${run}`);
ev.check('proof (agent argv): --model profile-model, then --model economy-model', JSON.stringify(a.map((x) => x.model)) === JSON.stringify(['profile-model', 'economy-model']), a.map((x) => x.argv));
ev.check('proof (SQL): the reasons recorded', JSON.stringify(runsOf(c, id).map((x) => x.reason)) === JSON.stringify(['runtime profile default', 'economy: 30% of limit']), runsOf(c, id));

// Leave the role as it was for later suites.
await setRoleModels(c, 'Product Manager', {});
writeState({ m3: { id } });
c.close(); ev.save();
