// E3 — Setup as code → choose a fixture folder → "Try on evals". The project's setup is exported through
// the daemon and copied into a fixture folder outside the project, with the Developer role moved to "good"
// there; the project's own files are put back. In the window, Project → "Import from a folder…" reads the
// fixture, and "Try on evals" opens the Runs form on Setup, prefilled with that folder. Nothing is applied:
// the project's roles and its setup status are the same before and after.
import { cpSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { SCRATCH, docsSize, readState, windowOf } from '../common.mjs';

const c = await context();
const { page, api, env, sleep } = c;
await docsSize(c);
const { go, press, has, waitFor } = windowOf(c);
const ev = new Evidence('E3', 'Setup as code: a fixture folder\'s "Try on evals" prefills the Runs form and applies nothing');
const { e1 } = readState();
if (!e1?.suiteId) throw new Error('E3 needs E1 first (a suite to try the setup on)');
const ws = env.workspaceId;

// ------------------------------------------------------------------ the fixture folder
const repositoryId = c.sql('SELECT id FROM repositories WHERE workspace_id = ?', ws)[0]?.id;
const exported = await api.post(`/v1/workspaces/${ws}/setup/export`, { repositoryId });
const fixture = join(SCRATCH, 'setup-fixture');
rmSync(fixture, { recursive: true, force: true });
cpSync(join(env.project, '.tandemise'), join(fixture, '.tandemise'), { recursive: true, filter: (src) => !src.includes('/.tandemise/out') });
const roleFile = join(fixture, '.tandemise', 'roles', 'development.md');
const exportedRole = existsSync(roleFile) ? readFileSync(roleFile, 'utf8') : '';
writeFileSync(roleFile, exportedRole.replace(/^model: bad$/m, 'model: good'));
ev.check('the fixture is the project\'s exported setup, with the Developer role on "good" instead of "bad"', /^model: bad$/m.test(exportedRole) && /^model: good$/m.test(readFileSync(roleFile, 'utf8')), { files: exported.files?.map((f) => f.path), role: readFileSync(roleFile, 'utf8').split('\n').slice(0, 8) });
// The export wrote into the project; the project goes back to its committed state.
const git = (...args) => execFileSync('git', args, { cwd: env.project }).toString();
git('checkout', '--', '.tandemise');
git('clean', '-fdq', '--', '.tandemise');
ev.check('the project is back to its committed files (the fixture lives outside it)', git('status', '--porcelain').trim() === '', git('status', '--porcelain'));

const roles = async () => JSON.stringify((await api.get(`/v1/roles?workspaceId=${ws}`)).map(({ updatedAt, ...r }) => r));
const setupStatus = async () => JSON.stringify(await api.get(`/v1/workspaces/${ws}/setup`));
const rolesBefore = await roles();
const statusBefore = await setupStatus();
// The daemon logs "setup.applied" when a setup is applied; its log is the one record of that.
const applied = () => (readFileSync(`${SCRATCH}/daemon.log`, 'utf8').match(/setup\.applied/g) ?? []).length;
const appliedBefore = applied();
ev.check('control (daemon log): the log does record setup actions ("setup.exported" is there)', /setup\.exported/.test(readFileSync(`${SCRATCH}/daemon.log`, 'utf8')));

// ------------------------------------------------------------------ Setup as code, in the window
writeFileSync(`${SCRATCH}/pick-directory.txt`, fixture);
await go('#/project');
await press('Import from a folder…');
await waitFor('Try on evals');
const preview = await page.text('main');
ev.check('the preview of the fixture shows the Developer role\'s model changing to "good"', /bad\s*→\s*good/.test(preview), preview.slice(Math.max(0, preview.indexOf('bad') - 200), preview.indexOf('bad') + 100));
await page.evaluate(`[...document.querySelectorAll('main button')].find((b) => b.innerText.trim() === 'Try on evals')?.scrollIntoView({ block: 'center' })`);
await page.screenshot(ev.shot('setup-preview'));
await press('Try on evals');
await waitFor('Setup folder');
const form = await page.evaluate(`document.querySelector('main [aria-label="New run"]')?.innerText ?? ''`);
ev.check('the Runs form opens on Setup, prefilled with the fixture folder', form.includes(fixture) && await page.evaluate(`(document.querySelector('[aria-label="Candidate kind"] [aria-pressed="true"], [aria-label="Candidate kind"] [aria-checked="true"], [aria-label="Candidate kind"] [data-active="true"]')?.innerText ?? '').trim() === 'Setup'`), form.slice(0, 600));
ev.check('the form is on E1\'s suite', await page.evaluate(`(document.querySelector('main [aria-label="New run"] select[aria-label="Suite"] option:checked')?.innerText ?? document.querySelector('.evals__listhead')?.innerText ?? '').includes('Runs')`));
ev.check('the location is the Evals Runs tab', await page.evaluate(`location.hash.startsWith('#/evals') && new URLSearchParams(location.search).get('tab') === 'runs'`), await page.evaluate('location.hash + location.search'));
await page.screenshot(ev.shot('runs-form-prefilled'));

await sleep(1000);
const rolesAfter = await roles();
ev.check('proof (API): the project\'s roles are unchanged (the Developer is still on "bad")', rolesAfter === rolesBefore && JSON.parse(rolesAfter).find((r) => r.id === 'development').models.model === 'bad', JSON.parse(rolesAfter).find((r) => r.id === 'development').models);
ev.check('proof (API): the setup status is unchanged, so no setup was applied', (await setupStatus()) === statusBefore, JSON.parse(statusBefore));
ev.check('proof (daemon log): no "setup.applied" was logged, before or after', appliedBefore === 0 && applied() === 0, { before: appliedBefore, after: applied() });
ev.check('proof (API): no run was started by opening the form', (await api.get(`/v1/evals/suites/${e1.suiteId}/runs`)).length === 1);

c.close(); ev.save();
