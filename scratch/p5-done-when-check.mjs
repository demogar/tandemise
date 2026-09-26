// P5: the Done-when ledger. Every Done-when line becomes U1…Un, the spec must
// cover each one, QA must verify spec criteria by id, and the facts the gates
// read are traced from that chain - never from what a report claims.
//
//   npm run build && node scratch/p5-done-when-check.mjs
//
// A real engine over a real SQLite file (the rounds-check harness), with the
// harvester driven directly against a scripted working directory.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const D = await import('@tandemise/domain');
const A = await import('@tandemise/artifacts');
const { createContextCompiler } = await import('@tandemise/context');

// ------------------------------------------------------------------ pure rules
section('pure: keys and validation');
{
  check('user keys are U1, U2 …', D.userCriterionKey(0) === 'U1' && D.userCriterionKey(1) === 'U2');
  check('U<n> is reserved for the person', D.isUserCriterionKey('U7') && !D.isUserCriterionKey('AC1') && !D.isUserCriterionKey('Unit'));
  check('resultKey prefers criterionId, falls back to the legacy criterion',
    D.resultKey({ criterionId: 'AC2', criterion: 'x', outcome: 'PASS', evidence: '' }) === 'AC2'
    && D.resultKey({ criterion: 'AC1', outcome: 'PASS', evidence: '' }) === 'AC1');
  const spec = D.checkSpecCriteria(['U1', 'U2'], [
    { key: 'AC1', statement: 's', covers: ['U1', 'U9'] }, { key: 'AC1', statement: 't', covers: [] }, { key: 'U2', statement: 'u', covers: [] },
  ]);
  check('a duplicate id and a user key are refused', spec.refused.length === 2, spec.refused);
  check('an uncovered user key is named', eq(spec.uncovered, ['U2']), spec.uncovered);
  check('a covers entry naming no user line is named', eq(spec.unknownCovers, ['AC1 → U9']), spec.unknownCovers);
  check('unknown QA keys are listed once', eq(D.unknownQaKeys(['U1', 'AC1'], [{ criterionId: 'AC9', criterion: '', outcome: 'PASS', evidence: '' }, { criterion: 'AC9', outcome: 'FAIL', evidence: '' }, { criterion: 'AC1', outcome: 'PASS', evidence: '' }]), ['AC9']));
  check('an empty ledger accepts any QA key (legacy missions)', D.unknownQaKeys([], [{ criterion: 'Login works', outcome: 'PASS', evidence: '' }]).length === 0);
}

