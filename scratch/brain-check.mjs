/**
 * #51: the brain, one git repository per project for memory and the factory.
 *
 * Proves, against the built packages, local bare repositories as remotes and a
 * fake `gh` on PATH (never the network):
 *
 *   - pure: paths, writer ids, scrubbing, the brain.yaml codec, remote names;
 *   - persistence: migration 023, workspace_brains, runs.brain, brain_passes
 *     counted in measured_usage, proposals;
 *   - codec: tracker/intake/mcps files and a brain root for the setup codec;
 *   - git: the git and gh adapters (append-only, rebase, protected, offline);
 *   - link: create, adopt, local, unlink, sync;
 *   - factory: the database as a cache of factory/, write-through, precedence;
 *   - fold / ledger / select / loading / tools / signals / classify / promotion;
 *   - intake config: the brain's IntakeConfigSource.
 *
 *   npm run build && node scratch/brain-check.mjs [--only=pure,git]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`); }
};
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;
const wants = (name) => only === null || only.has(name);
const section = (t) => console.log(`\n== ${t}`);

const shared = await import('@tandemise/shared');
const D = await import('@tandemise/domain');
const app = await import('@tandemise/application');

const HOME = mkdtempSync(join(tmpdir(), 'tdm-brain-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// ------------------------------------------------------------------ pure
if (wants('pure')) {
  section('pure: paths, writer ids, scrubbing, brain.yaml, remotes');
  const paths = shared.createPaths('/x');
  check('createPaths(..).brain(ws) is <root>/brains/<ws>', typeof paths.brain === 'function' && paths.brain('ws_1') === '/x/brains/ws_1', paths.brain);
  check('createPaths(..).brains is <root>/brains', paths.brains === '/x/brains');
  check('makeWriterId slugs the handle and keeps 6 hex', D.makeWriterId?.('Ana Smith', 'a1b2c3d4e5') === 'ana-smith-a1b2c3');

  const repos = [{ name: 'garipass', path: '/home/ana/src/garipass' }];
  const tok = D.scrubForBrain?.('use ghp_' + 'a'.repeat(36), repos);
  check('a GitHub token becomes [redacted secret]', tok && 'text' in tok && tok.text.includes('[redacted secret]') && !tok.text.includes('ghp_'), tok);
  const rel = D.scrubForBrain?.('edit /home/ana/src/garipass/src/app/page.tsx', repos);
  check('a path inside a repository becomes repo-relative', rel?.text === 'edit garipass:src/app/page.tsx', rel);
  const abs = D.scrubForBrain?.('read /etc/ssh/config', repos);
  check('any other absolute path is refused in words', abs?.refused === "A lesson can't name a path on your machine. Name the file inside its repository instead.", abs);
  const plain = D.scrubForBrain?.('Run npm run ci before a PR.', repos);
  check('plain text is unchanged', plain?.text === 'Run npm run ci before a PR.', plain);
  check('the secret refusal sentence', D.BRAIN_SECRET_REFUSAL === "A lesson can't contain a secret; it was left out.");

  const m = app.readBrainManifest?.('version: 1\nproject: Garipass\n');
  check('brain.yaml defaults', m?.manifest?.promotion?.autoApply === 'off' && m.manifest.promotion.minHelpful === 3 && m.manifest.promotion.minMissions === 2 && m.manifest.humanEdits === 'direct' && Array.isArray(m.manifest.repositories) && m.manifest.repositories.length === 0, m);
  const bad = app.readBrainManifest?.('version: 1\nproject: G\npromotion:\n  autoApply: always\n');
  check('autoApply: always is a problem naming autoApply', typeof bad?.problem === 'string' && bad.problem.includes('autoApply'), bad);
  const once = m && app.renderBrainManifest(m.manifest);
  check('renderBrainManifest is stable', once !== undefined && once === app.renderBrainManifest(app.readBrainManifest(once).manifest), once);
  check('remoteOf normalises ssh and https', app.remoteOf?.('git@github.com:garipass/brain.git') === 'github.com/garipass/brain' && app.remoteOf('https://github.com/garipass/brain.git') === 'github.com/garipass/brain' && app.remoteOf('https://github.com/garipass/brain') === 'github.com/garipass/brain');
  check('layout constants', app.BRAIN_GITATTRIBUTES === 'memory/ledger/** merge=union\n' && app.BRAIN_FACTORY === 'factory' && app.BRAIN_EVALS === 'evals');
}

// ------------------------------------------------------------------ persistence
if (wants('persistence')) {
  section('persistence: migration 023, links, runs.brain, passes in measured usage, proposals');
  const { Container, compose } = await import('@tandemise/kernel');
  const P = await import('@tandemise/persistence');
  const { ids, systemClock } = shared;
  const now = () => systemClock.now();
  const container = new Container();
  compose(container, P.persistenceModule({ path: join(HOME, 'persist.db'), clock: systemClock }));
  const db = container.resolve(P.DATABASE);
  check('schemaVersion is 23', P.schemaVersion(db) === 23, P.schemaVersion(db));
  const ws = ids.workspace();
  container.resolve(P.WORKSPACE_REPOSITORY).create({
    id: ws, name: 'Garipass', defaultRepositoryId: null,
    autonomy: { planApproval: 'ask', localCodeChanges: 'auto', externalWrites: 'policy', productionRelease: 'ask', financialActions: 'deny' },
    concurrency: { maxTotalWorkers: 3, perRuntime: {} }, routing: {}, defaultAutonomyLevel: 'balanced',
    knowledge: { productVision: null, architecturePrinciples: null, codingStandards: null, designSystem: null, glossary: null },
  });
  const brains = container.resolve(P.WORKSPACE_BRAIN_REPOSITORY);
  const link = {
    workspaceId: ws, remote: 'github.com/garipass/brain', defaultBranch: 'main', clonePath: '/x/brains/ws',
    writerId: 'ana-a1b2c3', lastPulledSha: null, lastPushedSha: null, lastSyncAt: null,
    lastSyncError: "Couldn't reach github.com.", fallbackBranch: null, linkedAt: now(),
  };
  brains.create(link);
  check('a workspace_brains row round-trips', JSON.stringify(brains.get(ws)) === JSON.stringify(link), brains.get(ws));
  check('update patches a link', brains.update(ws, { lastPulledSha: 'abc' }).lastPulledSha === 'abc' && brains.list().length === 1);

  const missionId = ids.mission();
  container.resolve(P.MISSION_REPOSITORY).create({ id: missionId, workspaceId: ws, repositoryId: null, title: 'M', goal: 'g', constraints: [], successCriteria: [] });
  const taskId = ids.task();
  container.resolve(P.TASK_REPOSITORY).replaceAll(missionId, [{
    id: taskId, missionId, key: 'build', title: 'Build', objective: 'do', roleId: 'development', dependsOn: [],
    requiredCapabilities: [], inputArtifacts: [], expectedOutputs: [], executionPolicy: { isolation: 'worktree', maxWallTimeMs: 1000, capabilities: [] },
    approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'block' },
    completionGate: null, status: 'RUNNING', statusReason: null, attempts: 0, remediatesTaskId: null, orderHint: 0,
    createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
  }]);
  const profileId = ids.runtimeProfile();
  container.resolve(P.RUNTIME_PROFILE_REPOSITORY).create({ id: profileId, workspaceId: ws, adapterId: 'fake', name: 'Fake', executablePath: null, args: [], settings: {}, capabilities: [], enabled: true, maxConcurrent: 1, createdAt: now(), updatedAt: now() });
  const targetId = ids.executionTarget();
  container.resolve(P.EXECUTION_TARGET_REPOSITORY).create({ id: targetId, workspaceId: ws, missionId, taskId, kind: 'worktree', name: 'wt', workingDirectory: '/tmp/wt', branch: 'b', baseBranch: 'main', status: 'READY', detail: null, createdAt: now(), releasedAt: null });
  const assignmentId = ids.workerAssignment();
  container.resolve(P.ASSIGNMENT_REPOSITORY).create({ id: assignmentId, workspaceId: ws, missionId, taskId, roleId: 'development', runtimeProfileId: profileId, executionTargetId: targetId, grants: [], budgets: { maxWallTimeMs: 1000, maxAttempts: 1 }, createdAt: now() });
  const runs = container.resolve(P.RUN_REPOSITORY);
  const brain = { sha: 'abc', rules: ['memory/rules/project.md'], loaded: [{ id: 'w:1', net: 2 }], indexed: 0, fetched: [], proposed: [] };
  const mkRun = (extra) => ({ id: ids.run(), missionId, taskId, assignmentId, attempt: 1, status: 'RUNNING', roleId: 'development', runtimeProfileId: profileId, executionTargetId: targetId, externalSessionId: null, pid: null, exitCode: null, errorCode: null, errorMessage: null, usage: null, startedAt: now(), finishedAt: null, heartbeatAt: null, ...extra });
  const withBrain = runs.create(mkRun({ brain }));
  const without = runs.create(mkRun({ attempt: 2 }));
  check('runs.brain round-trips', JSON.stringify(runs.get(withBrain.id).brain) === JSON.stringify(brain), runs.get(withBrain.id).brain);
  check('a run without brain reads null', runs.get(without.id).brain === null);
  check('runs.update keeps brain', runs.update(withBrain.id, { status: 'SUCCEEDED' }).brain?.sha === 'abc' && runs.get(withBrain.id).brain?.sha === 'abc');

  const limits = container.resolve(P.LIMIT_REPOSITORY);
  runs.recordUsage(without.id, { inputTokens: 10, outputTokens: 5, costUsd: 1 });
  const before = limits.usageForMission(missionId).costUsd;
  const records = container.resolve(P.BRAIN_RECORD_REPOSITORY);
  const pass = (cost) => ({ id: `bps_${Math.random().toString(16).slice(2)}`, workspaceId: ws, missionId, taskId, kind: 'reflect', signal: 'hold', runtimeProfileId: profileId, model: 'm', status: 'ok', reason: null, usage: cost === undefined ? null : { inputTokens: 1, outputTokens: 1, costUsd: cost, wallTimeMs: 10 }, createdAt: now() });
  records.insertPass(pass(0.25));
  const after = limits.usageForMission(missionId).costUsd;
  check('a reflector pass adds its cost to the mission usage', Math.abs(after - before - 0.25) < 1e-9, { before, after });
  records.insertPass(pass(null));
  check('a pass with no cost leaves the cost unchanged (not 0)', limits.usageForMission(missionId).costUsd === after);
  check('passes are listed by workspace since a time', records.passes(ws, '2000-01-01T00:00:00.000Z').length === 2);

  const prop = { id: 'p1', workspaceId: ws, lessonIds: ['w:1'], targets: ['memory/rules/project.md'], classification: 'small', reasons: [], branch: 'tandemise/promote/p1', state: 'evaluating', evalRunId: null, verdict: null, prUrl: null, appliedSha: null, createdAt: now(), updatedAt: now() };
  records.upsertProposal(prop);
  records.upsertProposal({ ...prop, state: 'open', prUrl: 'https://x/pull/1' });
  check('upsertProposal keeps one row with the second state', records.proposals(ws).length === 1 && records.proposal('p1').state === 'open' && records.proposal('p1').lessonIds[0] === 'w:1');
  brains.remove(ws);
  check('remove drops the link', brains.get(ws) === undefined);
  await container.dispose();
}

// ------------------------------------------------------------------ fake gh + git config
// `gh` is a script first on PATH; its state lives under HOME. A git config
// (passed as GIT_CONFIG_GLOBAL) turns https://github.com/ into the local
// bare repositories the fake gh creates, so nothing touches the network.
const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
const FAKE = {
  bin: join(HOME, 'bin'), log: join(HOME, 'gh-log.jsonl'), state: join(HOME, 'gh-state'),
  remotes: join(HOME, 'remotes'), gitconfig: join(HOME, 'gitconfig'),
};
mkdirSync(FAKE.bin, { recursive: true });
mkdirSync(FAKE.remotes, { recursive: true });
writeFileSync(join(FAKE.bin, 'gh'), `#!/bin/sh\nFAKE_GH_LOG='${FAKE.log}' FAKE_GH_STATE='${FAKE.state}' FAKE_GH_REMOTES='${FAKE.remotes}' exec '${process.execPath}' '${join(here, 'brain-fixtures', 'fake-gh.mjs')}' "$@"\n`);
chmodSync(join(FAKE.bin, 'gh'), 0o755);
writeFileSync(FAKE.gitconfig, `[url "file://${FAKE.remotes}/"]\n\tinsteadOf = https://github.com/\n[user]\n\tname = Check\n\temail = check@localhost\n[init]\n\tdefaultBranch = main\n`);
process.env.PATH = `${FAKE.bin}:${process.env.PATH}`;
process.env.GIT_CONFIG_GLOBAL = FAKE.gitconfig;
const ghLog = () => (existsSync(FAKE.log) ? readFileSync(FAKE.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const bare = (name) => {
  const dir = join(HOME, 'bare', `${name}.git`);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--bare', '-q', '-b', 'main');
  return dir;
};
let supervisor = null;
async function brainRepo() {
  const EL = await import('@tandemise/execution-local');
  supervisor ??= new EL.NodeProcessSupervisor(quiet);
  return new EL.GitBrainRepo(supervisor, quiet, () => ({ GIT_CONFIG_GLOBAL: FAKE.gitconfig }));
}
async function brainHost() {
  const { GhBrainHost } = await import('@tandemise/integration-github');
  const EL = await import('@tandemise/execution-local');
  supervisor ??= new EL.NodeProcessSupervisor(quiet);
  const exec = {
    async run(req) {
      const r = await supervisor.run({ command: req.command, args: req.args ?? [], cwd: req.cwd ?? HOME, env: req.env ?? {}, stdin: req.stdin, timeoutMs: req.timeoutMs });
      return { command: req.command, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, durationMs: 0, timedOut: r.timedOut };
    },
  };
  return new GhBrainHost(exec);
}

// ------------------------------------------------------------------ codec
// A P15 snapshot fixture, used by the codec section and later ones.
const roleFixture = (id, name, model, extra = {}) => ({
  id, name, summary: `${name} summary`, instructions: `Do the ${id} work well.`, capabilities: ['repository.read'],
  produces: [], consumes: [], isolation: 'worktree', outputContract: '', model, escalate: [], economyModel: null,
  runtime: [], skills: [], ...extra,
});
const skillHash = 'a'.repeat(64);
const snapshotFixture = {
  project: {
    name: 'Garipass', autonomy: { planApproval: 'ask', localCodeChanges: 'auto', externalWrites: 'policy', productionRelease: 'ask', financialActions: 'deny' },
    maxTotalWorkers: 3, knowledge: { codingStandards: 'Use the design tokens.' }, wipLimit: null, monthlyLimits: [], missionLimits: [],
  },
  roles: [roleFixture('development', 'Developer', 'strong-model', { skills: [{ name: 'tdd', version: 1, hash: skillHash }] }), roleFixture('review', 'Reviewer', null)],
  workflows: [{ file: 'build-feature.yaml', content: 'id: build-feature\nname: Build a feature\nsteps: []\n' }],
  routines: [{ name: 'Nightly', kind: 'mission', goal: 'Tidy up', successCriteria: [], priority: 'normal', limits: null, workflow: null, schedule: { type: 'daily', at: '03:00' } }],
  skills: [{ name: 'tdd', version: 1, hash: skillHash, source: { kind: 'git', url: 'https://github.com/garipass/skills', subpath: 'tdd' } }],
  issues: null,
};
const mcpsFixture = [
  { name: 'GitHub', provider: 'github', capabilities: ['github.read', 'github.write'], connect: { kind: 'cli', command: 'gh' } },
  { name: 'YouTrack', provider: 'mcp', capabilities: ['issues.read', 'issues.write'], connect: { kind: 'mcp', url: 'https://youtrack.example.com/mcp' } },
];
// renderSetup(snapshotFixture).hash computed from origin/main's build, before
// this change: a P15 export without the new files is byte-identical to today's.
const P15_BASELINE_HASH = '717200293e5b';

if (wants('codec')) {
  section('codec: tracker, intake and mcps files; a brain root');
  const base = app.renderSetup(snapshotFixture);
  if (process.argv.includes('--print-baseline')) console.log('BASELINE', base.hash);
  check('with no new fields the export is byte-identical to P15 (hash literal)', base.hash === P15_BASELINE_HASH, base.hash);
  const nulls = app.renderSetup({ ...snapshotFixture, mcps: null, tracker: null, intake: null });
  check('null mcps/tracker/intake add nothing', nulls.hash === base.hash);
  const tracker = 'tracker:\n  kind: youtrack\n';
  const full = app.renderSetup({ ...snapshotFixture, mcps: mcpsFixture, tracker, intake: null });
  const added = full.files.map((f) => f.path).filter((p) => !base.files.some((b) => b.path === p)).sort();
  check('the rendered set gains exactly mcps.yaml and tracker.yaml', JSON.stringify(added) === JSON.stringify(['mcps.yaml', 'tracker.yaml']), added);
  const mcpsText = full.files.find((f) => f.path === 'mcps.yaml')?.content ?? '';
  check('mcps.yaml names gh and no credential', mcpsText.includes('command: gh') && !/credentialRef|env|token/i.test(mcpsText), mcpsText);
  const files = Object.fromEntries(full.files.map((f) => [f.path, f.content]));
  const read = app.readSetup(files);
  check('readSetup round-trips mcps', JSON.stringify(read.snapshot.mcps) === JSON.stringify(app.readSetup(Object.fromEntries(app.renderSetup(read.snapshot).files.map((f) => [f.path, f.content]))).snapshot.mcps) && read.snapshot.mcps?.length === 2, read.snapshot.mcps);
  check('readSetup carries tracker byte for byte', read.snapshot.tracker === tracker && read.problems.length === 0, read.problems);
  const items = app.diffSetup({ ...snapshotFixture, mcps: [] }, read, { library: [], stored: new Set(), repositories: [], integrations: [{ provider: 'github', name: 'GitHub' }] });
  const yt = items.find((i) => i.id === 'mcps:YouTrack');
  check('a missing MCP is an add row saying what to connect', yt?.action === 'add' && yt.detail === 'This project needs YouTrack. Connect it.' && yt.problem === null && yt.choice === null, yt);
  check('a connected MCP is same', items.find((i) => i.id === 'mcps:GitHub')?.action === 'same');
  check('the tracker is an item', items.find((i) => i.id === 'tracker:project')?.name === 'Tracker and state mapping');

  const { FileSetupFolder } = await import('../apps/daemon/dist/setup-folder.js');
  const dir = join(HOME, 'codec-brain');
  mkdirSync(join(dir, 'factory', 'roles'), { recursive: true });
  writeFileSync(join(dir, 'factory', 'tracker.yaml'), tracker);
  writeFileSync(join(dir, 'factory', 'notes.txt'), 'hello');
  writeFileSync(join(dir, 'factory', 'mcps.yaml'), mcpsText);
  const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
  const folder = await new FileSetupFolder(quiet).read(dir, { root: 'factory' });
  check('FileSetupFolder reads a brain root', folder?.files['tracker.yaml'] === tracker && folder.files['mcps.yaml'] === mcpsText, folder);
  check('and lists other files as ignored', folder?.ignored.includes('notes.txt'), folder?.ignored);
}

// ------------------------------------------------------------------ git
if (wants('git')) {
  section('git: the brain repository adapter and the gh host');
  const repo = await brainRepo();
  const remote = bare('git1');
  const a = join(HOME, 'git1-a');
  await repo.init(a, 'main');
  const manifest = 'version: 1\nproject: Garipass\n';
  await repo.commit(a, [{ path: 'brain.yaml', mode: 'write', content: manifest }], 'chore: create', null);
  await repo.setRemote(a, remote);
  check('init + commit + push is pushed', (await repo.push(a, 'main', { setUpstream: true })) === 'pushed');
  check('the bare repo has one commit', git(remote, 'log', '--oneline', 'main').trim().split('\n').length === 1);

  const b = join(HOME, 'git1-b');
  await repo.clone(remote, b);
  const head = await repo.head(b);
  check('a clone reads brain.yaml at head', (await repo.readAt(b, head, 'brain.yaml')) === manifest);
  check('listAt of a missing dir is empty', (await repo.listAt(b, head, 'memory')).length === 0);
  check('readAt of a missing file is null', (await repo.readAt(b, head, 'nope.md')) === null);

  const ledger = 'memory/ledger/2026/10/w.jsonl';
  await repo.commit(a, [{ path: ledger, mode: 'append', content: 'a\n' }], 'chore: one', null);
  await repo.commit(a, [{ path: ledger, mode: 'append', content: 'a\n' }], 'chore: two', null);
  check('two appends give a\\na\\n', readFileSync(join(a, ledger), 'utf8') === 'a\na\n');
  let refused = null;
  try { await repo.commit(a, [{ path: ledger, mode: 'write', content: 'x' }], 'chore: bad', null); } catch (e) { refused = e.message; }
  check('a write to a ledger file is refused', refused === 'Ledger files are append-only.', refused);
  check('the file is untouched by the refused write', readFileSync(join(a, ledger), 'utf8') === 'a\na\n');
  await repo.push(a, 'main');

  // Concurrent writers: own ledger files never conflict.
  await repo.commit(a, [{ path: 'memory/ledger/2026/10/a.jsonl', mode: 'append', content: '{"a":1}\n' }], 'chore: a', null);
  await repo.commit(b, [{ path: 'memory/ledger/2026/10/b.jsonl', mode: 'append', content: '{"b":1}\n' }], 'chore: b', null);
  check('the first push wins', (await repo.push(a, 'main')) === 'pushed');
  check('the second is rejected', (await repo.push(b, 'main')) === 'rejected');
  const rebased = await repo.fetchAndRebase(b, 'main');
  check('fetchAndRebase reports no conflict on ledger files', rebased.conflicted.length === 0 && rebased.offline === null, rebased);
  check('then the push goes through', (await repo.push(b, 'main')) === 'pushed');

  // A real conflict on a rules file.
  await repo.fetchAndRebase(a, 'main');
  await repo.commit(a, [{ path: 'memory/rules/project.md', mode: 'write', content: 'from a\n' }], 'chore: rules a', null);
  await repo.push(a, 'main');
  await repo.commit(b, [{ path: 'memory/rules/project.md', mode: 'write', content: 'from b\n' }], 'chore: rules b', null);
  const conflict = await repo.fetchAndRebase(b, 'main');
  check('a rules conflict is reported', JSON.stringify(conflict.conflicted) === JSON.stringify(['memory/rules/project.md']), conflict);
  check('no rebase is left in progress', !existsSync(join(b, '.git', 'rebase-merge')) && !existsSync(join(b, '.git', 'rebase-apply')));
  const moved = await repo.moveUnpushedTo(b, 'tandemise/local/b/x', 'main');
  check('moveUnpushedTo moves one commit', moved.length === 1, moved);
  check('main equals origin/main afterwards', (await repo.head(b, 'main')) === (await repo.head(b, 'refs/remotes/origin/main')));

  // Protected branch.
  const prot = bare('protected');
  writeFileSync(join(prot, 'hooks', 'pre-receive'), '#!/bin/sh\necho "GH006: Protected branch update failed for refs/heads/main." >&2\nexit 1\n');
  chmodSync(join(prot, 'hooks', 'pre-receive'), 0o755);
  const c = join(HOME, 'git1-c');
  await repo.init(c, 'main');
  await repo.commit(c, [{ path: 'brain.yaml', mode: 'write', content: manifest }], 'chore: create', null);
  await repo.setRemote(c, prot);
  check('a protected branch push is protected', (await repo.push(c, 'main')) === 'protected');

  // Offline.
  renameSync(remote, `${remote}.gone`);
  let threw = false;
  let off;
  try { off = await repo.fetchAndRebase(a, 'main'); } catch { threw = true; }
  check('offline fetch never throws and says why', !threw && typeof off?.offline === 'string' && off.offline.length > 0, off);
  renameSync(`${remote}.gone`, remote);

  // Fake gh.
  const host = await brainHost();
  const pr = await host.openPr({ clone: a, head: 'tandemise/x', base: 'main', title: 'T', body: 'B', draft: true });
  check('openPr returns the fake URL', pr.url.endsWith('/pull/1'), pr);
  const line = ghLog().find((l) => l.argv[0] === 'pr' && l.argv[1] === 'create');
  check('the gh log has --draft and the body on stdin', line?.argv.includes('--draft') && line.stdin === 'B', line);
  check('findPr finds it by head', (await host.findPr(a, 'tandemise/x'))?.url === pr.url);
  check('prState reads open', (await host.prState(a, pr.url)) === 'open');
  check('the host is available', (await host.available()).ok === true);
}

// ------------------------------------------------------------------ fold
if (wants('fold')) {
  section('fold: a deterministic fold over the memory ledger');
  const W = ['ana-a1b2c3', 'ben-d4e5f6', 'cy-0a0b0c'];
  const t = (n) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
  const id = (w, n) => `${w}:${String(n).padStart(26, '0')}`;
  const scope = { role: 'development' };
  const add = (w, n, text, extra = {}) => ({ op: 'add', id: id(w, n), at: t(n), by: w, entry: { kind: 'lesson', text, scope, source: { signal: 'person', mission: `M${n}` }, state: 'active', ...extra } });
  const vote = (w, n, target, v, why = 'reflector', mission) => ({ op: 'vote', id: target, at: t(n), by: w, vote: v, why, ...(mission ? { mission } : {}) });
  const events = [];
  for (let i = 0; i < 12; i++) events.push(add(W[i % 3], i + 1, `Lesson number ${i} about the build.`));
  events.push(add(W[0], 20, 'Run npm run ci before a PR.'));
  events.push(add(W[1], 21, 'run  npm run ci, before a PR'));
  for (let i = 0; i < 10; i++) events.push(vote(W[i % 3], 30 + i, id(W[i % 3], (i % 12) + 1), i % 4 === 0 ? 'harmful' : 'helpful'));
  events.push(vote(W[2], 41, id(W[1], 21), 'helpful'));
  events.push(vote(W[2], 42, id(W[0], 20), 'helpful'));
  for (let i = 0; i < 12; i++) events.push({ op: 'confirm', id: id(W[(i + 1) % 3], (i % 12) + 1), at: t(50 + i), by: W[(i + 1) % 3], mission: `X${i}` });
  events.push({ op: 'accept', id: id(W[0], 4), at: t(60), by: W[2] });
  events.push({ op: 'retire', id: id(W[1], 5), at: t(61), by: W[0], reason: 'Old.' });
  check('the fixture has 40 events across 3 writers', events.length === 40, events.length);

  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  const now = t(100);
  const reference = JSON.stringify(D.foldLedger?.(events, [], now));
  let same = typeof D.foldLedger === 'function';
  for (let i = 0; i < 100 && same; i++) same = JSON.stringify(D.foldLedger(shuffle(events), [], now)) === reference;
  check('100 shuffles fold to the same memory', same);

  const memory = D.foldLedger?.(events, [], now);
  const ci = memory?.entries.filter((e) => D.normaliseText(e.text) === D.normaliseText('Run npm run ci before a PR.'));
  check('duplicate adds are one entry with the earlier id', ci?.length === 1 && ci[0].id === id(W[0], 20), ci?.map((e) => e.id));
  check('votes on either id sum on the winner', ci?.[0]?.helpful === 2, ci?.[0]);
  check('the winner counts both missions', ci?.[0]?.missions.length === 2, ci?.[0]?.missions);

  const pv = D.foldLedger?.([add(W[0], 1, 'Person voted.'), vote(W[1], 2, id(W[0], 1), 'helpful', 'person')], [], now);
  check('a person vote counts 3', pv?.entries[0]?.net === 3, pv?.entries[0]);

  const sup = D.foldLedger?.([add(W[0], 1, 'Old way.'), add(W[0], 2, 'New way.'), { op: 'supersede', id: id(W[0], 1), at: t(3), by: W[0], successor: id(W[0], 2), invalidAt: t(3) }], [], now);
  const old = sup?.entries.find((e) => e.id === id(W[0], 1));
  check('a superseded entry stays, invalid from invalidAt', old?.invalidAt === t(3) && old.supersededBy === id(W[0], 2), old);
  check('and is not loadable after', old !== undefined && D.isLoadable(old, t(4)) === false);

  const harm = D.foldLedger?.([add(W[0], 1, 'Bad advice.'), ...[2, 3, 4].map((n) => vote(W[1], n, id(W[0], 1), 'harmful'))], [], now);
  check('3 harmful votes flag it and stop it loading', harm?.entries[0]?.flags.harmful === true && D.isLoadable(harm.entries[0], now) === false, harm?.entries[0]);

  const staleNow = new Date(Date.parse(t(1)) + 91 * 86_400_000).toISOString();
  const stale = D.foldLedger?.([add(W[0], 1, 'Old but fine.')], [], staleNow);
  check('91 days unconfirmed is stale but still loads', stale?.entries[0]?.flags.stale === true && D.isLoadable(stale.entries[0], staleNow) === true, stale?.entries[0]?.flags);

  const cand = (extra) => D.foldLedger([add(W[0], 1, 'Maybe this.', { state: 'candidate', source: { signal: 'agent', mission: 'M1' } }), ...extra], [], now).entries[0];
  check('a candidate does not load alone', D.isLoadable?.(cand([]), now) === false);
  check('a confirm from the same mission is not enough', D.isLoadable?.(cand([{ op: 'confirm', id: id(W[0], 1), at: t(2), by: W[1], mission: 'M1' }]), now) === false);
  check('a confirm from another mission makes it load', D.isLoadable?.(cand([{ op: 'confirm', id: id(W[0], 1), at: t(2), by: W[1], mission: 'M2' }]), now) === true);
  check('accept makes it load', D.isLoadable?.(cand([{ op: 'accept', id: id(W[0], 1), at: t(2), by: W[1] }]), now) === true);
  check('reject never loads', D.isLoadable?.(cand([{ op: 'reject', id: id(W[0], 1), at: t(2), by: W[1] }, { op: 'confirm', id: id(W[0], 1), at: t(3), by: W[1], mission: 'M2' }]), now) === false);

  const lines = [JSON.stringify(add(W[0], 1, 'Good line.')), '{not json', '{"op":"explode"}', JSON.stringify(vote(W[0], 2, id(W[2], 9), 'helpful'))];
  const parsed = lines.map((l, i) => D.parseLedgerLine?.(l, 'memory/ledger/2026/10/ana-a1b2c3.jsonl', i + 1));
  const evs = parsed.filter((p) => p && !('problem' in p));
  const probs = parsed.filter((p) => p && 'problem' in p);
  const folded = D.foldLedger?.(evs, probs, now);
  check('bad lines are three problems naming file and line', folded?.problems.length === 3 && folded.problems.every((p) => p.problem.startsWith('memory/ledger/2026/10/ana-a1b2c3.jsonl line ')), folded?.problems);
  check('an unknown id is named in words', folded?.problems.some((p) => p.problem === "memory/ledger/2026/10/ana-a1b2c3.jsonl line 4: refers to an entry this brain doesn't have."), folded?.problems);
  check('the good entry is intact', folded?.entries.length === 1 && folded.entries[0].text === 'Good line.');
}

// ------------------------------------------------------------------ select
if (wants('select')) {
  section('select: scope ranking, the lesson budget, the index');
  const now = '2026-10-30T00:00:00.000Z';
  let n = 0;
  const entry = (text, scope, extra = {}) => ({
    id: `w-a1b2c3:${String(++n).padStart(26, '0')}`, kind: 'lesson', text, scope, source: { signal: 'person', mission: 'M' }, state: 'active',
    helpful: 0, harmful: 0, net: 0, addedAt: now, lastConfirmedAt: now, missions: ['M'], confirmedElsewhere: false,
    invalidAt: null, supersededBy: null, retired: null, promoted: null, netSinceRejected: null, flags: { harmful: false, stale: false }, ...extra,
  });
  const task = { repos: ['garipass'], role: 'development', step: 'build', files: ['garipass:src/app/page.tsx'] };
  const mem = (entries) => ({ entries, aliases: {}, problems: [] });
  const step0 = entry('Step lesson.', { step: 'build' });
  const proj9 = entry('Project lesson.', {}, { net: 9, helpful: 9 });
  const picked = D.selectBrain?.(mem([proj9, step0]), task, now);
  check('a step lesson with net 0 ranks above a project one with net 9', picked?.lessons[0]?.id === step0.id && picked.lessons[1]?.id === proj9.id, picked?.lessons);
  const thirty = Array.from({ length: 30 }, (_, i) => entry(`${String(i).padStart(2, '0')}${'x'.repeat(198)}`, {}));
  const budget = D.selectBrain?.(mem(thirty), task, now);
  check('30 lessons of 200 chars: 20 loaded, 10 indexed', budget?.lessons.length === 20 && budget.index.length === 10, [budget?.lessons.length, budget?.index.length]);
  check('an index line is the first 80 characters', budget?.index[0]?.title.length === 80);
  const hundred = Array.from({ length: 100 }, (_, i) => entry(`${String(i).padStart(3, '0')}${'y'.repeat(197)}`, {}));
  check('the index is capped at 40', D.selectBrain?.(mem(hundred), task, now).index.length === 40);
  check('a paths glob matches a repo-relative file', D.matchScope?.({ paths: ['src/**/*.tsx'] }, { ...task, files: ['garipass:src/app/page.tsx'] }) === 'paths');
  check('and not a .ts file', D.matchScope?.({ paths: ['src/**/*.tsx'] }, { ...task, files: ['garipass:src/app/page.ts'] }) === null);
  check('a lesson for another role does not match', D.matchScope?.({ role: 'review' }, task) === null);
  const harmful = entry('Harmful.', {}, { flags: { harmful: true, stale: false }, harmful: 3, net: -3 });
  const superseded = entry('Superseded.', {}, { invalidAt: '2026-01-01T00:00:00.000Z', supersededBy: 'x' });
  const sel = D.selectBrain?.(mem([harmful, superseded]), task, now);
  check('harmful and superseded entries are never selected', sel?.lessons.length === 0 && sel.index.length === 0, sel);
}

