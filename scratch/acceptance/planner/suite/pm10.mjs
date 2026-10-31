// PM10 — people stepping in tightens the next plan, and Project → Factory shows the files and the routing.
//
// The project's own .tandemise/factory/planner.yaml adds the spec's desktop-ui area and asks for a look from you
// once people stepped in on 3 of the last 3 tasks in an area. Holds (#50) aren't on this base, so "stepping in"
// is a request-changes round on the implement step, which counts the same for plan-time approvals (#53 §5.3).
// Three quick fixes touching apps/desktop/src/renderer/x.tsx each get a round on their implement step; the fourth
// such fix's Plan header says "you'll look at this one before it moves on". Project → Factory says where each
// file came from and has a Routing section.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { context, SCRATCH } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { SHIPPED_PLANNER } from '../../../../packages/application/dist/planning/defaults/planner.js';
import { autoDraft, shot, waitStatus, whyText } from '../common.mjs';

const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('PM10', 'People stepping in tightens the next plan; Project → Factory shows the files and routing');
const TOUCH = 'apps/desktop/src/renderer/x.tsx';
const goal = (n) => `fix: typo in the window title ${n} in ${TOUCH} SCRIPTED_TOUCH=${TOUCH}`;
const LOOK = "you'll look at this one before it moves on";

const factoryDir = join(SCRATCH, 'project', '.tandemise', 'factory');
const planner = {
  ...SHIPPED_PLANNER,
  areas: [
    ...SHIPPED_PLANNER.areas.filter((a) => a.name !== 'docs'),
    { name: 'desktop-ui', paths: ['apps/desktop/src/renderer/**'], sensitivity: 'none', skills: ['frontend-design'] },
    ...SHIPPED_PLANNER.areas.filter((a) => a.name === 'docs'),
  ],
  holdApproval: { minTasks: 3, rate: 0.4 },
};

const implementOf = async (id) => c.task(id, 'implement');

