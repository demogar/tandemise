// P3b evals, task 1: ids, entities, migration 020 and repositories - the
// foundation the rest of P3b builds on. Migrating a version-019 database to
// 020; the new eval suite/case/run/trial repository; run scores, idempotent
// on run id and leaving eval trials out of "From your runs" by default; a
// hidden eval trial mission, excluded from every list but reachable by id;
// seeding a trial's Done-when ledger once; the content-addressed eval blob
// store; and eval spend split out of workspace usage.
// Task 4: trial missions - a pinned model beats economy mode; a trial runs its
// frozen role on the pinned model, blocks on a missing skill without a card,
// answers ask_human with "nobody", denies tool approvals, is left alone by
// recovery, and is hidden from every list, the Desk, the Inbox and the scheduler.
//
//   npm run build && node scratch/p3-evals-check.mjs
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 700)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const D = await import('@tandemise/domain');
const S = await import('@tandemise/shared');
const A = await import('@tandemise/artifacts');
const P = await import('@tandemise/persistence');

const now = () => new Date().toISOString();
const clock = S.systemClock;

// ---------------------------------------------------------------- fixtures
//
// These close over `ws`, `container` and `app`, which are assigned once the
// harness below has run; every fixture is only ever called after that.

let ws;
let container;
let app;
/** Set by `seedUsage`, read by the limits section's last check. */
let trialMissionId;

const draft = (title) => ({ workspaceId: ws.id, repositoryId: null, title, goal: title, successCriteria: [] });

function createMission(title) {
  return container.resolve(app.MISSION_REPOSITORY).create({ ...draft(title), id: S.ids.mission() });
}

/** A runs row created through RUN_REPOSITORY for a fixture task, optionally on an eval trial mission. */
function realRun(missionOverrides = {}) {
  const missions = container.resolve(app.MISSION_REPOSITORY);
  const tasks = container.resolve(app.TASK_REPOSITORY);
  const assignments = container.resolve(app.ASSIGNMENT_REPOSITORY);
  const runs = container.resolve(app.RUN_REPOSITORY);
  const mission = missions.create({ ...draft('Score fixture'), id: S.ids.mission(), ...missionOverrides });
  const task = tasks.add({
    id: S.ids.task(), missionId: mission.id, repositoryId: null, executor: 'agent', waitPolicy: null,
    key: 'design', title: 'Design', objective: 'Design the greeting.', roleId: 'design',
    dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: ['DesignBrief'],
    executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
    approvalPolicy: { beforeStart: false, onCompletion: false },
    retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'block' },
    completionGate: null, status: 'SUCCEEDED', statusReason: null, attempts: 1,
    remediatesTaskId: null, orderHint: 0, createdAt: now(), updatedAt: now(), startedAt: now(), finishedAt: now(),
  });
  const assignment = assignments.create({
    id: S.ids.workerAssignment(), workspaceId: ws.id, missionId: mission.id, taskId: task.id, roleId: 'design',
    runtimeProfileId: 'rt_fixture', executionTargetId: 'tgt_fixture', grants: [],
    budgets: { maxWallTimeMs: 60000, maxAttempts: 1 }, createdAt: now(),
  });
  return runs.create({
    id: S.ids.run(), missionId: mission.id, taskId: task.id, assignmentId: assignment.id, attempt: 1,
    status: 'SUCCEEDED', roleId: 'design', runtimeProfileId: 'rt_fixture', executionTargetId: 'tgt_fixture',
    externalSessionId: null, pid: null, exitCode: 0, errorCode: null, errorMessage: null, usage: null,
    startedAt: now(), finishedAt: now(), heartbeatAt: null,
  });
}

function fixtureScore(run, overrides = {}) {
  return {
    runId: run.id, taskId: run.taskId, missionId: run.missionId, workspaceId: ws.id, roleId: run.roleId,
    model: null, skills: [], attempt: run.attempt, round: 1, purpose: null,
    gatePassed: true, gateDetail: 'first', facts: {}, criteria: null, overBudget: 0,
    inputTokens: null, outputTokens: null, costUsd: null, wallTimeMs: null,
    evalTrial: false, scoredAt: now(),
    ...overrides,
  };
}