// ------------------------------------------------------------------ harness
// The application composed over a real database, with the daemon's disk
// adapters and the brain's git and gh adapters, as bootstrap binds them.
async function brainHarness(name) {
  const home = join(HOME, name);
  const { Container, compose } = await import('@tandemise/kernel');
  const { createLogger, createPaths, systemClock } = shared;
  const persistenceTokens = await import('@tandemise/persistence');
  const A = await import('@tandemise/artifacts');
  const { policyModule } = await import('@tandemise/policy');
  const { contextModule } = await import('@tandemise/context');
  const { createEvaluationModule } = await import('@tandemise/evaluation');
  const { runtimesCoreModule } = await import('@tandemise/runtimes-core');
  const { genericRuntimeModule } = await import('@tandemise/runtime-generic');
  const { executionCoreModule, CLOCK: EXEC_CLOCK, LOGGER: EXEC_LOGGER, PATHS: EXEC_PATHS } = await import('@tandemise/execution-core');
  const { executionLocalModule } = await import('@tandemise/execution-local');
  const { integrationsCoreModule, CLOCK: INT_CLOCK, LOGGER: INT_LOGGER, COMMAND_EXECUTOR, BACKGROUND_PROCESS_LAUNCHER } = await import('@tandemise/integrations-core');
  const { FileWorkflowSource } = await import('../apps/daemon/dist/workflow-source.js');
  const { FileSetupFolder } = await import('../apps/daemon/dist/setup-folder.js');
  const { DaemonSkillFiles } = await import('../apps/daemon/dist/skill-files.js');
  const paths = createPaths(home);
  mkdirSync(paths.root, { recursive: true });
  const log = createLogger({ level: 'error', base: { component: 'brain-check' } });
  const clock = systemClock;
  const container = new Container();
  compose(
    container,
    persistenceTokens.persistenceModule({ path: paths.db, logger: log, clock }),
    A.createArtifactsModule({ paths }),
    policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
    executionCoreModule, executionLocalModule, integrationsCoreModule, app.createApplicationModule({ localPersonName: name === 'home2' ? 'Ben Ortiz' : 'Ana Smith' }),
  );
  container.bind(EXEC_CLOCK, () => clock, { source: 'check' });
  container.bind(EXEC_LOGGER, () => log, { source: 'check' });
  container.bind(EXEC_PATHS, () => paths, { source: 'check' });
  container.bind(INT_CLOCK, () => clock, { source: 'check' });
  container.bind(INT_LOGGER, () => log, { source: 'check' });
  container.bind(COMMAND_EXECUTOR, () => ({ run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }), { source: 'check' });
  container.bind(BACKGROUND_PROCESS_LAUNCHER, () => ({ launch: async () => { throw new Error('unused'); } }), { source: 'check' });
  const isToken = (v) => typeof v === 'object' && v !== null && typeof v.description === 'string';
  for (const key of Object.keys(app)) {
    const appToken = app[key]; const provider = persistenceTokens[key];
    if (!isToken(appToken) || !isToken(provider)) continue;
    if (!container.has(provider) || container.has(appToken)) continue;
    container.bind(appToken, (r) => r.resolve(provider), { source: `alias:${key}` });
  }
  const published = [];
  const subscribers = new Set();
  container.bind(app.ARTIFACT_STORE, (r) => r.resolve(A.ARTIFACT_STORE), { source: 'alias' });
  container.bind(app.ARTIFACT_TEMPLATES, () => ({ render: A.renderArtifactTemplate }), { source: 'check' });
  container.bind(app.ARTIFACT_PARSER, () => ({ parse: A.parseArtifact }), { source: 'check' });
  container.bind(app.ARTIFACT_MEASURE, () => ({ measure: A.measureArtifact, deriveHandoff: A.deriveHandoff, splitAppendix: A.splitAppendix }), { source: 'check' });
  container.bind(app.EVENT_BUS, () => ({ publish: (e) => { published.push(e); for (const s of subscribers) s(e); }, subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); } }), { source: 'check' });
  container.bind(app.PROJECTION_BUS, () => ({ invalidate: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.SECRET_STORE, () => ({ backend: 'memory', store: async () => 'x', resolve: async () => undefined, remove: async () => {}, list: async () => [] }), { source: 'check' });
  container.bind(app.SETTINGS_STORE, () => app.createMemorySettingsStore(), { source: 'check' });
  container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home, schemaVersion: 1 }), { source: 'check' });
  container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });
  container.rebind(app.WORKFLOW_SOURCE, () => new FileWorkflowSource(quiet), { source: 'check' });
  container.rebind(app.SETUP_FOLDER, () => new FileSetupFolder(quiet), { source: 'check' });
  container.rebind(app.SKILL_FILES, () => new DaemonSkillFiles(paths.skills, join(home, 'claude-skills'), quiet), { source: 'check' });
  const repoPort = await brainRepo();
  const hostPort = await brainHost();
  container.rebind(app.BRAIN_REPO, () => repoPort, { source: 'check' });
  container.rebind(app.BRAIN_HOST, () => hostPort, { source: 'check' });
  const ctx = await import('@tandemise/context');
  const prompts = [];
  const realCompiler = ctx.createContextCompiler();
  container.rebind(ctx.CONTEXT_COMPILER, () => ({ compile: (req) => { const c = realCompiler.compile(req); prompts.push({ taskId: req.task.id, prompt: c.prompt, truncated: c.truncated }); return c; } }), { source: 'check' });
  const services = app.createServices(container);
  const r = (t) => container.resolve(t);
  const caller = { personId: services.identity.localPerson().id };
  const repoDir = join(home, 'code');
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, 'init', '-q', '-b', 'main');
  writeFileSync(join(repoDir, 'README.md'), '# garipass\n');
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-q', '-m', 'init');
  const ws = (await services.workspaces.create(caller, { name: 'Garipass', repositoryPath: repoDir })).workspace.id;
  return { home, paths, container, services, r, caller, ws, repoDir, published, subscribers, brainRepo: repoPort, prompts };
}