section('pure: tracing');
{
  const at = (m) => `2026-09-26T10:${String(m).padStart(2, '0')}:00.000Z`;
  const row = (key, source, covers = [], createdAt = at(0), position = 0) => ({
    id: `crt_${key}`, missionId: 'm', key, statement: `${key} statement`, source, covers,
    specArtifactId: source === 'spec' ? 'art_spec' : null, position, supersededAt: null, createdAt,
  });
  const users = [row('U1', 'user', [], at(0), 0), row('U2', 'user', [], at(0), 1)];

  let t = D.traceCriteria(users, null);
  check('before a spec every user line counts and none is "not covered" yet', t.counted === 2 && t.unverified === 2 && t.rows.every((r) => !r.uncovered), t);
  check('uncovered_user counts them all', t.uncoveredUser === 2 && t.userTotal === 2 && t.total === 2);

  const ac1 = row('AC1', 'spec', ['U1', 'U2'], at(5), 0);
  t = D.traceCriteria([...users, ac1], null);
  check('E1 shape: one AC covering U1, U2 → counted set is {AC1}', t.counted === 1 && t.uncoveredUser === 0, t);
  const u1 = t.rows.find((r) => r.criterion.key === 'U1');
  check('U1 is covered by AC1 and not counted itself', eq(u1.coveredBy, ['AC1']) && !u1.counted && u1.result === 'UNVERIFIED');

  t = D.traceCriteria([...users, ac1], { results: [{ criterionId: 'AC1', criterion: 'AC1', outcome: 'PASS', evidence: 'saw it' }], recordedAt: at(10) });
  check('QA PASS on AC1 verifies it and, through it, U1 and U2', t.verified === 1 && t.unverified === 0 && t.rows.every((r) => r.result === 'PASS'), t.rows.map((r) => [r.criterion.key, r.result]));
  check('a user line verified through the spec says so', t.rows.find((r) => r.criterion.key === 'U2').evidence === 'Through AC1');

  const missesU2 = row('AC1', 'spec', ['U1'], at(5));
  t = D.traceCriteria([...users, missesU2], { results: [{ criterionId: 'AC1', criterion: 'AC1', outcome: 'PASS', evidence: '' }], recordedAt: at(10) });
  check('a spec dropping U2 does not look finished: U2 stays counted and unverified', t.uncoveredUser === 1 && t.counted === 2 && t.unverified === 1, t);
  check('U2 is "not covered" once a spec exists', t.rows.find((r) => r.criterion.key === 'U2').uncovered === true);

  const three = ['AC1', 'AC2', 'AC3'].map((k, i) => row(k, 'spec', ['U1', 'U2'], at(5), i));
  t = D.traceCriteria([...users, ...three], { results: [{ criterionId: 'AC1', criterion: '', outcome: 'PASS', evidence: '' }], recordedAt: at(10) });
  check('E3 shape: 3 ACs, 1 PASS → 2 unverified', t.verified === 1 && t.unverified === 2 && t.failed === 0, t);
  t = D.traceCriteria([...users, ...three], { results: [{ criterionId: 'AC1', criterion: '', outcome: 'PASS', evidence: '' }, { criterionId: 'AC2', criterion: '', outcome: 'FAIL', evidence: 'broken' }], recordedAt: at(10) });
  check('E4 shape: AC2 FAIL is failed, and the user lines it covers read FAIL', t.failed === 1 && t.rows.find((r) => r.criterion.key === 'U1').result === 'FAIL');

  const rewritten = ['AC1', 'AC2', 'AC3'].map((k, i) => row(k, 'spec', ['U1', 'U2'], at(20), i));
  t = D.traceCriteria([...users, ...rewritten], { results: [{ criterionId: 'AC1', criterion: '', outcome: 'PASS', evidence: '' }], recordedAt: at(10) });
  check('a spec rewritten after QA ran is unverified, even where an old id reappears', t.verified === 0 && t.unverified === 3, t);
  t = D.traceCriteria([...users, ac1], { results: [{ criterionId: 'U2', criterion: '', outcome: 'SKIP', evidence: 'n/a' }], recordedAt: at(10) });
  check('a result QA gives a user line directly wins over what covers it', t.rows.find((r) => r.criterion.key === 'U2').result === 'SKIP');
}

section('pure: facts');
{
  const { GateFactBuilder } = await import('@tandemise/evaluation');
  const { GATE_FACT_VOCABULARY } = await import('@tandemise/evaluation');
  const names = GATE_FACT_VOCABULARY.map((f) => f.name);
  for (const n of ['criteria.total', 'criteria.user_total', 'criteria.uncovered_user', 'criteria.unknown_covers', 'qa.criteria_verified', 'qa.criteria_unverified', 'qa.criteria_failed']) {
    check(`${n} is in the published vocabulary`, names.includes(n));
  }
  const at = (m) => `2026-09-26T10:${String(m).padStart(2, '0')}:00.000Z`;
  const five = [1, 2, 3, 4, 5].map((n) => ({ id: `c${n}`, missionId: 'm', key: `AC${n}`, statement: 's', source: 'spec', covers: [], specArtifactId: 'a', position: n, supersededAt: null, createdAt: at(0) }));
  const onePass = [{ criterionId: 'AC1', criterion: 'AC1', outcome: 'PASS', evidence: '' }];
  const legacy = new GateFactBuilder().withQa({ criteria: onePass, blockingDefects: 0 }).build();
  check('the old bug: one PASS reported of five reads 100 without a ledger', legacy['qa.acceptance_criteria_coverage'] === 100);
  const facts = new GateFactBuilder().withCriteria(D.traceCriteria(five, { results: onePass, recordedAt: at(9) })).withQa({ criteria: onePass, blockingDefects: 0 }).build();
  check('against the ledger it reads 20: the four never reported count as not verified', facts['qa.acceptance_criteria_coverage'] === 20, facts);
  check('and qa.criteria_unverified is 4', facts['qa.criteria_unverified'] === 4 && facts['qa.criteria_verified'] === 1);
  const empty = new GateFactBuilder().withCriteria(D.traceCriteria([], null)).build();
  check('an empty ledger measures criteria.total 0 but leaves the qa facts unmeasured', empty['criteria.total'] === 0 && !('qa.criteria_unverified' in empty));
}

