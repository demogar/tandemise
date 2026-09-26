// Builds the team (you + your agents) and its staffing through the Team screen, then proves A14
// (editing one thing never moves another).
//   You (owner) ─ Product agent · Design agent · Architecture agent · Coding agent
//               · QA agent · Finance agent · Release agent (all yours, on the scripted runtime)
// Since 0.4.0 the team is you and your agents: there is no "Add person", and the staffing
// pickers offer no people presets. This scenario proves that too.
import { context } from '../lib/ctx.mjs';
import { Evidence } from '../lib/evidence.mjs';

const AGENTS = [
  ['Product agent', 'Product Manager'],
  ['Design agent', 'Product Designer'],
  ['Architecture agent', 'Architect'],
  ['Coding agent', 'Developer'],
  ['QA agent', 'QA Engineer'],
  ['Finance agent', 'Finance Analyst'],
  ['Release agent', 'Release Manager'],
];

const c = await context();
const { page, api, env, sleep, until } = c;
const ev = new Evidence('TEAM', 'Build you + your agents and their staffing in the Team screen (with A14)');
const members = () => c.team();
const pressed = (label) => page.evaluate(`[...document.querySelectorAll('button')].find(b => b.offsetParent && b.innerText.trim() === ${JSON.stringify(label)})?.getAttribute('aria-pressed')`);
const setToggle = async (label, want) => { if ((await pressed(label)) !== String(want)) await page.click(label); };
const buttons = () => page.evaluate(`[...document.querySelectorAll('button,[role=tab],a')].filter(b => b.offsetParent).map(b => b.innerText.trim().replace(/\\s+/g, ' '))`);

await page.navigate('#/team'); await sleep(1200);
const teamButtons = await buttons();
ev.check('the Team screen offers "Add agent" and no "Add person"', teamButtons.includes('Add agent') && !teamButtons.some((b) => /Add person/.test(b)), teamButtons.filter((b) => /^Add/.test(b)));
ev.check('the first tab reads "You & agents"', teamButtons.some((b) => b.startsWith('You & agents')));

async function addAgent(name, role, runtime = 'Scripted agent') {
  await page.navigate('#/team'); await sleep(900);
  await page.click('Add agent'); await sleep(500);
  const owners = await page.evaluate(`(() => { const s = [...document.querySelectorAll('select')].find(x => x.offsetParent && (x.labels?.[0]?.innerText||'').startsWith('Owner')); return s ? [...s.options].map(o => o.text) : null; })()`);
  await page.fill('Name', name);
  await page.select('Owner', 'You');
  await setToggle(role, true);
  await page.click(runtime);
  await page.click('Add');
  await until(async () => (await members()).some((m) => m.name === name), { label: `agent ${name}`, timeoutMs: 10_000 });
  return owners;
}
const ownerChoices = [];
for (const [name, role] of AGENTS) ownerChoices.push(await addAgent(name, role));
ev.check('the Owner picker offers only you', ownerChoices.every((o) => JSON.stringify(o) === JSON.stringify(['You'])), ownerChoices[0]);

const t = await members();
const by = Object.fromEntries(t.map((m) => [m.name, m]));
ev.check('the team is you and seven agents', t.filter((m) => m.kind === 'person').length === 1 && t.filter((m) => m.kind === 'agent').length === AGENTS.length, t.map((m) => `${m.kind}:${m.name}`));
ev.check('every agent is yours', AGENTS.every(([n]) => by[n]?.reportsTo === c.me));
ev.check('every agent runs on the scripted runtime', t.filter((m) => m.kind === 'agent').every((m) => JSON.stringify(m.runtimeProfileIds) === JSON.stringify([env.scriptedProfileId])), t.filter((m) => m.kind === 'agent').map((m) => `${m.name}:${m.runtimeProfileIds.length}`));
ev.check('the team has no invariant issues', (await api.get(`/v1/workspaces/${env.workspaceId}/team`)).issues.length === 0);
await page.navigate('#/team'); await sleep(1200);
const tree = await page.text('main');
ev.check('the tree lists every agent as "Agent · yours"', AGENTS.every(([n]) => new RegExp(`${n}\\s*\\n\\s*Agent · yours`).test(tree)));
await page.screenshot(ev.shot('tree'));