function fixtureCase(suiteId) {
  return {
    id: S.ids.evalCase(),
    suiteId,
    name: 'Greeting step',
    snapshot: {
      repositoryId: 'repo_fixture',
      baseSha: 'deadbeef',
      inputs: [{ type: 'ProductSpec', sha256: '0'.repeat(64), mediaType: 'text/markdown', title: 'Spec', handoff: null }],
      step: {
        key: 'design', title: 'Design', roleId: 'design', objective: 'Design the greeting.',
        expectedOutputs: ['DesignBrief'], inputArtifacts: [{ type: 'ProductSpec', required: true }],
        requiredCapabilities: [], completionGate: 'artifact.DesignBrief.exists',
        retryPolicy: { maxAttempts: 2, backoffMs: 5000, onExhausted: 'block' },
        maxWallTimeMs: 600000, modelPolicy: null, stepModel: null, stepSkills: [],
      },
      mission: { title: 'Greeting', goal: 'Greet the visitor by name', constraints: [], knowledge: D.EMPTY_KNOWLEDGE, decisions: [], answers: [] },
      criteria: [{ key: 'U1', statement: 'Greets the visitor by name', source: 'user', covers: [] }],
    },
    provenance: {
      missionId: S.ids.mission(), missionTitle: 'Greeting', taskId: S.ids.task(), runId: S.ids.run(),
      inputArtifactIds: [], referenceOutputs: [{ type: 'DesignBrief', sha256: '1'.repeat(64) }],
    },
    createdBy: null,
    createdAt: now(),
  };
}

function fixtureRun(suiteId) {
  return {
    id: S.ids.evalRun(),
    suiteId,
    workspaceId: ws.id,
    status: 'queued',
    reason: null,
    repeats: 3,
    spendCapUsd: 5,
    candidate: { kind: 'models', roles: { design: 'strong-model' } },
    variants: {
      baseline: { label: 'baseline', roles: {} },
      candidate: { label: 'candidate', roles: {} },
    },
    scorecard: null,
    startedBy: null,
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
  };
}

function fixtureTrial(runId, caseId, repeat) {
  return {
    id: S.ids.evalTrial(),
    runId,
    caseId,
    variant: 'baseline',
    repeat,
    seq: repeat,
    missionId: null,
    status: 'queued',
    reason: null,
    score: null,
    startedAt: null,
    finishedAt: null,
  };
}

/** Two real runs, each with one usage record: one on an ordinary mission, one on an eval trial mission. */
function seedUsage({ realCost, trialCost }) {
  const runs = container.resolve(app.RUN_REPOSITORY);
  const real = realRun();
  const trial = realRun({ evalTrialId: S.ids.evalTrial() });
  trialMissionId = trial.missionId;
  runs.recordUsage(real.id, { costUsd: realCost, wallTimeMs: 1000 });
  runs.recordUsage(trial.id, { costUsd: trialCost, wallTimeMs: 1000 });
  // Wide enough to hold whatever `recordUsage` (real clock) actually stamped.
  return { month: { start: '1970-01-01T00:00:00.000Z', end: '2999-01-01T00:00:00.000Z' } };
}

/**
 * A hand-made eval trial (the runner comes in Task 6): a hidden mission and one
 * agent task written the way the runner writes trial tasks - NO_APPROVAL, no
 * staffing, failing on exhaustion, isolation per the workflow default (none).
 * `c` is the container to write through, the in-process one or the daemon's.
 */
function handTrial(c, workspaceId, taskOverrides = {}) {
  const mission = c.resolve(app.MISSION_REPOSITORY).create({
    workspaceId, repositoryId: null, title: 'Hidden', goal: 'Hidden', successCriteria: [],
    id: S.ids.mission(), evalTrialId: S.ids.evalTrial(),
  });
  const task = trialTaskOn(c, mission.id, taskOverrides);
  return { missionId: mission.id, taskId: task.id, evalTrialId: mission.evalTrialId };
}

function trialTaskOn(c, missionId, overrides = {}) {
  return c.resolve(app.TASK_REPOSITORY).add({
    id: S.ids.task(), missionId, repositoryId: null, executor: 'agent', waitPolicy: null,
    key: 'design', title: 'Design', objective: 'Design the greeting.', roleId: 'design',
    dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: ['DesignBrief'],
    executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
    approvalPolicy: D.NO_APPROVAL,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'fail' },
    completionGate: 'artifact.DesignBrief.exists', status: 'READY', statusReason: null, attempts: 0,
    remediatesTaskId: null, orderHint: 0, createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
    modelPolicy: { model: 'good', pinned: true }, staffing: null,
    ...overrides,
  });
}

/** The minimal missions row a version-019 database needs, copying rounds-check.mjs:50-53's raw insert. */
function insertMissionAt019(h, id, wsId) {
  const at = '2026-01-01T00:00:00.000Z';
  h.prepare(`INSERT INTO workspaces (id,name,default_repository_id,autonomy,concurrency,routing,default_autonomy_level,knowledge,created_at,updated_at)
             VALUES (?,'W',NULL,'{}','{}','{}','supervised','{}',?,?)`).run(wsId, at, at);
  h.prepare(`INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,issue_link_id,created_at,updated_at)
             VALUES (?,?,'T','G','[]','[]','DRAFT','balanced','standard',NULL,?,?)`).run(id, wsId, at, at);
}

