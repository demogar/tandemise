#!/usr/bin/env node
// P3b evals: the Evals screen and its entry points, in the real window, on a brand-new installation.
//
//   npm run build && node scratch/acceptance/p3-evals/ui-shots.mjs [--hold]
//
// Fresh TANDEMISE_HOME + project (p0/setup.mjs) behind /tmp/tdm-p3b-ui, the daemon from this checkout's
// build, the real desktop window with its own user-data-dir and CDP on 9338. Seeds real data through the
// daemon API - build-only missions on the scripted runtime (switched to NDJSON with a --model flag, so
// cost and model are measured), saved cases, eval runs - then drives the window and screenshots every
// state the Evals screen has. Screenshots go to $SHOTS_DIR (default: the plan workspace's task-8-shots).
// Every step asserts on the DOM; a failed assertion is listed at the end and fails the run.
//
// The scripted agent's knobs ride in each mission goal, so a trial (which replays the case's goal)
// behaves exactly as its source mission did:
//   SCRIPTED_COST_USD=0.25   every run reports $0.25
//   SCRIPTED_FAIL_MODEL=bad  a run on the model "bad" writes nothing, so its gate fails
// The role is on "good" while the source missions run, then moved to "bad": the baseline replays today's
// (bad) role and the candidate tries "good" again, so the scorecard has a real difference.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const LINK = process.env.ACCEPTANCE_LINK ?? '/tmp/tdm-p3b-ui';
const PORT = Number(process.env.CDP_PORT ?? 9338);
const SHOTS = resolve(process.env.SHOTS_DIR ?? join(repoRoot, '.superpowers/sdd/2026-09-27-p3b-evals/task-8-shots'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\n### ${m}`);

// ---------------------------------------------------------------- fresh install
try { execFileSync('pkill', ['-f', `user-data-dir=${LINK}/electron`]); } catch { /* none */ }
if (existsSync(`${LINK}/env.json`)) { try { process.kill(JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8')).pid); } catch { /* gone */ } }
await sleep(1500);
// Socket paths must stay under macOS's 104-byte limit, so the run lives behind a short symlink.
const real = join(tmpdir(), `tdm-p3b-ui-${Date.now().toString(36)}`);
mkdirSync(real, { recursive: true });
rmSync(LINK, { recursive: true, force: true });
symlinkSync(real, LINK);
mkdirSync(SHOTS, { recursive: true });

log('setup');
execFileSync(process.execPath, [join(here, '../p0/setup.mjs'), LINK], {
  env: { ...process.env, SCRIPTED_DELAY_MS: '700', SCRIPTED_STATE_DIR: `${LINK}/scripted-state` },
  stdio: ['ignore', 'pipe', 'inherit'],
});
// A native folder dialog can't be driven over CDP: the window reads the folder it "picks" from this file.
const PICK = `${LINK}/pick-directory.txt`;
writeFileSync(PICK, '');
// A window behind others stops painting, and a screenshot then never returns: keep it rendering while occluded.
const desktop = spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${PORT}`, `--user-data-dir=${LINK}/electron`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
  cwd: join(repoRoot, 'apps/desktop'),
  env: { ...process.env, TANDEMISE_HOME: `${LINK}/home`, TANDEMISE_TEST_PICK_DIRECTORY: PICK },
  stdio: ['ignore', 'ignore', 'ignore'],
  detached: true,
});
desktop.unref();

const stopAll = () => {
  if (process.argv.includes('--hold')) return;
  try { process.kill(-desktop.pid, 'SIGTERM'); } catch { /* gone */ }
  try { execFileSync('pkill', ['-f', `user-data-dir=${LINK}/electron`]); } catch { /* none */ }
  try { process.kill(JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8')).pid); } catch { /* gone */ }
};

process.env.ACCEPTANCE_SCRATCH = LINK;
process.env.CDP_PORT = String(PORT);
const { context } = await import('../p0/lib/ctx.mjs');

const failures = [];
const check = (label, ok, observed) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || observed === undefined ? '' : ` — ${JSON.stringify(observed).slice(0, 400)}`}`);
  if (!ok) failures.push(label);
};

try {
  const c = await context();
  const { api, page, env } = c;
  const ws = env.workspaceId;
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  const shot = async (name) => { await sleep(500); await page.screenshot(join(SHOTS, `${name}.png`)); console.log(`shot ${name}.png`); };
  const has = (needle, selector = 'main') => page.evaluate(`(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '').includes(${JSON.stringify(needle)})`);
  const waitFor = (needle, selector = 'main', timeoutMs = 30_000) => page.waitForText(needle, { selector, timeoutMs });
  /** Clicks an enabled button (or link) whose text is exactly `label`, inside `within`. */
  const press = async (label, within = 'main') => {
    const ok = await c.until(() => page.evaluate(`(() => {
      const root = [...document.querySelectorAll(${JSON.stringify(within)})].pop() ?? document.body;
      const b = [...root.querySelectorAll('button, a')].find((x) => x.offsetParent !== null && !x.disabled && (x.innerText || x.getAttribute('aria-label') || '').trim() === ${JSON.stringify(label)});
      if (!b) return false;
      b.scrollIntoView({ block: 'center' });
      b.click();
      return true;
    })()`), { label: `button "${label}"`, timeoutMs: 20_000, everyMs: 300 });
    await sleep(500);
    return ok;
  };
  // The app routes on the hash and keeps its query in location.search (wouter's hash navigation), so a
  // query goes where the app's own links put it, and the hashchange tells the router.
  const go = async (hash) => {
    const [path, query = ''] = hash.replace(/^#/, '').split('?');
    await page.evaluate(`(() => {
      const url = new URL(location.href);
      url.search = ${JSON.stringify(query)};
      url.hash = ${JSON.stringify(path)};
      history.pushState(null, '', url.href);
      dispatchEvent(new HashChangeEvent('hashchange'));
    })()`);
    await sleep(900);
  };

  // -------------------------------------------------------------- seed
  log('seed: runtime, team, role, skill');
  const profile = (await api.get(`/v1/runtimes?workspaceId=${ws}`)).map((p) => p.profile ?? p).find((p) => p.id === env.scriptedProfileId);
  await api.patch(`/v1/runtimes/${env.scriptedProfileId}`, { settings: { ...profile.settings, outputFormat: 'ndjson', modelFlag: '--model' } });
  const workspaces = await api.get('/v1/workspaces');
  const wsView = workspaces.map((w) => w.workspace ?? w).find((w) => w.id === ws);
  await api.patch(`/v1/workspaces/${ws}`, { autonomy: { ...wsView.autonomy, planApproval: 'auto' } });
  const coder = (await api.post(`/v1/workspaces/${ws}/members`, { kind: 'agent', name: 'Coding agent', reportsTo: c.me, roleIds: ['development'], runtimeProfileIds: [env.scriptedProfileId] })).id;
  await c.staff({ development: { assignees: [coder], reviews: [] } });

  const role = async () => (await api.get(`/v1/roles?workspaceId=${ws}`)).find((r) => r.id === 'development');
  const putRole = async (patch) => {
    const { createdAt, updatedAt, builtIn, workspaceId, ...rest } = await role();
    return api.put('/v1/roles/development', { ...rest, workspaceId: ws, ...patch });
  };

  // A skill the development role pins at v1, then updated to v2 at its source: the Skills screen's "Try on evals".
  const skillDir = join(LINK, 'skills', 'house-style');
  mkdirSync(skillDir, { recursive: true });
  const skillMd = (line) => `---\nname: house-style\ndescription: How this team writes pages.\n---\n\n# House style\n\n${line}\n`;
  writeFileSync(join(skillDir, 'SKILL.md'), skillMd('Keep pages calm.'));
  const preview = await api.post(`/v1/workspaces/${ws}/skills/preview`, { source: { kind: 'path', path: skillDir } });
  const imported = await api.post(`/v1/workspaces/${ws}/skills`, { source: { kind: 'path', path: skillDir }, hash: preview.hash });
  await putRole({ models: { model: 'good', escalate: [], economyModel: null }, skills: [{ name: 'house-style', version: 1 }] });

  log('seed: source missions');
  const missionStatus = (id) => c.sql('SELECT status, status_reason AS reason FROM missions WHERE id = ?', id)[0] ?? {};
  const mission = async (goal) => {
    const body = await api.post('/v1/missions', { workspaceId: ws, goal, workflowPreset: 'build-only', successCriteria: ['The page builds'], planNow: true });
    const id = body.mission.id;
    await c.until(() => /Ready to start/.test(missionStatus(id).reason ?? '') || missionStatus(id).status !== 'PLANNING', { label: `${goal} planned`, timeoutMs: 30_000 });
    if (missionStatus(id).status !== 'EXECUTING') await api.post(`/v1/missions/${id}/start`).catch(() => undefined);
    return id;
  };
  const banner = await mission('Add a banner SCRIPTED_COST_USD=0.25 SCRIPTED_FAIL_MODEL=bad');
  const sidebar = await mission('Add a sidebar SCRIPTED_COST_USD=0.25 SCRIPTED_FAIL_MODEL=bad');
  const footer = await mission('Add a footer SCRIPTED_USAGE_MIN=1');
  const header = await mission('Add a header SCRIPTED_COST_USD=0.1');
  for (const id of [banner, sidebar, footer, header]) {
    await c.until(() => ['COMPLETE', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(missionStatus(id).status), { label: `mission ${id} finished`, timeoutMs: 120_000 });
    check(`source mission ${id} completes`, missionStatus(id).status === 'COMPLETE', missionStatus(id));
  }
  const buildTask = async (id) => (await api.get(`/v1/missions/${id}/tasks`)).find((t) => t.roleId === 'development');

  log('seed: cases');
  const c1 = await api.post(`/v1/tasks/${(await buildTask(banner)).id}/eval-case`, { newSuiteName: 'Build steps', name: 'Banner step' });
  await api.post(`/v1/tasks/${(await buildTask(sidebar)).id}/eval-case`, { suiteId: c1.suiteId, name: 'Sidebar step' });
  const c3 = await api.post(`/v1/tasks/${(await buildTask(footer)).id}/eval-case`, { newSuiteName: 'Unmeasured cost', name: 'Footer step' });
  // Today's role is the bad model; the candidate tries the good one.
  await putRole({ models: { model: 'bad', escalate: [], economyModel: null } });
  // v2 of the skill at its source, imported: the role still pins v1.
  writeFileSync(join(skillDir, 'SKILL.md'), skillMd('Keep pages calm, and say what changed.'));
  await api.post(`/v1/skills/${imported.skill.id}/update`);

  const TERMINAL = ['completed', 'stopped_at_cap', 'failed', 'cancelled'];
  const waitRun = (id, ms = 240_000) => c.until(async () => { const r = await api.get(`/v1/evals/runs/${id}`); return TERMINAL.includes(r.status) && r; }, { label: `eval run ${id} ends`, timeoutMs: ms, everyMs: 1000 });
  const runsHash = (suite, run) => `#/evals?tab=runs&suite=${suite}${run ? `&run=${run}` : ''}`;

  // Seeding wrote roles and skills behind the window's back; a reload reads them fresh.
  await page.evaluate('location.reload()');
  await sleep(1500);
  await page.waitForText('Daemon connected', { timeoutMs: 60_000 });

  // -------------------------------------------------------------- suites
  log('suites');
  await go('#/evals');
  await waitFor('Banner step');
  check('the sidebar lists Evals after Skills', await page.evaluate(`(() => { const l = [...document.querySelectorAll('.navitem__label')].map((e) => e.innerText); return l.indexOf('Evals') === l.indexOf('Skills') + 1; })()`));
  check('suites show case counts', await has('2 cases'));
  check('a case names its mission, linked', await page.evaluate(`[...document.querySelectorAll('main a')].some((a) => a.innerText.startsWith('from Add a banner'))`));
  check('a case shows its base commit, short', await page.evaluate(`[...document.querySelectorAll('main td.mono')].some((td) => /^[0-9a-f]{7}$/.test(td.innerText.trim()))`));
  await shot('01-suites-with-cases');

  // -------------------------------------------------------------- run form, each kind
  log('run form');
  await press('Runs', '.tabs');
  await waitFor('New run');
  check('a suite with no runs opens the form', await has('Start run'));
  check('the model is prefilled with the role model', await page.evaluate(`document.querySelector('input[aria-label="Model for Developer"]')?.value === 'bad'`));
  await shot('02-run-form-models');
  await press('Skills', '[aria-label="Candidate kind"]');
  check('skills lists the pin with a version select', await page.evaluate(`!!document.querySelector('select[aria-label="Version of house-style for Developer"]')`));
  await shot('03-run-form-skills');
  writeFileSync(PICK, env.project);
  await press('Setup', '[aria-label="Candidate kind"]');
  await press('Choose…');
  await waitFor(env.project);
  await shot('04-run-form-setup');

  // -------------------------------------------------------------- a run through the window
  log('a run, started in the window');
  await press('Models', '[aria-label="Candidate kind"]');
  await page.fill('Model for Developer', 'good');
  await page.fill('Repeats', '3');
  // A bad-model baseline trial runs twice at $0.25 a run: 2 cases × 3 repeats come to about $4.50.
  await page.fill('Spend cap', '10');
  await press('Start run');
  await c.until(() => page.evaluate(`location.search.includes('run=')`), { label: 'the run opens', timeoutMs: 20_000 });
  const firstRun = new URLSearchParams(await page.evaluate('location.search')).get('run');
  await waitFor('Cancel run');
  await c.until(async () => (await api.get(`/v1/evals/runs/${firstRun}`)).progress.done >= 1, { label: 'a trial finishes', timeoutMs: 90_000, everyMs: 500 });
  await sleep(2500);
  check('a running run shows n / total trials', /\d+ \/ 12 trials/.test(await page.text('main')), (await page.text('main')).slice(0, 600));
  check('a running run shows its spend against the cap', /Spent \$[0-9.]+ of \$10\.00/.test(await page.text('main')));
  await shot('05-running-run');

  // A delete while the run uses the suite is refused, in the daemon's words.
  await press('Suites', '.tabs');
  await press('Delete suite');
  await press('Delete suite', '[role=dialog]');
  await sleep(800);
  const refusal = await page.evaluate(`document.querySelector('main [role=alert]')?.innerText ?? ''`);
  check('a refused delete shows the daemon message inline', refusal.length > 0, refusal);
  await shot('06-delete-refused-inline');

  await waitRun(firstRun);
  await go(runsHash(c1.suiteId, firstRun));
  await waitFor('Scorecard');
  check('no few-repeats note at 3 repeats', !(await has('few repeats, differences may be noise')));
  check('a better pass rate is marked better', await page.evaluate(`document.querySelector('[aria-label="Whole suite"] tr[aria-label="Gate pass rate"] td:last-child')?.dataset.direction === 'better'`));
  check('a worse difference uses the danger colour', await page.evaluate(`!!document.querySelector('[aria-label="Whole suite"] .scorecard__diff--worse')`));
  await shot('07-finished-scorecard');
  await press('Banner step', '[aria-label="Cases"]').catch(() => undefined);
  await page.evaluate(`document.querySelector('[aria-label="Cases"] button')?.click()`);
  await sleep(500);
  check('a case row opens to the same table', await page.evaluate(`!!document.querySelector('[aria-label="Case Banner step"]')`));
  await page.evaluate(`document.querySelector('[aria-label="Case Banner step"]')?.scrollIntoView({ block: 'center' })`);
  await shot('08-scorecard-case-expanded');

  // -------------------------------------------------------------- few repeats, the cap, unmeasured cost
  log('few repeats');
  const few = await api.post(`/v1/evals/suites/${c1.suiteId}/runs`, { candidate: { kind: 'models', roles: { development: 'good' } }, repeats: 2, spendCapUsd: 5 });
  await waitRun(few.id);
  await go(runsHash(c1.suiteId, few.id));
  await waitFor('Scorecard');
  check('the few-repeats note', await has('few repeats, differences may be noise'));
  await shot('09-scorecard-few-repeats');

  log('stopped at the cap');
  const capped = await api.post(`/v1/evals/suites/${c1.suiteId}/runs`, { candidate: { kind: 'models', roles: { development: 'good' } }, repeats: 2, spendCapUsd: 0.6 });
  const cappedDone = await waitRun(capped.id);
  await go(runsHash(c1.suiteId, capped.id));
  await waitFor('Stopped at');
  check('the run stopped at its cap', cappedDone.status === 'stopped_at_cap', cappedDone.status);
  check('the cap line, verbatim', await has('Stopped at your $0.60 cap'));
  await shot('10-stopped-at-cap');

  log('unmeasured cost');
  const unmeasured = await api.post(`/v1/evals/suites/${c3.suiteId}/runs`, { candidate: { kind: 'models', roles: { development: 'good' } }, repeats: 1, spendCapUsd: 5 });
  await waitRun(unmeasured.id);
  await go(runsHash(c3.suiteId, unmeasured.id));
  await waitFor('Scorecard');
  check('the unmeasured-cost copy, verbatim', await has("This runtime doesn't report cost, so your cap can't stop this run."));
  await shot('11-cost-unmeasured');

  // -------------------------------------------------------------- from your runs
  log('from your runs');
  await go('#/evals?tab=yours');
  await waitFor('Every gated step');
  await c.until(() => page.evaluate(`!!document.querySelector('main table[aria-label="From your runs"]')`), { label: 'the runs table', timeoutMs: 20_000 });
  check('a role × model row', await page.evaluate(`!!document.querySelector('tr[aria-label="Developer on good"]')`));
  check('trials stay out of real-run scores', !(await page.evaluate(`!!document.querySelector('tr[aria-label="Developer on bad"]')`)));
  await shot('12-from-your-runs');

  // -------------------------------------------------------------- save as eval case
  log('save as eval case');
  await go(`#/missions/${header}`);
  await waitFor('Save as eval case');
  await press('Save as eval case');
  await waitFor('Case name', '[role=dialog]');
  check('the case name defaults to the step title', await page.evaluate(`(document.querySelector('[role=dialog] input[aria-label="Case name"]')?.value ?? '') !== ''`));
  await shot('13-save-case-dialog');
  await press('Save case', '[role=dialog]');
  await waitFor('Saved to Build steps', '[role=dialog]');
  check('saved, with a link to Evals', await page.evaluate(`[...document.querySelectorAll('[role=dialog] a')].some((a) => a.innerText === 'Open Evals')`));
  await shot('14-save-case-saved');
  await press('Done', '[role=dialog]');

  // -------------------------------------------------------------- try on evals: setup preview
  log('try on evals: setup');
  const repositoryId = (await api.get(`/v1/workspaces/${ws}/repositories`).catch(() => null))?.[0]?.id
    ?? c.sql('SELECT id FROM repositories WHERE workspace_id = ?', ws)[0]?.id;
  await api.post(`/v1/workspaces/${ws}/setup/export`, { repositoryId });
  writeFileSync(PICK, env.project);
  await go('#/project');
  await press('Import from a folder…');
  await waitFor('Try on evals');
  await page.evaluate(`[...document.querySelectorAll('main button')].find((b) => b.innerText.trim() === 'Try on evals')?.scrollIntoView({ block: 'center' })`);
  await shot('15-setup-preview-try-on-evals');
  const roleBefore = JSON.stringify(await role());
  await press('Try on evals');
  await waitFor('Setup folder');
  check('the form opens on Setup with the folder', await has(env.project));
  check('trying a setup applies nothing', JSON.stringify(await role()) === roleBefore);
  await shot('16-setup-candidate-prefilled');

  // A deep link's candidate is used once: leave by the sidebar without Cancel, come back by the sidebar
  // (and after a reload), and the old candidate must not reopen the form.
  const sidebarTo = (label) => press(label, '.sidebar__nav');
  const formWithFolder = () => page.evaluate(`(document.querySelector('main [aria-label="New run"]')?.innerText ?? '').includes(${JSON.stringify(env.project)})`);
  check('the link left no candidate in the query', !(await page.evaluate(`/candidate=|new=1/.test(location.search)`)), await page.evaluate('location.search'));
  await sidebarTo('Missions');
  await sidebarTo('Evals');
  await waitFor('Suites');
  check('the sidebar marks Evals active on its query link', await page.evaluate(`[...document.querySelectorAll('.sidebar__nav a[aria-current="page"]')].map((a) => a.innerText.trim()).join() === 'Evals'`));
  check('back by the sidebar opens Suites', await page.evaluate(`document.querySelector('.tabs [aria-selected="true"]')?.innerText.trim() === 'Suites'`));
  await press('Runs', '.tabs');
  await sleep(800);
  check('the old candidate does not reopen the run form', !(await formWithFolder()) && !(await has('Start run')));
  await page.evaluate('location.reload()');
  await sleep(1500);
  await page.waitForText('Daemon connected', { timeoutMs: 60_000 });
  await sleep(800);
  check('nor after a reload', !(await formWithFolder()) && !(await has('Start run')));
  await shot('16b-back-to-evals-no-stale-candidate');

  // -------------------------------------------------------------- try on evals: skills
  log('try on evals: skills');
  await go('#/skills');
  await waitFor('Try on evals');
  await shot('17-skills-try-on-evals');
  await press('Try on evals');
  await c.until(() => page.evaluate(`!!document.querySelector('main table[aria-label="Skills by role"] select')`), { label: 'the skills form', timeoutMs: 20_000 });
  check('the pin is prefilled at latest', await page.evaluate(`document.querySelector('select[aria-label="Version of house-style for Developer"]')?.value === 'latest'`));
  await shot('18-skills-candidate-prefilled');

  // -------------------------------------------------------------- limits
  log('limits');
  await go('#/project');
  await waitFor('of which evals');
  await page.evaluate(`[...document.querySelectorAll('.stat__label')].find((e) => e.innerText === 'Cost this month')?.scrollIntoView({ block: 'center' })`);
  check('the Limits line', /of which evals \$[0-9.]+/.test(await page.text('main')));
  await shot('19-limits-of-which-evals');

  // -------------------------------------------------------------- light theme, the scorecard's colours
  log('light theme');
  await go(runsHash(c1.suiteId, firstRun));
  await waitFor('Scorecard');
  await page.evaluate(`document.documentElement.dataset.theme = 'light'`);
  await shot('20-scorecard-light');
  await page.evaluate(`delete document.documentElement.dataset.theme`);

  // -------------------------------------------------------------- no suites: the empty states
  log('empty states');
  for (const suite of await api.get(`/v1/workspaces/${ws}/evals/suites`)) await api.del(`/v1/evals/suites/${suite.id}`);
  // Deleted behind the window's back: nothing streams evals, so read them fresh.
  await page.evaluate('location.reload()');
  await sleep(1500);
  await page.waitForText('Daemon connected', { timeoutMs: 60_000 });
  await go('#/evals?tab=suites');
  await waitFor('No suites yet');
  check('the empty suites copy, verbatim', await has('Save a finished step as a case from its card to start a suite.'));
  await shot('21-suites-empty');
  await go('#/evals?tab=runs&new=1');
  await waitFor('Save a case first');
  await shot('22-runs-no-suite');

  c.close();
} catch (error) {
  console.error(error);
  failures.push(`threw: ${error.message}`);
} finally {
  stopAll();
}

console.log(`\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILED:\n- ${failures.join('\n- ')}`}\nshots: ${SHOTS}`);
process.exit(failures.length === 0 ? 0 : 1);
