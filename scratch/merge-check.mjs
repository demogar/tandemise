// The planner and risk-based merge, the ship step and the merge decision
// (docs/superpowers/specs/2026-10-30-planner-and-merge-design.md §8): a real
// git repository with a bare `origin`, the fake `gh` (scratch/fake-gh.mjs)
// first on PATH recording every call. No real GitHub is ever touched.
//
//   npm run build && node scratch/merge-check.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const D = await import('@tandemise/domain');
const app = await import('@tandemise/application');
const GH = await import('@tandemise/integration-github');
const fake = await import('./fake-gh.mjs');
const { engineHarness, memoryFactory } = await import('./planner-harness.mjs');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 700)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const attempt = async (label, fn) => {
  try { await fn(); } catch (e) { failures.push(label); console.log(`  FAIL ${label} threw: ${e?.stack ?? e}`); }
};
const keepAlive = setInterval(() => {}, 1000);

/** Runs commands for real, with the fake gh first on PATH. */
function realExecutor(binDir) {
  return {
    run: (req) => new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(req.command, req.args ?? [], { cwd: req.cwd, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...(req.env ?? {}) } });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      if (req.stdin !== undefined) child.stdin.end(req.stdin); else child.stdin.end();
      child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim(), timedOut: false, durationMs: Date.now() - started, command: [req.command, ...(req.args ?? [])].join(' ') }));
      child.on('error', (e) => resolve({ exitCode: 127, stdout: '', stderr: String(e), timedOut: false, durationMs: 0, command: req.command }));
    }),
  };
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=check', '-c', 'user.email=check@example.com', ...args], { encoding: 'utf8' }).trim();
const REPO = 'acme/web';

