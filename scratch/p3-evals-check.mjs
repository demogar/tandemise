// P3b evals, task 1: ids, entities, migration 020 and repositories - the
// foundation the rest of P3b builds on. Migrating a version-019 database to
// 020; the new eval suite/case/run/trial repository; run scores, idempotent
// on run id and leaving eval trials out of "From your runs" by default; a
// hidden eval trial mission, excluded from every list but reachable by id;
// seeding a trial's Done-when ledger once; the content-addressed eval blob
// store; and eval spend split out of workspace usage.
//
//   npm run build && node scratch/p3-evals-check.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/** The minimal missions row a version-019 database needs, copying rounds-check.mjs:50-53's raw insert. */
function insertMissionAt019(h, id, wsId) {
  const at = '2026-01-01T00:00:00.000Z';
  h.prepare(`INSERT INTO workspaces (id,name,default_repository_id,autonomy,concurrency,routing,default_autonomy_level,knowledge,created_at,updated_at)
             VALUES (?,'W',NULL,'{}','{}','{}','supervised','{}',?,?)`).run(wsId, at, at);
  h.prepare(`INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,issue_link_id,created_at,updated_at)
             VALUES (?,?,'T','G','[]','[]','DRAFT','balanced','standard',NULL,?,?)`).run(id, wsId, at, at);
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
} finally {
  container?.resolve(P.DATABASE)?.close?.();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