try {
  mkdirSync(factoryDir, { recursive: true });
  // JSON is YAML: the factory reads it as the project's own planner file.
  writeFileSync(join(factoryDir, 'planner.yaml'), `${JSON.stringify(planner, null, 2)}\n`);

  for (const n of [1, 2, 3]) {
    const id = await autoDraft(c, goal(n));
    ev.note(`desktop-ui fix ${n}: mission ${id}`);
    await api.post(`/v1/missions/${id}/plan`, {});
    const done = await until(async () => { const t = await implementOf(id); return t?.status === 'SUCCEEDED' && t; }, { label: `implement ${n} done`, timeoutMs: 150_000 });
    await waitStatus(c, id, ['COMPLETE', 'FAILED', 'BLOCKED'], 150_000).catch(() => null);
    // A person sends the implement step back: a note, then a round on it (the API the drawer uses).
    const note = await api.post(`/v1/tasks/${done.id}/feedback`, { text: `The title still has the typo (${n}).` });
    // A note on a finished step whose output nothing used starts the round itself; otherwise you start it.
    if (note.roundStarted === null) await api.post(`/v1/tasks/${done.id}/rounds`, { feedbackIds: [note.feedback.id], downstream: 'keep' });
    const t = await implementOf(id);
    ev.check(`fix ${n}: a round started on its implement step`, (t.round ?? 1) >= 2, { round: t.round, status: t.status });
  }

  const fourth = await autoDraft(c, goal(4));
  ev.note(`fourth desktop-ui fix: mission ${fourth}`);
  await api.post(`/v1/missions/${fourth}/plan`, {});
  const decision = await until(() => api.get(`/v1/missions/${fourth}/plan-decision`), { label: 'plan decision', timeoutMs: 60_000 });
  ev.check('the fourth plan profiles desktop-ui from the path it names', decision.chips.some((ch) => ch.signals.some((s) => s.includes('desktop-ui'))), decision.chips);
  const why = await whyText(c, fourth, (t) => t.includes(LOOK));
  ev.check(`its Plan header says "${LOOK}"`, why.includes(LOOK), why);
  ev.check('…because people stepped in on 3 of the last 3 desktop-ui implement steps', why.includes('People stepped in on 3 of the last 3 desktop-ui implement steps'), why);
  await shot(c, ev, 'plan-header');
  const implement = await implementOf(fourth);
  ev.check('…and the implement step asks for your look when it finishes', implement.approvalPolicy?.onCompletion === true, implement.approvalPolicy);

  // Project → Factory.
  await page.navigate('#/project');
  const factory = await until(async () => {
    const t = await page.evaluate(`document.querySelector('section[aria-label="Factory"]')?.innerText ?? ''`);
    return t.includes('Routing') && t;
  }, { label: 'Factory section', timeoutMs: 30_000 });
  ev.check('Project → Factory: the planner file is "From this project\'s repository"', /Planner rules[\s\S]*From this project's repository/.test(factory), factory);
  ev.check('…routing and merge are "Built in"', (factory.match(/Built in/g) ?? []).length >= 2, factory);
  ev.check('…with a Routing section that says every step uses its role\'s model', factory.includes("every step uses its role's model"), factory);
  const view = await api.get(`/v1/workspaces/${c.env.workspaceId}/factory`);
  ev.check('GET /factory: planner from the project, routing and merge built in', view.files.map((f) => f.origin).join(',') === 'project,shipped,shipped', view.files.map((f) => [f.name, f.origin, f.path]));
  const routing = await api.get(`/v1/workspaces/${c.env.workspaceId}/routing`);
  ev.check('GET /routing: no ladder written, with the empty sentence', routing.classes.length === 0 && typeof routing.empty === 'string', routing);
  await page.evaluate(`document.querySelector('section[aria-label="Factory"]')?.scrollIntoView({ block: 'start' })`);
  await sleep(500);
  await shot(c, ev, 'factory');

  // Write the defaults into the repository: the two built-in files land beside the project's own planner file.
  await page.click('Write the defaults into the repository', { within: 'section[aria-label="Factory"]' });
  const written = await until(async () => {
    const v = await api.get(`/v1/workspaces/${c.env.workspaceId}/factory`);
    return v.files.every((f) => f.origin === 'project') && v;
  }, { label: 'defaults written', timeoutMs: 20_000 });
  ev.check('Write the defaults: routing and merge now come from the repository', written.files.every((f) => f.path?.startsWith(factoryDir)), written.files.map((f) => [f.name, f.origin, f.path]));
  ev.check("…the project's own planner file is left as it was", readFileSync(join(factoryDir, 'planner.yaml'), 'utf8').includes('"minTasks": 3'));
  const after = await until(async () => {
    const t = await page.evaluate(`document.querySelector('section[aria-label="Factory"]')?.innerText ?? ''`);
    return (t.match(/From this project's repository/g) ?? []).length === 3 && t;
  }, { label: 'three files from the repository', timeoutMs: 20_000 }).catch(() => '');
  ev.check('…and the Factory section says so for all three, with the button gone', after !== '' && !after.includes('Write the defaults'), after);

  // A ladder for implement steps: the Routing table shows each model's record in the bucket these fixes ran in.
  writeFileSync(join(factoryDir, 'routing.yaml'), `${JSON.stringify({ version: 1, classes: { implement: { ladder: ['haiku', 'sonnet', 'opus'], default: 'sonnet' } } }, null, 2)}\n`);
  const table = await until(async () => {
    const r = await api.get(`/v1/workspaces/${c.env.workspaceId}/routing`);
    return r.classes.length === 1 && r;
  }, { label: 'routing ladder read', timeoutMs: 20_000 });
  const implementClass = table.classes[0];
  const bucket = implementClass.buckets.find((b) => b.key === 'implement|quick|none');
  ev.check('GET /routing: implement, "Quick lane · not sensitive", starting at sonnet', implementClass.title === 'Implement' && bucket?.title === 'Quick lane · not sensitive' && bucket.models.find((m) => m.starting)?.model === 'sonnet', table);
  ev.check('…the runs measured so far show as their own row (the model they ran on), never as a cost of $0', bucket?.models.some((m) => !m.onLadder && m.tasks >= 3 && m.medianCost !== '$0.00'), bucket?.models);
  await page.navigate('#/project');
  const routed = await until(async () => {
    const t = await page.evaluate(`document.querySelector('section[aria-label="Factory"]')?.innerText ?? ''`);
    return t.includes('Quick lane · not sensitive') && t;
  }, { label: 'routing table', timeoutMs: 30_000 });
  ev.check('Project → Factory → Routing: a table for implement steps', routed.includes('Implement') && /passed first time/i.test(routed) && routed.includes('starts here'), routed);
  await page.evaluate(`document.querySelector('section[aria-label="Factory"]')?.scrollIntoView({ block: 'start' })`);
  await sleep(500);
  await page.screenshot(join(dirname(ev.shots[0]), 'factory-settings.png'));

  // With the ladder written, the next plan's step line says which model, why, and where it goes if it fails.
  await api.post(`/v1/missions/${fourth}/cancel`, {}).catch(() => null);
  const fifth = await autoDraft(c, 'fix: typo in the footer text');
  ev.note(`routed fix: mission ${fifth}`);
  await api.post(`/v1/missions/${fifth}/plan`, {});
  const routedWhy = await whyText(c, fifth, (t) => t.includes('Implement · sonnet'));
  ev.check('Plan header: "Implement · sonnet · … · if it fails, opus"', /Implement · sonnet · .+ · if it fails, opus/.test(routedWhy), routedWhy);
  await shot(c, ev, 'routed-step');
  await api.post(`/v1/missions/${fifth}/cancel`, {}).catch(() => null);
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
} finally {
  rmSync(join(SCRATCH, 'project', '.tandemise', 'factory'), { recursive: true, force: true });
}
c.close(); ev.save();