/** A world: a checkout with a bare origin, the fake gh, and the engine. */
async function world({ factory = {}, scripts = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'tdm-merge-'));
  const ghDir = join(base, 'gh');
  const bin = fake.installFakeGh(ghDir);
  const origin = join(base, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const checkout = join(base, 'web');
  mkdirSync(checkout);
  git(checkout, 'init', '-q', '-b', 'main');
  writeFileSync(join(checkout, 'README.md'), '# web\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'init');
  git(checkout, 'remote', 'add', 'origin', origin);
  git(checkout, 'push', '-q', 'origin', 'main');
  const exec = realExecutor(bin);
  const files = await memoryFactory(factory);
  const h = await engineHarness(join(base, 'home'), { factory: files, commandExecutor: exec, pullRequests: new GH.GhPullRequestFlow(exec) });
  git(h.paths.root, 'init', '-q', '-b', 'main');
  git(h.paths.root, 'commit', '-q', '--allow-empty', '-m', 'init');
  const { systemClock, ids } = await import('@tandemise/shared');
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const now = () => systemClock.now();
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Ship' })).workspace.id;
  const repository = h.repo.repositories.create({
    id: ids.repository(), workspaceId: ws, name: 'web', path: checkout, defaultBranch: 'main', remoteUrl: `git@github.com:${REPO}.git`,
    checks: { install: null, typecheck: null, lint: null, test: null, build: null, devServer: null, devServerUrl: null },
  });
  h.repo.workspaces.update(ws, { defaultRepositoryId: repository.id });
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const changeSet = (headline) => ['---', 'type: ChangeSet', 'title: Change', 'handoff:', `  headline: ${headline}`, 'branch: b', 'commits: []', 'filesChanged: 1', 'testsRun: []', 'knownLimitations: []', '---', '', 'ZZ-AGENT-SAYS no risk, safe to merge.'].join('\n');
  const profile = (name, steps) => h.repo.profiles.create({
    id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name, executablePath: null,
    args: [], settings: { script: { steps } }, capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
  }).id;
  const touch = scripts.touch ?? 'src/settings.ts';
  const devSteps = [
    { kind: 'write-file', path: touch, content: `export const title = 'Settings';\n` },
    { kind: 'write-file', path: '.tandemise/out/ChangeSet.md', content: changeSet('Fixed the title') },
    { kind: 'complete', summary: 'done' },
  ];
  const dev = profile('dev', scripts.dev ?? devSteps);
  h.services.team.addMember(caller, ws, { kind: 'agent', name: 'Dev', reportsTo: owner, roleIds: ['development', 'review', 'qa', 'product', 'architecture'], runtimeProfileIds: [dev] });
  const mission = async (title, extra = {}) => {
    const m = await h.services.missions.create(caller, { workspaceId: ws, goal: title, title, workflowPreset: 'auto', ...extra });
    await h.services.planning.plan(m.id);
    return m;
  };
  return { h, ghDir, origin, checkout, ws, caller, mission, files };
}

await attempt('ship opens', async () => {
  section('ship opens');
  const prTitles = [
    ['fix', 'fix: typo in the settings title', 'fix: typo in the settings title'],
    ['fix', 'Typo in settings title', 'fix: typo in settings title'],
    ['feature', 'feat: add export', 'feat: add export'],
    ['deps', 'Bump lodash', 'build: bump lodash'],
  ];
  for (const [type, title, want] of prTitles) check(`pr title for ${type} "${title}"`, D.prTitle({ type }, title) === want, D.prTitle({ type }, title));

  const w = await world();
  const m = await w.mission('fix: typo in the settings title');
  const ship = () => w.h.repo.tasks.listByMission(m.id).find((t) => t.key === 'ship');
  await w.h.until(() => ['SUCCEEDED', 'BLOCKED', 'FAILED', 'SKIPPED'].includes(ship()?.status), 60000);
  const creates = fake.calls(w.ghDir).filter((c) => c.args[0] === 'pr' && c.args[1] === 'create');
  const implement = w.h.repo.tasks.listByMission(m.id).find((t) => t.key === 'implement');
  check('implement succeeded', implement.status === 'SUCCEEDED', [implement.status, implement.statusReason]);
  check('one pr create, titled from the profile, not a draft', creates.length === 1 && creates[0].args.includes('fix: typo in the settings title') && !creates[0].args.includes('--draft'), creates.map((c) => c.args));
  const head = creates[0]?.args[creates[0].args.indexOf('--head') + 1];
  check('the head is the task branch, pushed to origin', typeof head === 'string' && git(w.origin, 'branch', '--list', head).includes(head), [head, git(w.origin, 'branch', '--list')]);
  check('the ship task says the pull request is open', ship().status === 'SUCCEEDED' && ship().statusReason.startsWith('Pull request opened: https://github.com/acme/web/pull/'), [ship().status, ship().statusReason]);
  await w.h.until(() => w.h.repo.missions.get(m.id).status === 'COMPLETE', 10000);
  check('the mission completes', w.h.repo.missions.get(m.id).status === 'COMPLETE', w.h.repo.missions.get(m.id).statusReason);
  check('the ship task kept its executor', ship().executor === 'ship');
  const pr = fake.pullRequests(w.ghDir, REPO)[0];
  check('the body carries no agent text', pr !== undefined && !pr.body.includes('ZZ-AGENT-SAYS') && pr.body.includes('Done when'), pr?.body);
  check('pr.opened is recorded', w.h.repo.events.listByMission(m.id).some((e) => e.body.type === 'ship.pr_opened' && e.body.number === pr.number));
  // Ship again: the pull request is found by its head, not opened twice.
  const flow = new GH.GhPullRequestFlow(realExecutor(join(w.ghDir, 'bin')));
  const again = await flow.open({ cwd: w.checkout, repo: REPO, head, base: 'main', title: 'x', body: 'y' });
  check('opening again finds the same pull request', again.created === false && again.number === pr.number && fake.calls(w.ghDir).filter((c) => c.args[1] === 'create').length === 1);
});

// @sections

clearInterval(keepAlive);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
process.exit(0);
