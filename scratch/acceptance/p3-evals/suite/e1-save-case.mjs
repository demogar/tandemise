// E1 — Save as eval case on a succeeded build step. The suite's setup comes first: the scripted runtime
// switched to NDJSON with a --model flag (so a run's cost and model are measured), a design and a coding
// agent, and the Developer role on the model "good". A mission on the P3b evals workflow (a design, then a
// gated build that reads it) is planned and approved in the window and runs to the end; "Save as eval case"
// on the build's feed card saves it into a new suite, and the Evals Suites tab shows the case with its short
// base commit and its input.
import { execFileSync } from 'node:child_process';
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { WORKFLOW, agent, developerOn, docsSize, measuredRuntime, role, windowOf, writeState } from '../common.mjs';

const c = await context();
const { page, api, env, until, sleep } = c;
await docsSize(c);
const { go, press, has, waitFor, reload } = windowOf(c);
const ev = new Evidence('E1', 'Save as eval case on a succeeded build step');

// ------------------------------------------------------------------ setup
const settings = await measuredRuntime(c);
ev.check('setup (API): the scripted runtime reports NDJSON and takes --model', settings.outputFormat === 'ndjson' && settings.modelFlag === '--model', { outputFormat: settings.outputFormat, modelFlag: settings.modelFlag });
const designer = await agent(c, 'Design agent', ['design']);
const coder = await agent(c, 'Coding agent', ['development']);
await c.staff({ design: { assignees: [designer], reviews: [] }, development: { assignees: [coder], reviews: [] } });
await developerOn(c, 'good');
ev.check('setup (API): the Developer role is on the model "good"', (await role(c)).models?.model === 'good', (await role(c)).models);
ev.note('the daemon runs with SCRIPTED_FAIL_MODEL=bad and SCRIPTED_COST_USD=0.25: a run on "bad" writes nothing, every run reports $0.25');
// Roles are cached by the window; it reads the new model fresh.
await reload();

// ------------------------------------------------------------------ a real mission
const goal = 'Add a hello banner to the page';
const missionId = await c.createMission(goal, { workflow: WORKFLOW });
await c.approvePlan(missionId, goal);
const mission = await until(async () => { const m = (await api.get(`/v1/missions/${missionId}`)).mission; return ['COMPLETE', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(m.status) && m; }, { label: 'the mission finishes', timeoutMs: 180_000, everyMs: 1000 });
const build = await c.task(missionId, 'build');
ev.check('proof (API): the mission completed and its build step SUCCEEDED', mission.status === 'COMPLETE' && build.status === 'SUCCEEDED', { mission: mission.status, build: build.status });
const buildRuns = c.sql('SELECT id, status FROM runs WHERE task_id = ? ORDER BY started_at', build.id);
ev.check('proof (API): the build passed on its first run', buildRuns.length === 1, buildRuns);

// ------------------------------------------------------------------ Save as eval case, in the window
await page.navigate(`#/missions/${missionId}`);
await sleep(1500);
const cardText = await until(async () => { const t = await c.cardText('build'); return t.includes('Save as eval case') && t; }, { label: 'Save as eval case on the build card', timeoutMs: 30_000 }).catch(() => c.cardText('build'));
ev.check('the succeeded build card offers "Save as eval case"', cardText.includes('Save as eval case'), cardText);
await page.evaluate(`document.querySelector('[data-feed-card="build"]')?.scrollIntoView({ block: 'center' })`);
await page.screenshot(ev.shot('build-card'));
await press('Save as eval case', '[data-feed-card="build"]');
await waitFor('Case name', '[role=dialog]');
const dialog = await page.evaluate(`(() => {
  const d = document.querySelector('[role=dialog]');
  return { suite: d.querySelector('select[aria-label="Suite"] option:checked')?.innerText ?? '', caseName: d.querySelector('input[aria-label="Case name"]')?.value ?? '', newSuite: !!d.querySelector('input[aria-label="New suite name"]') };
})()`);
ev.check('with no suite yet, the dialog offers a new suite, and the case name defaults to the step title', dialog.suite === 'New suite…' && dialog.newSuite && dialog.caseName === build.title, { ...dialog, stepTitle: build.title });
await page.fill('New suite name', 'Runs');
await page.fill('Case name', 'Hello banner build');
await page.screenshot(ev.shot('save-dialog'));
await press('Save case', '[role=dialog]');
const saved = await page.waitForText('Saved to Runs', { selector: '[role=dialog]', timeoutMs: 20_000 }).catch(() => page.text('[role=dialog]'));
ev.check('the dialog says "Saved to Runs." with a link to Evals', saved.includes('Saved to Runs.') && saved.includes('Open Evals'), saved);
await page.screenshot(ev.shot('saved'));
await press('Open Evals', '[role=dialog]');

// ------------------------------------------------------------------ the Suites tab
await waitFor('Hello banner build');
const suites = await api.get(`/v1/workspaces/${env.workspaceId}/evals/suites`);
const suite = suites.find((s) => s.name === 'Runs');
const cases = suite ? await api.get(`/v1/evals/suites/${suite.id}/cases`) : [];
const kase = cases[0];
ev.check('proof (API): a suite "Runs" with one case, from this mission\'s build step', suite?.cases === 1 && kase?.source?.missionId === missionId && kase?.name === 'Hello banner build', { suite, kase: kase && { name: kase.name, source: kase.source, roleId: kase.roleId } });
const project = (...args) => execFileSync('git', args, { cwd: env.project }).toString().trim();
const baseExists = (() => { try { project('cat-file', '-e', `${kase.baseSha}^{commit}`); return true; } catch { return false; } })();
ev.check('proof (API): the case keeps its base commit (a commit in the project) and its DesignBrief input', baseExists && kase.inputs.length === 1 && kase.inputs[0].type === 'DesignBrief', { baseSha: kase?.baseSha, inputs: kase?.inputs });
const row = await page.evaluate(`[...(document.querySelector('tr[aria-label="Case: Hello banner build"]')?.querySelectorAll('td') ?? [])].map((td) => td.innerText.trim())`);
ev.note(`the case row reads: ${JSON.stringify(row)}`);
ev.check('the Suites tab lists "Runs · 1 case" and the case row', (await has('1 case')) && row[0] === 'Hello banner build', row);
ev.check('the row shows the short base commit (7 characters of the case\'s base)', row[3] === kase.baseSha.slice(0, 7), { shown: row[3], baseSha: kase.baseSha });
ev.check('the row shows its input: the design brief, (DesignBrief)', /\(DesignBrief\)/.test(row[4] ?? ''), row[4]);
ev.check('the row names the mission it came from, linked', await page.evaluate(`[...document.querySelectorAll('main a')].some((a) => a.innerText === ${JSON.stringify(`from ${goal}`)})`));
ev.check('the Evals tab is active in the sidebar', await page.evaluate(`[...document.querySelectorAll('.sidebar__nav a[aria-current="page"]')].map((a) => a.innerText.trim()).join() === 'Evals'`));
await page.screenshot(ev.shot('suites-tab'));

writeState({ e1: { missionId, goal, suiteId: suite.id, caseId: kase.id, buildTaskId: build.id } });
c.close(); ev.save();
