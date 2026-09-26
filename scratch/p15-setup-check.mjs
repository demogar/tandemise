/**
 * P15: the project's setup as files, and gates that can pass.
 *
 * Proves, against the built packages and a real SQLite database:
 *
 *   - every gate fact has a scope, and each step fact is really measured by
 *     `GateService.factsFor` (mission and project facts are not, and their own
 *     services measure them); `security.required_checks` and `checks.<name>`
 *     are gone, `git.clean` is measured on a real git worktree;
 *   - one validator (`lintGate`) refuses unknown facts, mission-wide facts and
 *     gates that never check their own output, with the person-readable words,
 *     in workflow files, planner plans and materialize; presets pass it;
 *   - the planner prompt and docs/WORKFLOWS.md are generated from the vocabulary;
 *   - export is byte-stable (twice, same bytes and hash), has no secrets, ids,
 *     paths or timestamps, and makes the files committable;
 *   - import previews Add/Change/Remove/Same, applies atomically, refuses a
 *     folder that changed since the preview, and imports routines off.
 *
 *   npm run build && node scratch/p15-setup-check.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
const section = (t) => console.log(`\n== ${t}`);

const D = await import('@tandemise/domain');
const app = await import('@tandemise/application');
const A = await import('@tandemise/artifacts');
const E = await import('@tandemise/evaluation');
const { newId, ids, systemClock } = await import('@tandemise/shared');
const { FileSetupFolder } = await import('../apps/daemon/dist/setup-folder.js');
const { FileWorkflowSource } = await import('../apps/daemon/dist/workflow-source.js');
const docTool = await import('../scripts/gate-facts-doc.mjs');
const YAML = await import('yaml');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };

// ------------------------------------------------------------------ vocabulary
section('the vocabulary: one scope per fact, nothing listed that is never measured');
{
  const vocab = D.GATE_FACT_VOCABULARY;
  check('evaluation re-exports the same list', E.GATE_FACT_VOCABULARY === vocab);
  check('every fact has a scope of step, mission or workspace', vocab.every((f) => ['step', 'mission', 'workspace'].includes(f.scope)), vocab.filter((f) => !f.scope).map((f) => f.name));
  check('every fact says where it is measured', vocab.every((f) => typeof f.measuredIn === 'string' && f.measuredIn.length > 3));
  check('security.required_checks is gone (nothing could ever measure it)', !vocab.some((f) => f.name === 'security.required_checks'));
  check('checks.<name> is gone (a repository configures only five checks)', !vocab.some((f) => f.name === 'checks.<name>'));
  check('git.clean stays, scoped to a step with a worktree', vocab.find((f) => f.name === 'git.clean')?.requires === 'worktree');
  const mission = ['mission.stalled', 'run.silent_minutes', 'mission.agent_minutes', 'mission.tokens', 'mission.spend_usd', 'mission.limit_percent', 'mission.priority', 'ready.criteria', 'ready.open_questions', 'ready.proposed_pending'];
  const workspace = ['workspace.active_missions', 'workspace.max_active_missions', 'workspace.month_limit_percent'];
  check('mission facts are mission scope', mission.every((n) => D.factDefinition(n)?.scope === 'mission'), mission.map((n) => [n, D.factDefinition(n)?.scope]));
  check('project facts are workspace scope', workspace.every((n) => D.factDefinition(n)?.scope === 'workspace'));
  check('artifact.<Type> needs a real type', D.factDefinition('artifact.ChangeSet.exists') !== undefined && D.factDefinition('artifact.Changeset.exists') === undefined);
  check('approval.<kind> needs a real kind; release is approval.release_candidate', D.factDefinition('approval.choice') !== undefined && D.factDefinition('approval.release') === undefined && D.factDefinition('approval.release_candidate') !== undefined);
  check('the GateFactBuilder no longer offers withSecurityChecks', typeof new E.GateFactBuilder().withSecurityChecks !== 'function');
  check('ready_to_ship no longer reads security.required_checks', !E.QUALITY_GATES.ready_to_ship.expression.includes('security'));
}

// -------------------------------------------------------- engine harness (real DB)
const HOME = mkdtempSync(join(tmpdir(), 'tdm-p15-'));
async function engineHarness() {
  const { Container, compose } = await import('@tandemise/kernel');
  const { createLogger, createPaths } = await import('@tandemise/shared');
  const persistenceTokens = await import('@tandemise/persistence');
  const { policyModule } = await import('@tandemise/policy');
  const { contextModule } = await import('@tandemise/context');
  const { createEvaluationModule } = await import('@tandemise/evaluation');
  const { runtimesCoreModule } = await import('@tandemise/runtimes-core');
  const { genericRuntimeModule } = await import('@tandemise/runtime-generic');
  const { executionCoreModule, CLOCK: EXEC_CLOCK, LOGGER: EXEC_LOGGER, PATHS: EXEC_PATHS } = await import('@tandemise/execution-core');
  const { executionLocalModule } = await import('@tandemise/execution-local');
  const { integrationsCoreModule, CLOCK: INT_CLOCK, LOGGER: INT_LOGGER, COMMAND_EXECUTOR, BACKGROUND_PROCESS_LAUNCHER } = await import('@tandemise/integrations-core');
  const paths = createPaths(join(HOME, 'home'));
  mkdirSync(paths.root, { recursive: true });
  const log = createLogger({ level: 'error', base: { component: 'p15-check' } });
  const clock = systemClock;
  const container = new Container();
  compose(
    container,
    persistenceTokens.persistenceModule({ path: paths.db, logger: log, clock }),
    A.createArtifactsModule({ paths }),
    policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
    executionCoreModule, executionLocalModule, integrationsCoreModule, app.createApplicationModule({ localPersonName: 'Demo' }),
  );
  container.bind(EXEC_CLOCK, () => clock, { source: 'check' });
  container.bind(EXEC_LOGGER, () => log, { source: 'check' });
  container.bind(EXEC_PATHS, () => paths, { source: 'check' });
  container.bind(INT_CLOCK, () => clock, { source: 'check' });
  container.bind(INT_LOGGER, () => log, { source: 'check' });
  container.bind(COMMAND_EXECUTOR, () => ({ run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }), { source: 'check' });
  container.bind(BACKGROUND_PROCESS_LAUNCHER, () => ({ launch: async () => { throw new Error('unused'); } }), { source: 'check' });
  const isToken = (v) => typeof v === 'object' && v !== null && typeof v.description === 'string';
  for (const name of Object.keys(app)) {
    const appToken = app[name]; const provider = persistenceTokens[name];
    if (!isToken(appToken) || !isToken(provider)) continue;
    if (!container.has(provider) || container.has(appToken)) continue;
    container.bind(appToken, (r) => r.resolve(provider), { source: `alias:${name}` });
  }
  container.bind(app.ARTIFACT_STORE, (r) => r.resolve(A.ARTIFACT_STORE), { source: 'alias' });
  container.bind(app.ARTIFACT_TEMPLATES, () => ({ render: A.renderArtifactTemplate }), { source: 'check' });
  container.bind(app.ARTIFACT_PARSER, () => ({ parse: A.parseArtifact }), { source: 'check' });
  container.bind(app.ARTIFACT_MEASURE, () => ({ measure: A.measureArtifact, deriveHandoff: A.deriveHandoff, splitAppendix: A.splitAppendix }), { source: 'check' });
  container.bind(app.EVENT_BUS, () => ({ publish: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.PROJECTION_BUS, () => ({ invalidate: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.SECRET_STORE, () => ({ backend: 'memory', store: async () => 'x', resolve: async () => undefined, remove: async () => {}, list: async () => [] }), { source: 'check' });
  container.bind(app.SETTINGS_STORE, () => app.createMemorySettingsStore(), { source: 'check' });
  container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home: HOME, schemaVersion: 1 }), { source: 'check' });
  container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });
  // The daemon's real disk adapters, as bootstrap binds them.
  container.rebind(app.WORKFLOW_SOURCE, () => new FileWorkflowSource(quiet), { source: 'check' });
  container.rebind(app.SETUP_FOLDER, () => new FileSetupFolder(quiet), { source: 'check' });
  const services = app.createServices(container);
  const r = (t) => container.resolve(t);
  const repo = {
    workspaces: r(app.WORKSPACE_REPOSITORY), repos: r(app.REPO_REPOSITORY), missions: r(app.MISSION_REPOSITORY),
    tasks: r(app.TASK_REPOSITORY), artifacts: r(app.ARTIFACT_REPOSITORY), evaluations: r(app.EVALUATION_REPOSITORY),
    approvals: r(app.APPROVAL_REPOSITORY), criteria: r(app.MISSION_CRITERIA_REPOSITORY), routines: r(app.ROUTINE_REPOSITORY),
  };
  return { container, services, repo, clock };
}

const h = await engineHarness();
const caller = { personId: h.services.identity.localPerson().id };

/** A git repository with one commit. */
function gitRepo(name, files = {}) {
  const dir = join(HOME, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'check@example.com');
  git(dir, 'config', 'user.name', 'Check');
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const GOOD_WORKFLOW = `name: P15 build
description: One step that builds.
steps:
  - key: build
    role: development
    objective: Build it.
    outputs: [ChangeSet]
    gate: artifact.ChangeSet.exists && checks.tests != FAIL
`;

// --------------------------------------------------------- step facts measured
section('every step fact is measured by GateService.factsFor; no mission or project fact is');
const project = gitRepo('audit');
const wsAudit = (await h.services.workspaces.create(caller, { name: 'Audit', repositoryPath: project })).workspace.id;
const now = () => new Date().toISOString();
const missionId = ids.mission();
h.repo.missions.create({
  id: missionId, workspaceId: wsAudit, repositoryId: h.repo.repos.listByWorkspace(wsAudit)[0].id, title: 'Audit', goal: 'measure everything',
  constraints: [], successCriteria: [], autonomy: 'balanced', baseBranch: 'main',
});
const mkTask = (key, extra = {}) => ({
  id: ids.task(), missionId, key, title: key, objective: key, roleId: 'development',
  dependsOn: [], requiredCapabilities: ['filesystem.write'], inputArtifacts: [], expectedOutputs: ['ChangeSet'],
  executionPolicy: { isolation: 'worktree', maxWallTimeMs: 600000, capabilities: ['shell.exec'] },
  approvalPolicy: { beforeStart: false, onCompletion: false },
  retryPolicy: { maxAttempts: 3, backoffMs: 0, onExhausted: 'block' },
  completionGate: 'artifact.ChangeSet.exists', status: 'RUNNING', statusReason: null, attempts: 1,
  remediatesTaskId: null, orderHint: 0, createdAt: now(), updatedAt: now(), startedAt: now(), finishedAt: null, repositoryId: null,
  ...extra,
});
const [auditTask] = h.repo.tasks.replaceAll(missionId, [mkTask('implement')]);
{
  for (const name of ['checks.install', 'checks.typecheck', 'checks.lint', 'checks.tests', 'checks.build', 'git.clean']) {
    h.repo.evaluations.recordCheck({
      id: newId('chk'), missionId, taskId: auditTask.id, runId: null, name, outcome: 'PASS', detail: name, command: 'x',
      exitCode: 0, durationMs: 1, outputRef: null, createdAt: now(),
    });
  }
  h.repo.artifacts.create({
    id: ids.artifact(), workspaceId: wsAudit, missionId, taskId: auditTask.id, createdByRunId: null,
    type: 'ChangeSet', title: 'the work', contentRef: 'artifacts/cs.md', mediaType: 'text/markdown',
    sha256: 'c'.repeat(64), byteSize: 64, schemaVersion: 1, sourceRefs: [], supersedes: null, summary: 'the work', createdAt: now(),
  });
  h.repo.criteria.addUserCriteria(missionId, ['It works']);
  const evaluation = (role, extra) => h.repo.evaluations.createEvaluation({
    id: newId('evl'), missionId, taskId: auditTask.id, runId: null, evaluatorRoleId: role, verdict: 'pass', summary: 's',
    findings: [], criteriaCoverage: [], createdAt: now(), ...extra,
  });
  evaluation('review', {});
  evaluation('qa', { criteriaCoverage: [{ criterion: 'U1', outcome: 'PASS', evidence: 'seen' }] });
  for (const kind of ['plan', 'release', 'choice']) {
    h.repo.approvals.create({
      id: ids.approval(), workspaceId: wsAudit, missionId, taskId: null, runId: null, kind, status: 'APPROVED', risk: 'read',
      title: kind, rationale: 'r', effect: 'e', evidence: [], options: [{ id: 'approve', label: 'Approve' }], recommendedOptionId: 'approve',
      selectedOptionId: 'approve', decidedBy: null, decisionNote: null, createdAt: now(), decidedAt: now(), expiresAt: null,
      addressees: [], escalationLevel: 0, escalateAt: null, recordedBy: 'system',
    });
  }
  const gates = h.container.resolve(app.GATE_SERVICE);
  const facts = gates.factsFor(h.repo.tasks.get(auditTask.id), { filesChanged: 3 });
  const concrete = (name) => name.replace('artifact.<Type>.', 'artifact.ChangeSet.').replace('approval.<kind>', 'approval.choice');
  const missing = [];
  for (const fact of D.stepFacts()) {
    // review.independent needs two real runs on a step with independentOf: P12's
    // p12-models-check (M4) measures it through a real daemon.
    if (fact.name === 'review.independent') continue;
    if (facts[concrete(fact.name)] === undefined) missing.push(fact.name);
  }
  check('each step fact has a value in factsFor', missing.length === 0, { missing, have: Object.keys(facts) });
  const leaked = D.GATE_FACT_VOCABULARY.filter((f) => f.scope !== 'step' && facts[f.name] !== undefined).map((f) => f.name);
  check('no mission or project fact is in factsFor (so a step gate could never read one)', leaked.length === 0, leaked);
  check('git.clean is read from the newest check row like any check', facts['git.clean'] === 'PASS', facts['git.clean']);

  const limitFacts = h.container.resolve(app.LIMIT_SERVICE).facts(missionId);
  check('the limit service measures mission.agent_minutes', limitFacts['mission.agent_minutes'] !== undefined, limitFacts);
  const livenessFacts = h.container.resolve(app.LIVENESS_SERVICE).facts(missionId);
  check('the liveness service measures mission.stalled', livenessFacts['mission.stalled'] !== undefined, livenessFacts);
  check('the readiness facts come from the readiness rule', D.readinessFacts({ criteria: 1, openQuestions: 0, proposedPending: 0 })['ready.criteria'] === 1);
}

// ----------------------------------------------------------------- git.clean
section('git.clean: measured by CheckService in a real worktree, FAIL lists the files');
{
  const wt = join(HOME, 'audit-wt');
  git(project, 'worktree', 'add', '-q', '-b', 'tandemise/wt', wt);
  const exec = async ({ command, args = [], cwd }) => {
    const res = spawnSync(command, args, { cwd: cwd ?? wt, encoding: 'utf8' });
    return { exitCode: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '', durationMs: 1, timedOut: false };
  };
  const recorder = { record() {}, invalidate() {}, note() {} };
  const checks = new app.CheckService(h.repo.evaluations, recorder, systemClock);
  const task = { ...h.repo.tasks.get(auditTask.id), completionGate: 'artifact.ChangeSet.exists && git.clean' };
  const repository = h.repo.repos.listByWorkspace(wsAudit)[0];
  const request = (kind) => ({ task, repository, target: { kind, workingDirectory: wt, exec }, runId: null, scope: {}, signal: new AbortController().signal });
  const clean = await checks.run(request('worktree'));
  check('a clean worktree measures PASS', clean.length === 1 && clean[0].name === 'git.clean' && clean[0].outcome === 'PASS', clean);
  writeFileSync(join(wt, 'left-behind.txt'), 'oops');
  const dirty = await checks.run(request('worktree'));
  check('an uncommitted file measures FAIL', dirty[0]?.outcome === 'FAIL', dirty);
  check('and the detail names it', dirty[0]?.detail.includes('left-behind.txt') && dirty[0]?.detail.startsWith('1 path is not committed'), dirty[0]?.detail);
  const gates = h.container.resolve(app.GATE_SERVICE);
  check('the gate now reads the newest measurement (FAIL)', gates.factsFor(task)['git.clean'] === 'FAIL');
  check('and a gate reading it fails with the reason', gates.evaluate(task)?.passed === false);
  const inPlace = await checks.run(request('local'));
  check('a step working in place reads SKIP, which never passes', inPlace[0]?.outcome === 'SKIP' && inPlace[0]?.detail.includes('own worktree'), inPlace);
  const noGate = await checks.run({ ...request('worktree'), task: { ...task, completionGate: 'artifact.ChangeSet.exists' } });
  check('a gate that does not read it measures nothing', noGate.length === 0);
}

// ------------------------------------------------------------------- the lint
section('lintGate: every rule, in the words the person reads');
{
  const lint = (gate, subject = {}) => D.lintGate(gate, { stepKey: 'release', outputs: [], independentOf: false, ...subject });
  const one = (gate, subject) => lint(gate, subject).map((p) => p.message);
  check('a valid step gate has no problems', lint('artifact.ReleaseCandidate.exists && qa.criteria_unverified == 0', { outputs: ['ReleaseCandidate'] }).length === 0);
  check('(c) mission scope, exact words',
    one('mission.stalled == 0').includes("The gate on 'release' reads mission.stalled, which is only known for the whole mission, not inside a step."), one('mission.stalled == 0'));
  check('(c) project scope',
    one('workspace.month_limit_percent < 80').includes("The gate on 'release' reads workspace.month_limit_percent, which is only known for the whole project, not inside a step."));
  check('(b) unknown fact with a suggestion',
    one('checks.test != FAIL').includes("The gate on 'release' reads checks.test, which Tandemise never measures. Did you mean checks.tests?"), one('checks.test != FAIL'));
  check('(b) removed facts are unknown now', lint('security.required_checks == PASS')[0]?.code === 'unknown_fact' && lint('checks.a11y == PASS')[0]?.code === 'unknown_fact');
  check('(b) no suggestion for something far away', one('banana.split').every((m) => !m.includes('Did you mean')), one('banana.split'));
  const own = one('qa.criteria_unverified == 0', { outputs: ['ReleaseCandidate'] });
  check('(a) a gate that never checks its own output',
    own.includes("The gate on 'release' never checks that the step wrote its output: add artifact.ReleaseCandidate.exists, so a run that writes nothing cannot pass."), own);
  check('(a) several outputs are offered with "or"', one('checks.tests == PASS', { outputs: ['ChangeSet', 'Evidence'] }).some((m) => m.includes('artifact.ChangeSet.exists or artifact.Evidence.exists')));
  check('(a) reading another step\'s artifact is not enough', lint('artifact.QAReport.exists', { outputs: ['ReleaseCandidate'] }).some((p) => p.code === 'own_output'));
  check('review.independent needs independentOf', lint('review.independent')[0]?.message === "The gate on 'release' reads review.independent, which is only measured on a step with independentOf.");
  check('review.independent with independentOf is fine', lint('review.independent', { independentOf: true }).length === 0);
  check('git.clean on a step working in place', lint('git.clean', { isolation: 'none' })[0]?.message === "The gate on 'release' reads git.clean, which is only measured on a step that works in its own worktree.");
  check('git.clean in a worktree is fine', lint('git.clean', { isolation: 'worktree' }).length === 0);
  check('diff.files_changed needs a ChangeSet', lint('diff.files_changed < 20')[0]?.code === 'needs_changeset' && lint('artifact.ChangeSet.exists && diff.files_changed < 20', { outputs: ['ChangeSet'] }).length === 0);
  check('a gate that does not parse', lint('checks.tests ==')[0]?.code === 'syntax' && lint('checks.tests ==')[0]?.message.startsWith("The gate on 'release' cannot be read:"), lint('checks.tests =='));
}

section('the presets and the engine\'s own spliced tasks pass the validator');
{
  const bad = [];
  for (const preset of app.WORKFLOW_PRESETS) {
    for (const context of [{ hasTestCommand: true }, { hasTestCommand: false }]) {
      for (const problem of D.planGateProblems(preset.build(context).tasks)) bad.push(`${preset.id}: ${problem.message}`);
    }
  }
  check('every preset gate is valid', bad.length === 0, bad);
  // remediation.ts and branch-integration.ts splice a development task writing a
  // ChangeSet gated on artifact.ChangeSet.exists.
  check('the spliced fix / merge task gate is valid', D.lintGate('artifact.ChangeSet.exists', { stepKey: 'fix', outputs: ['ChangeSet'], independentOf: false, isolation: 'worktree' }).length === 0);
}

section('the planner prompt lists only step facts');
{
  const text = app.buildPlannerPrompt({
    mission: { title: 'x', goal: 'g', constraints: [], successCriteria: [], autonomy: 'balanced' },
    repository: null, roles: [], preset: app.findPreset('feature-delivery'), availableCapabilities: [], repositoryContext: null,
  });
  const listed = [...text.matchAll(/^ {3}- `([^`]+)` — /gm)].map((m) => m[1]);
  check('it lists the step facts from the vocabulary', listed.length >= 20 && listed.includes('checks.tests') && listed.includes('artifact.<Type>.exists'), listed);
  check('it lists no mission or project fact', listed.every((n) => D.GATE_FACT_VOCABULARY.find((f) => f.name === n)?.scope === 'step'), listed);
  check('it does not offer review.independent (a planner cannot set independentOf)', !listed.includes('review.independent'));
  check('it still tells the planner to gate on its own output', text.includes('must include `artifact.<Type>.exists` for an artifact in'));
}

section('docs/WORKFLOWS.md\'s facts table is generated from the vocabulary');
{
  const doc = readFileSync(docTool.DOC, 'utf8');
  const expected = docTool.withTable(doc, docTool.renderFactsTable(D.GATE_FACT_VOCABULARY));
  check('the table in the file equals the generated one', doc === expected, 'run: node scripts/gate-facts-doc.mjs --write');
  check('it has a Scope column and every fact', D.GATE_FACT_VOCABULARY.every((f) => doc.includes(`| \`${f.name}\` |`)) && doc.includes('| Fact | Type | Scope |'));
}

