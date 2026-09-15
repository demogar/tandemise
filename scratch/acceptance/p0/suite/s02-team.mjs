// Builds the team and staffing through the Team screen, then proves A14 (editing one thing never moves another).
//   You (owner) ─ Maria Lopez (Director of Design) ─ Ana Ruiz (Product Designer) ─ Figma design agent
//              └ Bo Chen (Engineer, Developer + QA) ─ Coding agent
//              └ Product / Architecture / Finance / Release agents (yours)
import { context } from '../lib/ctx.mjs';
import { Evidence } from '../lib/evidence.mjs';

const c = await context();
const { page, api, env, ui, sleep, until } = c;
const ev = new Evidence('TEAM', 'Build the team and staffing in the Team screen (with A14)');
const members = () => c.team();
const pressed = (label) => page.evaluate(`[...document.querySelectorAll('button')].find(b => b.offsetParent && b.innerText.trim() === ${JSON.stringify(label)})?.getAttribute('aria-pressed')`);
const setToggle = async (label, want) => { if ((await pressed(label)) !== String(want)) await page.click(label); };

async function openAdd(kind) {
  await page.navigate('#/team'); await sleep(900);
  await page.click(kind === 'person' ? 'Add person' : 'Add agent'); await sleep(500);
}
async function addPerson(name, title, reportsTo, roles) {
  await openAdd('person');
  const picker = await page.evaluate(`[...document.querySelectorAll('select')].some(s => s.offsetParent && (s.labels?.[0]?.innerText||'').startsWith('Person'))`);
  if (picker) await page.select('Person', 'Someone new');
  await page.fill('Name', name); await page.fill('Title', title);
  await page.select('Reports to', reportsTo);
  for (const r of roles) await setToggle(r, true);
  await page.click('Add');
  await until(async () => (await members()).some((m) => m.name === name), { label: `person ${name}`, timeoutMs: 10_000 });
}
async function addAgent(name, owner, roles, runtime = 'Scripted agent') {
  await openAdd('agent');
  await page.fill('Name', name);
  await page.select('Owner', owner);
  for (const r of roles) await setToggle(r, true);
  await page.click(runtime);
  await page.click('Add');
  await until(async () => (await members()).some((m) => m.name === name), { label: `agent ${name}`, timeoutMs: 10_000 });
}

await addPerson('Maria Lopez', 'Director of Design', 'You', ['Product Designer']);
await addPerson('Ana Ruiz', 'Product Designer', 'Maria Lopez', ['Product Designer']);
await addPerson('Bo Chen', 'Engineer', 'You', ['Developer', 'QA Engineer']);
await addAgent('Figma design agent', 'Ana Ruiz', ['Product Designer']);
await addAgent('Coding agent', 'Bo Chen', ['Developer']);
await addAgent('Product agent', 'You', ['Product Manager']);
await addAgent('Architecture agent', 'You', ['Architect']);
await addAgent('Finance agent', 'You', ['Finance Analyst']);
await addAgent('Release agent', 'You', ['Release Manager']);

const t = await members();
const by = Object.fromEntries(t.map((m) => [m.name, m]));
ev.check('Maria reports to you; Ana reports to Maria; Bo reports to you', by['Maria Lopez'].reportsTo === c.me && by['Ana Ruiz'].reportsTo === by['Maria Lopez'].id && by['Bo Chen'].reportsTo === c.me);
ev.check("Figma agent is Ana's; Coding agent is Bo's", by['Figma design agent'].reportsTo === by['Ana Ruiz'].id && by['Coding agent'].reportsTo === by['Bo Chen'].id);
ev.check('every agent runs on the scripted runtime', t.filter((m) => m.kind === 'agent').every((m) => m.runtimeProfileIds.includes(env.scriptedProfileId)), t.filter((m) => m.kind === 'agent').map((m) => `${m.name}:${m.runtimeProfileIds.length}`));
ev.check('the Reports-to picker offered no cycle (no invariant issues)', (await api.get(`/v1/workspaces/${env.workspaceId}/team`)).issues.length === 0);
await page.navigate('#/team'); await sleep(1200);
await page.screenshot(ev.shot('tree'));

// Staffing presets from the Staffing tab.
const staffing = () => api.get(`/v1/workspaces/${env.workspaceId}/staffing`);
const preset = async (role, label) => { await page.navigate('#/team/staffing'); await sleep(900); await page.select(`${role} staffing`, label); await sleep(900); };
await preset('Product Manager', 'AI drafts, responsible approves');
await preset('Product Designer', 'AI drafts, responsible approves');
await preset('Architect', 'AI drafts, person checks later');
await preset('Finance Analyst', 'AI with a safety net');
await preset('Release Manager', 'AI with a safety net');
const before = await staffing();

await page.navigate('#/team/staffing'); await sleep(900);
await page.clickIn('QA Engineer', 'Edit'); await sleep(700);
await page.select('How this role is staffed', 'Anyone from a group'); await sleep(600);
const picks = async () => page.evaluate(`Object.fromEntries([...document.querySelectorAll('button.pick')].filter(b=>b.offsetParent).map(b=>[b.innerText.trim().replace(/^\\d+\\s*/,''), b.getAttribute('aria-pressed')]))`);
const defaults = await picks();
ev.check('"Anyone from a group" preselects the people who cover QA (Bo), not unrelated people', defaults['Bo Chen'] === 'true' && defaults['Maria Lopez'] !== 'true', defaults);
for (const [name, want] of Object.entries({ 'Ana Ruiz': true, 'Bo Chen': true, You: false, 'Maria Lopez': false })) {
  const now = (await picks())[name];
  if (now !== undefined && now !== String(want)) { await page.evaluate(`[...document.querySelectorAll('button.pick')].find(b=>b.offsetParent && b.innerText.trim().replace(/^\\d+\\s*/,'') === ${JSON.stringify(name)})?.click()`); await sleep(250); }
}
await page.screenshot(ev.shot('qa-drawer'));
await page.click('Save'); await sleep(1000);
const after = await staffing();
ev.check('product and design: AI drafts, the responsible person approves', after.product?.reviews?.[0]?.mode === 'blocking' && after.design?.assignees?.[0] === by['Figma design agent'].id);
ev.check('architecture: checked later; finance and release: safety net', after.architecture?.reviews?.[0]?.mode === 'after' && ['finance', 'release'].every((r) => after[r]?.reviews?.[0]?.when === 'task.risk_level >= 2'));
ev.check('qa: pool of exactly Ana and Bo', after.qa?.mode === 'pool' && after.qa.assignees.length === 2 && [by['Ana Ruiz'].id, by['Bo Chen'].id].every((m) => after.qa.assignees.includes(m)), after.qa);
ev.check('A14: saving QA left every other role unchanged', ['product', 'design', 'architecture', 'finance', 'release'].every((r) => JSON.stringify(before[r]) === JSON.stringify(after[r])));

const s0 = await staffing();
await page.navigate('#/team'); await sleep(900);
await page.evaluate(`[...document.querySelectorAll('button')].find(x => x.offsetParent && x.innerText.trim().replace(/\\s+/g,' ').startsWith('Coding agent Agent'))?.click()`);
await sleep(700);
await page.fill('Title', 'Writes the code');
await page.click('Save'); await sleep(1000);
ev.check('A14: editing an agent in its drawer leaves all staffing unchanged', JSON.stringify(s0) === JSON.stringify(await staffing()));
await page.navigate('#/team/staffing'); await sleep(1200);
await page.screenshot(ev.shot('staffing'));
c.close(); ev.save();