// -------------------------------------------------------------------------- daemon harness
//
// A real daemon (startDaemon, in process), a scripted runtime and the helpers
// later P3b tasks reuse: api(), sql(), missionWith(), waitMission(), tasks(),
// and the DI container itself, so a repository can be read directly rather
// than only through the HTTP API. Copies scratch/p12-models-check.mjs's daemon
// setup (env, workflows fixture, scripted runtime), generalised to a helper.
//
// Meant to be called once per process: it starts one real daemon on its own
// port and home directory, and sets process-wide env vars (GIT_CONFIG_GLOBAL,
// SCRIPTED_*) that a second daemon in the same process would stomp on.
async function daemonHarness() {
  const root = mkdtempSync(join(tmpdir(), 'tdm3-'));
  const home = join(root, 'h');
  const repo = join(root, 'r');
  const argsDir = join(root, 'args');
  const gitConfig = join(root, 'gitconfig');
  writeFileSync(gitConfig, '[user]\n\tname = Evals Tester\n\temail = evals@example.com\n');
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.SCRIPTED_DELAY_MS = '0';
  process.env.SCRIPTED_ARGS_DIR = argsDir;
  process.env.SCRIPTED_STATE_DIR = join(root, 'state');
  delete process.env.TANDEMISE_OWNER_NAME;
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  writeFileSync(join(repo, 'README.md'), '# evals check\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'e', private: true, scripts: { test: 'node -e "process.exit(0)"' } }));
  mkdirSync(join(repo, '.tandemise', 'workflows'), { recursive: true });
  const workflowsDir = join(here, 'acceptance/p0/workflows');
  for (const f of readdirSync(workflowsDir)) copyFileSync(join(workflowsDir, f), join(repo, '.tandemise/workflows', f));
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore' });

  globalThis.__sqlite = await import('node:sqlite');
  const { startDaemon } = await import('../apps/daemon/dist/main.js');
  const daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 200 });
  const token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
  const api = async (method, path, body) => {
    const res = await fetch(`${daemon.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const poll = async (fn, ms = 60_000) => {
    for (const until = Date.now() + ms; Date.now() < until; await sleep(150)) { const v = await fn(); if (v) return v; }
    return undefined;
  };
  const sql = (q, ...p) => {
    const db = new globalThis.__sqlite.DatabaseSync(join(home, 'tandemise.db'), { readOnly: true });
    try { return db.prepare(q).all(...p); } finally { db.close(); }
  };

  const wsRes = await api('POST', '/v1/workspaces', { name: 'Evals', repositoryPath: repo });
  const wsId = wsRes.body?.workspace?.id;
  await api('PATCH', `/v1/workspaces/${wsId}`, { autonomy: { ...wsRes.body.workspace.autonomy, planApproval: 'auto' } });
  await api('POST', '/v1/runtimes', {
    adapterId: 'generic-cli', name: 'Scripted agent', workspaceId: null,
    settings: {
      command: process.execPath, args: [resolve(here, 'acceptance/p0/scripted-agent.mjs')], promptVia: 'stdin',
      outputFormat: 'ndjson', modelFlag: '--model', capabilities: ['reasoning', 'tool_calling', 'shell', 'git', 'filesystem', 'mcp'],
    },
    maxConcurrent: 4, enabled: true,
  });

  const status = (id) => sql('SELECT status FROM missions WHERE id = ?', id)[0]?.status;
  const TERMINAL = ['COMPLETE', 'BLOCKED', 'FAILED', 'CANCELLED'];
  return {
    api,
    sql,
    container: daemon.container,
    workspaceId: wsId,
    /** Creates and starts a mission on the harness workspace; `workflow` names a fixture in acceptance/p0/workflows. */
    async missionWith({ goal, workflow, ...extra }) {
      const body = (await api('POST', '/v1/missions', {
        workspaceId: wsId, goal, workflowPreset: workflow, successCriteria: ['The steps finish'], planNow: true, ...extra,
      })).body;
      const id = body?.mission?.id;
      if (id !== undefined) {
        await poll(() => /Ready to start/.test(sql('SELECT status_reason AS r FROM missions WHERE id = ?', id)[0]?.r ?? '') || status(id) !== 'PLANNING', 20_000);
        await api('POST', `/v1/missions/${id}/start`);
      }
      return { id };
    },
    /** Polls until the mission reaches `want`, or any terminal status; returns the status it stopped on. */
    async waitMission(id, want) {
      await poll(() => status(id) === want || TERMINAL.includes(status(id)), 60_000);
      return status(id);
    },
    /** A mission's tasks, from the API's task view (carries `roleId`, `completionGate`, `gate`, ...). */
    async tasks(id) {
      const t = (await api('GET', `/v1/missions/${id}/tasks`)).body;
      return t.tasks ?? t;
    },
    async stop() {
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// -------------------------------------------------------------------------- harness
// Real SQLite, real artifact store and real services, composed as
// scratch/p3-contributions-check.mjs composes them, with EVAL_BLOBS added.
async function engineHarness(HOME, prStub = { read: async () => null }, configure = () => {}) {
  const app = await import('@tandemise/application');
  const { Container, compose } = await import('@tandemise/kernel');
  const { createLogger, createPaths, systemClock } = await import('@tandemise/shared');
  const persistenceTokens = await import('@tandemise/persistence');
  const { policyModule } = await import('@tandemise/policy');
  const { contextModule } = await import('@tandemise/context');
  const { createEvaluationModule } = await import('@tandemise/evaluation');
  const { runtimesCoreModule } = await import('@tandemise/runtimes-core');
  const { genericRuntimeModule } = await import('@tandemise/runtime-generic');
  const { executionCoreModule, CLOCK: EXEC_CLOCK, LOGGER: EXEC_LOGGER, PATHS: EXEC_PATHS } = await import('@tandemise/execution-core');
  const { executionLocalModule } = await import('@tandemise/execution-local');
  const { integrationsCoreModule, CLOCK: INT_CLOCK, LOGGER: INT_LOGGER, COMMAND_EXECUTOR, BACKGROUND_PROCESS_LAUNCHER } = await import('@tandemise/integrations-core');
  const paths = createPaths(HOME);
  mkdirSync(paths.root, { recursive: true });
  const clock = systemClock;
  const log = createLogger({ level: 'error', base: { component: 'p3-evals-check' } });
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
  container.bind(COMMAND_EXECUTOR, () => ({ run: async () => { throw new Error('unused'); } }), { source: 'check' });
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
  container.rebind(app.PULL_REQUEST_SNAPSHOTS, () => prStub, { source: 'check' });
  // Eval case inputs (P3b): content-addressed, so a case outlives its mission.
  container.bind(app.EVAL_BLOBS, () => new A.FileEvalBlobs(join(HOME, 'eval-blobs')), { source: 'check' });
  configure(container, app);
  const services = app.createServices(container);
  return { app, container, services, paths };
}

// ---------------------------------------------------------------------------- run

const tmp = mkdtempSync(join(tmpdir(), 'tdm-p3-evals-'));
try {
  const h = await engineHarness(tmp);
  ({ container, app } = h);
  const caller = { personId: h.services.identity.localPerson().id };
  ws = (await h.services.workspaces.create(caller, { name: 'Evals' })).workspace;

  section('persistence: migration 020');
  check('schema version is 20', P.SCHEMA_VERSION === 20, P.SCHEMA_VERSION);
  {
    // A database at 019 with one mission migrates, and the mission is not a trial.
    const path = join(tmp, 'at-019.db');
    const db = P.openDatabase({ path });
    P.migrate(db, undefined, P.MIGRATIONS.filter((m) => m.version <= 19));
    const dbh = db.handle;
    dbh.pragma('foreign_keys = OFF');
    insertMissionAt019(dbh, 'msn_old', 'ws_old');
    dbh.pragma('foreign_keys = ON');
    const result = P.migrate(db, undefined, P.MIGRATIONS);
    check('only migration 020 applies', eq(result.applied, [20]), result.applied);
    const missions = new P.SqliteMissionRepository(db, clock);
    check('an old mission has evalTrialId null', missions.get('msn_old').evalTrialId === null);
    db.close();
  }
  {
    const repo = container.resolve(P.EVAL_REPOSITORY);
    const suite = repo.createSuite({ id: S.ids.evalSuite(), workspaceId: ws.id, name: 'Smoke', createdAt: now(), updatedAt: now() });
    const kase = repo.insertCase(fixtureCase(suite.id));
    check('a suite lists its case count', repo.listSuites(ws.id).find((s) => s.id === suite.id)?.cases === 1);
    check('a case round-trips its snapshot', eq(repo.getCase(kase.id).snapshot, kase.snapshot));
    const run = repo.insertRun(fixtureRun(suite.id));
    repo.insertTrials([fixtureTrial(run.id, kase.id, 0)]);
    check('an active run is listed', repo.activeRuns().some((r) => r.id === run.id));
    repo.deleteSuite(suite.id);
    check('deleting a suite removes its cases and runs', repo.getCase(kase.id) === undefined && repo.getRun(run.id) === undefined);
  }
  {
    const scores = container.resolve(P.RUN_SCORE_REPOSITORY);
    const run = realRun(); // a runs row created through RUN_REPOSITORY for a fixture task
    scores.insert(fixtureScore(run, { evalTrial: false }));
    scores.insert(fixtureScore(run, { evalTrial: false, gateDetail: 'second' }));
    check('insert is idempotent on run id', scores.listByTask(run.taskId).length === 1 && scores.listByTask(run.taskId)[0].gateDetail !== 'second');
    const trialRun = realRun();
    scores.insert(fixtureScore(trialRun, { evalTrial: true }));
    check('list leaves trials out by default', scores.list(ws.id, '1970-01-01').every((s) => !s.evalTrial));
    check('list can include trials', scores.list(ws.id, '1970-01-01', { includeTrials: true }).some((s) => s.evalTrial));
  }
  {
    const missions = container.resolve(P.MISSION_REPOSITORY);
    const trial = missions.create({ ...draft('Eval trial smoke'), id: S.ids.mission(), evalTrialId: S.ids.evalTrial() });
    check('a trial mission is not listed', !missions.list({ workspaceId: ws.id }).some((m) => m.id === trial.id));
    check('a trial mission is reachable by id', missions.get(trial.id)?.evalTrialId === trial.evalTrialId);
    check('isTrialMission', D.isTrialMission(trial) && !D.isTrialMission({ evalTrialId: null }));
  }
  {
    const criteria = container.resolve(P.MISSION_CRITERIA_REPOSITORY);
    const m = createMission('Seeded ledger');
    const rows = criteria.seed(m.id, [
      { key: 'U2', statement: 'Works offline', source: 'user', covers: [] },
      { key: 'S5', statement: 'Caches the last page', source: 'spec', covers: ['U2'] },
    ]);
    check('seed keeps keys verbatim', eq(rows.map((r) => r.key), ['U2', 'S5']));
    check('seeded rows are active', criteria.listActive(m.id).length === 2);
    let refused = false; try { criteria.seed(m.id, []); } catch { refused = true; }
    check('seeding twice is refused', refused);
  }
  {
    const blobs = container.resolve(app.EVAL_BLOBS);
    const bytes = new TextEncoder().encode('# Spec\n');
    const sha = await blobs.put(bytes);
    check('put returns sha256 hex', /^[0-9a-f]{64}$/.test(sha));
    check('same bytes, same hash', (await blobs.put(bytes)) === sha);
    check('get round-trips', new TextDecoder().decode(await blobs.get(sha)) === '# Spec\n');
    writeFileSync(join(tmp, 'eval-blobs', sha.slice(0, 2), sha), 'tampered');
    check('a tampered blob reads as missing', (await blobs.get(sha)) === null);
  }
  {
    const limits = container.resolve(P.LIMIT_REPOSITORY);
    // One real mission and one trial mission, each with one usage record costing 1.0 and 2.0.
    const { month } = seedUsage({ realCost: 1, trialCost: 2 });
    check('workspace total includes trials', limits.usageForWorkspace(ws.id, month.start, month.end).costUsd === 3);
    check('eval usage is the trial share', limits.evalUsageForWorkspace(ws.id, month.start, month.end).costUsd === 2);
    check('per-mission usage leaves trials out', limits.usageByMission(ws.id, month.start, month.end).every((u) => u.missionId !== trialMissionId));
  }

  section('pure: scorecard');
  const E = await import('@tandemise/evaluation');
  const row = (o) => ({ runId: 'r', taskId: 't1', missionId: 'm', workspaceId: 'w', roleId: 'development', model: 'good', skills: [], attempt: 1, round: 1, purpose: 'round', gatePassed: true, gateDetail: '', facts: {}, criteria: null, overBudget: 0, inputTokens: 100, outputTokens: 10, costUsd: 0.5, wallTimeMs: 1000, evalTrial: false, scoredAt: '2026-09-27T00:00:00Z', ...o });
  const summary = E.summarizeRunScores([
    row({ taskId: 'a', gatePassed: false, scoredAt: '1' }), row({ taskId: 'a', gatePassed: true, scoredAt: '2', costUsd: 1.5 }),
    row({ taskId: 'b', gatePassed: true, costUsd: null }),
    row({ taskId: 'c', gatePassed: false, criteria: { verified: 1, failed: 2, unverified: 0 } }),
    row({ taskId: 'd', model: 'other' }),
  ]);
  const good = summary.find((s) => s.model === 'good');
  check('runs per role × model', good.runs === 4 && summary.length === 2);
  check('first-attempt pass rate is per task and round', good.firstAttemptPassRate === 1 / 3, good.firstAttemptPassRate);
  check('mean attempts to pass counts only tasks that passed', good.meanAttemptsToPass === 1.5, good.meanAttemptsToPass);
  check('criteria failed sums', good.criteriaFailed === 2);
  check('median cost ignores nulls', good.medianCostUsd === 0.5, good.medianCostUsd);
  check('a round is its own group', E.summarizeRunScores([row({ round: 1, gatePassed: false }), row({ round: 2, gatePassed: true, scoredAt: '3' })])[0].firstAttemptPassRate === 0.5);

  const ts = E.trialScoreFrom([row({ scoredAt: '2', gatePassed: true }), row({ scoredAt: '1', gatePassed: false })]);
  check('trial score: last gate, first attempt, sums', ts.gatePassed && !ts.firstAttemptPassed && ts.attempts === 2 && ts.costUsd === 1);
  check('trial score: one unknown cost makes the total unknown', E.trialScoreFrom([row({}), row({ costUsd: null, scoredAt: '9' })]).costUsd === null);
  check('trial score of no rows is null', E.trialScoreFrom([]) === null);

  const score = (o) => ({ gatePassed: true, attempts: 1, firstAttemptPassed: true, criteria: null, overBudget: 0, inputTokens: 100, outputTokens: 0, costUsd: 1, wallTimeMs: 10, model: 'x', ...o });
  const card = E.scoreEvalRun([
    { caseId: 'c1', caseName: 'One', variant: 'baseline', status: 'failed', score: score({ gatePassed: false, firstAttemptPassed: false, attempts: 2 }) },
    { caseId: 'c1', caseName: 'One', variant: 'candidate', status: 'passed', score: score({}) },
    { caseId: 'c2', caseName: 'Two', variant: 'baseline', status: 'blocked', score: null },
    { caseId: 'c2', caseName: 'Two', variant: 'candidate', status: 'passed', score: score({ costUsd: null }) },
  ], 2);
  check('baseline counts', eq(card.baseline.trials, { completed: 1, blocked: 1, failed: 1 }));
  check('gate pass rates', card.baseline.gatePassRate === 0 && card.candidate.gatePassRate === 1);
  check('difference is candidate minus baseline', card.difference.gatePassRate === 1 && card.difference.meanAttempts === -1);
  check('an unknown cost makes the variant cost unknown', card.candidate.costUsd.total === null && card.difference.meanCostUsd === null);
  check('per case, in first-seen order', eq(card.perCase.map((c) => c.caseId), ['c1', 'c2']));
  check('few repeats under 3', card.fewRepeats === true && E.scoreEvalRun([], 3).fewRepeats === false);
  check('no completed trials gives null rates', E.scoreEvalRun([], 3).baseline.gatePassRate === null);

  section('pure: pinned model');
  {
    const ctx = (step, pressure) => ({ step, role: { model: 'role-model', escalate: [], economyModel: 'cheap' }, profileModel: null, attempt: 1, pressure, runtimeTakesModel: true });
    const pressure = { percent: 90, scope: 'month' };
    check('unpinned under pressure goes economy', D.resolveModel(ctx({ model: 'good' }, pressure)).model === 'cheap');
    check('pinned beats economy', D.resolveModel(ctx({ model: 'good', pinned: true }, pressure)).model === 'good');
    const pinned = D.resolveModel(ctx({ model: 'good', pinned: true }, pressure));
    check('pinned reason and source', pinned.source === 'pinned' && pinned.reason === 'pinned step model (eval trial)', pinned);
    check('escalation still beats pinned on retry', D.resolveModel({ ...ctx({ model: 'good', pinned: true, escalate: ['big'] }, null), attempt: 2 }).model === 'big');
    check('pinned with no step model falls through', D.resolveModel(ctx({ pinned: true }, pressure)).source === 'economy');
  }

  section('harness: trial missions');
  {
    const roles = container.resolve(app.ROLE_REPOSITORY);
    const runs = container.resolve(app.RUN_REPOSITORY);
    const tasks = container.resolve(app.TASK_REPOSITORY);
    const approvals = container.resolve(app.APPROVAL_REPOSITORY);
    const limits = container.resolve(app.LIMIT_SERVICE);
    // The scripted stand-in for a model, as a Generic CLI runtime that takes `--model`
    // and saves every prompt it is given.
    const promptDir = join(tmp, 'prompts');
    process.env.SCRIPTED_PROMPT_DIR = promptDir;
    process.env.SCRIPTED_DELAY_MS = '0';
    container.resolve(app.RUNTIME_PROFILE_REPOSITORY).create({
      id: S.ids.runtimeProfile(), workspaceId: null, adapterId: 'generic-cli', name: 'Scripted agent', executablePath: null, args: [],
      settings: {
        command: process.execPath, args: [resolve(here, 'acceptance/p0/scripted-agent.mjs')], promptVia: 'stdin',
        outputFormat: 'ndjson', modelFlag: '--model', capabilities: ['reasoning', 'tool_calling', 'shell', 'git', 'filesystem', 'mcp'],
      },
      capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
    });
    const prompts = () => (!existsSync(promptDir) ? [] : readdirSync(promptDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(promptDir, e.name), 'utf8')));

    // The trial's frozen role: the design role with its own instructions and an economy model
    // that a limit under pressure would otherwise switch to.
    const live = roles.get('design', ws.id);
    const frozenRole = { ...live, instructions: 'EVAL-ROLE-MARK', models: { model: 'role-model', escalate: [], economyModel: 'cheap' } };
    const lost = new Set();
    const trialContext = (m) => (D.isTrialMission(m) && !lost.has(m.id)
      ? { role: frozenRole, knowledge: D.EMPTY_KNOWLEDGE, decisions: [], answers: [] }
      : null);
    // Built as the module builds it, plus the seam the eval runner will supply and a
    // month limit under pressure, so the economy rule would fire if the pin did not win.
    const base = container.resolve(app.TASK_EXECUTOR);
    const pressured = { admit: (id) => limits.admit(id), afterUsage: (id, run) => limits.afterUsage(id, run), pressure: () => ({ percent: 90, scope: 'month' }) };
    // No tool surface: its socket would sit under this harness's long temp path,
    // past macOS's socket-path limit, and nothing here calls a tool.
    const noTools = { provision: async () => app.NO_TOOL_SURFACE };
    const executor = new app.TaskExecutor({ ...base.deps, limits: pressured, mcpGateway: noTools, trialContext });
    const workIn = (missionId) => {
      const dir = h.paths.mission(ws.id, missionId);
      mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main', dir]);
      execFileSync('git', ['-C', dir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
    };

    const t = handTrial(container, ws.id);
    workIn(t.missionId);
    const ran = await executor.execute(t.taskId, new AbortController().signal);
    const captured = prompts().join('\n');
    check('the trial ran', ran.kind === 'settled' && runs.listByTask(t.taskId).length === 1, ran);
    check('the trial role reaches the prompt', captured.includes('EVAL-ROLE-MARK'), captured.slice(0, 400));
    const lastRun = runs.listByTask(t.taskId).at(-1);
    check('the pinned model ran under pressure', lastRun?.model === 'good', lastRun?.model);
    check('and says it was pinned', lastRun?.modelReason === 'pinned step model (eval trial)', lastRun?.modelReason);

    // Missing skill: a trial task pinned to a hash that is not in the store.
    const miss = handTrial(container, ws.id, { skills: [{ name: 'ghost', version: 1, hash: 'f'.repeat(64) }] });
    const out = await executor.execute(miss.taskId, new AbortController().signal);
    check('a missing skill blocks the trial', out.kind === 'settled' && out.status === 'BLOCKED' && /Missing skill: ghost/.test(out.reason), out);
    check('and creates no approval', approvals.list({ missionId: miss.missionId }).length === 0);
    check('limits admit a trial', limits.admit(miss.missionId) === null);
    // seedUsage above recorded a $2 trial run this month.
    const evalShare = limits.usage(ws.id).evalCostUsd;
    check('the month usage names the eval share', typeof evalShare === 'number' && evalShare >= 2, evalShare);

    // A trial whose setup is gone is a runner bug: it stops rather than run on the live role.
    const orphan = handTrial(container, ws.id);
    lost.add(orphan.missionId);
    const orphaned = await executor.execute(orphan.taskId, new AbortController().signal);
    check('a trial that lost its setup blocks', orphaned.kind === 'settled' && orphaned.status === 'BLOCKED' && orphaned.reason === 'This eval trial lost its setup.', orphaned);

    // Nobody can answer a trial: a question hears so at once, a tool needing approval is denied.
    {
      const I = await import('@tandemise/integrations-core');
      const asking = handTrial(container, ws.id, { status: 'RUNNING', attempts: 1 });
      const assignment = container.resolve(app.ASSIGNMENT_REPOSITORY).create({
        id: S.ids.workerAssignment(), workspaceId: ws.id, missionId: asking.missionId, taskId: asking.taskId, roleId: 'design',
        runtimeProfileId: 'rt_fixture', executionTargetId: 'tgt_fixture', grants: [],
        budgets: { maxWallTimeMs: 60000, maxAttempts: 1 }, createdAt: now(),
      });
      const askHuman = container.resolveAll(I.BUILT_IN_TOOLS).find((tool) => tool.name === 'ask_human');
      let asked = null;
      try {
        await askHuman.execute({ assignment, assignmentId: assignment.id, runId: null, signal: new AbortController().signal }, { question: 'Which colour?' });
      } catch (e) { asked = e.message; }
      check('ask_human in a trial answers nobody', asked === 'Nobody can answer during an eval trial. Continue with your best judgement and say what you assumed.', asked);
      const decision = await container.resolve(I.APPROVAL_GATE).requestApproval({
        toolName: 'shell', capability: 'shell.exec', assignmentId: assignment.id, risk: 'write_reversible', reason: 'asks', inputSummary: 'ls',
      }, new AbortController().signal);
      check('a tool approval in a trial is denied', decision.approved === false && decision.reason === 'No one can approve tools during an eval trial.', decision);
      check('neither raised a card nor parked the task', approvals.list({ missionId: asking.missionId }).length === 0 && tasks.get(asking.taskId).status === 'RUNNING');
      tasks.update(asking.taskId, { status: 'CANCELLED' });
    }

    // Recovery: a trial task found RUNNING under a dead run is left for the eval runner;
    // a real one in the same state goes back to the queue.
    const recovering = handTrial(container, ws.id, { status: 'RUNNING', attempts: 1 });
    const real = realRun();
    tasks.update(real.taskId, { status: 'RUNNING' });
    const dead = (taskId, missionId) => {
      const assignment = container.resolve(app.ASSIGNMENT_REPOSITORY).create({
        id: S.ids.workerAssignment(), workspaceId: ws.id, missionId, taskId, roleId: 'design',
        runtimeProfileId: 'rt_fixture', executionTargetId: 'tgt_fixture', grants: [],
        budgets: { maxWallTimeMs: 60000, maxAttempts: 1 }, createdAt: now(),
      });
      runs.create({
        id: S.ids.run(), missionId, taskId, assignmentId: assignment.id, attempt: 9,
        status: 'RUNNING', roleId: 'design', runtimeProfileId: 'rt_fixture', executionTargetId: 'tgt_fixture',
        externalSessionId: null, pid: null, exitCode: null, errorCode: null, errorMessage: null, usage: null,
        startedAt: now(), finishedAt: null, heartbeatAt: now(),
      });
    };
    dead(recovering.taskId, recovering.missionId);
    dead(real.taskId, real.missionId);
    await container.resolve(app.RECOVERY_SERVICE).run();
    check('recovery does not requeue a trial task', tasks.get(recovering.taskId).status !== 'READY', tasks.get(recovering.taskId).status);
    check('recovery still requeues a real task', tasks.get(real.taskId).status === 'READY', tasks.get(real.taskId).status);
  }
} finally {
  container?.resolve(P.DATABASE)?.close?.();
  rmSync(tmp, { recursive: true, force: true });
}

section('daemon: run scores');
{
  const d = await daemonHarness();
  try {
    // A build step that fails its gate once and then passes (the scripted agent writes nothing on its first run).
    const m1 = await d.missionWith({ goal: 'Add a footer SCRIPTED_FAIL_TIMES=1 SCRIPTED_COST_USD=0.25', workflow: 'build-only' });
    check('mission completes', await d.waitMission(m1.id, 'COMPLETE') === 'COMPLETE');
    const buildTask = (await d.tasks(m1.id)).find((t) => t.roleId === 'development');
    const rows = d.sql(`SELECT * FROM run_scores WHERE task_id = ? ORDER BY scored_at, rowid`, buildTask.id);
    check('two scores for fail then pass', eq(rows.map((r) => r.gate_passed), [0, 1]), rows.map((r) => r.gate_passed));
    check('facts include the check results', JSON.parse(rows[1]?.facts ?? '{}')['checks.tests'] !== undefined, Object.keys(JSON.parse(rows[1]?.facts ?? '{}')));
    check('cost is kept', rows[1]?.cost_usd === 0.25, rows[1]?.cost_usd);
    check('a real run is not a trial', rows.every((r) => r.eval_trial === 0));

    // p2-solo's single `doc` step has no completion gate, so it is never scored.
    const m2 = await d.missionWith({ goal: 'Write a short spec', workflow: 'p2-solo' });
    check('the ungated mission completes', await d.waitMission(m2.id, 'COMPLETE') === 'COMPLETE');
    const ungated = (await d.tasks(m2.id)).filter((t) => t.completionGate === null);
    check('the ungated mission has an ungated task', ungated.length > 0, ungated.map((t) => t.key));
    check('a step with no gate has no score', ungated.every((t) => d.sql('SELECT 1 FROM run_scores WHERE task_id = ?', t.id).length === 0));

    section('daemon: trial missions');
    const ws = d.workspaceId;
    const homeBefore = (await d.api('GET', `/v1/home?workspaceId=${ws}`)).body;
    // Built by hand through the repositories (the runner comes in Task 6), with a
    // second step waiting on a person, which a real mission would show in the Inbox.
    const t = handTrial(d.container, ws, { roleId: 'development', key: 'build' });
    trialTaskOn(d.container, t.missionId, { key: 'sign', title: 'Sign off', executor: 'human', status: 'AWAITING_HUMAN' });
    const missionsList = (await d.api('GET', `/v1/missions?workspaceId=${ws}`)).body;
    check('not in GET /v1/missions', Array.isArray(missionsList.missions ?? missionsList) && !JSON.stringify(missionsList).includes(t.missionId));
    check('not in the backlog', !JSON.stringify((await d.api('GET', `/v1/workspaces/${ws}/backlog`)).body).includes(t.missionId));
    const homeAfter = (await d.api('GET', `/v1/home?workspaceId=${ws}`)).body;
    check('not on the Desk', !JSON.stringify(homeAfter).includes(t.missionId) && eq(homeAfter.metrics, homeBefore.metrics), { before: homeBefore.metrics, after: homeAfter.metrics });
    check('not in the Inbox', !JSON.stringify((await d.api('GET', `/v1/inbox?workspaceId=${ws}`)).body).includes(t.missionId));
    await new Promise((r) => setTimeout(r, 1000)); // five scheduler ticks
    check('the scheduler never dispatches it', d.sql('SELECT COUNT(*) n FROM runs WHERE task_id = ?', t.taskId)[0].n === 0);
    // Month usage includes a trial's spend, shown as the eval share.
    const u = (await d.api('GET', `/v1/workspaces/${ws}/usage`)).body;
    check('usage reports the eval share', typeof u.evalCostUsd === 'number' || u.evalCostUsd === null, u);
  } finally {
    await d.stop();
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