// Staffing presets from the Staffing tab.
const staffing = () => api.get(`/v1/workspaces/${env.workspaceId}/staffing`);
await page.navigate('#/team/staffing'); await sleep(900);
const presetOptions = await page.evaluate(`[...(document.querySelector('select[aria-label="QA Engineer staffing"]')?.options ?? [])].map(o => o.text)`);
ev.check('the staffing picker offers no people presets', presetOptions.length > 0 && !presetOptions.some((o) => /A person does it|Anyone from a group/.test(o)), presetOptions);
const preset = async (role, label) => { await page.navigate('#/team/staffing'); await sleep(900); await page.select(`${role} staffing`, label); await sleep(900); };
await preset('Product Manager', 'AI drafts, responsible approves');
await preset('Product Designer', 'AI drafts, responsible approves');
await preset('Architect', 'AI drafts, responsible checks later');
await preset('Finance Analyst', 'AI with a safety net');
await preset('Release Manager', 'AI with a safety net');
const before = await staffing();
ev.check('product and design: their agent drafts, the responsible person approves', before.product?.assignees?.[0] === by['Product agent'].id && before.product?.reviews?.[0]?.mode === 'blocking' && before.design?.assignees?.[0] === by['Design agent'].id && before.design?.reviews?.[0]?.mode === 'blocking', { product: before.product, design: before.design });
ev.check('architecture: checked later; finance and release: safety net', before.architecture?.reviews?.[0]?.mode === 'after' && ['finance', 'release'].every((r) => before[r]?.reviews?.[0]?.when === 'task.risk_level >= 2'), { architecture: before.architecture, finance: before.finance });

// A14: edit one role in its drawer - QA runs on the QA agent, then the Coding agent.
await page.navigate('#/team/staffing'); await sleep(900);
await page.clickIn('QA Engineer', 'Edit'); await sleep(700);
const picks = async () => page.evaluate(`Object.fromEntries([...document.querySelectorAll('button.pick')].filter(b=>b.offsetParent).map(b=>[b.innerText.trim().replace(/^\\d+\\s*/,''), b.getAttribute('aria-pressed')]))`);
const defaults = await picks();
ev.check('the QA drawer preselects the agent that holds the role and offers only agents', defaults['QA agent'] === 'true' && Object.values(defaults).filter((v) => v === 'true').length === 1 && !('You' in defaults), defaults);
await page.evaluate(`[...document.querySelectorAll('button.pick')].find(b=>b.offsetParent && b.innerText.trim().replace(/^\\d+\\s*/,'') === 'Coding agent')?.click()`); await sleep(300);
await page.screenshot(ev.shot('qa-drawer'));
await page.click('Save'); await sleep(1000);
const after = await staffing();
ev.check('qa: the QA agent first, then the Coding agent', JSON.stringify(after.qa?.assignees) === JSON.stringify([by['QA agent'].id, by['Coding agent'].id]), after.qa);
ev.check('A14: saving QA left every other role unchanged', ['product', 'design', 'architecture', 'finance', 'release', 'development'].every((r) => JSON.stringify(before[r]) === JSON.stringify(after[r])));

const s0 = await staffing();
await page.navigate('#/team'); await sleep(900);
await page.evaluate(`[...document.querySelectorAll('button')].find(x => x.offsetParent && x.innerText.trim().replace(/\\s+/g,' ').startsWith('Coding agent Agent'))?.click()`);
await sleep(700);
await page.fill('Title', 'Writes the code');
await page.click('Save'); await sleep(1000);
ev.check('the agent drawer saved its title', (await members()).find((m) => m.id === by['Coding agent'].id)?.title === 'Writes the code');
ev.check('A14: editing an agent in its drawer leaves all staffing unchanged', JSON.stringify(s0) === JSON.stringify(await staffing()));
await page.navigate('#/team/staffing'); await sleep(1200);
await page.screenshot(ev.shot('staffing'));
c.close(); ev.save();
