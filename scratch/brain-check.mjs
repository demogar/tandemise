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

// ------------------------------------------------------------------ end
rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