// -------------------------------------------------- where gates are written
section('workflow files, plans and materialize refuse the same gates');
{
  const dir = gitRepo('bad-workflows', {
    '.tandemise/workflows/stalled.yaml': `name: Stalled gate
steps:
  - key: release
    role: release
    objective: Ship it.
    outputs: [ReleaseCandidate]
    gate: artifact.ReleaseCandidate.exists && mission.stalled == 0
`,
    '.tandemise/workflows/no-output.yaml': `name: No output check
steps:
  - key: build
    role: development
    objective: Build it.
    outputs: [ChangeSet]
    gate: checks.typecheck != FAIL
`,
    '.tandemise/workflows/good.yaml': GOOD_WORKFLOW,
  });
  const loaded = await new FileWorkflowSource(quiet).list([dir]);
  const issues = (id) => loaded.find((w) => w.id === id)?.issues.map((i) => `${i.path}: ${i.message}`) ?? [];
  check('mission.stalled: listed with the reason',
    issues('stalled').includes("steps.0.gate: The gate on 'release' reads mission.stalled, which is only known for the whole mission, not inside a step."), issues('stalled'));
  check('missing output check: listed with the reason',
    issues('no-output').includes("steps.0.gate: The gate on 'build' never checks that the step wrote its output: add artifact.ChangeSet.exists, so a run that writes nothing cannot pass."), issues('no-output'));
  check('a broken file has no definition, so nothing plans from it', loaded.find((w) => w.id === 'stalled')?.definition === null);
  check('a good file loads', issues('good').length === 0 && loaded.find((w) => w.id === 'good')?.definition !== null && typeof loaded.find((w) => w.id === 'good')?.text === 'string');

  const wsBad = (await h.services.workspaces.create(caller, { name: 'Bad workflows', repositoryPath: dir })).workspace.id;
  const listed = await h.services.workflows.list(wsBad);
  check('the workflow list (New mission) carries the issue', listed.find((w) => w.id === 'stalled')?.issues[0]?.message.includes('mission.stalled'), listed.find((w) => w.id === 'stalled'));

  const inherit = D.compileWorkflow({ name: 'x', inputs: [], steps: [{ key: 'notes', role: 'release', objective: 'o', executor: 'agent', dependsOn: [], capabilities: [], outputs: [], inputs: [], gate: 'git.clean', approval: 'none' }] }, {}, { isolationForRole: () => 'none' });
  check('compile: git.clean on a step inheriting "none" from its role', !inherit.ok && inherit.error.some((i) => i.message.includes('own worktree')), inherit);

  const task = (gate, extra = {}) => ({
    key: 'release', title: 'Release', objective: 'o', roleId: 'release', dependsOn: [], requiredCapabilities: [], inputArtifacts: [],
    expectedOutputs: ['ReleaseCandidate'], executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
    approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'block' },
    completionGate: gate, ...extra,
  });
  const ctx = { knownRoleIds: new Set(['release']), satisfiableCapabilities: new Set() };
  const plan = D.validateMissionPlan({ summary: 's', tasks: [task('artifact.ReleaseCandidate.exists && run.silent_minutes < 5')] }, ctx);
  check('validateMissionPlan (planner output) refuses it', !plan.ok && plan.error.some((i) => i.message.includes('run.silent_minutes, which is only known for the whole mission')), plan);
  const syntaxOnly = D.validateMissionPlan({ summary: 's', tasks: [task('qa.criteria_unverified == 0')] }, { ...ctx, gates: 'syntax' });
  check('a running mission\'s graph is re-checked for syntax only', syntaxOnly.ok, syntaxOnly);
  let refused = null;
  try { app.materializePlan({ summary: 's', tasks: [task('qa.criteria_unverified == 0')] }, 'msn_x', systemClock); } catch (e) { refused = e; }
  check('materializePlan refuses it', refused?.code === 'VALIDATION' && refused.message.includes('never checks that the step wrote its output'), refused?.message);
}

