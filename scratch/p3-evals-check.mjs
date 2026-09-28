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
// Task 5: EvalService - suites, saving a finished gated step as a case (base
// sha, inputs copied into the blob store, the step and mission context frozen,
// criteria copied), and every refusal (not succeeded, no gate, no run, base
// unresolved).
// Task 6: eval runs - the runner's deferral path against a stub executor, then
// real runs on the daemon: baseline vs a models candidate scored as a
// scorecard, trials hidden and cleaned up (no worktree, no branch), pinned
// models under economy pressure, the spend cap, every startRun refusal, a
// setup-folder candidate, cancel mid-trial, a restart mid-trial (the run
// fails and nothing is requeued), and a runtime that reports no cost.
//
//   npm run build && node scratch/p3-evals-check.mjs
import { execFileSync, spawnSync } from 'node:child_process';
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
  // `let`: restart() replaces the daemon on the same home, and with it the url and container.
  let daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 200 });
  let token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
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
  /** Creates and plans a mission but never starts it, so its root tasks stay READY. */
  const planOnly = async ({ goal, workflow, ...extra }) => {
    const body = (await api('POST', '/v1/missions', {
      workspaceId: wsId, goal, workflowPreset: workflow, successCriteria: ['The steps finish'], planNow: true, ...extra,
    })).body;
    const id = body?.mission?.id;
    if (id !== undefined) {
      await poll(() => /Ready to start/.test(sql('SELECT status_reason AS r FROM missions WHERE id = ?', id)[0]?.r ?? '') || status(id) !== 'PLANNING', 20_000);
    }
    return { id };
  };
  return {
    api,
    sql,
    /** A getter: after restart() it is the new daemon's container. */
    get container() { return daemon.container; },
    workspaceId: wsId,
    /** The fixture repository's checkout on disk, for the eval-cases section's own git plumbing. */
    repoPath: repo,
    /** This daemon's own home directory, so a check can look for a file it should (or should not) have written. */
    home,
    planOnly,
    /** Creates and starts a mission on the harness workspace; `workflow` names a fixture in acceptance/p0/workflows. */
    async missionWith({ goal, workflow, ...extra }) {
      const { id } = await planOnly({ goal, workflow, ...extra });
      if (id !== undefined) await api('POST', `/v1/missions/${id}/start`);
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
    /** Stops the daemon and starts a new one on the same home, as a machine restart would (boot recovery runs). */
    async restart() {
      await daemon.stop();
      daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 200 });
      token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
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
  // The application module binds an in-memory default; this replaces it with a real one on disk.
  container.rebind(app.EVAL_BLOBS, () => new A.FileEvalBlobs(join(HOME, 'eval-blobs')), { source: 'check' });
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
    // Task 6: the trial's own timeline must not say its work "was returned to the queue" - it was not.
    const restartNote = (missionId) => container.resolve(app.EVENT_REPOSITORY).listByMission(missionId)
      .some((e) => e.body.type === 'note' && /Tandemise restarted while this mission was running/.test(e.body.text));
    check('recovery leaves no restart note on a trial mission', !restartNote(recovering.missionId));
    check('recovery still notes a real mission', restartNote(real.missionId));
  }

  section('harness: eval runner deferral');
  {
    // A stub executor stands in for the real one, and the runner's clock is moved by its own sleep,
    // so ten minutes of deferral pass without waiting for them.
    const evalsRepo = container.resolve(app.EVAL_REPOSITORY);
    const tasksRepo = container.resolve(app.TASK_REPOSITORY);
    const missionsRepo = container.resolve(app.MISSION_REPOSITORY);
    // Only the run under test is active: earlier sections left fixture runs queued.
    for (const r of evalsRepo.activeRuns()) evalsRepo.updateRun(r.id, { status: 'cancelled' });
    const repo = container.resolve(app.REPO_REPOSITORY).create({
      id: S.ids.repository(), workspaceId: ws.id, name: 'deferral', path: tmp, defaultBranch: 'main', remoteUrl: null, checks: D.NO_CHECKS,
    });
    const suite = evalsRepo.createSuite({ id: S.ids.evalSuite(), workspaceId: ws.id, name: 'Deferral', createdAt: now(), updatedAt: now() });
    const base = fixtureCase(suite.id);
    const kase = evalsRepo.insertCase({ ...base, snapshot: { ...base.snapshot, repositoryId: repo.id, inputs: [] } });
    const design = container.resolve(app.ROLE_REPOSITORY).get('design', ws.id);
    const variant = (label) => ({ label, roles: { design: { role: { ...design, instructions: `FROZEN-${label}` }, pins: [] } } });
    const queueRun = () => {
      const run = evalsRepo.insertRun({ ...fixtureRun(suite.id), repeats: 1, variants: { baseline: variant('baseline'), candidate: variant('candidate') } });
      evalsRepo.insertTrials([{ ...fixtureTrial(run.id, kase.id, 1), seq: 1 }]);
      return run;
    };
    let fakeMs = Date.parse('2026-01-01T00:00:00.000Z');
    const fakeClock = { now: () => new Date(fakeMs).toISOString(), epochMs: () => fakeMs };
    const sleep = async (ms) => { fakeMs += ms; };
    const stub = (script) => {
      const s = { calls: 0, seen: [] };
      s.execute = async (taskId) => {
        const out = script(s.calls++);
        const task = tasksRepo.get(taskId);
        s.seen.push(runner.contextFor(missionsRepo.get(task.missionId)));
        if (out.kind === 'settled') tasksRepo.update(taskId, { status: out.status, statusReason: out.reason });
        return out;
      };
      return s;
    };
    let runner;
    const drive = async (executor, extra = {}) => {
      const run = queueRun();
      runner = new app.EvalRunner({ ...container.resolve(app.EVAL_RUNNER).deps, executor, clock: fakeClock, sleep, ...extra });
      await runner.start();
      for (const until = Date.now() + 15_000; Date.now() < until && !['completed', 'failed'].includes(evalsRepo.getRun(run.id).status);) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await runner.stop();
      return { run: evalsRepo.getRun(run.id), trial: evalsRepo.listTrials(run.id)[0] };
    };

    const twice = stub((n) => (n < 2 ? { kind: 'deferred', reason: 'Waiting for a runtime slot.' } : { kind: 'settled', status: 'SUCCEEDED', reason: null }));
    const passed = await drive(twice);
    check('two deferrals, then it runs', twice.calls === 3 && passed.trial.status === 'passed', { calls: twice.calls, trial: passed.trial });
    check('the run completes after deferrals', passed.run.status === 'completed' && passed.run.scorecard !== null, passed.run);
    check('the executor was given the frozen role', twice.seen.every((c) => c?.role.instructions === 'FROZEN-baseline'), twice.seen.map((c) => c?.role.instructions));
    check('a real mission has no trial context', runner.contextFor(missionsRepo.get(createMission('Not a trial').id)) === null);
    const trialMission = missionsRepo.get(passed.trial.missionId);
    check('the trial mission is hidden, ranked 0, on the case base', trialMission.evalTrialId === passed.trial.id && trialMission.rank === 0 && trialMission.baseBranch === 'deadbeef' && trialMission.status === 'COMPLETE', trialMission);
    const stepTask = tasksRepo.listByMission(trialMission.id).find((t) => t.key === 'design');
    check('the step task is written for a trial', stepTask.approvalPolicy.beforeStart === false && stepTask.approvalPolicy.onCompletion === false
      && stepTask.retryPolicy.onExhausted === 'fail' && stepTask.executionPolicy.isolation === 'worktree' && stepTask.staffing === null, stepTask);

    const forever = stub(() => ({ kind: 'deferred', reason: 'Waiting for a runtime slot.', retryAfterMs: 60_000 }));
    const blocked = await drive(forever);
    check('ten minutes of deferral blocks the trial with the reason', blocked.trial.status === 'blocked' && blocked.trial.reason === 'Waiting for a runtime slot.', blocked.trial);
    check('it gave up after ten minutes, not before', forever.calls >= 10 && forever.calls <= 12, forever.calls);
    check('the blocked trial task says why', tasksRepo.listByMission(blocked.trial.missionId).find((t) => t.key === 'design')?.status === 'BLOCKED');
    check('the run still completes', blocked.run.status === 'completed', blocked.run);

    // Fix round 1: a write that throws after the step settled still ends the trial and cleans it up.
    const targetsRepo = container.resolve(app.EXECUTION_TARGET_REPOSITORY);
    const guarded = (repo, method, when, message) => new Proxy(repo, {
      get(target, key) {
        if (key === method) return (...args) => { if (when(...args)) throw new Error(message); return target[key](...args); };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const released = [];
    const stubTargets = { release: async (record) => { released.push(record.id); return { targetId: record.id, released: true, workingDirectory: record.workingDirectory, retainedReason: null, commit: null }; } };
    let madeTarget;
    const withTarget = stub(() => ({ kind: 'settled', status: 'SUCCEEDED', reason: null }));
    const settle = withTarget.execute;
    withTarget.execute = async (taskId) => {
      const task = tasksRepo.get(taskId);
      madeTarget = targetsRepo.create({
        id: S.ids.executionTarget(), workspaceId: ws.id, missionId: task.missionId, taskId, kind: 'worktree', name: 'trial',
        workingDirectory: join(tmp, 'no-such-worktree'), branch: 'tandemise/trial/x', baseBranch: null, status: 'READY',
        detail: null, createdAt: now(), releasedAt: null,
      });
      return settle(taskId);
    };
    const throwing = await drive(withTarget, {
      targetManager: stubTargets,
      missions: guarded(missionsRepo, 'update', (_id, patch) => patch.status === 'COMPLETE', 'The disk is full.'),
    });
    check('a throw after the step settled ends the trial failed with its message', throwing.trial.status === 'failed' && throwing.trial.reason === 'The disk is full.', throwing.trial);
    check('and its worktree is still cleaned up', released.includes(madeTarget?.id), released);
    check('and the run still ends', throwing.run.status === 'completed', throwing.run);

    // Fix round 1: boot recovery that throws still fails the run, so the loop never resumes it.
    const stuck = queueRun();
    evalsRepo.updateRun(stuck.id, { status: 'running' });
    const brokenRecovery = new app.EvalRunner({
      ...container.resolve(app.EVAL_RUNNER).deps,
      evals: guarded(evalsRepo, 'listTrials', () => true, 'The database is locked.'),
    });
    await brokenRecovery.recoverInterrupted();
    const stuckAfter = evalsRepo.getRun(stuck.id);
    check('recovery that throws still fails the run', stuckAfter.status === 'failed' && stuckAfter.reason === 'The daemon stopped during this run.' && stuckAfter.finishedAt !== null, stuckAfter);
    evalsRepo.updateTrial(evalsRepo.listTrials(stuck.id)[0].id, { status: 'cancelled' });

    // Fix round 1: a worktree whose target row never got its branch (the daemon died between
    // `git worktree add` and recording it) is found by the branch the factory names, and removed.
    {
      const repoDir = join(tmp, 'leftover-repo');
      execFileSync('git', ['init', '-q', '-b', 'main', repoDir]);
      execFileSync('git', ['-C', repoDir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
      const repo2 = container.resolve(app.REPO_REPOSITORY).create({
        id: S.ids.repository(), workspaceId: ws.id, name: 'leftover', path: repoDir, defaultBranch: 'main', remoteUrl: null, checks: D.NO_CHECKS,
      });
      const run = evalsRepo.insertRun({ ...fixtureRun(suite.id), status: 'running', variants: { baseline: variant('baseline'), candidate: variant('candidate') } });
      const trialId = S.ids.evalTrial();
      const title = 'Eval trial Leftover baseline 1';
      const mission = missionsRepo.create({
        id: S.ids.mission(), workspaceId: ws.id, repositoryId: repo2.id, title, goal: title, successCriteria: [], rank: 0, evalTrialId: trialId,
      });
      evalsRepo.insertTrials([{ ...fixtureTrial(run.id, kase.id, 1), id: trialId, seq: 1, status: 'running', missionId: mission.id }]);
      const task = trialTaskOn(container, mission.id, { status: 'READY' });
      const name = `${S.slugify(title)}-${task.key}`;
      const branch = `tandemise/${S.slugify(title)}/${S.slugify(name)}-${task.id.slice(-8)}`;
      execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-q', '-b', branch, join(tmp, 'leftover-wt'), 'main']);
      targetsRepo.create({
        id: S.ids.executionTarget(), workspaceId: ws.id, missionId: mission.id, taskId: task.id, kind: 'worktree', name,
        workingDirectory: repoDir, branch: null, baseBranch: 'main', status: 'FAILED', detail: 'Provisioning was interrupted by a daemon restart.',
        createdAt: now(), releasedAt: null,
      });
      const git = { run: async ({ command, args, cwd }) => {
        const r = spawnSync(command, args, { cwd, encoding: 'utf8' });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr, timedOut: false, durationMs: 0, command: [command, ...args].join(' ') };
      } };
      await new app.EvalRunner({ ...container.resolve(app.EVAL_RUNNER).deps, exec: git }).recoverInterrupted();
      check('a branchless worktree left by a crash is removed', !execFileSync('git', ['-C', repoDir, 'worktree', 'list']).toString().includes('leftover-wt'));
      check('and so is its branch', execFileSync('git', ['-C', repoDir, 'branch', '--list', branch]).toString().trim() === '');
      check('and the run is failed', evalsRepo.getRun(run.id).status === 'failed' && evalsRepo.getTrial(trialId).status === 'cancelled');
    }
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

    section('daemon: eval cases');
    {
      // EvalService and the repositories it reads, resolved through the real
      // daemon's own container - no HTTP route exists yet (Task 7).
      const evals = d.container.resolve(app.EVAL_SERVICE);
      const runsRepo = d.container.resolve(app.RUN_REPOSITORY);
      const runInputsRepo = d.container.resolve(app.RUN_INPUT_REPOSITORY);
      const artifactsRepo = d.container.resolve(app.ARTIFACT_REPOSITORY);
      const blobsRepo = d.container.resolve(app.EVAL_BLOBS);
      const criteriaRepo = d.container.resolve(app.MISSION_CRITERIA_REPOSITORY);
      const missionsRepo = d.container.resolve(app.MISSION_REPOSITORY);
      const caller = { personId: d.container.resolve(app.IDENTITY).localPerson().id };
      const gitc = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
      const refuses = async (label, fn, code) => {
        let err;
        try { await fn(); } catch (e) { err = e; }
        check(label, err?.code === code, err === undefined ? 'did not throw' : { code: err.code, message: err.message });
      };

      // The gated build step from "daemon: run scores" above, already SUCCEEDED.
      const kase = await evals.saveCase(buildTask.id, caller, { newSuiteName: 'Smoke', name: 'Banner' });
      check('base sha is the fixture main', kase.snapshot.baseSha === gitc(d.repoPath, 'rev-parse', 'main'), kase.snapshot.baseSha);
      const firstRun = runsRepo.listByTask(buildTask.id).sort((a, b) => a.attempt - b.attempt)[0];
      const inputHashes = runInputsRepo.listByRun(firstRun.id).map((id) => artifactsRepo.get(id).sha256).sort();
      check('inputs are the run inputs, by hash', eq(kase.snapshot.inputs.map((i) => i.sha256).sort(), inputHashes));
      check('every input is in the blob store', (await Promise.all(kase.snapshot.inputs.map((i) => blobsRepo.has(i.sha256)))).every(Boolean));
      check('criteria keys copied', eq(kase.snapshot.criteria.map((x) => x.key), criteriaRepo.listActive(m1.id).map((x) => x.key)));

      missionsRepo.remove(m1.id);
      const again = evals.listCases(kase.suiteId).find((x) => x.id === kase.id);
      check('a case survives deleting its mission', again !== undefined && eq(again.snapshot, kase.snapshot));

      // A step that never started: planned but the mission was never started.
      const { id: readyMissionId } = await d.planOnly({ goal: 'Add a widget', workflow: 'build-only' });
      const readyTask = (await d.tasks(readyMissionId)).find((t) => t.roleId === 'development');
      await refuses('a READY step is refused', () => evals.saveCase(readyTask.id, caller, { suiteId: kase.suiteId, name: 'x' }), 'not_succeeded');
      await refuses('an ungated step is refused', () => evals.saveCase(ungated[0].id, caller, { suiteId: kase.suiteId, name: 'x' }), 'no_gate');

      // A mission based on a branch that is then deleted; build is the first
      // gated step, so no upstream ChangeSet ref masks the branch resolution.
      execFileSync('git', ['branch', 'feature/gone'], { cwd: d.repoPath, stdio: 'ignore' });
      const m3 = await d.missionWith({ goal: 'On a branch', baseBranch: 'feature/gone', workflow: 'build-only' });
      check('the branch mission completes', await d.waitMission(m3.id, 'COMPLETE') === 'COMPLETE');
      const m3Build = (await d.tasks(m3.id)).find((t) => t.roleId === 'development');
      // The gated step's worktree remains after completion (it is the reviewable
      // artifact); it must go before its base branch can be deleted.
      const worktree = d.sql('SELECT working_directory AS d FROM execution_targets WHERE task_id = ?', m3Build.id)[0]?.d;
      if (worktree !== undefined) execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: d.repoPath, stdio: 'ignore' });
      execFileSync('git', ['branch', '-D', 'feature/gone'], { cwd: d.repoPath, stdio: 'ignore' });
      await refuses('a deleted base branch is refused', () => evals.saveCase(m3Build.id, caller, { suiteId: kase.suiteId, name: 'y' }), 'base_unresolved');

      // Proves saveCase's write ordering (fix round 1, item 1): a synthetic
      // input - the step's own ChangeSet, attached as a run input purely so
      // the blob-store phase has something to write - must still be absent
      // after a refusal, and present on disk only once a save actually lands.
      const m4 = await d.missionWith({ goal: 'Add a header', workflow: 'build-only' });
      check('m4 completes', await d.waitMission(m4.id, 'COMPLETE') === 'COMPLETE');
      const m4Build = (await d.tasks(m4.id)).find((t) => t.roleId === 'development');
      const m4FirstRun = runsRepo.listByTask(m4Build.id).sort((a, b) => a.attempt - b.attempt)[0];
      const changeSet = artifactsRepo.listByTask(m4Build.id).find((a) => a.type === 'ChangeSet');
      runInputsRepo.record(m4FirstRun.id, [changeSet.id]);
      const blobPath = join(d.home, 'evals', 'blobs', changeSet.sha256.slice(0, 2), changeSet.sha256);
      check('the input blob does not exist yet', !existsSync(blobPath));

      await refuses(
        'an invalid case name is refused before any input is written to the blob store',
        () => evals.saveCase(m4Build.id, caller, { suiteId: kase.suiteId, name: '' }),
        'VALIDATION',
      );
      check('no blob was written for the refused save', !existsSync(blobPath));

      const kase4 = await evals.saveCase(m4Build.id, caller, { suiteId: kase.suiteId, name: 'Header' });
      check('a saved case writes its input blob to disk', existsSync(blobPath));
      check('the saved case records the same hash', kase4.snapshot.inputs.some((i) => i.sha256 === changeSet.sha256));

      section('daemon: eval runs');
      {
        // Everything is resolved per call: `d.restart()` below replaces the container.
        const E = () => d.container.resolve(app.EVAL_SERVICE);
        const R = (tok) => d.container.resolve(tok);
        const ws = d.workspaceId;
        const TERMINAL = ['completed', 'stopped_at_cap', 'failed', 'cancelled'];
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        const waitEvalRun = async (id, statuses, ms = 240_000) => {
          for (const until = Date.now() + ms; Date.now() < until; await pause(200)) {
            if (statuses.includes(E().getRun(id).run.status)) break;
          }
          return E().getRun(id);
        };
        /**
         * Until a candidate trial has an agent run in flight, so a stop or cancel lands mid-run. The
         * candidate's good model is the one SCRIPTED_DELAY_MS holds; a bad-model run ends at once.
         */
        const waitTrialRunning = async (id, ms = 120_000) => {
          for (const until = Date.now() + ms; Date.now() < until; await pause(100)) {
            const live = E().getRun(id).trials.find((t) => t.status === 'running' && t.variant === 'candidate' && t.missionId !== null);
            // STARTING until the agent's first output, which the delay holds back; a moment more so it is mid-delay.
            if (live !== undefined && d.sql(`SELECT 1 FROM runs WHERE mission_id = ? AND status IN ('STARTING', 'RUNNING')`, live.missionId).length > 0) {
              await pause(1000);
              return live;
            }
          }
          return undefined;
        };
        const runsOf = (detail, variant) => detail.trials
          .filter((t) => t.variant === variant && t.missionId !== null)
          .flatMap((t) => d.sql('SELECT model, status FROM runs WHERE mission_id = ?', t.missionId));
        const candidateRuns = (detail) => runsOf(detail, 'candidate');
        const trialTasks = (detail) => detail.trials
          .filter((t) => t.missionId !== null)
          .flatMap((t) => d.sql('SELECT key, status FROM mission_tasks WHERE mission_id = ?', t.missionId));
        const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
        const roleOf = async (id) => (await d.api('GET', `/v1/roles?workspaceId=${ws}`)).body.find((r) => r.id === id);
        const setRoleModels = async (id, models) => {
          const { createdAt, updatedAt, builtIn, workspaceId, ...rest } = await roleOf(id);
          return d.api('PUT', `/v1/roles/${id}`, { ...rest, workspaceId: ws, models });
        };
        const blobPathOf = (sha) => join(d.home, 'evals', 'blobs', sha.slice(0, 2), sha);

        // The scripted model: "bad" writes nothing (its gate fails every time), and every run costs $0.25.
        process.env.SCRIPTED_FAIL_MODEL = 'bad';
        process.env.SCRIPTED_COST_USD = '0.25';

        // A suite of its own rather than "Smoke": the Header case there has a ChangeSet input, and the
        // build gate only asks that a ChangeSet exists. A gate that only checks an artifact type the step
        // also receives can't tell variants apart - the seeded input satisfies it - exactly as it can't
        // in a real mission, and trials keep gate facts identical to real missions (coordinator ruling).
        // Two cases from two missions that passed on a good model, then the role is switched to the bad one:
        // the baseline replays today's (bad) role, the candidate tries the good model again.
        check('the role runs on a good model', (await setRoleModels('development', { model: 'good', escalate: [], economyModel: null })).status === 200);
        const m5 = await d.missionWith({ goal: 'Add a banner', workflow: 'build-only' });
        const m6 = await d.missionWith({ goal: 'Add a sidebar', workflow: 'build-only' });
        check('both source missions complete', await d.waitMission(m5.id, 'COMPLETE') === 'COMPLETE' && await d.waitMission(m6.id, 'COMPLETE') === 'COMPLETE');
        const c5 = await E().saveCase((await d.tasks(m5.id)).find((t) => t.roleId === 'development').id, caller, { newSuiteName: 'Runs', name: 'Banner step' });
        await E().saveCase((await d.tasks(m6.id)).find((t) => t.roleId === 'development').id, caller, { suiteId: c5.suiteId, name: 'Sidebar step' });
        const suite = { id: c5.suiteId };
        check('the role now runs on the bad model', (await setRoleModels('development', { model: 'bad', escalate: [], economyModel: null })).status === 200);

        const run = await E().startRun(suite.id, caller, { candidate: { kind: 'models', roles: { development: 'good' } }, repeats: 2, spendCapUsd: 5 });
        check('a run starts queued', run.status === 'queued' && run.repeats === 2 && run.spendCapUsd === 5, run);
        check('the baseline froze the role as it is today', run.variants.baseline.roles.development?.role.models?.model === 'bad', run.variants.baseline);
        check('the candidate carries the model', run.variants.candidate.roles.development?.role.models?.model === 'good', run.variants.candidate);
        const done = await waitEvalRun(run.id, TERMINAL);
        check('the run completes', done.run.status === 'completed', done.run);
        check('2 cases × 2 variants × 2 repeats', done.trials.length === 8, done.trials.length);
        check('trials alternate baseline and candidate per case', eq(done.trials.slice(0, 4).map((t) => t.variant), ['baseline', 'candidate', 'baseline', 'candidate']));
        check('trials are taken case by case, repeat by repeat', eq(done.trials.slice(0, 4).map((t) => t.repeat), [1, 1, 2, 2]) && done.trials.slice(0, 4).every((t) => t.caseId === c5.id));
        const card = done.run.scorecard;
        check('baseline fails, candidate passes', card?.baseline.gatePassRate === 0 && card?.candidate.gatePassRate === 1, card);
        check('difference is +1', card?.difference.gatePassRate === 1, card?.difference);
        check('few repeats is flagged', card?.fewRepeats === true);
        check('trial statuses follow the gate', done.trials.every((t) => t.status === (t.variant === 'baseline' ? 'failed' : 'passed')), done.trials.map((t) => t.status));
        check('every finished trial has a score', done.trials.every((t) => t.score !== null && t.finishedAt !== null));
        check('spend is measured', done.costUnmeasured === false && typeof done.spentUsd === 'number' && done.spentUsd > 0, { spent: done.spentUsd, unmeasured: done.costUnmeasured });
        const missionsBody = (await d.api('GET', `/v1/missions?workspaceId=${ws}`)).body;
        check('no trial in missions list', !JSON.stringify(missionsBody).includes('Eval trial'));
        check('trial missions are hidden, finished missions', done.trials.every((t) => ['COMPLETE', 'FAILED'].includes(d.sql('SELECT status FROM missions WHERE id = ?', t.missionId)[0]?.status)));
        check('trial missions take no backlog rank', done.trials.every((t) => d.sql('SELECT rank FROM missions WHERE id = ?', t.missionId)[0]?.rank === 0));
        check('each trial replays the case criteria', done.trials.every((t) => d.sql('SELECT COUNT(*) n FROM mission_criteria WHERE mission_id = ?', t.missionId)[0].n === c5.snapshot.criteria.length));
        check('no trial worktrees left', !git(d.repoPath, 'worktree', 'list').includes('eval-trial'), git(d.repoPath, 'worktree', 'list'));
        check('no trial branches left', git(d.repoPath, 'branch', '--list', 'tandemise/eval-trial*').trim() === '', git(d.repoPath, 'branch', '--list', 'tandemise/eval-trial*'));
        check('candidate trials ran the candidate model', candidateRuns(done).length >= 4 && candidateRuns(done).every((r) => r.model === 'good'), candidateRuns(done));
        check('baseline trials ran the role model', runsOf(done, 'baseline').length >= 4 && runsOf(done, 'baseline').every((r) => r.model === 'bad'), runsOf(done, 'baseline'));
        check('trial scores are kept as trials', d.sql('SELECT COUNT(*) n FROM run_scores WHERE eval_trial = 1')[0].n >= 8);
        const realRunsFor = (s) => d.sql(
          `SELECT COUNT(*) n FROM run_scores WHERE workspace_id = ? AND eval_trial = 0 AND role_id = ? AND COALESCE(model, '') = ?`,
          ws, s.roleId, s.model ?? '',
        )[0].n;
        const summary = E().runScoreSummary(ws, 30);
        check('real-run summary leaves trials out', summary.length > 0 && summary.every((s) => s.runs === realRunsFor(s)) && !summary.some((s) => s.model === 'bad'), summary);
        check('runs are listed for the suite', E().listRuns(suite.id).some((r) => r.id === run.id));

        // Economy pressure does not move a pinned trial model.
        check('economy model set', (await setRoleModels('development', { model: 'bad', escalate: [], economyModel: 'cheap' })).status === 200);
        check('a month limit is set', (await d.api('PATCH', `/v1/workspaces/${ws}`, { monthlyLimits: [{ metric: 'usd', amount: 100, warnPercent: 1 }] })).status === 200);
        check('the month is under pressure', R(app.LIMIT_SERVICE).pressure(m5.id) !== null, R(app.LIMIT_SERVICE).pressure(m5.id));
        const r2 = await E().startRun(suite.id, caller, { candidate: { kind: 'models', roles: { development: 'good' } }, repeats: 1, spendCapUsd: 5 });
        const d2 = await waitEvalRun(r2.id, TERMINAL);
        check('the pressured run completes', d2.run.status === 'completed', d2.run);
        check('trials ignore economy mode', candidateRuns(d2).length > 0 && candidateRuns(d2).every((r) => r.model === 'good') && runsOf(d2, 'baseline').every((r) => r.model === 'bad'), [candidateRuns(d2), runsOf(d2, 'baseline')]);
        await d.api('PATCH', `/v1/workspaces/${ws}`, { monthlyLimits: [] });
        await setRoleModels('development', { model: 'bad', escalate: [], economyModel: null });

        // The cap: every run costs $0.25 and a bad-model trial runs twice, so a $0.60 cap stops the run early.
        const r3 = await E().startRun(suite.id, caller, { candidate: { kind: 'models', roles: { development: 'good' } }, repeats: 2, spendCapUsd: 0.6 });
        const d3 = await waitEvalRun(r3.id, TERMINAL);
        check('stopped at the cap', d3.run.status === 'stopped_at_cap' && d3.run.reason === 'Stopped at your $0.60 cap', d3.run);
        const finished3 = d3.trials.filter((t) => t.status !== 'cancelled');
        check('the rest of the trials are cancelled', d3.trials.some((t) => t.status === 'cancelled') && finished3.length <= 3, d3.trials.map((t) => t.status));
        check('spend reached the cap', typeof d3.spentUsd === 'number' && d3.spentUsd >= 0.6, d3.spentUsd);
        check('a stopped run still has a scorecard', d3.run.scorecard !== null && d3.run.finishedAt !== null);

        // Refusals write nothing.
        const runsBefore = E().listRuns(suite.id).length;
        await refuses('no cap', () => E().startRun(suite.id, caller, { candidate: { kind: 'models', roles: {} } }), 'cap_required');
        await refuses('a zero cap', () => E().startRun(suite.id, caller, { candidate: { kind: 'models', roles: {} }, spendCapUsd: 0 }), 'cap_required');
        await refuses('repeats out of range', () => E().startRun(suite.id, caller, { candidate: { kind: 'models', roles: {} }, repeats: 11, spendCapUsd: 1 }), 'repeats_range');
        await refuses('fractional repeats', () => E().startRun(suite.id, caller, { candidate: { kind: 'models', roles: {} }, repeats: 1.5, spendCapUsd: 1 }), 'repeats_range');
        const empty = E().createSuite(ws, caller, 'Empty');
        await refuses('an empty suite', () => E().startRun(empty.id, caller, { candidate: { kind: 'models', roles: {} }, spendCapUsd: 1 }), 'suite_empty');
        await refuses('an unknown skill', () => E().startRun(suite.id, caller, { candidate: { kind: 'skills', roles: { development: [{ name: 'ghost', version: 'latest' }] } }, spendCapUsd: 1 }), 'skill_unknown');
        // The Header case (from "eval cases" above) has an input; without its blob no trial can seed it.
        const headerSha = kase4.snapshot.inputs[0].sha256;
        const blobCopy = join(d.home, 'blob-aside');
        copyFileSync(blobPathOf(headerSha), blobCopy);
        rmSync(blobPathOf(headerSha));
        let missing;
        try { await E().startRun(kase4.suiteId, caller, { candidate: { kind: 'models', roles: {} }, spendCapUsd: 1 }); } catch (e) { missing = e; }
        check('missing input names the case', missing?.code === 'input_missing' && missing.message === 'An input of case Header is missing from the eval store.', missing?.message);
        copyFileSync(blobCopy, blobPathOf(headerSha));
        // A case whose role was deleted: a custom role runs a gated step, the step is saved, the role is deleted.
        writeFileSync(join(d.repoPath, '.tandemise/workflows/copy-only.yaml'), [
          'name: Copy only', 'description: One copywriting step, gated, on a custom role.', 'steps:',
          '  - key: copy', '    role: copywriter', '    objective: Write the hello page copy.', '    outputs: [ChangeSet]',
          '    gate: artifact.ChangeSet.exists', '',
        ].join('\n'));
        const dev = await roleOf('development');
        const { createdAt: _c, updatedAt: _u, builtIn: _b, workspaceId: _w, ...devRest } = dev;
        check('a custom role is created', (await d.api('PUT', '/v1/roles/copywriter', { ...devRest, id: 'copywriter', name: 'Copywriter', workspaceId: ws, models: { model: 'good', escalate: [], economyModel: null } })).status === 200);
        const m7 = await d.missionWith({ goal: 'Write the copy', workflow: 'copy-only' });
        check('the custom-role mission completes', await d.waitMission(m7.id, 'COMPLETE') === 'COMPLETE');
        const orphan = await E().saveCase((await d.tasks(m7.id)).find((t) => t.roleId === 'copywriter').id, caller, { suiteId: suite.id, name: 'Copy step' });
        check('the custom role is deleted', (await d.api('DELETE', `/v1/roles/copywriter?workspaceId=${ws}`)).status < 300);
        let orphaned;
        try { await E().startRun(suite.id, caller, { candidate: { kind: 'models', roles: {} }, spendCapUsd: 1 }); } catch (e) { orphaned = e; }
        check('a deleted role names the case', orphaned?.code === 'role_missing' && orphaned.message === 'The role copywriter used by case Copy step no longer exists.', orphaned?.message);
        E().deleteCase(orphan.id, caller);
        check('no refusal wrote a run', E().listRuns(suite.id).length === runsBefore && E().listRuns(kase4.suiteId).length === 0 && E().listRuns(empty.id).length === 0);

        // Setup candidate: role instructions from a folder reach the prompt; the project is untouched.
        // The Smoke suite has the Header case, whose ChangeSet input each trial must seed.
        const promptDir = join(d.home, 'r4-prompts');
        const argsDir = join(d.home, 'r4-args');
        process.env.SCRIPTED_PROMPT_DIR = promptDir;
        const argsBefore = process.env.SCRIPTED_ARGS_DIR;
        process.env.SCRIPTED_ARGS_DIR = argsDir;
        const folder = join(d.home, 'candidate-setup');
        mkdirSync(join(folder, '.tandemise', 'roles'), { recursive: true });
        writeFileSync(join(folder, '.tandemise', app.roleFileName('development')), app.renderRole({
          id: 'development', name: dev.name, summary: dev.summary, instructions: 'EVAL-ROLE-MARK: write like the candidate.',
          capabilities: dev.defaultCapabilities, produces: dev.producesArtifacts, consumes: dev.consumesArtifacts,
          isolation: dev.defaultIsolation, outputContract: dev.outputContract,
          model: 'good', escalate: [], economyModel: null, runtime: [], skills: [],
        }));
        const r4 = await E().startRun(kase4.suiteId, caller, { candidate: { kind: 'setup', folder }, repeats: 1, spendCapUsd: 5 });
        const d4 = await waitEvalRun(r4.id, TERMINAL);
        process.env.SCRIPTED_ARGS_DIR = argsBefore;
        delete process.env.SCRIPTED_PROMPT_DIR;
        check('the setup run completes', d4.run.status === 'completed', d4.run);
        // A prompt and its argv are written by the same process: pair them by pid to learn each prompt's model.
        const byPid = (dir, ext) => new Map((existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith(ext))
          .map((f) => [f.slice(f.indexOf('-') + 1, -ext.length), readFileSync(join(dir, f), 'utf8')]));
        const promptsByPid = byPid(promptDir, '.txt');
        const pairs = [...byPid(argsDir, '.json')].map(([pid, args]) => ({ model: JSON.parse(args).model, prompt: promptsByPid.get(pid) ?? '' }));
        const candidateArgs = pairs.filter((p) => p.model === 'good');
        const baselineArgs = pairs.filter((p) => p.model === 'bad');
        check('setup candidate instructions reach the prompt', candidateArgs.length >= 2 && candidateArgs.every((a) => a.prompt.includes('EVAL-ROLE-MARK')), candidateArgs.length);
        check('baseline trials did not see them', baselineArgs.length >= 2 && baselineArgs.every((a) => a.prompt !== '' && !a.prompt.includes('EVAL-ROLE-MARK')), baselineArgs.length);
        check('the project role is unchanged', !R(app.ROLE_REPOSITORY).get('development', ws).instructions.includes('EVAL-ROLE-MARK'));
        const headerTrials = d4.trials.filter((t) => t.caseId === kase4.id);
        const seeded = headerTrials.flatMap((t) => d.sql(
          `SELECT a.sha256 FROM artifacts a JOIN mission_tasks t ON t.id = a.task_id WHERE a.mission_id = ? AND t.key = 'input-changeset'`, t.missionId,
        ).map((row) => row.sha256));
        check('each trial seeds the case input by hash', headerTrials.length === 2 && seeded.length === 2 && seeded.every((sha) => sha === headerSha), seeded);
        let badSetup;
        try { await E().startRun(kase4.suiteId, caller, { candidate: { kind: 'setup', folder: join(d.home, 'nowhere') }, spendCapUsd: 5 }); } catch (e) { badSetup = e; }
        check('a folder with no setup is refused', badSetup?.code === 'setup_invalid', badSetup?.message);

        // Deleting a suite while its run is running. The delay keeps the good model's runs going long enough.
        process.env.SCRIPTED_DELAY_MS = '4000';
        const r5 = await E().startRun(suite.id, caller, { candidate: { kind: 'models', roles: { development: 'good' } }, repeats: 1, spendCapUsd: 5 });
        const live5 = await waitTrialRunning(r5.id);
        check('a trial is mid-run', live5 !== undefined, E().getRun(r5.id).trials.map((t) => t.status));
        await refuses('delete suite during a run', async () => E().deleteSuite(suite.id, caller), 'already_running');
        await refuses('a second run in the project', () => E().startRun(kase4.suiteId, caller, { candidate: { kind: 'models', roles: {} }, spendCapUsd: 1 }), 'already_running');
        E().cancelRun(r5.id, caller);
        const d5 = await waitEvalRun(r5.id, TERMINAL);
        check('cancel ends the run', d5.run.status === 'cancelled' && d5.run.scorecard !== null, d5.run);
        // The runner writes the live trial's end once its attempt unwinds.
        for (const until = Date.now() + 30_000; Date.now() < until && E().getRun(r5.id).trials.some((t) => t.status === 'running'); await pause(100));
        const d5b = E().getRun(r5.id);
        check('the live trial ends cancelled', d5b.trials.find((t) => t.id === live5?.id)?.status === 'cancelled', d5b.trials.map((t) => t.status));
        check('nothing is left queued or running', d5b.trials.every((t) => !['queued', 'running'].includes(t.status)));
        check('the cancelled trial worktree is gone', !git(d.repoPath, 'worktree', 'list').includes('eval-trial'), git(d.repoPath, 'worktree', 'list'));
        await refuses('a finished run cannot be cancelled', async () => E().cancelRun(r5.id, caller), 'not_running');

        // Restart mid-trial.
        const r6 = await E().startRun(suite.id, caller, { candidate: { kind: 'models', roles: { development: 'good' } }, repeats: 1, spendCapUsd: 5 });
        check('a trial is mid-run before the restart', (await waitTrialRunning(r6.id)) !== undefined);
        await d.restart();
        process.env.SCRIPTED_DELAY_MS = '0';
        const d6 = E().getRun(r6.id);
        check('a restart fails the run with the reason', d6.run.status === 'failed' && d6.run.reason === 'The daemon stopped during this run.', d6.run);
        check('the interrupted trial task is not requeued', d6.trials.every((t) => t.status !== 'running' && t.status !== 'queued') && trialTasks(d6).length > 0 && trialTasks(d6).every((t) => t.status !== 'READY'), [d6.trials.map((t) => t.status), trialTasks(d6)]);
        check('its worktree is gone', !git(d.repoPath, 'worktree', 'list').includes('eval-trial'), git(d.repoPath, 'worktree', 'list'));
        check('no trial branch is left after the restart', git(d.repoPath, 'branch', '--list', 'tandemise/eval-trial*').trim() === '');
        check('a failed run still has a scorecard', d6.run.scorecard !== null && d6.run.finishedAt !== null);

        // A runtime that reports no cost: a text profile never reads the usage line.
        const runtime = (await d.api('GET', '/v1/runtimes')).body.map((v) => v.profile).find((p) => p.name === 'Scripted agent');
        const asText = await d.api('PATCH', `/v1/runtimes/${runtime.id}`, { settings: { ...runtime.settings, outputFormat: 'text' } });
        check('the runtime reports no cost now', asText.status === 200, asText.body);
        const r7 = await E().startRun(suite.id, caller, { candidate: { kind: 'models', roles: { development: 'good' } }, repeats: 1, spendCapUsd: 0.01 });
        const d7 = await waitEvalRun(r7.id, TERMINAL);
        check('unmeasured cost is flagged, never zero', d7.costUnmeasured === true && d7.spentUsd === null, { unmeasured: d7.costUnmeasured, spent: d7.spentUsd });
        check('an unmeasured run is not stopped at the cap', d7.run.status === 'completed', d7.run);
        await d.api('PATCH', `/v1/runtimes/${runtime.id}`, { settings: runtime.settings });
        delete process.env.SCRIPTED_FAIL_MODEL;
        delete process.env.SCRIPTED_COST_USD;

        section('http: evals');
        {
          // Task 7's HTTP surface, round-tripped over the daemon's own bearer
          // token: a suite made from scratch, a case saved from m5's finished
          // build step (already SUCCEEDED above), a run started and watched to
          // a terminal state, every view's shape, and the two refusals that
          // only show up over HTTP (no cap, a second run while one is active).
          const m5BuildTask = (await d.tasks(m5.id)).find((t) => t.roleId === 'development');

          const suiteRes = await d.api('POST', `/v1/workspaces/${ws}/evals/suites`, { name: 'HTTP suite' });
          check('create suite: 200', suiteRes.status === 200, suiteRes);
          const httpSuiteId = suiteRes.body.id;
          check('list suites includes it', (await d.api('GET', `/v1/workspaces/${ws}/evals/suites`)).body.some((s) => s.id === httpSuiteId));

          const caseRes = await d.api('POST', `/v1/tasks/${m5BuildTask.id}/eval-case`, { suiteId: httpSuiteId, name: 'HTTP case' });
          check('save case: 200', caseRes.status === 200, caseRes);
          const httpCaseId = caseRes.body.id;

          const casesRes = await d.api('GET', `/v1/evals/suites/${httpSuiteId}/cases`);
          check('list cases: 200', casesRes.status === 200 && Array.isArray(casesRes.body), casesRes);
          const caseView = casesRes.body.find((c) => c.id === httpCaseId);
          check(
            'case view shape',
            caseView?.suiteId === httpSuiteId && caseView.name === 'HTTP case' && typeof caseView.baseSha === 'string'
              && typeof caseView.repositoryId === 'string' && caseView.roleId === 'development' && typeof caseView.stepTitle === 'string'
              && Array.isArray(caseView.inputs) && typeof caseView.criteria === 'number',
            caseView,
          );
          check(
            'case view names its live source mission',
            caseView?.source?.missionId === m5.id && caseView.source.missionExists === true,
            caseView?.source,
          );

          const noCap = await d.api('POST', `/v1/evals/suites/${httpSuiteId}/runs`, { candidate: { kind: 'models', roles: {} } });
          check('starting a run with no cap: 400, the service message', noCap.status === 400 && noCap.body.error.message === 'Set a spend cap for this run.', noCap);

          process.env.SCRIPTED_COST_USD = '0.25';
          const startRes = await d.api('POST', `/v1/evals/suites/${httpSuiteId}/runs`, {
            candidate: { kind: 'models', roles: { development: 'good' } }, repeats: 1, spendCapUsd: 5,
          });
          check('start run: 200, a run view', startRes.status === 200, startRes);
          const httpRunId = startRes.body.id;
          check(
            'run view at start: suite, trials, progress',
            startRes.body.suiteId === httpSuiteId && Array.isArray(startRes.body.trials)
              && startRes.body.progress?.total === startRes.body.trials.length,
            startRes.body,
          );

          const second = await d.api('POST', `/v1/evals/suites/${httpSuiteId}/runs`, { candidate: { kind: 'models', roles: {} }, spendCapUsd: 1 });
          check('a second run while one is active: 409', second.status === 409, second);

          let runView;
          for (const until = Date.now() + 120_000; Date.now() < until; ) {
            runView = (await d.api('GET', `/v1/evals/runs/${httpRunId}`)).body;
            if (TERMINAL.includes(runView.status)) break;
            await pause(200);
          }
          check('get run: reaches a terminal state', TERMINAL.includes(runView?.status), runView);
          check(
            'run view once finished: scorecard, spend, done progress',
            runView.scorecard !== null && typeof runView.spentUsd === 'number' && runView.costUnmeasured === false
              && runView.progress.done === runView.progress.total,
            runView,
          );
          check('run view trials carry the case name', runView.trials.length > 0 && runView.trials.every((t) => t.caseName === 'HTTP case'), runView.trials);

          const runsRes = await d.api('GET', `/v1/evals/suites/${httpSuiteId}/runs`);
          check('list runs: includes it', runsRes.status === 200 && runsRes.body.some((r) => r.id === httpRunId), runsRes.body);

          const scoresRes = await d.api('GET', `/v1/workspaces/${ws}/evals/run-scores?days=30`);
          check('run-scores: 200, an array', scoresRes.status === 200 && Array.isArray(scoresRes.body), scoresRes);

          const cancelFinished = await d.api('POST', `/v1/evals/runs/${httpRunId}/cancel`);
          check(
            'cancel a finished run: 400 not_running',
            cancelFinished.status === 400 && cancelFinished.body.error.details?.code === 'not_running',
            cancelFinished,
          );

          const usage = await d.api('GET', `/v1/workspaces/${ws}/usage`);
          check('workspace usage names an eval share after these runs', typeof usage.body.evalCostUsd === 'number' && usage.body.evalCostUsd > 0, usage.body.evalCostUsd);

          const delCase = await d.api('DELETE', `/v1/evals/cases/${httpCaseId}`);
          check('delete case: 204', delCase.status === 204, delCase);
          const delSuite = await d.api('DELETE', `/v1/evals/suites/${httpSuiteId}`);
          check('delete suite: 204', delSuite.status === 204, delSuite);

          delete process.env.SCRIPTED_COST_USD;
        }
      }
    }
  } finally {
    await d.stop();
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