// ------------------------------------------------------------------ link
let H1 = null;
let H2 = null;
if (wants('link') || wants('factory') || wants('ledger') || wants('loading') || wants('tools') || wants('signals') || wants('promotion') || wants('intake')) {
  H1 = await brainHarness('home1');
  H2 = await brainHarness('home2');
}
const remoteDir = join(FAKE.remotes, 'garipass', 'brain.git');
const tokenText = 'ghp_' + 'z'.repeat(36);

if (H1 !== null) {
  section('link: create, adopt, keep local, unlink, sync');
  const { services: s1, r: r1, caller: c1, ws: ws1 } = H1;
  // Home 1 has a reviewer with a model and a token in its instructions, a GitHub integration, and an accepted decision.
  const reviewer = s1.roles.list(ws1).find((x) => x.id === 'review');
  s1.roles.upsert({ ...reviewer, workspaceId: ws1, instructions: `Review carefully. Use ${tokenText} for nothing.`, models: { model: 'strong-model', escalate: [], economyModel: null } });
  r1(app.INTEGRATION_REPOSITORY).create({ id: shared.ids.integration(), workspaceId: ws1, providerId: 'github', name: 'GitHub', transport: 'cli', config: {}, credentialRef: null, enabledCapabilities: ['github.read'], enabled: true, createdAt: shared.systemClock.now(), updatedAt: shared.systemClock.now() });
  const decision = (id) => ({ id, workspaceId: ws1, missionId: null, title: 'Use SQLite for state', context: 'One machine.', decision: 'SQLite with WAL.', rationale: 'Simple.', alternatives: [{ title: 'Postgres', summary: 'A server.' }], consequences: ['No server.'], status: 'accepted', owner: 'ana', relatedArtifacts: [], supersedes: null, createdAt: shared.systemClock.now(), decidedAt: shared.systemClock.now() });
  r1(app.DECISION_REPOSITORY).create(decision(shared.ids.decision()));
  s1.workspaces.update(ws1, { knowledge: { productVision: 'Calm software.', architecturePrinciples: null, codingStandards: 'Run npm run ci.', designSystem: null, glossary: null } });

  const before = ghLog().length;
  const view = await s1.brain.link(c1, ws1, { mode: 'create', owner: 'garipass', name: 'brain' });
  const created = ghLog().slice(before).find((l) => l.argv[0] === 'repo');
  check('create runs gh repo create --private', created?.argv.join(' ') === 'repo create garipass/brain --private', created);
  check('the view is linked and up to date', view.linked === true && view.status === 'up_to_date' && view.statusLine.startsWith('Up to date'), view);
  const tree = git(remoteDir, 'ls-tree', '-r', '--name-only', 'main').split('\n').filter(Boolean);
  for (const f of ['brain.yaml', 'README.md', '.gitattributes', 'factory/tandemise.yaml', 'factory/roles/development.md', 'memory/rules/project.md']) {
    check(`the bare repo has ${f}`, tree.includes(f), tree);
  }
  check('.gitattributes is the union rule', git(remoteDir, 'show', 'main:.gitattributes') === app.BRAIN_GITATTRIBUTES);
  const p15 = app.renderSetup(await s1.setup.snapshotFor(ws1, { mcps: false }));
  const mismatched = p15.files.filter((f) => { try { return git(remoteDir, 'show', `main:factory/${f.path}`) !== f.content; } catch { return true; } }).map((f) => f.path);
  check('every P15 file is byte-identical under factory/', mismatched.length === 0, mismatched);
  check('mcps.yaml is in the brain', tree.includes('factory/mcps.yaml'));
  check('a decision file is in the brain', tree.some((f) => /^memory\/decisions\/use-sqlite-for-state-[0-9a-f]{8}\.md$/.test(f)), tree);
  const rules = git(remoteDir, 'show', 'main:memory/rules/project.md');
  check('project.md carries the knowledge fields in order', rules.indexOf('## Product vision') >= 0 && rules.indexOf('## Product vision') < rules.indexOf('## Coding standards') && rules.includes('Run npm run ci.'), rules);

  let second = null;
  try { await s1.brain.link(c1, ws1, { mode: 'create', owner: 'garipass', name: 'brain' }); } catch (e) { second = e.message; }
  check('a second brain is refused in words', second === 'This project already has a brain: github.com/garipass/brain.', second);

  const factoryText = tree.filter((f) => f.startsWith('factory/')).map((f) => git(remoteDir, 'show', `main:${f}`)).join('\n');
  const profileIds = r1(app.RUNTIME_PROFILE_REPOSITORY).list().map((p) => p.id);
  check('factory/ has no runtime profile id', !profileIds.some((id) => factoryText.includes(id)));
  check('routines.yaml has no enabled key', !/^\s*enabled:/m.test(tree.includes('factory/routines.yaml') ? git(remoteDir, 'show', 'main:factory/routines.yaml') : ''));
  check('factory/ has no absolute path', !/(^|[\s'"])\/(home|Users|tmp|private)\//.test(factoryText));
  const all = git(remoteDir, 'log', '-p', '--all');
  check('no ghp_ token anywhere in the brain', !all.includes('ghp_'), all.slice(0, 200));

  // Adopt from a second home.
  const { services: s2, caller: c2, ws: ws2 } = H2;
  const preview = await s2.brain.link(c2, ws2, { mode: 'adopt', remote: 'github.com/garipass/brain' });
  check('adopt previews role:development as same', preview.items?.find((i) => i.id === 'role:development')?.action === 'same', preview.items?.map((i) => [i.id, i.action]));
  check('adopt previews the missing GitHub connection', preview.items?.find((i) => i.id === 'mcps:GitHub')?.detail === 'This project needs GitHub. Connect it.');
  check('adopt counts the brain', preview.brain?.rules >= 1 && preview.brain.mcpsNeeded.includes('GitHub'), preview.brain);
  const adopted = await s2.brain.applyAdopt(c2, ws2, { hash: preview.hash, choices: {} });
  check('after applyAdopt home 2 is linked', adopted.linked === true && adopted.remote === 'github.com/garipass/brain', adopted);
  const model = (s, w, id) => s.roles.list(w).find((x) => x.id === id)?.models?.model ?? null;
  check("home 2's Reviewer model equals home 1's", model(s2, ws2, 'review') === 'strong-model' && model(s2, ws2, 'development') === model(s1, ws1, 'development'));
  check('the two homes have different writer ids', s1.brain.view(ws1).writerId !== s2.brain.view(ws2).writerId, [s1.brain.view(ws1).writerId, s2.brain.view(ws2).writerId]);

  // Decisions are content-named.
  const d1 = app.decisionFile(decision(shared.ids.decision()));
  const d2 = app.decisionFile(decision(shared.ids.decision()));
  check('the same decision on two machines is one file name', d1.path === d2.path, [d1.path, d2.path]);

  // Offline.
  const pinned = s1.brain.view(ws1).lastPulledSha;
  renameSync(remoteDir, `${remoteDir}.gone`);
  const off = await s1.brain.sync(ws1, 'person');
  check('offline: status and words', off.status === 'offline' && off.statusLine.startsWith('Working from your copy of the brain'), off);
  check('offline: pin still returns the old head', (await s1.brain.pin(ws1)) === pinned);
  renameSync(`${remoteDir}.gone`, remoteDir);
  const back = await s1.brain.sync(ws1, 'person');
  check('back online: up to date again', back.status === 'up_to_date', back);

  // Local only, then unlink, on a third project.
  const ws3 = (await s1.workspaces.create(c1, { name: 'Side', repositoryPath: H1.repoDir })).workspace.id;
  const ghBefore = ghLog().length;
  const local = await s1.brain.link(c1, ws3, { mode: 'local' });
  check('local: status local_only with no gh call', local.status === 'local_only' && ghLog().length === ghBefore && local.statusLine === 'This brain is only on this machine. Share it to work with others.', local);
  const rolesBefore = JSON.stringify(s1.roles.list(ws3).map((x) => [x.id, x.models]));
  const unlinked = await s1.brain.unlink(c1, ws3);
  check('unlink: the row is gone', unlinked.linked === false && r1(app.WORKSPACE_BRAIN_REPOSITORY).get(ws3) === undefined);
  check('unlink: the clone stays', existsSync(join(H1.paths.brain(ws3), 'brain.yaml')));
  check('unlink: roles unchanged', JSON.stringify(s1.roles.list(ws3).map((x) => [x.id, x.models])) === rolesBefore);
  let evalsRefused = null;
  try { await s1.brain.readAt(ws1, pinned, 'evals/gates.yaml'); } catch (e) { evalsRefused = e.message; }
  check('readAt refuses evals/', evalsRefused === 'The evals folder can only be changed by a person.', evalsRefused);
}

// ------------------------------------------------------------------ factory
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
let scratchN = 0;
/** A person's own clone of the brain: edit, commit, push. */
function scratchEdit(edits, message = 'chore: edit by hand') {
  const dir = join(HOME, `scratch-${++scratchN}`);
  execFileSync('git', ['clone', '-q', remoteDir, dir], { stdio: 'ignore' });
  for (const [path, content] of Object.entries(edits)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof content === 'function' ? content(existsSync(join(dir, path)) ? readFileSync(join(dir, path), 'utf8') : null) : content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  git(dir, 'push', '-q', 'origin', 'main');
  return dir;
}
const commitCount = () => Number(git(remoteDir, 'rev-list', '--count', 'main').trim());
const withModel = (text, model) => {
  const read = app.readRole('roles/development.md', text);
  return app.renderRole({ ...read.role, model });
};

if (H1 !== null && (wants('factory') || wants('ledger') || wants('loading') || wants('tools') || wants('signals') || wants('promotion') || wants('intake'))) {
  section('factory: the database is a cache of factory/, your edits write through');
  const { services: s1, r: r1, caller: c1, ws: ws1 } = H1;
  const { services: s2, ws: ws2 } = H2;

  // A routine made here writes through to the brain.
  const routine = s1.routines.create(c1, ws1, { name: 'Nightly tidy', kind: 'mission', goal: 'Tidy up', successCriteria: ['Nothing is left untidy.'], priority: 'normal', limits: null, workflowPreset: null, schedule: { type: 'daily', at: '03:00' }, enabled: false }).routine;
  await sleep(3000);
  await s1.brain.sync(ws1, 'person');
  check('a new routine writes through to factory/routines.yaml', git(remoteDir, 'show', 'main:factory/routines.yaml').includes('Nightly tidy'));
  // Personal fields: switch it on and route Developer here.
  s1.routines.update(routine.id, { enabled: true });
  const profileX = r1(app.RUNTIME_PROFILE_REPOSITORY).list()[0]?.id ?? 'rt-x';
  s1.workspaces.update(ws1, { routing: { development: [profileX] } });
  await sleep(2600);
  await s1.brain.sync(ws1, 'person');
  const beforeCount = commitCount();
  const beforeGh = ghLog().length;

  scratchEdit({
    'factory/roles/development.md': (t) => withModel(t, 'other-model'),
    'factory/routines.yaml': (t) => t.replace("at: \"03:00\"", "at: \"04:30\"").replace("at: '03:00'", "at: '04:30'").replace('at: 03:00', 'at: 04:30'),
  });
  const afterEdit = commitCount();
  await s1.brain.sync(ws1, 'person');
  const dev = s1.roles.list(ws1).find((x) => x.id === 'development');
  check('a pushed role edit reaches the database after sync (no preview)', dev?.models?.model === 'other-model', dev?.models);
  const tidy = r1(app.ROUTINE_REPOSITORY).list(ws1).find((x) => x.name === 'Nightly tidy');
  check('the routine took the brain schedule', tidy?.schedule?.at === '04:30', tidy?.schedule);
  check('this machine keeps the routine switched on', tidy?.enabled === true, tidy?.enabled);
  check('routing still names this machine\'s profile', JSON.stringify(s1.workspaces.view(ws1).workspace.routing.development) === JSON.stringify([profileX]));
  await sleep(2600);
  check('the refresh did not write back (loop guard)', commitCount() === afterEdit && ghLog().length === beforeGh, { beforeCount, afterEdit, now: commitCount() });

  // Write-through, direct.
  const devRole = s1.roles.list(ws1).find((x) => x.id === 'development');
  s1.roles.upsert({ ...devRole, workspaceId: ws1, models: { model: 'third-model', escalate: [], economyModel: null } });
  await sleep(3000);
  const last = git(remoteDir, 'log', '-1', '--format=%an%x1f%s', 'main').trim().split('\x1f');
  check('your edit is a commit on main within 3 s', git(remoteDir, 'show', 'main:factory/roles/development.md').includes('third-model') && last[1].startsWith('chore: '), last);
  check('the commit is authored by you', last[0] === s1.identity.localPerson().displayName, last);

  // Write-through, as a pull request.
  scratchEdit({ 'brain.yaml': (t) => t.replace('humanEdits: direct', 'humanEdits: pr') });
  await s1.brain.sync(ws1, 'person');
  const ghBefore = ghLog().length;
  s1.roles.upsert({ ...s1.roles.list(ws1).find((x) => x.id === 'development'), workspaceId: ws1, models: { model: 'fourth-model', escalate: [], economyModel: null } });
  await sleep(3000);
  const prLine = ghLog().slice(ghBefore).find((l) => l.argv[0] === 'pr' && l.argv[1] === 'create');
  check('with humanEdits: pr your edit opens a PR from tandemise/edit/', prLine?.argv[prLine.argv.indexOf('--head') + 1]?.startsWith('tandemise/edit/'), prLine?.argv);
  check('and main is unchanged', !git(remoteDir, 'show', 'main:factory/roles/development.md').includes('fourth-model'));
  scratchEdit({ 'brain.yaml': (t) => t.replace('humanEdits: pr', 'humanEdits: direct') });
  await s1.brain.sync(ws1, 'person');

  // Workflow precedence.
  const wf = (name) => `name: ${name}\ndescription: One step.\nsteps:\n  - key: build\n    role: development\n    objective: Build it.\n    outputs: [ChangeSet]\n    gate: artifact.ChangeSet.exists\n`;
  mkdirSync(join(H1.repoDir, '.tandemise', 'workflows'), { recursive: true });
  writeFileSync(join(H1.repoDir, '.tandemise', 'workflows', 'build-feature.yaml'), wf('From the code repo'));
  scratchEdit({ 'factory/workflows/build-feature.yaml': wf('From the brain') });
  await s1.brain.sync(ws1, 'person');
  const { FileWorkflowSource } = await import('../apps/daemon/dist/workflow-source.js');
  const listed = await app.listProjectWorkflows({ workflows: new FileWorkflowSource(quiet), brain: s1.brain }, ws1, [H1.repoDir]);
  const bf = listed.workflows.find((w) => w.id === 'build-feature');
  check('a brain workflow wins over the code repo', bf?.origin === 'brain' && bf.definition?.name === 'From the brain', bf);
  check('the code repo copy is listed as shadowed', listed.shadowed.some((w) => w.id === 'build-feature' && w.origin === 'repository'));
  const viaService = await s1.workflows.list(ws1);
  check('the workflow service lists the brain one', viaService.find((w) => w.id === 'build-feature')?.name === 'From the brain', viaService.map((w) => [w.id, w.name]));

  // Vendored skills close P15 Ruling 14.
  const skillText = '---\nname: tdd\ndescription: Test first.\n---\n\nWrite the failing test first.\n';
  const skillHashV = D.hashSkillFiles([{ path: 'SKILL.md', bytes: Buffer.from(skillText) }]);
  scratchEdit({
    [`skills/tdd/${skillHashV.slice(0, 12)}/SKILL.md`]: skillText,
    'factory/skills.lock': `skills:\n  - hash: ${skillHashV}\n    name: tdd\n    source:\n      kind: git\n      subpath: tdd\n      url: https://github.com/garipass/skills\n    version: 1\nversion: 1\n`,
    'factory/roles/review.md': (t) => { const read = app.readRole('roles/review.md', t); return app.renderRole({ ...read.role, skills: [{ name: 'tdd', version: 1, hash: skillHashV }] }); },
  });
  const ws4 = (await s2.workspaces.create(H2.caller, { name: 'Third', repositoryPath: H2.repoDir })).workspace.id;
  const pv = await s2.brain.link(H2.caller, ws4, { mode: 'adopt', remote: 'github.com/garipass/brain' });
  check('the adopt preview has no Needs import for a vendored skill', !pv.items.some((i) => i.needsImport !== null), pv.items.filter((i) => i.needsImport !== null).map((i) => i.id));
  await s2.brain.applyAdopt(H2.caller, ws4, { hash: pv.hash, choices: {} });
  check('the skill is in the store after adopt', (await s2.skills.content(skillHashV)) !== null);
  check('the reviewer pins it', (s2.roles.list(ws4).find((x) => x.id === 'review')?.skills ?? []).some((p) => p.name === 'tdd'));
  await s1.brain.sync(ws1, 'person');
  check('home 1 fills its store from the brain on sync', (await s1.skills.content(skillHashV)) !== null);

  // A conflict on a rules file becomes a PR.
  const link1 = r1(app.WORKSPACE_BRAIN_REPOSITORY).get(ws1);
  await H1.brainRepo.commit(link1.clonePath, [{ path: 'memory/rules/project.md', mode: 'write', content: '# Mine\n' }], 'chore: rules here', null);
  scratchEdit({ 'memory/rules/project.md': '# Theirs\n' });
  const ghC = ghLog().length;
  const conflicted = await s1.brain.sync(ws1, 'person');
  const cpr = ghLog().slice(ghC).find((l) => l.argv[0] === 'pr' && l.argv[1] === 'create');
  check('a conflicting change opens a PR from tandemise/local/', cpr?.argv[cpr.argv.indexOf('--head') + 1]?.startsWith('tandemise/local/'), cpr?.argv);
  check('the sync error says what conflicts', r1(app.WORKSPACE_BRAIN_REPOSITORY).get(ws1).lastSyncError?.startsWith('Your change to memory/rules/project.md conflicts'), r1(app.WORKSPACE_BRAIN_REPOSITORY).get(ws1).lastSyncError);
  check('the cache follows origin/main', git(remoteDir, 'rev-parse', 'main').trim() === conflicted.lastPulledSha, conflicted);
  await s2.brain.sync(ws2, 'person');
}

// ------------------------------------------------------------------ ledger
const ledgerFiles = (dir) => {
  const out = {};
  const walk = (rel) => {
    const abs = join(dir, rel);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs, { withFileTypes: true })) {
      const p = rel === '' ? name.name : `${rel}/${name.name}`;
      if (name.isDirectory()) walk(p); else out[p] = readFileSync(join(dir, p));
    }
  };
  walk('memory/ledger');
  return out;
};
const missionFor = (h, title, extra = {}) => {
  const id = shared.ids.mission();
  h.r(app.MISSION_REPOSITORY).create({ id, workspaceId: h.ws, repositoryId: null, title, goal: 'g', constraints: [], successCriteria: [], ...extra });
  return id;
};

if (H1 !== null && (wants('ledger') || wants('loading') || wants('tools') || wants('signals') || wants('promotion') || wants('intake'))) {
  section('ledger: append, batch, history, Remember this');
  const { services: s1, caller: c1, ws: ws1 } = H1;
  const { services: s2, caller: c2, ws: ws2 } = H2;
  const clone1 = H1.r(app.WORKSPACE_BRAIN_REPOSITORY).get(ws1).clonePath;
  // A recorder on the port: no ledger path may ever be a write or a delete.
  const badWrites = [];
  for (const h of [H1, H2]) {
    const original = h.brainRepo.commit.bind(h.brainRepo);
    if (!h.brainRepo.__recorded) {
      h.brainRepo.commit = async (clone, files, ...rest) => {
        for (const f of files) if (f.path.startsWith('memory/ledger/') && f.mode !== 'append') badWrites.push(f.path);
        return original(clone, files, ...rest);
      };
      h.brainRepo.__recorded = true;
    }
  }
  await s1.brain.sync(ws1, 'person');
  const r1 = await s1.brain.remember(c1, ws1, { text: 'Run npm run ci before opening a PR.', scope: { role: 'development' } });
  check('remember answers in words', r1.message === 'Saved. Agents on Developer will see it from the next run.', r1.message);
  await s1.brain.flush(ws1);
  const before = ledgerFiles(clone1);
  const r2 = await s1.brain.remember(c1, ws1, { text: 'Prefer small pull requests.' });
  await s1.brain.vote(c1, r1.entry.id, { vote: 'helpful' });
  const cand = await s1.brain.append(ws1, [{ op: 'add', entry: { kind: 'lesson', text: 'Maybe cache the build.', scope: {}, source: { signal: 'agent', mission: 'M' }, state: 'candidate' } }], { actor: 'agent' });
  await s1.brain.accept(c1, cand[0].id);
  const cand2 = await s1.brain.append(ws1, [{ op: 'add', entry: { kind: 'lesson', text: 'Skip the tests on Fridays.', scope: {}, source: { signal: 'agent', mission: 'M' }, state: 'candidate' } }], { actor: 'agent' });
  await s1.brain.reject(c1, cand2[0].id);
  await s1.brain.retire(c1, r2.entry.id, { reason: 'We changed our mind.' });
  const done = missionFor(H1, 'Ship onboarding', { status: 'COMPLETE' });
  H1.r(app.MISSION_REPOSITORY).update(done, { status: 'COMPLETE' });
  await s1.brain.missionEnded(done);
  await s1.brain.flush(ws1);
  const after = ledgerFiles(clone1);
  const prefixes = Object.entries(before).every(([p, bytes]) => after[p] !== undefined && after[p].subarray(0, bytes.length).equals(bytes));
  check('every ledger file is a byte prefix of its next version', prefixes && Object.keys(before).length > 0, Object.keys(before));
  check('no ledger path was ever written or deleted', badWrites.length === 0, badWrites);
  const listed = s1.brain.entries(ws1, {});
  check('remembered lessons are listed, active', listed.some((e) => e.id === r1.entry.id && e.state === 'active' && e.sourceLabel === 'you' && e.scopeLabel === 'Developer'), listed.map((e) => [e.text, e.state, e.sourceLabel, e.scopeLabel]));
  check('a person vote counts three', listed.find((e) => e.id === r1.entry.id)?.net === 3);
  check('accept and reject are recorded', listed.find((e) => e.id === cand[0].id)?.state === 'accepted' && listed.find((e) => e.id === cand2[0].id)?.state === 'rejected', [cand.length, cand2.length, listed.find((e) => e.id === cand[0]?.id)?.state, listed.find((e) => e.id === cand2[0]?.id)?.state]);
  check('a retired lesson is history, not listed', !listed.some((e) => e.id === r2.entry.id));
  const withHistory = s1.brain.entries(ws1, { includeHistory: true });
  check('the retired lesson shows under history', withHistory.some((e) => e.id === r2.entry.id && e.retired !== null));
  const hist = withHistory.filter((e) => e.kind === 'history');
  check('a finished mission adds one history entry', hist.length === 1 && hist[0].text.startsWith('Ship onboarding — completed.'), hist.map((e) => e.text));
  check('history is not in the default list', !listed.some((e) => e.kind === 'history'));
  const trial = missionFor(H1, 'Trial run', { status: 'COMPLETE', evalTrialId: 'etr_x' });
  H1.r(app.MISSION_REPOSITORY).update(trial, { status: 'COMPLETE' });
  await s1.brain.missionEnded(trial);
  await s1.brain.flush(ws1);
  check('a trial mission adds nothing', s1.brain.entries(ws1, { includeHistory: true }).filter((e) => e.kind === 'history').length === 1);

  // Scrubbing.
  const secret = await s1.brain.remember(c1, ws1, { text: `Use token ghp_${'x'.repeat(36)} for the API.` });
  await s1.brain.flush(ws1);
  check('a token is saved as [redacted secret]', secret.entry.text.includes('[redacted secret]') && !secret.entry.text.includes('ghp_'), secret.entry.text);
  check('the remote never sees ghp_x', !git(remoteDir, 'log', '-p', '--all').includes('ghp_x'));
  let pathRefused = null;
  try { await s1.brain.remember(c1, ws1, { text: 'see /etc/hosts' }); } catch (e) { pathRefused = e.message; }
  check('a machine path is refused with the sentence', pathRefused === "A lesson can't name a path on your machine. Name the file inside its repository instead.", pathRefused);

  // Two writers converge.
  await s2.brain.sync(ws2, 'person');
  const mine = [];
  for (const [s, c, w, tag] of [[s1, c1, ws1, 'A'], [s2, c2, ws2, 'B']]) {
    for (let i = 0; i < 3; i++) mine.push({ s, w, e: (await s.brain.remember(c, w, { text: `Writer ${tag} lesson ${i}.` })).entry });
  }
  await s1.brain.sync(ws1, 'person');
  await s2.brain.sync(ws2, 'person');
  await s1.brain.sync(ws1, 'person');
  const bLesson = mine.find((m) => m.e.text === 'Writer B lesson 0.').e.id;
  const aLesson = mine.find((m) => m.e.text === 'Writer A lesson 0.').e.id;
  await s1.brain.vote(c1, bLesson, { vote: 'helpful' });
  await s2.brain.vote(c2, aLesson, { vote: 'harmful' });
  const both = await Promise.all([s1.brain.sync(ws1, 'person'), s2.brain.sync(ws2, 'person')]);
  await s1.brain.sync(ws1, 'person');
  await s2.brain.sync(ws2, 'person');
  const v1 = s1.brain.view(ws1);
  const v2 = s2.brain.view(ws2);
  check('both clones end on the same head', v1.lastPulledSha === v2.lastPulledSha && v1.lastPulledSha !== null, [v1.lastPulledSha, v2.lastPulledSha]);
  const m1 = await s1.brain.memoryAt(ws1, v1.lastPulledSha);
  const m2 = await s2.brain.memoryAt(ws2, v2.lastPulledSha);
  check('both folds are equal', JSON.stringify(m1) === JSON.stringify(m2));
  check('no sync reported a conflict', both.every((v) => !v.problems.some((p) => p.includes('conflicts'))) && v1.problems.every((p) => !p.includes('conflicts')), both.map((v) => v.problems));
  check('votes from both writers counted', m1.entries.find((e) => e.id === bLesson)?.helpful === 3 && m1.entries.find((e) => e.id === aLesson)?.harmful === 3);

  // A protected default branch: lessons go to one standing PR.
  const wsP = (await s1.workspaces.create(c1, { name: 'Guarded', repositoryPath: H1.repoDir })).workspace.id;
  await s1.brain.link(c1, wsP, { mode: 'create', owner: 'garipass', name: 'guarded' });
  const guarded = join(FAKE.remotes, 'garipass', 'guarded.git');
  writeFileSync(join(guarded, 'hooks', 'pre-receive'), '#!/bin/sh\nwhile read old new ref; do if [ "$ref" = "refs/heads/main" ]; then echo "GH006: Protected branch update failed" >&2; exit 1; fi; done\nexit 0\n');
  chmodSync(join(guarded, 'hooks', 'pre-receive'), 0o755);
  const ghP = ghLog().length;
  await s1.brain.remember(c1, wsP, { text: 'Guarded lesson one.' });
  await s1.brain.flush(wsP);
  await s1.brain.remember(c1, wsP, { text: 'Guarded lesson two.' });
  await s1.brain.flush(wsP);
  const writer = s1.brain.view(wsP).writerId;
  const prs = ghLog().slice(ghP).filter((l) => l.argv[0] === 'pr' && l.argv[1] === 'create');
  check('a protected branch gets exactly one standing PR', prs.length === 1 && prs[0].argv[prs[0].argv.indexOf('--title') + 1] === `Lessons from ${writer}`, prs.map((p) => p.argv));
  check('the lessons are on tandemise/ledger/<writer>', git(guarded, 'log', '--format=%s', `tandemise/ledger/${writer}`).includes(`chore: lessons from ${writer}`));
  const pv = s1.brain.view(wsP);
  check('the Brain section says lessons go to a pull request', pv.status === 'protected' && pv.statusLine.startsWith('Your default branch is protected, so lessons go to a pull request: https://'), pv);
}

// ------------------------------------------------------------------ loading
const runTaskIn = async (h, { key = 'build', role = 'development', steps = [{ kind: 'complete', summary: 'done' }], title = 'Load the brain' } = {}) => {
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const now = () => shared.systemClock.now();
  const profileId = h.r(app.RUNTIME_PROFILE_REPOSITORY).create({
    id: shared.ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name: `fake-${Math.random().toString(16).slice(2, 8)}`, executablePath: null,
    args: [], settings: { script: { steps } }, capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
  }).id;
  const owner = h.services.team.me(h.caller).memberships.find((m) => m.workspaceId === h.ws).memberId;
  const agent = h.services.team.addMember(h.caller, h.ws, { kind: 'agent', name: `Agent ${profileId.slice(-4)}`, reportsTo: owner, roleIds: [role], runtimeProfileIds: [profileId] }).id;
  const mission = await h.services.missions.create(h.caller, { workspaceId: h.ws, goal: 'Prove the brain loads', title });
  const taskId = shared.ids.task();
  h.r(app.TASK_REPOSITORY).add({
    id: taskId, missionId: mission.id, key, title: key, objective: `Do ${key}`, roleId: role, dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: [],
    executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false },
    retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'fail' }, completionGate: null, status: 'READY', statusReason: null,
    attempts: 0, remediatesTaskId: null, repositoryId: null, executor: 'agent', waitPolicy: null, orderHint: 0, staffingOverride: { assignees: [agent] },
    createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
  });
  h.r(app.MISSION_REPOSITORY).update(mission.id, { status: 'EXECUTING' });
  const scheduler = h.r(app.SCHEDULER);
  for (let i = 0; i < 300; i++) {
    await scheduler.tick();
    const t = h.r(app.TASK_REPOSITORY).get(taskId);
    if (['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(t.status)) break;
    await sleep(40);
  }
  const task = h.r(app.TASK_REPOSITORY).get(taskId);
  const run = h.r(app.RUN_REPOSITORY).listByTask(taskId).at(-1);
  return { mission, task, run, prompt: h.prompts.find((p) => p.taskId === taskId)?.prompt ?? '' };
};

if (H1 !== null && (wants('loading') || wants('tools') || wants('signals') || wants('promotion') || wants('intake'))) {
  section('loading: rules and lessons in the prompt, runs.brain, one commit per attempt');
  const { services: s1, caller: c1, ws: ws1 } = H1;
  // Home 1's mission repo for a local target needs git in the Tandemise home.
  if (!existsSync(join(H1.paths.root, '.git'))) {
    execFileSync('git', ['init', '-q', '-b', 'main', H1.paths.root]);
    execFileSync('git', ['-C', H1.paths.root, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  }
  s1.workspaces.update(ws1, { knowledge: { productVision: null, architecturePrinciples: null, codingStandards: 'OLD-CODING-STANDARDS-FIELD', designSystem: null, glossary: null } });
  scratchEdit({ 'memory/rules/project.md': '# Project rules\n\nAlways run npm run ci.\n' });
  await s1.brain.sync(ws1, 'person');
  const lesson = await s1.brain.remember(c1, ws1, { text: 'DEV-LESSON: keep components small.', scope: { role: 'development' } });
  await s1.brain.sync(ws1, 'person');
  const view = s1.brain.view(ws1);
  const first = await runTaskIn(H1);
  check('the task ran', first.task.status === 'SUCCEEDED', [first.task.status, first.task.statusReason]);
  check('the prompt has the project rules', first.prompt.includes('Project rules') && first.prompt.includes('Always run npm run ci.'), first.prompt.slice(0, 400));
  check('the prompt has the role lesson', first.prompt.includes('DEV-LESSON: keep components small.'));
  check("the workspace's knowledge field is replaced by the rules", !first.prompt.includes('OLD-CODING-STANDARDS-FIELD'));
  check('runs.brain records the sha the run read', first.run?.brain?.sha === view.lastPulledSha, [first.run?.brain, view.lastPulledSha]);
  check('runs.brain lists the rules file', JSON.stringify(first.run?.brain?.rules) === JSON.stringify(['memory/rules/project.md']), first.run?.brain?.rules);
  check('runs.brain lists the lesson it loaded', first.run?.brain?.loaded.some((l) => l.id === lesson.entry.id));

  // One commit per attempt: a retry in the same round reuses the sha, a new round gets the new one.
  const supply = H1.r(app.BRAIN_CONTEXT_SUPPLY);
  const t = H1.r(app.TASK_REPOSITORY).get(first.task.id);
  const mission = H1.r(app.MISSION_REPOSITORY).get(first.mission.id);
  const role = s1.roles.list(ws1).find((r) => r.id === 'development');
  const repos = H1.r(app.REPO_REPOSITORY).listByWorkspace(ws1);
  scratchEdit({ 'memory/rules/project.md': '# Project rules\n\nAlways run npm run ci.\n\nNEW-RULE-AFTER-RUN.\n' });
  await s1.brain.sync(ws1, 'person');
  const retry = await supply.forAttempt({ task: t, mission, role, repositories: repos, round: t.round ?? 1, previousRuns: [first.run], trial: null });
  check('a retry in the same round reads the same commit', retry?.record.sha === first.run.brain.sha && !retry.request.rules.some((r) => r.text.includes('NEW-RULE-AFTER-RUN')), retry?.record.sha);
  const next = await supply.forAttempt({ task: { ...t, round: 2 }, mission, role, repositories: repos, round: 2, previousRuns: [first.run], trial: null });
  check('a new round reads the new commit', next?.record.sha === s1.brain.view(ws1).lastPulledSha && next.request.rules.some((r) => r.text.includes('NEW-RULE-AFTER-RUN')), next?.record.sha);

  // Under budget pressure the lessons go before the rules.
  const { createContextCompiler } = await import('@tandemise/context');
  const compiler = createContextCompiler();
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `w:${i}`, text: `Lesson ${i}: ${'z'.repeat(180)}`, net: 0 }));
  const baseReq = {
    role, workspaceName: 'Garipass', knowledge: { productVision: null, architecturePrinciples: null, codingStandards: null, designSystem: null, glossary: null },
    mission, task: t, dependencyArtifacts: [], decisions: [], evidence: [], grants: [], outputContract: { artifacts: [], workingDirectory: '/w', completionGate: null, notes: [] },
  };
  const tight = compiler.compile({ ...baseReq, maxChars: 6000, brain: { sha: 'abc', rules: [{ path: 'memory/rules/project.md', text: 'Always run npm run ci.' }], lessons: many, index: [] } });
  check('under pressure the lessons are summarized or dropped', tight.truncated.some((x) => x.section === 'Lessons from earlier work'), tight.truncated);
  check('and the rules stay', tight.prompt.includes('Project rules') && tight.prompt.includes('Always run npm run ci.'));
  check('with no brain the prompt is byte-identical', compiler.compile(baseReq).prompt === compiler.compile({ ...baseReq, brain: undefined }).prompt);

  // Trials read their frozen knowledge, or only a candidate's rules.
  const trialOff = await supply.forAttempt({ task: t, mission, role, repositories: repos, round: 1, previousRuns: [], trial: { role, knowledge: baseReq.knowledge, decisions: [], answers: [] } });
  check('a trial without brain rules gets no brain', trialOff === undefined);
  const trialOn = await supply.forAttempt({ task: t, mission, role, repositories: repos, round: 1, previousRuns: [], trial: { role, knowledge: baseReq.knowledge, decisions: [], answers: [], brainRules: [{ path: 'memory/rules/project.md', text: 'CANDIDATE RULE' }] } });
  check('a trial with brain rules gets rules only', trialOn?.request.rules[0]?.text === 'CANDIDATE RULE' && trialOn.request.lessons.length === 0 && trialOn.request.index.length === 0, trialOn?.request);
}

// ------------------------------------------------------------------ end
rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