// ------------------------------------------------------------------- export
section('export: byte-stable, no secrets, ids, paths or timestamps, committable');
const repoDir = gitRepo('setup', { '.tandemise/workflows/p15.yaml': GOOD_WORKFLOW });
// What a planning run before P15 left behind: git ignored all of .tandemise/.
writeFileSync(join(repoDir, '.tandemise', '.gitignore'), D.LEGACY_TANDEMISE_IGNORE_BODY);
writeFileSync(join(repoDir, '.git', 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n.tandemise/\n');
const second = gitRepo('second');
const ws = (await h.services.workspaces.create(caller, { name: 'Setup demo', repositoryPath: repoDir })).workspace.id;
await h.services.workspaces.addRepository(ws, { path: second });
const repoId = h.repo.repos.listByWorkspace(ws).find((r) => r.path === repoDir).id;
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
h.services.workspaces.update(ws, {
  maxActiveMissions: 2,
  monthlyLimits: [{ metric: 'usd', amount: 50, warnPercent: 80 }],
  defaultMissionLimits: [{ metric: 'agent_minutes', amount: 30, warnPercent: 75 }],
  knowledge: { codingStandards: `Small commits. Call the API with ${SECRET}.` },
});
const roleOf = (id) => h.services.roles.list(ws).find((r) => r.id === id);
const put = (id, patch) => {
  const { createdAt, updatedAt, builtIn, workspaceId, ...rest } = roleOf(id);
  return h.services.roles.upsert({ ...rest, workspaceId: ws, ...patch });
};
put('development', { models: { model: 'role-dev', escalate: ['strong-dev'], economyModel: 'eco-dev' } });
h.services.roles.upsert({
  workspaceId: ws, id: 'docs-writer', name: 'Docs writer', summary: 'Writes the docs.', instructions: 'Write plainly. Key: sk-ant-abcdefghijklmnop123',
  defaultCapabilities: ['repository.read', 'artifact.write'], producesArtifacts: ['DecisionRecord'], consumesArtifacts: [], defaultIsolation: 'none', outputContract: 'A short page.',
});
h.services.routines.create(caller, ws, {
  name: 'Weekly dependency bump', kind: 'mission', goal: 'Update dependencies ({date})', successCriteria: ['Every dependency is current'],
  priority: 'high', schedule: { type: 'weekly', day: 1, at: '09:00' },
});

const setupDir = join(repoDir, '.tandemise');
const readAll = () => {
  const out = {};
  const walk = (rel) => {
    for (const e of readdirSync(join(setupDir, rel), { withFileTypes: true })) {
      const p = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p); else out[p] = readFileSync(join(setupDir, p), 'utf8');
    }
  };
  walk('');
  return out;
};
const first = await h.services.setup.export(ws, repoId);
const bytes1 = readAll();
const again = await h.services.setup.export(ws, repoId);
const bytes2 = readAll();
{
  const paths = first.files.map((f) => f.path);
  check('the expected files', ['.tandemise/tandemise.yaml', '.tandemise/routines.yaml', '.tandemise/roles/development.md', '.tandemise/roles/docs-writer.md', '.tandemise/workflows/p15.yaml'].every((p) => paths.includes(p)), paths);
  check('every role of the project, built-ins included', D.BUILT_IN_ROLE_IDS.every((id) => paths.includes(`.tandemise/roles/${id}.md`)));
  check('the workflow already in this repository is kept, not rewritten', first.files.find((f) => f.path === '.tandemise/workflows/p15.yaml')?.status === 'kept' && bytes1['workflows/p15.yaml'] === GOOD_WORKFLOW);
  check('no skills.lock (P13 adds it)', !paths.some((p) => p.includes('skills')));
  check('twice: the same hash', first.hash === again.hash && /^[0-9a-f]{12}$/.test(first.hash), [first.hash, again.hash]);
  check('twice: the same bytes', JSON.stringify(bytes1) === JSON.stringify(bytes2));
  check('the hash is over the files on disk', app.setupHash(Object.entries(bytes1).filter(([p]) => p !== '.gitignore').map(([path, content]) => ({ path, content }))) === first.hash);
  const all = Object.entries(bytes1).filter(([p]) => p !== '.gitignore').map(([, c]) => c).join('\n');
  check('no absolute paths', !all.includes(HOME) && !all.includes('/Users/') && !all.includes('/tmp/'));
  check('no row ids', !/\b(wsp|rtn|msn|rpo|mbr|per)_[A-Za-z0-9]/.test(all), all.match(/\b(wsp|rtn|msn|rpo|mbr|per)_[A-Za-z0-9]+/)?.[0]);
  check('no timestamps', !/\d{4}-\d\d-\d\dT\d\d:\d\d/.test(all));
  check('no secret', !all.includes(SECRET) && !all.includes('sk-ant-abcdefghijklmnop123'));
  const main = YAML.parse(bytes1['tandemise.yaml']);
  check('tandemise.yaml: version, wip limit, limits, defaults', main.version === 1 && main.wipLimit === 2 && main.limits.monthly[0].amount === 50 && main.defaults.missionLimits[0].metric === 'agent_minutes', main);
  check('the secret became a declared placeholder', main.project.knowledge.codingStandards.includes('${SECRET_1}') && main.secrets.some((s) => s.file === 'tandemise.yaml' && s.name === 'SECRET_1') && main.secrets.some((s) => s.file === 'roles/docs-writer.md'), main.secrets);
  check('the export view lists the placeholders', first.secrets.length === 2, first.secrets);
  check('keys are sorted', Object.keys(main).join(',') === [...Object.keys(main)].sort().join(','), Object.keys(main));
  const dev = bytes1['roles/development.md'];
  check('roles/development.md: models in the front matter, instructions below', dev.startsWith('---\n') && /\nmodel: role-dev\n/.test(dev) && /\neconomyModel: eco-dev\n/.test(dev) && dev.includes('escalate:\n  - strong-dev'), dev.slice(0, 600));
  const routines = YAML.parse(bytes1['routines.yaml']).routines;
  check('routines.yaml: the routine, without enabled or history', routines.length === 1 && routines[0].name === 'Weekly dependency bump' && !('enabled' in routines[0]) && !('nextRunAt' in routines[0]), routines);
  const status = h.services.setup.status(ws);
  check('"Last exported <hash>" is remembered', status.lastExport?.hash === first.hash && status.lastExport?.repositoryName === 'setup', status);

  check('the old ignore file was repaired', bytes1['.gitignore'] === D.TANDEMISE_IGNORE_BODY);
  check('the old exclude line was repaired', readFileSync(join(repoDir, '.git/info/exclude'), 'utf8').split('\n').includes('.tandemise/out/') && !readFileSync(join(repoDir, '.git/info/exclude'), 'utf8').split('\n').includes('.tandemise/'));
  check('and the export said so', first.warnings.some((w) => w.includes('.git/info/exclude')), first.warnings);
  const ignored = spawnSync('git', ['check-ignore', '.tandemise/tandemise.yaml', '.tandemise/roles/development.md'], { cwd: repoDir });
  check('git no longer ignores the exported files', ignored.status === 1, ignored.stdout?.toString());
  check('git still ignores Tandemise\'s working files', spawnSync('git', ['check-ignore', '-q', '.tandemise/out/x/ChangeSet.md'], { cwd: repoDir }).status === 0);
  check('a second export has nothing left to repair', again.warnings.length === 0, again.warnings);

  // A rule of the person's own is reported, not changed.
  writeFileSync(join(second, '.gitignore'), '.tandemise\n');
  const repoSecond = h.repo.repos.listByWorkspace(ws).find((r) => r.path === second).id;
  const other = await h.services.setup.export(ws, repoSecond);
  check('a rule of their own is reported with how to fix it', other.warnings.some((w) => w.includes('.gitignore line 1') && w.includes('git add -f')), other.warnings);
  check('a workflow from another repository is copied byte for byte', readFileSync(join(second, '.tandemise/workflows/p15.yaml'), 'utf8') === GOOD_WORKFLOW && other.files.find((f) => f.path === '.tandemise/workflows/p15.yaml')?.status === 'written');
  check('the last export is now the second repository', h.services.setup.status(ws).lastExport?.repositoryName === 'second');
}

// ------------------------------------------------------------------- import
section('import: preview Add / Change / Remove / Same, one atomic Apply, routines arrive off');
{
  const preview = () => h.services.setup.preview(ws, repoDir);
  const p0 = await preview();
  check('an unchanged folder previews all Same', p0.counts.add === 0 && p0.counts.change === 0 && p0.counts.remove === 0 && p0.counts.same > 10, { counts: p0.counts, changed: p0.items.filter((i) => i.action !== 'same') });
  check('Same rows offer no choice', p0.items.every((i) => i.choice === null));

  const devPath = join(setupDir, 'roles/development.md');
  writeFileSync(devPath, readFileSync(devPath, 'utf8').replace('model: role-dev', 'model: strong-model'));
  const p1 = await preview();
  const changed = p1.items.filter((i) => i.action !== 'same');
  check('editing a role\'s model: exactly one Change', changed.length === 1 && changed[0].id === 'role:development' && changed[0].action === 'change', changed);
  check('its detail says what changes', changed[0]?.detail === 'model: role-dev → strong-model', changed[0]?.detail);
  check('Change defaults to take theirs', changed[0]?.choice === 'theirs');

  const routinesPath = join(setupDir, 'routines.yaml');
  const doc = YAML.parse(readFileSync(routinesPath, 'utf8'));
  doc.routines.push({ name: 'Nightly status report', kind: 'status_report', goal: '', successCriteria: [], priority: 'normal', limits: null, workflow: null, schedule: { type: 'daily', at: '18:00' } });
  writeFileSync(routinesPath, YAML.stringify(doc));
  unlinkSync(join(setupDir, 'roles/docs-writer.md'));
  const p2 = await preview();
  const byId = new Map(p2.items.map((i) => [i.id, i]));
  check('a new routine is an Add, taken by default', byId.get('routine:Nightly status report')?.action === 'add' && byId.get('routine:Nightly status report')?.choice === 'theirs', byId.get('routine:Nightly status report'));
  check('it says it arrives off', byId.get('routine:Nightly status report')?.notes.some((n) => n.startsWith('Arrives off')));
  check('a role missing from the files is a Remove that keeps yours by default', byId.get('role:docs-writer')?.action === 'remove' && byId.get('role:docs-writer')?.choice === 'mine');

  const missionsBefore = h.repo.missions.list({ workspaceId: ws }).length;
  let conflict = null;
  try {
    writeFileSync(join(setupDir, 'roles/qa.md'), readFileSync(join(setupDir, 'roles/qa.md'), 'utf8') + '\nOne more line.\n');
    await h.services.setup.apply(caller, ws, { path: repoDir, hash: p2.hash, choices: {} });
  } catch (e) { conflict = e; }
  check('files changed since the preview: refused with 409 words', conflict?.code === 'CONFLICT' && conflict.message === 'The files changed since the preview. Preview again.', conflict?.message);
  check('and nothing changed', roleOf('development').models?.model === 'role-dev');

  const p3 = await preview();
  const applied = await h.services.setup.apply(caller, ws, { path: repoDir, hash: p3.hash, choices: { 'role:qa': 'mine' } });
  check('applied: the model change and the routine; kept: the QA edit and the removal', applied.applied === 2 && applied.kept === 2, applied);
  check('the role has the new model', roleOf('development').models?.model === 'strong-model', roleOf('development').models);
  check('Remove kept yours: the docs writer is still there', roleOf('docs-writer') !== undefined);
  check('Keep mine kept yours: QA instructions unchanged', !roleOf('qa').instructions.includes('One more line.'));
  const imported = h.repo.routines.list(ws).find((r) => r.name === 'Nightly status report');
  check('the imported routine is off, not scheduled, with the note', imported?.enabled === false && imported?.nextRunAt === null && imported?.lastDetail === app.IMPORTED_ROUTINE_NOTE, imported);
  check('the note reads "Imported — review and turn on"', app.IMPORTED_ROUTINE_NOTE === 'Imported — review and turn on');
  check('nothing started: no mission was created', h.repo.missions.list({ workspaceId: ws }).length === missionsBefore);
  const view = h.services.routines.list(ws).find((v) => v.routine.name === 'Nightly status report');
  check('the routine list shows the note', view?.lastLabel === app.IMPORTED_ROUTINE_NOTE && view?.nextRunLabel === 'Paused', view);
  const on = h.services.routines.update(imported.id, { enabled: true });
  check('turning it on clears the note and schedules it', on.routine.enabled && on.lastLabel === null && on.routine.nextRunAt !== null, on);
  h.services.routines.update(imported.id, { enabled: false });

  const p4 = await preview();
  const left = p4.items.filter((i) => i.action !== 'same').map((i) => i.id).sort();
  check('previewing again: only what was kept still differs', JSON.stringify(left) === JSON.stringify(['role:docs-writer', 'role:qa']), left);

  // Taking a Remove deletes a role someone added.
  const p5 = await preview();
  await h.services.setup.apply(caller, ws, { path: repoDir, hash: p5.hash, choices: { 'role:docs-writer': 'theirs', 'role:qa': 'mine' } });
  check('Remove, taken: the added role is deleted', roleOf('docs-writer') === undefined);
}

section('import from another folder: workflows land in the project, a bad one cannot be taken, a failed apply changes nothing');
{
  const incoming = join(HOME, 'incoming');
  mkdirSync(join(incoming, '.tandemise', 'workflows'), { recursive: true });
  mkdirSync(join(incoming, '.tandemise', 'roles'), { recursive: true });
  const role = readFileSync(join(setupDir, 'roles/review.md'), 'utf8').replace(/\nname: [^\n]+\n/, '\nname: Strict reviewer\n');
  writeFileSync(join(incoming, '.tandemise/roles/review.md'), role);
  writeFileSync(join(incoming, '.tandemise/workflows/extra.yaml'), GOOD_WORKFLOW.replace('P15 build', 'Extra'));
  writeFileSync(join(incoming, '.tandemise/workflows/bad.yaml'), GOOD_WORKFLOW.replace('artifact.ChangeSet.exists && checks.tests != FAIL', 'checks.tests != FAIL && mission.stalled == 0'));
  writeFileSync(join(incoming, '.tandemise/routines.yaml'), YAML.stringify({ routines: [{ name: 'Imported weekly', kind: 'mission', goal: 'Tidy the backlog', successCriteria: ['The backlog is tidy'], priority: 'low', limits: null, workflow: null, schedule: { type: 'weekly', day: 5, at: '16:00' } }] }));
  writeFileSync(join(incoming, '.tandemise/skills.lock'), 'future\n');

  const p = await h.services.setup.preview(ws, join(incoming, '.tandemise'));
  const byId = new Map(p.items.map((i) => [i.id, i]));
  check('the .tandemise folder itself can be chosen', p.folder.endsWith('.tandemise'));
  check('a file this version does not read is listed as ignored', p.ignored.includes('skills.lock'), p.ignored);
  check('a new workflow is an Add', byId.get('workflow:extra.yaml')?.action === 'add');
  check('a workflow with a bad gate cannot be taken, and says why', byId.get('workflow:bad.yaml')?.choice === null && byId.get('workflow:bad.yaml')?.problem?.includes('mission.stalled, which is only known for the whole mission'), byId.get('workflow:bad.yaml'));
  check('the project\'s own workflow is a Remove kept by default', byId.get('workflow:p15.yaml')?.action === 'remove' && byId.get('workflow:p15.yaml')?.choice === 'mine');
  check('the missing routine is a Remove, the new one an Add', byId.get('routine:Weekly dependency bump')?.action === 'remove' && byId.get('routine:Imported weekly')?.action === 'add');
  let bad = null;
  try { await h.services.setup.apply(caller, ws, { path: incoming, hash: p.hash, choices: { 'workflow:bad.yaml': 'theirs' } }); } catch (e) { bad = e; }
  check('choosing theirs for it is refused', bad?.code === 'VALIDATION' && bad.message.startsWith('bad cannot be taken:'), bad?.message);

  // A routine the service refuses half-way through: every row rolls back, no file appears.
  const c = h.container;
  const failing = new app.SetupService({
    workspaces: h.services.workspaces, repositories: c.resolve(app.REPO_REPOSITORY), roles: h.services.roles,
    runtimeProfiles: c.resolve(app.RUNTIME_PROFILE_REPOSITORY), routines: c.resolve(app.ROUTINE_REPOSITORY),
    routineService: {
      create: () => { throw new Error('the disk is full'); },
      update: (...a) => h.services.routines.update(...a), remove: (...a) => h.services.routines.remove(...a), problemWith: (f) => h.services.routines.problemWith(f),
    },
    workflows: c.resolve(app.WORKFLOW_SOURCE), folder: c.resolve(app.SETUP_FOLDER), settings: c.resolve(app.SETTINGS_STORE),
    unitOfWork: c.resolve(app.UNIT_OF_WORK), recorder: c.resolve(app.EVENT_RECORDER), clock: systemClock, log: quiet,
  });
  let boom = null;
  try { await failing.apply(caller, ws, { path: incoming, hash: p.hash, choices: {} }); } catch (e) { boom = e; }
  check('the apply failed', boom?.message === 'the disk is full', boom?.message);
  check('the role change before it was rolled back', roleOf('review').name !== 'Strict reviewer', roleOf('review').name);
  const wfDir = join(repoDir, '.tandemise', 'workflows');
  check('no workflow file was written, and nothing staged is left', !existsSync(join(wfDir, 'extra.yaml')) && readdirSync(wfDir).every((f) => !f.includes('staged')), readdirSync(wfDir));

  const ok = await h.services.setup.apply(caller, ws, { path: incoming, hash: p.hash, choices: {} });
  check('the same apply, working: role, workflow, routine', ok.applied === 3 && roleOf('review').name === 'Strict reviewer', ok);
  check('the new workflow file is in the project\'s default repository', readFileSync(join(wfDir, 'extra.yaml'), 'utf8') === GOOD_WORKFLOW.replace('P15 build', 'Extra'));
  check('the kept workflow is still there', existsSync(join(wfDir, 'p15.yaml')));
  const weekly = h.repo.routines.list(ws).find((r) => r.name === 'Imported weekly');
  check('the imported mission routine is off with the note', weekly?.enabled === false && weekly?.lastDetail === app.IMPORTED_ROUTINE_NOTE);
  check('the removed routine was kept (Remove defaults to yours)', h.repo.routines.list(ws).some((r) => r.name === 'Weekly dependency bump'));
}

section('a folder without .tandemise, and a file that cannot be read');
{
  let none = null;
  try { await h.services.setup.preview(ws, join(HOME, 'audit')); } catch (e) { none = e; }
  check('no .tandemise folder: a plain reason', none?.code === 'VALIDATION' && none.message.includes('There is no .tandemise folder'), none?.message);
  const broken = join(HOME, 'broken', '.tandemise', 'roles');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, 'qa.md'), 'no front matter here');
  writeFileSync(join(HOME, 'broken', '.tandemise', 'tandemise.yaml'), 'version: 2\n');
  const p = await h.services.setup.preview(ws, join(HOME, 'broken'));
  const qa = p.items.find((i) => i.id === 'role:qa');
  check('an unreadable role file is a row with its reason and no choice', qa?.problem?.startsWith('A role file starts with front matter') && qa?.choice === null, qa);
  check('a newer setup version is refused on its rows', p.items.find((i) => i.kind === 'settings')?.problem?.includes('setup version 1'), p.items.find((i) => i.kind === 'settings'));
}

rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log('ALL P15 SETUP CHECKS PASSED');
process.exit(0);