section('contracts: schemas and templates');
{
  const spec = A.parseArtifact('ProductSpec', ['---', 'type: ProductSpec', 'title: Hello', 'handoff:', '  headline: Spec ready', 'acceptanceCriteria:', '  - id: AC1', '    statement: Greets by name', '    covers: [U1, U2]', '---', '', '# Hello'].join('\n'));
  check('a ProductSpec criterion carries covers', spec.ok && eq(spec.value.frontMatter.acceptanceCriteria[0].covers, ['U1', 'U2']), spec.ok ? spec.value.frontMatter : spec.error);
  const qa = (line) => A.parseArtifact('QAReport', ['---', 'type: QAReport', 'title: QA', 'handoff:', '  headline: QA done', 'results:', `  - ${line}`, '    outcome: PASS', 'blockingDefects: 0', '---', '', '# QA'].join('\n'));
  check('a QAReport result with criterionId parses', qa('criterionId: AC1').ok);
  check('the legacy criterion field still parses', qa('criterion: AC1').ok);
  const none = qa('evidence: nothing');
  check('a result naming neither is refused and says criterionId', !none.ok && JSON.stringify(none.error).includes('criterionId'), none.ok ? null : none.error);
  check('the ProductSpec template shows covers', A.renderArtifactTemplate('ProductSpec').includes('covers:'));
  check('the QAReport template shows criterionId', A.renderArtifactTemplate('QAReport').includes('criterionId:'));
}

section('prompt: the Mission section lists the ledger');
{
  const compiler = createContextCompiler();
  const base = {
    role: { name: 'QA', summary: 's', instructions: 'i', outputContract: 'o' },
    workspaceName: 'w', knowledge: {}, decisions: [], evidence: [], grants: [], dependencyArtifacts: [],
    mission: { title: 'Hello', goal: 'Greet', constraints: [], successCriteria: ['Greets by name'], autonomy: 'balanced' },
    task: { key: 'qa', title: 'QA', objective: 'test', executionPolicy: { isolation: 'none' }, inputArtifacts: [] },
    outputContract: { artifacts: [], workingDirectory: '/w' },
  };
  const withLedger = compiler.compile({ ...base, criteria: [{ key: 'U1', statement: 'Greets by name', covers: [] }, { key: 'AC1', statement: 'Shows Hello, Ana', covers: ['U1'] }] }).prompt;
  check('the ledger replaces plain bullets, with ids and what each covers',
    withLedger.includes('Done when (criteria ledger; cite these ids):') && withLedger.includes('- U1: Greets by name') && withLedger.includes('- AC1: Shows Hello, Ana (covers U1)') && !withLedger.includes('Success criteria:'));
  const without = compiler.compile(base).prompt;
  check('without a ledger the success criteria stay as they were', without.includes('Success criteria:') && !without.includes('Done when'));
}

section('presets read the ledger');
{
  const app = await import('@tandemise/application');
  const fd = app.findPreset('feature-delivery').build({ hasTestCommand: true });
  const gate = (plan, key) => plan.tasks.find((t) => t.key === key)?.completionGate;
  check('product_spec: spec exists, every line covered, no unknown ids, at least one criterion',
    gate(fd, 'product_spec') === 'artifact.ProductSpec.exists && criteria.uncovered_user == 0 && criteria.unknown_covers == 0 && criteria.total >= 1', gate(fd, 'product_spec'));
  check('qa: no failed criterion', gate(fd, 'qa') === 'artifact.QAReport.exists && review.blocking_findings == 0 && qa.criteria_failed == 0', gate(fd, 'qa'));
  check('release_candidate: none left unverified', gate(fd, 'release_candidate') === 'qa.criteria_unverified == 0 && qa.blocking_defects == 0', gate(fd, 'release_candidate'));
  check('implement keeps the Slice 0 tests clause', gate(fd, 'implement').endsWith('checks.tests == PASS'));
  const bug = app.findPreset('bug-investigation').build({ hasTestCommand: false });
  check('bug-investigation gates its spec and its verification the same way', gate(bug, 'investigate') === app.SPEC_CRITERIA_GATE && gate(bug, 'verify') === app.QA_CRITERIA_GATE);
}

// ---------------------------------------------------------------- the engine
/** A real engine over a real SQLite file, composed as the daemon composes it (from rounds-check). */
async function engineHarness(HOME) {
  const { mkdirSync } = await import('node:fs');
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
  const app = await import('@tandemise/application');
  const paths = createPaths(HOME);
  mkdirSync(paths.root, { recursive: true });
  const log = createLogger({ level: 'error', base: { component: 'p5-check' } });
  const container = new Container();
  compose(container, persistenceTokens.persistenceModule({ path: paths.db, logger: log }), A.createArtifactsModule({ paths }),
    policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
    executionCoreModule, executionLocalModule, integrationsCoreModule, app.createApplicationModule({ localPersonName: 'Demo' }));
  container.bind(EXEC_CLOCK, () => systemClock, { source: 'check' });
  container.bind(EXEC_LOGGER, () => log, { source: 'check' });
  container.bind(EXEC_PATHS, () => paths, { source: 'check' });
  container.bind(INT_CLOCK, () => systemClock, { source: 'check' });
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
  const invalidated = [];
  container.bind(app.PROJECTION_BUS, () => ({ invalidate: (topic, scope) => invalidated.push([topic, scope?.missionId]), subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.SECRET_STORE, () => ({ backend: 'memory', store: async () => 'x', resolve: async () => undefined, remove: async () => {}, list: async () => [] }), { source: 'check' });
  container.bind(app.SETTINGS_STORE, () => app.createMemorySettingsStore(), { source: 'check' });
  container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home: HOME, schemaVersion: 1 }), { source: 'check' });
  container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });
  return {
    app, container, services: app.createServices(container), invalidated,
    db: container.resolve(persistenceTokens.DATABASE),
    tasks: container.resolve(app.TASK_REPOSITORY),
    missions: container.resolve(app.MISSION_REPOSITORY),
    criteria: container.resolve(app.MISSION_CRITERIA_REPOSITORY),
    harvester: container.resolve(app.ARTIFACT_HARVESTER),
    gates: container.resolve(app.GATE_SERVICE),
    persistence: persistenceTokens,
  };
}

/** A working directory the harvester can read: the files a worker left in `.tandemise/out/<task>/`. */
function scriptedTarget(files) {
  return {
    kind: 'local', workingDirectory: '/scripted',
    filesystem: () => ({
      exists: async (p) => p === '.tandemise/out' || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
      list: async (p) => Object.keys(files).filter((f) => f.startsWith(`${p}/`) && !f.slice(p.length + 1).includes('/')).map((f) => ({ kind: 'file', name: f.slice(p.length + 1) })),
      read: async (p) => { if (!(p in files)) throw new Error(`no ${p}`); return files[p]; },
    }),
    exec: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
  };
}

const specDoc = (criteria) => ['---', 'type: ProductSpec', 'title: Hello spec', 'handoff:', '  headline: The hello page spec', 'acceptanceCriteria:',
  ...criteria.flatMap((c) => [`  - id: ${c.id}`, `    statement: ${c.statement ?? `${c.id} holds`}`, `    covers: [${(c.covers ?? []).join(', ')}]`]), '---', '', '# Hello'].join('\n');
const qaDoc = (results) => ['---', 'type: QAReport', 'title: Hello QA', 'handoff:', '  headline: QA ran', 'results:',
  ...results.flatMap((r) => [`  - ${r.legacy ? 'criterion' : 'criterionId'}: ${r.id}`, `    outcome: ${r.outcome}`, `    evidence: ${r.evidence ?? 'observed'}`]), 'blockingDefects: 0', '---', '', '# QA'].join('\n');

const HOME = mkdtempSync(join(tmpdir(), 'tdm-p5-'));
const keepAlive = setInterval(() => {}, 1000);
try {
  const h = await engineHarness(HOME);
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Ledger' })).workspace.id;

  section('migration 011');
  {
    const cols = h.db.handle.prepare("SELECT name FROM pragma_table_info('mission_criteria')").all().map((r) => r.name);
    check('mission_criteria has the ledger columns', eq(cols, ['id', 'mission_id', 'key', 'statement', 'source', 'covers', 'spec_artifact_id', 'position', 'superseded_at', 'created_at']), cols);
    check('schema version is 11', h.persistence.SCHEMA_VERSION === 11);
    const idx = h.db.handle.prepare("SELECT sql FROM sqlite_master WHERE name = 'ux_mission_criteria_live_key'").get();
    check('keys are unique among live rows only (partial index)', /WHERE superseded_at IS NULL/.test(idx?.sql ?? ''), idx);
  }

  const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'A hello page', title: 'Hello', successCriteria: ['Greets the visitor by name', '  ', 'Works offline'] });
  h.missions.update(mission.id, { status: 'EXECUTING' });
  const addTask = (key, roleId, expectedOutputs, completionGate) => h.tasks.add({
    id: `tsk_${key}_${Date.now().toString(36)}`, missionId: mission.id, key, title: key, objective: 'o', roleId, dependsOn: [], requiredCapabilities: [],
    inputArtifacts: [], expectedOutputs, executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
    approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' },
    completionGate, status: 'RUNNING', statusReason: null, attempts: 1, remediatesTaskId: null, repositoryId: null, executor: 'agent',
    waitPolicy: null, orderHint: 0, staffingOverride: null, round: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null,
  });
  const harvest = (task, type, body) => h.harvester.harvest({
    mission: h.missions.get(mission.id), task, target: scriptedTarget({ [`.tandemise/out/${task.id}/${type}.md`]: body }), runId: null, roleId: task.roleId,
    scope: { workspaceId: ws, missionId: mission.id, taskId: task.id, roleId: task.roleId }, sourceRefs: [],
  });
  const tick = () => new Promise((r) => setTimeout(r, 15));

  section('mission creation numbers the Done-when lines');
  {
    const live = h.criteria.listActive(mission.id);
    check('two non-blank lines become U1 and U2, in order', eq(live.map((c) => [c.key, c.statement, c.source]), [['U1', 'Greets the visitor by name', 'user'], ['U2', 'Works offline', 'user']]), live);
    const view = h.services.criteria.list(mission.id);
    check('the view lists them unverified and counted, not yet "not covered"', view.length === 2 && view.every((v) => v.result === 'UNVERIFIED' && v.counted && !v.uncovered && v.qaArtifactId === null), view);
  }

  const app = h.app;
  const spec = addTask('product_spec', 'product', ['ProductSpec'], app.SPEC_CRITERIA_GATE);
  const qa = addTask('qa', 'qa', ['QAReport'], app.QA_CRITERIA_GATE);
  const release = addTask('release_candidate', 'release', ['ReleaseCandidate'], app.RELEASE_CRITERIA_GATE);

  section('harvest: a spec the ledger cannot hold is refused');
  {
    const dup = await harvest(spec, 'ProductSpec', specDoc([{ id: 'AC1', covers: ['U1', 'U2'] }, { id: 'AC1', covers: [] }]));
    check('two criteria with one id: refused, not stored', dup.manifests.length === 0 && dup.issues.some((i) => /AC1 is used by more than one/.test(i)), dup.issues);
    const taken = await harvest(spec, 'ProductSpec', specDoc([{ id: 'U1', covers: ['U1', 'U2'] }]));
    check('a spec criterion named U1: refused', taken.manifests.length === 0 && taken.issues.some((i) => /U1 is reserved/.test(i)), taken.issues);
    check('nothing reached the ledger', h.criteria.listActive(mission.id).every((c) => c.source === 'user'));
  }

  section('harvest: a spec that misses U2 is stored and the gate names it');
  let firstSpec;
  {
    const r = await harvest(spec, 'ProductSpec', specDoc([{ id: 'AC1', statement: 'The page shows Hello, <name>', covers: ['U1'] }]));
    firstSpec = r.manifests[0];
    check('stored', r.manifests.length === 1, r.issues);
    check('the retry is told U2 is uncovered, with its words', r.issues.some((i) => i.includes('leaves U2 uncovered') && i.includes('Works offline')), r.issues);
    check('the ledger holds AC1 covering U1, tied to the spec', eq(h.criteria.listActive(mission.id).filter((c) => c.source === 'spec').map((c) => [c.key, c.covers, c.specArtifactId]), [['AC1', ['U1'], firstSpec.id]]));
    check('the criteria topic was invalidated', h.invalidated.some(([t, m]) => t === 'criteria' && m === mission.id));
    const gate = h.gates.evaluate(h.tasks.get(spec.id));
    check('the spec gate fails on criteria.uncovered_user', !gate.passed && gate.detail.includes('criteria.uncovered_user is 1, needs 0'), gate.detail);
    const view = h.services.criteria.list(mission.id);
    const u2 = view.find((v) => v.key === 'U2');
    check('U2 reads "not covered" and still counts', u2.uncovered && u2.counted && u2.result === 'UNVERIFIED', u2);
    check('U1 is covered by AC1 and no longer counted itself', eq(view.find((v) => v.key === 'U1').coveredBy, ['AC1']) && !view.find((v) => v.key === 'U1').counted);
  }

  section('harvest: an unknown covers id is stored and fails the gate by name');
  {
    await tick();
    const r = await harvest(spec, 'ProductSpec', specDoc([{ id: 'AC1', covers: ['U1', 'U2', 'U9'] }]));
    check('stored, and the retry names AC1 → U9', r.manifests.length === 1 && r.issues.some((i) => i.includes('AC1 → U9') && i.includes('U1, U2')), r.issues);
    const gate = h.gates.evaluate(h.tasks.get(spec.id));
    check('the gate fails on criteria.unknown_covers', !gate.passed && gate.detail.includes('criteria.unknown_covers is 1, needs 0'), gate.detail);
  }

  section('harvest: a newer spec supersedes the old criteria');
  let liveSpec;
  {
    await tick();
    const r = await harvest(spec, 'ProductSpec', specDoc([{ id: 'AC1', covers: ['U1', 'U2'] }, { id: 'AC2', covers: ['U2'] }]));
    liveSpec = r.manifests[0];
    check('stored with no issues', r.manifests.length === 1 && r.issues.length === 0, r.issues);
    const all = h.criteria.listAll(mission.id).filter((c) => c.source === 'spec');
    check('the earlier AC1 rows are superseded, the new AC1 and AC2 live', all.filter((c) => c.supersededAt !== null).length === 2 && eq(h.criteria.listActive(mission.id).filter((c) => c.source === 'spec').map((c) => c.key), ['AC1', 'AC2']), all.map((c) => [c.key, c.supersededAt]));
    const gate = h.gates.evaluate(h.tasks.get(spec.id));
    check('the spec gate passes', gate.passed, gate.detail);
    const release0 = h.gates.evaluate(h.tasks.get(release.id));
    check('before QA the release reads 2 unverified (measured, not missing)', !release0.passed && release0.detail.includes('qa.criteria_unverified is 2, needs 0'), release0.detail);
    check('a duplicate live key is refused by the database itself', (() => { try { h.db.handle.prepare("INSERT INTO mission_criteria (id, mission_id, key, statement, source, created_at) VALUES ('crt_x', ?, 'AC1', 's', 'spec', 'now')").run(mission.id); return false; } catch { return true; } })());
  }

  section('harvest: QA must name ledger ids');
  {
    const r = await harvest(qa, 'QAReport', qaDoc([{ id: 'AC1', outcome: 'PASS' }, { id: 'AC9', outcome: 'PASS' }]));
    check('a result naming AC9 is refused, not stored', r.manifests.length === 0, r.manifests);
    check('the retry lists the unknown id and every valid one', r.issues.some((i) => i.includes('AC9') && i.includes('U1, U2, AC1, AC2')), r.issues);
    const gate = h.gates.evaluate(h.tasks.get(qa.id));
    check('so artifact.QAReport.exists is still false', !gate.passed && gate.detail.includes('artifact.QAReport.exists'), gate.detail);
  }

  section('QA: partial, legacy field, failed, and the coverage fix');
  {
    await tick();
    const partial = await harvest(qa, 'QAReport', qaDoc([{ id: 'AC1', outcome: 'PASS', legacy: true }, { id: 'AC2', outcome: 'SKIP' }]));
    check('the legacy criterion field is accepted when it is a ledger id', partial.manifests.length === 1, partial.issues);
    const facts = h.gates.factsFor(h.tasks.get(release.id));
    check('1 verified, 1 unverified, 0 failed', facts['qa.criteria_verified'] === 1 && facts['qa.criteria_unverified'] === 1 && facts['qa.criteria_failed'] === 0, facts);
    check('coverage is measured against the ledger: 50', facts['qa.acceptance_criteria_coverage'] === 50, facts['qa.acceptance_criteria_coverage']);
    const rel = h.gates.evaluate(h.tasks.get(release.id));
    check('the release gate names what is left', !rel.passed && rel.detail.includes('qa.criteria_unverified is 1, needs 0'), rel.detail);
    // No review ran in this fixture, so review.blocking_findings is unmeasured: only the criteria clause is at issue here.
    const qaPartial = h.gates.evaluate(h.tasks.get(qa.id));
    check('a SKIP is not a failure: the QA gate does not name qa.criteria_failed', qaPartial.facts['qa.criteria_failed'] === 0 && !qaPartial.detail.includes('qa.criteria_failed'), qaPartial.detail);

    await tick();
    await harvest(qa, 'QAReport', qaDoc([{ id: 'AC1', outcome: 'PASS' }, { id: 'AC2', outcome: 'FAIL', evidence: 'Offline shows a blank page' }]));
    const qaGate = h.gates.evaluate(h.tasks.get(qa.id));
    check('a failed criterion fails the QA gate', !qaGate.passed && qaGate.detail.includes('qa.criteria_failed is 1, needs 0'), qaGate.detail);
    const view = h.services.criteria.list(mission.id);
    const ac2 = view.find((v) => v.key === 'AC2');
    check('AC2 reads FAIL with QA\'s evidence and opens the QA report', ac2.result === 'FAIL' && ac2.evidence === 'Offline shows a blank page' && typeof ac2.qaArtifactId === 'string', ac2);

    await tick();
    await harvest(qa, 'QAReport', qaDoc([{ id: 'AC1', outcome: 'PASS' }, { id: 'AC2', outcome: 'PASS' }]));
    check('all verified: the release gate passes', h.gates.evaluate(h.tasks.get(release.id)).passed, h.gates.evaluate(h.tasks.get(release.id)).detail);
    const all = h.services.criteria.list(mission.id);
    check('every row reads PASS and U rows say what verified them', all.every((v) => v.result === 'PASS') && all.find((v) => v.key === 'U2').evidence === 'Through AC1, AC2', all.map((v) => [v.key, v.result, v.evidence]));
    check('"N of M verified" counts the spec criteria: 2 of 2', all.filter((v) => v.counted).length === 2 && all.filter((v) => v.counted && v.result === 'PASS').length === 2);
  }

  section('a spec rewritten after QA is unverified again');
  {
    await tick();
    await harvest(spec, 'ProductSpec', specDoc([{ id: 'AC1', covers: ['U1', 'U2'] }, { id: 'AC2', covers: ['U2'] }, { id: 'AC3', covers: ['U1'] }]));
    const view = h.services.criteria.list(mission.id);
    check('AC1, AC2 and the new AC3 all read UNVERIFIED', ['AC1', 'AC2', 'AC3'].every((k) => view.find((v) => v.key === k)?.result === 'UNVERIFIED'), view.map((v) => [v.key, v.result]));
    check('the release gate is shut again', !h.gates.evaluate(h.tasks.get(release.id)).passed);
  }

  section('a mission without a ledger behaves as before');
  {
    const plain = await h.services.missions.create(caller, { workspaceId: ws, goal: 'No criteria', title: 'Plain' });
    h.missions.update(plain.id, { status: 'EXECUTING' });
    check('no Done-when lines: an empty ledger', h.criteria.listActive(plain.id).length === 0 && h.services.criteria.list(plain.id).length === 0);
    const t = h.tasks.add({ ...h.tasks.get(qa.id), id: `tsk_legacy_${Date.now().toString(36)}`, missionId: plain.id, completionGate: 'artifact.QAReport.exists' });
    const r = await h.harvester.harvest({
      mission: h.missions.get(plain.id), task: t, target: scriptedTarget({ [`.tandemise/out/${t.id}/QAReport.md`]: qaDoc([{ id: 'Login works', outcome: 'PASS', legacy: true }]) }),
      runId: null, roleId: 'qa', scope: { workspaceId: ws, missionId: plain.id, taskId: t.id, roleId: 'qa' }, sourceRefs: [],
    });
    check('a free-text criterion is accepted', r.manifests.length === 1 && r.issues.length === 0, r.issues);
    const facts = h.gates.factsFor(t);
    check('legacy coverage from QA\'s own results, and no qa.criteria_* facts', facts['qa.acceptance_criteria_coverage'] === 100 && !('qa.criteria_unverified' in facts) && facts['criteria.total'] === 0, facts);
  }
} finally {
  clearInterval(keepAlive);
  rmSync(HOME, { recursive: true, force: true });
}

console.log(`\n${failures.length === 0 ? `DONE-WHEN LEDGER TRACES (${passed} checks)` : `${failures.length} FAILED of ${passed + failures.length}`}`);
process.exit(failures.length === 0 ? 0 : 1);
