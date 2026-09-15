// P2 feedback and rounds. Pure rules and persistence first; later tasks append
// impact, service, http, engine and review sections.
//
//   npm run build && node scratch/rounds-check.mjs
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const code = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return e.code ?? String(e); } };

section('pure: feedback entity');
{
  const D = await import('@tandemise/domain');
  const { ids } = await import('@tandemise/shared');
  const a = ids.feedback(); const b = ids.feedback();
  check('feedback ids are fb_ plus 20 characters', /^fb_[0-9a-z]{20}$/.test(a), a);
  check('statuses are exactly the spec list', eq(D.FEEDBACK_STATUSES, ['open', 'queued', 'in_round', 'addressed', 'dismissed']));
  check('run purposes are exactly the spec list', eq(D.RUN_PURPOSES, ['round', 'tighten', 'feedback', 'retry']));
  const handoff = { changed: [{ what: 'Shorter intro', feedback: `${a}, ${b}` }, { what: 'Declined: out of scope', feedback: a }, { what: 'Tidied', feedback: null }] };
  check('citedFeedbackIds reads several ids per entry, once each', eq(D.citedFeedbackIds(handoff), [a, b]));
  check('citedFeedbackIds of null is empty', eq(D.citedFeedbackIds(null), []));
  check('isDeclinedChange is case-insensitive on the prefix', D.isDeclinedChange('  declined: nope') && !D.isDeclinedChange('Not declined'));
  check('request_changes is not affirmative', !D.isAffirmative('action', D.REQUEST_CHANGES_OPTION));
  for (const type of ['feedback.given', 'feedback.addressed', 'feedback.dismissed', 'task.round_started']) {
    check(`${type} is on the semantic timeline`, D.SEMANTIC_EVENT_TYPES.has(type));
  }
}

section('persistence: migration 010');
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const P = await import('@tandemise/persistence');
  const { systemClock } = await import('@tandemise/shared');
  const dir = mkdtempSync(join(tmpdir(), 'tandemise-rounds-'));
  const db = P.openDatabase({ path: join(dir, 't.db') });
  P.migrate(db, undefined, P.MIGRATIONS.filter((m) => m.version <= 9));
  const h = db.handle;
  const now = '2026-09-14T00:00:00.000Z';
  h.pragma('foreign_keys = OFF');
  h.prepare(`INSERT INTO workspaces (id,name,default_repository_id,autonomy,concurrency,routing,default_autonomy_level,knowledge,created_at,updated_at)
             VALUES ('ws_r','R',NULL,'{}','{}','{}','supervised','{}',?,?)`).run(now, now);
  h.prepare(`INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,created_at,updated_at)
             VALUES ('m_r','ws_r','T','G','[]','[]','EXECUTING','balanced','standard',?,?)`).run(now, now);
  h.prepare(`INSERT INTO mission_tasks (id,mission_id,key,title,objective,role_id,required_capabilities,input_artifacts,expected_outputs,execution_policy,approval_policy,retry_policy,status,created_at,updated_at)
             VALUES ('t_r','m_r','design','T','O','design','[]','[]','["DesignBrief"]','{}','{}','{}','SUCCEEDED',?,?)`).run(now, now);
  h.prepare(`INSERT INTO runs (id,mission_id,task_id,assignment_id,attempt,status,role_id,runtime_profile_id,execution_target_id,started_at)
             VALUES ('r_old','m_r','t_r','wa',1,'SUCCEEDED','design','rt','tg',?)`).run(now);
  h.prepare(`INSERT INTO artifacts (id,workspace_id,mission_id,task_id,created_by_run_id,type,title,content_ref,media_type,sha256,byte_size,schema_version,created_at)
             VALUES ('ar_r','ws_r','m_r','t_r','r_old','DesignBrief','Brief','c','text/markdown','x',1,1,?)`).run(now);
  // Kept off through the round round-trip below: `r_old`'s assignment_id is a
  // fixture id with no worker_assignments row, and SQLite re-validates every
  // foreign key column a full-row UPDATE writes, changed or not, so turning
  // enforcement back on before those updates would fail them for a reason
  // that has nothing to do with what this section tests (same convention as
  // staffing-check.mjs).

  const result = P.migrate(db);
  check('a version 9 database migrates to 10', eq(result.applied, [10]) && P.schemaVersion(db) === 10, result);
  const tasks = new P.SqliteTaskRepository(db, systemClock);
  const runs = new P.SqliteRunRepository(db, systemClock);
  const artifacts = new P.SqliteArtifactRepository(db);
  check('an existing task is round 1', tasks.get('t_r')?.round === 1, tasks.get('t_r')?.round);
  check('an existing run has no round and no purpose', runs.get('r_old')?.round === null && runs.get('r_old')?.purpose === null, runs.get('r_old'));
  check('an existing artifact has no round', artifacts.get('ar_r')?.round === null);
  tasks.update('t_r', { round: 3 });
  check('a task round round-trips', tasks.get('t_r')?.round === 3);
  runs.update('r_old', { round: 2, purpose: 'feedback' });
  check('a run round and purpose round-trip', runs.get('r_old')?.round === 2 && runs.get('r_old')?.purpose === 'feedback');

  const feedback = new P.SqliteFeedbackRepository(db, systemClock);
  const item = { id: 'fb_aaaaaaaaaaaaaaaaaaaa', taskId: 't_r', artifactId: 'ar_r', authorId: 'mem_ana', recordedBy: 'mem_owner', text: 'Shorter intro', attachments: [], status: 'open', round: null, createdAt: now, updatedAt: now };
  feedback.create(item);
  check('a feedback item round-trips', eq(feedback.get(item.id), item), feedback.get(item.id));
  const moved = feedback.update(item.id, { status: 'in_round', round: 2 });
  check('update sets status and round and stamps updatedAt', moved.status === 'in_round' && moved.round === 2 && moved.updatedAt !== now, moved);
  check('listByTask, listByMission and listByStatus find it',
    feedback.listByTask('t_r').length === 1 && feedback.listByMission('m_r').length === 1 && feedback.listByStatus(['in_round']).length === 1 && feedback.listByStatus(['open']).length === 0);
  check('text over 4000 characters is refused by the schema', await code(() => feedback.create({ ...item, id: 'fb_bbbbbbbbbbbbbbbbbbbb', text: 'x'.repeat(4001) })) !== 'ok');
  check('empty text is refused by the schema', await code(() => feedback.create({ ...item, id: 'fb_cccccccccccccccccccc', text: '' })) !== 'ok');
  check('an unknown status is refused by the schema', await code(() => feedback.create({ ...item, id: 'fb_dddddddddddddddddddd', status: 'done' })) !== 'ok');
  check('an unknown run purpose is refused by the schema', await code(() => runs.update('r_old', { purpose: 'rewrite' })) !== 'ok');
  // Back on for the rest of the section: run_inputs' own foreign keys are all
  // satisfied, and the cascade check below depends on enforcement being on.
  h.pragma('foreign_keys = ON');

  const inputs = new P.SqliteRunInputRepository(db);
  inputs.record('r_old', ['ar_r']);
  inputs.record('r_old', ['ar_r']);
  check('run_inputs record is idempotent', eq(inputs.listByRun('r_old'), ['ar_r']));
  check('run_inputs listByMission joins through runs', eq(inputs.listByMission('m_r'), [{ runId: 'r_old', artifactId: 'ar_r' }]));

  h.prepare("DELETE FROM missions WHERE id = 'm_r'").run();
  check('removing the mission removes its feedback and run inputs',
    h.prepare('SELECT count(*) AS n FROM feedback').get().n === 0 && h.prepare('SELECT count(*) AS n FROM run_inputs').get().n === 0);
  check('integrity_check returns ok', h.pragma('integrity_check', { simple: true }) === 'ok');
  db.close();
}

/**
 * A real engine over a real SQLite file with the fake runtime, composed as the
 * daemon composes it. Modelled on staffing-check's harness.
 */
async function engineHarness(HOME, component) {
  const { mkdirSync } = await import('node:fs');
  const { Container, compose } = await import('@tandemise/kernel');
  const { createLogger, createPaths, systemClock } = await import('@tandemise/shared');
  const persistenceTokens = await import('@tandemise/persistence');
  const { persistenceModule } = persistenceTokens;
  const A = await import('@tandemise/artifacts');
  const { policyModule } = await import('@tandemise/policy');
  const { contextModule } = await import('@tandemise/context');
  const { createEvaluationModule } = await import('@tandemise/evaluation');
  const { runtimesCoreModule } = await import('@tandemise/runtimes-core');
  const { genericRuntimeModule } = await import('@tandemise/runtime-generic');
  const { executionCoreModule, CLOCK: EXEC_CLOCK, LOGGER: EXEC_LOGGER, PATHS: EXEC_PATHS } = await import('@tandemise/execution-core');
  const { executionLocalModule } = await import('@tandemise/execution-local');
  const {
    integrationsCoreModule, CLOCK: INT_CLOCK, LOGGER: INT_LOGGER, COMMAND_EXECUTOR, BACKGROUND_PROCESS_LAUNCHER,
  } = await import('@tandemise/integrations-core');
  const app = await import('@tandemise/application');

  const paths = createPaths(HOME);
  mkdirSync(paths.root, { recursive: true });
  const log = createLogger({ level: 'error', base: { component } });
  const container = new Container();
  compose(
    container,
    persistenceModule({ path: paths.db, logger: log }),
    A.createArtifactsModule({ paths }),
    policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
    executionCoreModule, executionLocalModule, integrationsCoreModule, app.createApplicationModule({ localPersonName: 'Demo' }),
  );
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
  container.bind(app.PROJECTION_BUS, () => ({ invalidate: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.SECRET_STORE, () => ({ backend: 'memory', store: async () => 'x', resolve: async () => undefined, remove: async () => {}, list: async () => [] }), { source: 'check' });
  container.bind(app.SETTINGS_STORE, () => app.createMemorySettingsStore(), { source: 'check' });
  container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home: HOME, schemaVersion: 1 }), { source: 'check' });
  container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });

  const services = app.createServices(container);
  const scheduler = container.resolve(app.SCHEDULER);
  const repo = {
    tasks: container.resolve(app.TASK_REPOSITORY),
    missions: container.resolve(app.MISSION_REPOSITORY),
    runs: container.resolve(app.RUN_REPOSITORY),
    events: container.resolve(app.EVENT_REPOSITORY),
    artifacts: container.resolve(app.ARTIFACT_REPOSITORY),
    profiles: container.resolve(app.RUNTIME_PROFILE_REPOSITORY),
    approvals: container.resolve(app.APPROVAL_REPOSITORY),
    store: container.resolve(app.ARTIFACT_STORE),
    feedback: container.resolve(app.FEEDBACK_REPOSITORY),
    runInputs: container.resolve(app.RUN_INPUT_REPOSITORY),
    evaluations: container.resolve(app.EVALUATION_REPOSITORY),
  };
  const recorder = container.resolve(app.EVENT_RECORDER);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000, every = 40) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await scheduler.tick();
      const v = fn();
      if (v) return v;
      await sleep(every);
    }
    return fn();
  };
  const rounds = container.resolve(app.FEEDBACK_ROUNDS);
  const db = container.resolve(persistenceTokens.DATABASE);
  return { app, container, services, scheduler, repo, recorder, paths, until, rounds, db };
}

/** Seed rows the engine would have written; ids and times are explicit so assertions can name them. */
function fixtures(h, ws, missionId) {
  const at = (m) => `2026-09-14T10:${String(m).padStart(2, '0')}:00.000Z`;
  const addTask = (key, status, extra = {}) => h.repo.tasks.add({
    id: extra.id ?? `tsk_${key}`, missionId, key, title: extra.title ?? key, objective: 'o', roleId: extra.roleId ?? 'design',
    dependsOn: extra.dependsOn ?? [], requiredCapabilities: [], inputArtifacts: extra.inputArtifacts ?? [], expectedOutputs: extra.expectedOutputs ?? ['DesignBrief'],
    executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
    approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' },
    completionGate: null, status, statusReason: null, attempts: extra.attempts ?? 1, remediatesTaskId: null, repositoryId: null,
    executor: extra.executor ?? 'agent', waitPolicy: null, orderHint: 0, staffingOverride: null, round: extra.round ?? 1,
    createdAt: at(0), updatedAt: at(1), startedAt: extra.startedAt === undefined ? at(1) : extra.startedAt, finishedAt: null,
  });
  const addArtifact = (task, type, extra = {}) => h.repo.artifacts.create({
    id: extra.id ?? `art_${task.key}_${extra.round ?? 1}`, workspaceId: ws, missionId, taskId: task.id, createdByRunId: null, type,
    title: extra.title ?? `${task.key} ${type}`, contentRef: 'c', mediaType: 'text/markdown', sha256: 'x', byteSize: 1, schemaVersion: 1,
    sourceRefs: [], supersedes: extra.supersedes ?? null, summary: null, createdAt: extra.createdAt ?? at(5),
    handoff: { headline: `${task.key} v${extra.round ?? 1}`, points: [], needs: null, changed: extra.changed ?? [], links: [] },
    wordCount: 10, overBudget: false, round: extra.round ?? 1,
  });
  const addRun = (task, extra = {}) => h.repo.runs.create({
    id: extra.id ?? `run_${task.key}_${extra.attempt ?? 1}`, missionId, taskId: task.id, assignmentId: 'wa_x', attempt: extra.attempt ?? 1,
    status: extra.status ?? 'SUCCEEDED', roleId: task.roleId, runtimeProfileId: 'rt_x', executionTargetId: 'tg_x', externalSessionId: null,
    pid: null, exitCode: 0, errorCode: null, errorMessage: null, usage: null, startedAt: extra.startedAt ?? at(20), finishedAt: null,
    heartbeatAt: null, agentMemberId: null, round: 'round' in extra ? extra.round : 1, purpose: 'round' in extra && extra.round === null ? null : 'round',
  });
  const addCard = (task, extra = {}) => h.repo.approvals.create({
    id: extra.id ?? `apr_${task.key}`, workspaceId: ws, missionId, taskId: task.id, runId: null, kind: extra.kind ?? 'action', status: 'PENDING', risk: 'read',
    title: `Approve the output of ${task.key}?`, rationale: 'r', effect: 'e', evidence: [{ kind: 'text', label: 'Review', value: '1/1' }],
    options: [{ id: 'approve', label: 'Approve' }, { id: 'request_changes', label: 'Request changes' }, { id: 'reject', label: 'Reject without changes' }],
    recommendedOptionId: 'approve', selectedOptionId: null, decidedBy: null, decisionNote: null, createdAt: at(30), decidedAt: null, expiresAt: null,
    addressees: [], escalationLevel: 0, escalateAt: null, recordedBy: 'system',
  });
  return { at, addTask, addArtifact, addRun, addCard };
}

section('impact: consumers and round start');
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const keepAlive = setInterval(() => {}, 1000);
  const HOME = mkdtempSync(join(tmpdir(), 'tri-'));
  const h = await engineHarness(HOME, 'rounds-impact-check');
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Impact' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Greet visitors', title: 'Impact' });
  h.repo.missions.update(mission.id, { status: 'EXECUTING' });
  const f = fixtures(h, ws, mission.id);
  const task = (id) => h.repo.tasks.get(id);
  h.db.handle.pragma('foreign_keys = OFF');   // runs point at assignments and targets this fixture does not create

  const design = f.addTask('design', 'SUCCEEDED');
  const dV1 = f.addArtifact(design, 'DesignBrief', { createdAt: f.at(5) });
  const build = f.addTask('build', 'SUCCEEDED', { dependsOn: ['design'], roleId: 'development', expectedOutputs: ['ChangeSet'], inputArtifacts: [{ type: 'DesignBrief', required: true }] });
  const rBuild = f.addRun(build);
  h.repo.runInputs.record(rBuild.id, [dV1.id]);
  const change = f.addArtifact(build, 'ChangeSet', { createdAt: f.at(25) });
  const review = f.addTask('review', 'RUNNING', { dependsOn: ['build'], roleId: 'review', expectedOutputs: ['ReviewReport'] });
  const rReview = f.addRun(review, { status: 'RUNNING', startedAt: f.at(26) });
  h.repo.runInputs.record(rReview.id, [change.id]);
  const docs = f.addTask('docs', 'SUCCEEDED', { dependsOn: ['design'], roleId: 'product', expectedOutputs: ['ProductSpec'], inputArtifacts: [{ type: 'DesignBrief', required: true }] });
  f.addRun(docs, { round: null, startedAt: f.at(21) });           // a run from before migration 010
  const later = f.addTask('later', 'READY', { dependsOn: ['design'], startedAt: null });
  // READY again after an earlier attempt (a retry backing off): it has no run on record, so it is no consumer either.
  const retrying = f.addTask('retrying', 'READY', { dependsOn: ['design'] });
  const sibling = f.addTask('sibling', 'SUCCEEDED');
  f.addRun(sibling);
  f.addCard(build);

  const impact = h.rounds.impactOf(task(design.id));
  const byKey = Object.fromEntries(impact.consumers.map((c) => [c.task.key, c]));
  check('build consumed design, from its recorded inputs', byKey.build?.via === 'record' && byKey.build.used.id === dV1.id, impact.consumers.map((c) => [c.task.key, c.via]));
  check('review consumed build, so it is a transitive consumer of design', byKey.review?.via === 'record');
  check('a pre-010 run is inferred from its input types and start time', byKey.docs?.via === 'inferred');
  check('a task that has not run and an unrelated task are not consumers', byKey.later === undefined && byKey.sibling === undefined);
  check('the default is redo because review is still running', impact.defaultChoice === 'redo');
  check('the used version is numbered along the chain', impact.usedVersion.get(build.id) === 1);

  const cancelled = [];
  const cancelOriginal = h.scheduler.cancelTask.bind(h.scheduler);
  h.scheduler.cancelTask = (id) => { cancelled.push(id); cancelOriginal(id); };

  // Keep: dependents stay; a READY task that never ran is held back.
  const k = h.rounds.record({ task: task(design.id), text: 'Shorter intro', artifactId: null, authorId: owner, recordedBy: owner, status: 'open', round: null });
  check('record writes an open item and a feedback.given event', h.repo.feedback.get(k.id)?.status === 'open'
    && h.repo.events.listByMission(mission.id).some((e) => e.body.type === 'feedback.given' && e.body.feedbackId === k.id));
  h.rounds.startRound({ task: task(design.id), feedbackIds: [k.id], downstream: 'keep', actorId: owner });
  check('keep: design is READY as round 2', task(design.id).status === 'READY' && task(design.id).round === 2 && task(design.id).retryFeedback === null, task(design.id));
  check('keep: the item is in round 2', h.repo.feedback.get(k.id).status === 'in_round' && h.repo.feedback.get(k.id).round === 2);
  check('keep: build and review are untouched', task(build.id).status === 'SUCCEEDED' && task(review.id).status === 'RUNNING' && cancelled.length === 0);
  check('keep: a dependent that never ran waits again', task(later.id).status === 'PENDING', task(later.id).status);
  check('keep: a READY dependent that started before is held back too', task(retrying.id).status === 'PENDING', task(retrying.id).status);
  check('keep: the round budget is extended past the attempts spent', task(design.id).retryPolicy.maxAttempts === task(design.id).attempts + 2);
  const started = h.repo.events.listByMission(mission.id).filter((e) => e.body.type === 'task.round_started');
  check('task.round_started names the round, the items and the choice', started.length === 1 && started[0].body.round === 2 && eq(started[0].body.feedbackIds, [k.id]) && started[0].body.downstream === 'keep', started.map((e) => e.body));

  // Redo: running dependents are cancelled, finished ones reset, their cards withdrawn.
  h.repo.tasks.update(design.id, { status: 'SUCCEEDED' });
  const r = h.rounds.record({ task: task(design.id), text: 'Bigger buttons', artifactId: null, authorId: owner, recordedBy: owner, status: 'open', round: null });
  check('redo with a task that did not consume is refused', await code(() => h.rounds.startRound({ task: task(design.id), feedbackIds: [r.id], downstream: 'redo', redoTaskIds: [sibling.id], actorId: owner })) === 'VALIDATION');
  check('none is refused while something consumed the output', await code(() => h.rounds.startRound({ task: task(design.id), feedbackIds: [r.id], downstream: 'none', actorId: owner })) === 'VALIDATION');

  // A failure part-way through leaves nothing half-done: the card withdrawal throws after the task rows were written.
  const updateCard = h.repo.approvals.update;
  const bus = h.container.resolve(h.app.EVENT_BUS);
  const projectionBus = h.container.resolve(h.app.PROJECTION_BUS);
  const published = [];
  const [publish, invalidate] = [bus.publish, projectionBus.invalidate];
  bus.publish = (record) => { published.push(record.body.type); };
  projectionBus.invalidate = (topic) => { published.push(`invalidate:${topic}`); };
  h.repo.approvals.update = () => { throw new Error('disk full'); };
  const failed = await code(() => h.rounds.startRound({ task: task(design.id), feedbackIds: [r.id], downstream: 'redo', actorId: owner }));
  h.repo.approvals.update = updateCard;
  bus.publish = publish;
  projectionBus.invalidate = invalidate;
  check('a rolled-back round start publishes nothing to subscribers', published.length === 0, published);
  check('deferred refuses an async function', await code(() => h.recorder.deferred(async () => {})) !== 'ok');
  check('a round start that fails part-way rolls back entirely, and cancels nothing',
    failed !== 'ok' && task(design.id).status === 'SUCCEEDED' && task(design.id).round === 2 && h.repo.feedback.get(r.id).status === 'open'
    && task(build.id).status === 'SUCCEEDED' && h.repo.approvals.get('apr_build').status === 'PENDING' && cancelled.length === 0
    && h.repo.events.listByMission(mission.id).filter((e) => e.body.type === 'task.round_started').length === 1,
    [failed, task(design.id).status, task(build.id).status, cancelled]);

  // Only review is selected; build sits between it and design, so it is redone too.
  h.rounds.startRound({ task: task(design.id), feedbackIds: [r.id], downstream: 'redo', redoTaskIds: [review.id], actorId: owner });
  check('redo of a transitive consumer also redoes the consumer between', task(build.id).status === 'PENDING', task(build.id).status);
  check('redo: build and review are PENDING with the spec reason',
    task(build.id).status === 'PENDING' && task(build.id).statusReason === 'Redone after design round 3' && task(review.id).status === 'PENDING', [task(build.id).statusReason, task(review.id).status]);
  check('redo: the running review was cancelled', eq(cancelled, [review.id]), cancelled);
  check("redo: build's review card is withdrawn", h.repo.approvals.get('apr_build').status === 'CANCELLED');
  check('redo: docs, not selected, is untouched', task(docs.id).status === 'SUCCEEDED');

  // Guards.
  const s = h.rounds.record({ task: task(sibling.id), text: 'x', artifactId: null, authorId: owner, recordedBy: owner, status: 'open', round: null });
  h.repo.tasks.update(sibling.id, { status: 'RUNNING' });
  check('a RUNNING task cannot start a round', await code(() => h.rounds.startRound({ task: task(sibling.id), feedbackIds: [s.id], downstream: 'none', actorId: owner })) === 'PRECONDITION_FAILED');
  h.repo.tasks.update(sibling.id, { status: 'SUCCEEDED' });
  check('an item that is not open on the task is refused', await code(() => h.rounds.startRound({ task: task(sibling.id), feedbackIds: [k.id], downstream: 'none', actorId: owner })) === 'VALIDATION');

  // Stranded notes.
  const q1 = h.rounds.record({ task: task(sibling.id), text: 'late note', artifactId: null, authorId: owner, recordedBy: owner, status: 'queued', round: 1 });
  h.repo.tasks.update(review.id, { status: 'RUNNING' });
  const q2 = h.rounds.record({ task: task(review.id), text: 'while running', artifactId: null, authorId: owner, recordedBy: owner, status: 'queued', round: 1 });
  check('releaseStranded moves a queued note on a settled task to open, and leaves a running one', h.rounds.releaseStranded() === 1
    && h.repo.feedback.get(q1.id).status === 'open' && h.repo.feedback.get(q1.id).round === null && h.repo.feedback.get(q2.id).status === 'queued');
  check('a released note leaves a line on the task timeline',
    h.repo.events.listByMission(mission.id).some((e) => e.taskId === sibling.id && e.body.type === 'note' && e.body.text.includes('late note')));

  h.scheduler.cancelTask = cancelOriginal;
  await h.container.dispose();
  clearInterval(keepAlive);
}

section('impact: a redo wins over a pass that is already settling');
{
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { systemClock, ids } = await import('@tandemise/shared');
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const keepAlive = setInterval(() => {}, 1000);
  const HOME = mkdtempSync(join(tmpdir(), 'trs-'));
  const h = await engineHarness(HOME, 'rounds-settle-check');
  const now = () => systemClock.now();
  const brief = ['---', 'type: DesignBrief', 'title: Build brief', 'handoff:', '  headline: Built', '  needs: Approve the palette', 'flows:', '  - onboarding', '---', '', '# Build', '', 'word '.repeat(60).trim(), ''].join('\n');
  h.repo.profiles.create({
    id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name: 'builds', executablePath: null, args: [],
    settings: { script: { steps: [{ kind: 'write-file', path: '.tandemise/out/DesignBrief.md', content: brief }, { kind: 'complete', summary: 'done' }] } },
    capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
  });
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Settle' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const executor = h.container.resolve(h.app.TASK_EXECUTOR);
  const checks = h.container.resolve(h.app.CHECK_SERVICE);
  const task = (id) => h.repo.tasks.get(id);

  let seq = 0;
  /** A finished design and a build about to run on it, whose passed round would ask for approval. */
  const setup = async () => {
    const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Greet visitors', title: `S${++seq}` });
    const dir = h.paths.mission(ws, mission.id);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
    h.repo.missions.update(mission.id, { status: 'EXECUTING' });
    const f = fixtures(h, ws, mission.id);
    const design = f.addTask(`design${seq}`, 'SUCCEEDED', { id: `tsk_design${seq}`, expectedOutputs: ['ProductSpec'] });
    const spec = f.addArtifact(design, 'ProductSpec', { id: `art_design${seq}` });
    const build = f.addTask(`build${seq}`, 'READY', {
      id: `tsk_build${seq}`, dependsOn: [design.key], inputArtifacts: [{ type: 'ProductSpec', required: true }], attempts: 0, startedAt: null,
    });
    h.repo.tasks.update(build.id, { approvalPolicy: { beforeStart: false, onCompletion: true } });
    return { mission, design, spec, build, f };
  };
  const attempt = async (build) => {
    const controller = new AbortController();
    h.scheduler.cancelTask = () => controller.abort();
    return executor.execute(build.id, controller.signal);
  };
  const redoBuild = ({ design, spec, build }) => {
    const [run] = h.repo.runs.listByTask(build.id);
    h.repo.runInputs.record(run.id, [spec.id]);
    const item = h.rounds.record({ task: task(design.id), text: 'Warmer copy', artifactId: null, authorId: owner, recordedBy: owner, status: 'open', round: null });
    h.rounds.startRound({ task: task(design.id), feedbackIds: [item.id], downstream: 'redo', actorId: owner });
  };

  // Control: left alone, the pass records its output and asks for approval.
  {
    const c = await setup();
    const outcome = await attempt(c.build);
    check('control: an undisturbed pass awaits approval with a card and an artifact',
      outcome.status === 'AWAITING_APPROVAL' && h.repo.approvals.pendingForTask(c.build.id).length === 1 && h.repo.artifacts.listByTask(c.build.id).length === 1,
      [outcome, task(c.build.id).statusReason]);
    const read = await h.services.artifacts.read(h.repo.artifacts.listByTask(c.build.id)[0].id);
    check('control: the reader shows the live output asking, and not set aside',
      read.withdrawnAt === null && read.openRequest !== null && read.manifest.handoff?.needs === 'Approve the palette', read.openRequest);
  }

  // The redo lands as the run finishes, before its output is harvested.
  {
    const c = await setup();
    const updateRun = h.repo.runs.update;
    let fired = false;
    h.repo.runs.update = function (id, patch) {
      if (!fired && patch.status === 'SUCCEEDED' && h.repo.runs.get(id)?.taskId === c.build.id) { fired = true; redoBuild(c); }
      return updateRun.call(this, id, patch);
    };
    const outcome = await attempt(c.build);
    h.repo.runs.update = updateRun;
    check('redo after the run ended: the redo trigger fired', fired);
    check('redo after the run ended: PENDING survives, and the outcome reports it',
      task(c.build.id).status === 'PENDING' && task(c.build.id).statusReason === `Redone after ${c.design.key} round 2` && outcome.status === 'PENDING',
      [outcome, task(c.build.id).status, task(c.build.id).statusReason]);
    check('redo after the run ended: no card and no artifact are recorded',
      h.repo.approvals.pendingForTask(c.build.id).length === 0 && h.repo.artifacts.listByTask(c.build.id).length === 0,
      [h.repo.approvals.pendingForTask(c.build.id).length, h.repo.artifacts.listByTask(c.build.id).length]);
  }

  // The redo lands while the checks run, after the output was harvested. The
  // build had an earlier version, which its output would replace.
  {
    const c = await setup();
    const earlier = c.f.addArtifact(c.build, 'DesignBrief', { id: `art_build${seq}_earlier` });
    const run = checks.run;
    let fired = false;
    checks.run = async function (request) {
      if (!fired && request.task.id === c.build.id) { fired = true; redoBuild(c); }
      return run.call(this, request);
    };
    const outcome = await attempt(c.build);
    checks.run = run;
    check('redo during checks: PENDING survives, and no card is raised',
      fired && task(c.build.id).status === 'PENDING' && outcome.status === 'PENDING' && h.repo.approvals.pendingForTask(c.build.id).length === 0
      && !h.repo.events.listByMission(c.mission.id).some((e) => e.body.type === 'approval.requested'),
      [fired, outcome, task(c.build.id).status]);
    const overtaken = h.repo.events.listByMission(c.mission.id).find((e) => e.body.type === 'artifact.created' && e.taskId === c.build.id);
    check('redo during checks: the pass did harvest an output', overtaken !== undefined && h.repo.artifacts.get(overtaken.body.artifactId) !== undefined);
    check("redo during checks: the overtaken output is not the build's live output; the earlier version is again",
      eq(h.repo.artifacts.listByTask(c.build.id).map((a) => a.id), [earlier.id])
      && eq(h.repo.artifacts.listByMission(c.mission.id, 'DesignBrief').map((a) => a.id), [earlier.id])
      && h.repo.artifacts.latest(c.mission.id, 'DesignBrief')?.id === earlier.id,
      [h.repo.artifacts.listByTask(c.build.id).map((a) => a.id), h.repo.artifacts.latest(c.mission.id, 'DesignBrief')?.id]);
    const read = await h.services.artifacts.read(overtaken.body.artifactId);
    check('redo during checks: the reader marks the overtaken output set aside, numbered after the version it replaced',
      typeof read.withdrawnAt === 'string' && read.manifest.version === 2 && read.manifest.supersededBy === null,
      { withdrawnAt: read.withdrawnAt, version: read.manifest.version, supersededBy: read.manifest.supersededBy });
    check('redo during checks: set-aside output asks for nothing', read.openRequest === null && read.manifest.handoff?.needs === null, read.openRequest);
    const cardView = h.app.toApprovalView({
      missions: h.repo.missions, tasks: h.repo.tasks, roles: h.container.resolve(h.app.ROLE_REPOSITORY), runs: h.repo.runs,
      members: h.container.resolve(h.app.MEMBER_REPOSITORY), artifacts: h.repo.artifacts,
    }, {
      id: 'apr_cites_withdrawn', workspaceId: ws, missionId: c.mission.id, taskId: c.build.id, runId: null, kind: 'check', status: 'PENDING', risk: 'read',
      title: 'Look at this', rationale: 'r', effect: 'e', evidence: [{ kind: 'artifact', label: 'Output', value: overtaken.body.artifactId }],
      options: [{ id: 'approve', label: 'OK' }], recommendedOptionId: 'approve', selectedOptionId: null, decidedBy: null, decisionNote: null,
      createdAt: now(), decidedAt: null, expiresAt: null, addressees: [], escalationLevel: 0, escalateAt: null, recordedBy: 'system',
    });
    check('redo during checks: a card citing set-aside output quotes the live version instead', cardView.headline === `${c.build.key} v1`, cardView.headline);
    // Back to READY once the design round passes: the feed shows its card again.
    h.repo.tasks.update(c.build.id, { status: 'READY', statusReason: 'Retrying' });
    const card = h.services.projections.missionFeed(c.mission.id, caller).inProgress.find((x) => x.taskId === c.build.id);
    check('redo during checks: the feed card shows the earlier version, not the overtaken one',
      card?.artifactId === earlier.id && card.superseded === false, card && { artifactId: card.artifactId, superseded: card.superseded });
  }

  // A sign-out reported as the run ends: the redo that landed first stands.
  {
    const c = await setup();
    // Workspace routing names this one profile, so its script is swapped for the attempt.
    const builds = h.repo.profiles.list().find((p) => p.name === 'builds');
    h.repo.profiles.update(builds.id, { settings: { script: { steps: [{ kind: 'fail', code: 'RUNTIME_SIGNED_OUT', message: 'Sign in again' }] } } });
    const updateRun = h.repo.runs.update;
    let fired = false;
    h.repo.runs.update = function (id, patch) {
      if (!fired && patch.status === 'FAILED' && h.repo.runs.get(id)?.taskId === c.build.id) { fired = true; redoBuild(c); }
      return updateRun.call(this, id, patch);
    };
    const outcome = await attempt(c.build);
    h.repo.runs.update = updateRun;
    h.repo.profiles.update(builds.id, { settings: builds.settings });
    check('signed out after a redo: PENDING survives', fired && task(c.build.id).status === 'PENDING' && outcome.status === 'PENDING',
      [fired, outcome, task(c.build.id).status, task(c.build.id).statusReason]);
  }

  // A round of the design starts while the build is still being routed: it is held, and never starts on the old version.
  {
    const c = await setup();
    const { RUNTIME_MANAGER } = await import('@tandemise/runtimes-core');
    const manager = h.container.resolve(RUNTIME_MANAGER);
    const select = manager.select;
    manager.select = async function (...args) {
      manager.select = select;
      const item = h.rounds.record({ task: task(c.design.id), text: 'Calmer colours', artifactId: null, authorId: owner, recordedBy: owner, status: 'open', round: null });
      h.rounds.startRound({ task: task(c.design.id), feedbackIds: [item.id], downstream: 'none', actorId: owner });
      return select.apply(this, args);
    };
    const outcome = await attempt(c.build);
    manager.select = select;
    check('held while routing: the build stays PENDING and no run starts',
      task(c.build.id).status === 'PENDING' && outcome.status === 'PENDING' && h.repo.runs.listByTask(c.build.id).length === 0,
      [outcome, task(c.build.id).status, h.repo.runs.listByTask(c.build.id).length]);
  }

  await h.container.dispose();
  clearInterval(keepAlive);
}

section('service: feedback by task state');
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const keepAlive = setInterval(() => {}, 1000);
  const HOME = mkdtempSync(join(tmpdir(), 'trs-'));
  const h = await engineHarness(HOME, 'rounds-service-check');
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Service' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const ana = h.services.team.addMember(caller, ws, { kind: 'person', personId: h.services.team.createPerson(caller, { displayName: 'Ana Ruiz' }).id, reportsTo: owner }).id;
  const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Greet visitors', title: 'Service' });
  h.repo.missions.update(mission.id, { status: 'EXECUTING' });
  const f = fixtures(h, ws, mission.id);
  const task = (id) => h.repo.tasks.get(id);
  const give = (t, text, extra = {}) => h.services.feedback.give(caller, t.id, { text, ...extra });
  h.db.handle.pragma('foreign_keys = OFF');

  const running = f.addTask('running', 'RUNNING');
  const g1 = give(running, 'Use the brand palette');
  check('RUNNING: the item is queued and nothing reopens', g1.feedback.status === 'queued' && g1.roundStarted === null && task(running.id).status === 'RUNNING', g1);

  const person = f.addTask('person', 'AWAITING_HUMAN', { executor: 'human' });
  const g2 = give(person, 'Mention the pricing page');
  check('AWAITING_HUMAN: the item is attached to round 1', g2.feedback.status === 'open' && g2.feedback.round === 1 && task(person.id).status === 'AWAITING_HUMAN');
  const pending = f.addTask('pending', 'PENDING', { startedAt: null, attempts: 0 });
  check('PENDING: the item is attached to round 1', give(pending, 'Keep it short').feedback.round === 1 && task(pending.id).status === 'PENDING');

  const reviewed = f.addTask('reviewed', 'AWAITING_APPROVAL');
  f.addRun(reviewed, { startedAt: f.at(20) });
  f.addCard(reviewed);
  const g3 = give(reviewed, 'Bigger touch targets', { onBehalfOf: ana });
  const card = h.repo.approvals.get('apr_reviewed');
  check('AWAITING_APPROVAL: the review card is decided Request changes with the note',
    card.status === 'REJECTED' && card.selectedOptionId === 'request_changes' && card.decisionNote === 'Bigger touch targets' && card.decidedBy === ana && card.recordedBy === owner, card);
  check('AWAITING_APPROVAL: the same task starts round 2 and no _revision_ task exists',
    g3.roundStarted === 2 && task(reviewed.id).status === 'READY' && !h.repo.tasks.listByMission(mission.id).some((t) => t.key.includes('_revision_')));
  check('onBehalfOf: authored by Ana, recorded by me', g3.feedback.author?.id === ana && g3.feedback.recordedBy?.id === owner, g3.feedback);

  const lone = f.addTask('lone', 'SUCCEEDED');
  f.addArtifact(lone, 'DesignBrief');
  const g4 = give(lone, 'Shorter intro');
  check('SUCCEEDED with no consumers: round 2 starts at once', g4.impact === null && g4.roundStarted === 2 && task(lone.id).round === 2);

  const design = f.addTask('design', 'SUCCEEDED');
  const dV1 = f.addArtifact(design, 'DesignBrief');
  const build = f.addTask('build', 'SUCCEEDED', { dependsOn: ['design'], expectedOutputs: ['ChangeSet'] });
  h.repo.runInputs.record(f.addRun(build).id, [dV1.id]);
  const g5 = give(design, 'Darker header');
  check('SUCCEEDED with a consumer: the item waits and the impact lists build at v1',
    g5.roundStarted === null && g5.feedback.status === 'open' && g5.impact?.dependents.length === 1 && g5.impact.dependents[0].key === 'build' && g5.impact.dependents[0].usedVersion === 1 && g5.impact.defaultChoice === 'keep', g5.impact);
  check('list reports the pending impact', h.services.feedback.list(design.id).pendingImpact?.feedbackIds.includes(g5.feedback.id));
  h.services.feedback.startRound(caller, design.id, { feedbackIds: [g5.feedback.id], downstream: 'keep' });
  check('startRound keep: design is round 2, build untouched', task(design.id).round === 2 && task(build.id).status === 'SUCCEEDED');

  const blocked = f.addTask('blocked', 'BLOCKED');
  h.repo.tasks.update(blocked.id, { retryFeedback: 'Missing expected artifacts: DesignBrief.' });
  const g6 = give(blocked, 'Write the brief even if it is short');
  check('BLOCKED: the next attempt is a round with the gate feedback cleared', g6.roundStarted === 2 && task(blocked.id).status === 'READY' && task(blocked.id).retryFeedback === null);

  const retried = f.addTask('retried', 'FAILED');
  await h.services.missions.retryTask(caller, retried.id, { note: 'Use the brand palette' });
  const items = h.repo.feedback.listByTask(retried.id);
  check('retry with a note stores the note as feedback and starts a round', items.length === 1 && items[0].text === 'Use the brand palette' && items[0].status === 'in_round' && task(retried.id).round === 2);
  const plain = f.addTask('plain', 'FAILED');
  h.repo.tasks.update(plain.id, { retryFeedback: 'gate' });
  await h.services.missions.retryTask(caller, plain.id, {});
  check('retry without a note keeps today\'s behaviour', task(plain.id).round === 1 && task(plain.id).retryFeedback === 'gate' && h.repo.feedback.listByTask(plain.id).length === 0);
  // A wait step reads no feedback, so its retry note is today's retry, not a refused round.
  const overrides = h.container.resolve(h.app.RUNTIME_OVERRIDES);
  const waitFailed = f.addTask('waitFailed', 'FAILED', { executor: 'wait' });
  const waitRetry = await code(() => h.services.missions.retryTask(caller, waitFailed.id, { note: 'Check again', addCapabilities: ['browser'] }));
  check('retry with a note on a wait step keeps today\'s behaviour',
    waitRetry === 'ok' && task(waitFailed.id).status === 'READY' && task(waitFailed.id).round === 1 && h.repo.feedback.listByTask(waitFailed.id).length === 0,
    [waitRetry, task(waitFailed.id).status]);
  // A retry that becomes a round and fails to start leaves no widening and no runtime override behind.
  const widened = f.addTask('widened', 'FAILED');
  h.services.feedback.beginGive = () => { throw new Error('disk full'); };
  const widenRetry = await code(() => h.services.missions.retryTask(caller, widened.id, { note: 'Use the browser', addCapabilities: ['browser'], runtimeProfileId: 'rt_other' }));
  delete h.services.feedback.beginGive;
  check('a retry round that fails to start writes nothing',
    widenRetry !== 'ok' && task(widened.id).executionPolicy.capabilities.length === 0 && overrides.take(widened.id) === undefined && task(widened.id).status === 'FAILED',
    [widenRetry, task(widened.id).executionPolicy.capabilities]);

  const wait = f.addTask('wait', 'AWAITING_EXTERNAL', { executor: 'wait' });
  check('a wait step refuses feedback', await code(() => give(wait, 'x')) === 'PRECONDITION_FAILED');
  const other = f.addTask('other', 'SUCCEEDED');
  check('an artifact of another task is refused', await code(() => give(other, 'x', { artifactId: dV1.id })) === 'VALIDATION');
  check('dismissing an open item works', h.services.feedback.dismiss(caller, g2.feedback.id, {}).status === 'dismissed');
  check('dismissing an item already in a round is a conflict', await code(() => h.services.feedback.dismiss(caller, g6.feedback.id, {})) === 'CONFLICT');
  check('a dismissal is on the timeline', h.repo.events.listByMission(mission.id).some((e) => e.body.type === 'feedback.dismissed' && e.body.feedbackId === g2.feedback.id));

  // A failed task whose earlier output was used: the round waits for the person's choice, as a finished task's does.
  const shaky = f.addTask('shaky', 'FAILED');
  const sV1 = f.addArtifact(shaky, 'DesignBrief');
  const user = f.addTask('user', 'SUCCEEDED', { dependsOn: ['shaky'], expectedOutputs: ['ChangeSet'] });
  h.repo.runInputs.record(f.addRun(user).id, [sV1.id]);
  const g7 = give(shaky, 'Try the dark theme');
  check('FAILED with a consumer: the item waits with the impact instead of starting a round',
    g7.roundStarted === null && g7.impact?.dependents[0]?.key === 'user' && task(shaky.id).status === 'FAILED' && g7.feedback.status === 'open', g7);

  // A round that fails to start leaves no note and no decided card behind.
  const fragile = f.addTask('fragile', 'AWAITING_APPROVAL');
  f.addRun(fragile, { startedAt: f.at(20) });
  f.addCard(fragile);
  h.rounds.beginRound = () => { throw new Error('disk full'); };
  const broke = await code(() => give(fragile, 'Rounder corners'));
  delete h.rounds.beginRound;
  check('a round that fails to start rolls the note and the card decision back',
    broke !== 'ok' && h.repo.feedback.listByTask(fragile.id).length === 0 && h.repo.approvals.get('apr_fragile').status === 'PENDING'
    && !h.repo.events.listByMission(mission.id).some((e) => e.taskId === fragile.id && e.body.type === 'feedback.given'),
    [broke, h.repo.approvals.get('apr_fragile').status]);

  // Behind a start card nothing has run, so a retry note there is not a round.
  const gated = f.addTask('gated', 'AWAITING_APPROVAL', { startedAt: null, attempts: 0 });
  f.addCard(gated);
  // The fixture's review evidence would make it an output card; a start card carries none.
  h.repo.approvals.update('apr_gated', { evidence: [] });
  await h.services.missions.retryTask(caller, gated.id, { note: 'Go ahead' });
  check('retry with a note behind a start card keeps today\'s behaviour', task(gated.id).status === 'READY' && task(gated.id).round === 1 && h.repo.feedback.listByTask(gated.id).length === 0, [task(gated.id).status, task(gated.id).round, h.repo.feedback.listByTask(gated.id)]);

  // A card links a change only to its own task's notes; an id from elsewhere in the mission is not its answer.
  const citer = f.addTask('citer', 'SUCCEEDED');
  f.addArtifact(citer, 'DesignBrief', { changed: [{ what: 'Palette', feedback: g1.feedback.id }] });
  const citerCard = [...h.services.projections.missionFeed(mission.id, caller, { doneLimit: 100 }).done].find((c) => c.key === 'citer');
  check("a card does not resolve another task's note", citerCard?.changed.length === 1 && citerCard.changed[0].feedback.length === 0, citerCard?.changed);
  // A running dependent is stopped only once the whole round has committed: its pass re-reads its row as it settles.
  const source = f.addTask('source', 'SUCCEEDED');
  const srcV1 = f.addArtifact(source, 'DesignBrief');
  const consumer = f.addTask('consumer', 'RUNNING', { dependsOn: ['source'], expectedOutputs: ['ChangeSet'] });
  h.repo.runInputs.record(f.addRun(consumer, { status: 'RUNNING' }).id, [srcV1.id]);
  const g8 = give(source, 'Tighter spacing');
  const stops = [];
  const cancelTask = h.scheduler.cancelTask;
  h.scheduler.cancelTask = (id) => { stops.push([id, h.db.handle.inTransaction]); };
  h.services.feedback.startRound(caller, source.id, { feedbackIds: [g8.feedback.id], downstream: 'redo' });
  h.scheduler.cancelTask = cancelTask;
  check('redo through the service stops the running dependent after the commit, not inside it',
    g8.impact?.defaultChoice === 'redo' && eq(stops, [[consumer.id, false]]) && task(consumer.id).status === 'PENDING', [stops, task(consumer.id).status]);
  // Messages reach a person: they name notes by what they say or how many, never by id.
  const message = async (fn) => { try { await fn(); return ''; } catch (e) { return String(e.message); } };
  const notOpen = await message(() => h.services.feedback.startRound(caller, other.id, { feedbackIds: [g2.feedback.id], downstream: 'keep' }));
  const unknown = await message(() => h.services.feedback.dismiss(caller, 'fb_zzzzzzzzzzzzzzzzzzzz', {}));
  check('refusals about notes carry no raw fb_ ids', notOpen !== '' && unknown !== '' && !notOpen.includes('fb_') && !unknown.includes('fb_'), [notOpen, unknown]);

  const view = await h.services.projections.taskView(design.id);
  check('TaskView carries round and the feedback thread', view.round === 2 && view.feedback.some((i) => i.id === g5.feedback.id && i.status === 'in_round'));
  await h.container.dispose();
  clearInterval(keepAlive);
}

section('api: routes and views (http)');
{
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const HOME = mkdtempSync(join(tmpdir(), 'tra-'));
  const h = await engineHarness(HOME, 'rounds-api-seed');
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Api' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Greet visitors', title: 'Api' });
  // Paused, so the daemon's scheduler leaves READY tasks alone while the check reads them.
  h.repo.missions.update(mission.id, { status: 'PAUSED' });
  const f = fixtures(h, ws, mission.id);
  h.db.handle.pragma('foreign_keys = OFF');
  const doc = f.addTask('doc', 'SUCCEEDED', { round: 2 });
  const v1 = f.addArtifact(doc, 'DesignBrief', { round: 1, createdAt: f.at(5) });
  const note = h.rounds.record({ task: doc, text: 'Shorter intro', artifactId: null, authorId: owner, recordedBy: owner, status: 'open', round: null });
  h.repo.feedback.update(note.id, { status: 'addressed', round: 2 });
  // The reader reads the body from the store, so the version it opens is written there first, under the store's id.
  const v2Body = await h.repo.store.write({ workspaceId: ws, missionId: mission.id, taskId: doc.id, type: 'DesignBrief', title: 'doc DesignBrief', body: '# Brief\n\nTwo lines.', mediaType: 'text/markdown' });
  const v2 = f.addArtifact(doc, 'DesignBrief', { id: v2Body.id, round: 2, supersedes: v1.id, createdAt: f.at(9), changed: [{ what: 'Cut the intro to two lines', feedback: `${note.id}, fb_zzzzzzzzzzzzzzzzzzzz` }, { what: 'Declined: keep the logo', feedback: note.id }] });
  await h.container.dispose();

  const { startDaemon } = await import('../apps/daemon/dist/main.js');
  const daemon = await startDaemon({ home: HOME, logLevel: 'error', tickIntervalMs: 200 });
  const token = JSON.parse(readFileSync(join(HOME, 'daemon.json'), 'utf8')).token;
  const api = async (method, path, body) => {
    const res = await fetch(`${daemon.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const tooLong = await api('POST', `/v1/tasks/${doc.id}/feedback`, { text: 'x'.repeat(4001) });
  check('POST feedback over 4000 characters is a 400', tooLong.status === 400, tooLong);
  const blank = await api('POST', `/v1/tasks/${doc.id}/feedback`, { text: '   ' });
  check('POST feedback that is only whitespace is a 400', blank.status === 400);
  const given = await api('POST', `/v1/tasks/${doc.id}/feedback`, { text: 'Add a subtitle' });
  check('POST feedback returns the item and the started round', given.status === 200 && given.body.feedback.text === 'Add a subtitle' && given.body.roundStarted === 3, given.body);
  const list = await api('GET', `/v1/tasks/${doc.id}/feedback`);
  check('GET feedback lists the thread with the task round', list.body.round === 3 && list.body.items.length === 2, list.body);
  const feed = await api('GET', `/v1/missions/${mission.id}/feed`);
  const card = [...feed.body.inProgress, ...feed.body.done, ...feed.body.needsYou].find((c) => c.key === 'doc');
  check('FeedCard carries round, canRequestChanges and resolved changes',
    card?.round === 3 && card.canRequestChanges === true && card.changed.length === 2 && card.changed[0].feedback.length === 1 && card.changed[0].feedback[0].text === 'Shorter intro' && card.changed[1].declined === true, card);
  const read = await api('GET', `/v1/artifacts/${v2.id}`);
  check('the read view lists both versions and the changes linked to their notes',
    eq(read.body.versions.map((v) => v.version), [1, 2]) && read.body.round === 2 && read.body.changes[0].feedback[0].author?.id === owner, read.body);
  const rounds = await api('POST', `/v1/tasks/${doc.id}/rounds`, { feedbackIds: ['fb_nope'], downstream: 'keep' });
  check('POST rounds on a task that cannot start one is a 412', rounds.status === 412, rounds);
  await daemon.stop();
}

section('engine: rounds');
{
  const { mkdtempSync, mkdirSync, readFileSync, existsSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { systemClock, ids } = await import('@tandemise/shared');
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const keepAlive = setInterval(() => {}, 1000);
  const HOME = mkdtempSync(join(tmpdir(), 'tre-'));
  const h = await engineHarness(HOME, 'rounds-engine-check');
  const now = () => systemClock.now();

  const FB_ALL = '^\\d+\\. (fb_[0-9a-z]{20}) \\(';
  const FB_FIRST = '^1\\. (fb_[0-9a-z]{20}) \\(';
  const brief = ({ headline = 'Onboarding designed', changed = null } = {}) => [
    '---', 'type: DesignBrief', 'title: Onboarding design', 'handoff:', `  headline: ${headline}`,
    ...(changed === null ? [] : ['  changed:', ...changed.flatMap((c) => [`    - what: ${JSON.stringify(c.what)}`, `      feedback: ${JSON.stringify(c.feedback)}`])]),
    'flows:', '  - onboarding', '---', '', '# Onboarding', '', `${headline}.`, '',
  ].join('\n');
  const IN_ROUND = { promptIncludes: 'Feedback to address' };
  const write = (content, when) => ({ kind: 'write-file', path: '.tandemise/out/DesignBrief.md', content, ...(when ? { when } : {}) });
  const promptFile = { kind: 'write-file', path: 'prompts/{{runId}}.txt', content: '{{prompt}}' };
  const done = { kind: 'complete', summary: 'done' };
  const profile = (name, steps, extra = {}) => h.repo.profiles.create({
    id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name, executablePath: null, args: [],
    settings: { script: { steps, ...extra } }, capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
  }).id;
  const cited = (feedback = '{{fb}}', what = 'Shortened the intro') => write(brief({ headline: 'Onboarding, shorter', changed: [{ what, feedback }] }), IN_ROUND);
  const session = (id) => ({ kind: 'checkpoint', sessionId: id, label: 'session.init' });
  const P = {
    c1: profile('c1', [session('sess-c1'), promptFile, write(brief()), cited(), done], { captures: { fb: FB_ALL } }),
    lost: profile('lost', [promptFile, session('sess-lost'), write(brief()), cited(), done], { captures: { fb: FB_ALL }, resume: 'missing' }),
    slow: profile('slow', [session('sess-c4'), promptFile, write(brief()), { kind: 'delay', ms: 1500 }, cited(), done], { captures: { fb: FB_ALL } }),
    partial: profile('partial', [promptFile, write(brief()), cited('{{first}}'), { ...cited('{{fb}}'), when: { promptIncludes: 'must cite' } }, done], { captures: { fb: FB_ALL, first: FB_FIRST } }),
    decline: profile('decline', [promptFile, write(brief()), cited('{{fb}}', 'Declined: the intro is already one line'), done], { captures: { fb: FB_ALL } }),
    lazy: profile('lazy', [promptFile, cited(), done], { captures: { fb: FB_ALL } }),
    // Never cites the note it owes, in round 1 or after any retry: every round-2 attempt is refused the same way.
    neverCites: profile('neverCites', [promptFile, write(brief()), done], { captures: { fb: FB_ALL } }),
  };
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Engine' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const agent = (name, profileId, roleIds = ['design']) => h.services.team.addMember(caller, ws, { kind: 'agent', name, reportsTo: owner, roleIds, runtimeProfileIds: [profileId] }).id;
  const A = Object.fromEntries(Object.entries(P).map(([k, id]) => [k, agent(`Agent ${k}`, id)]));

  let seq = 0;
  const addMission = async (defs) => {
    const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Design onboarding', title: `E${++seq}` });
    const dir = h.paths.mission(ws, mission.id);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const out = {};
    for (const d of defs) {
      out[d.key] = h.repo.tasks.add({
        id: ids.task(), missionId: mission.id, key: d.key, title: d.key, objective: 'o', roleId: d.roleId ?? 'design',
        dependsOn: d.dependsOn ?? [], requiredCapabilities: [], inputArtifacts: d.inputArtifacts ?? [], expectedOutputs: d.expectedOutputs ?? ['DesignBrief'],
        executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false },
        retryPolicy: { maxAttempts: d.maxAttempts ?? 2, backoffMs: 0, onExhausted: 'block' }, completionGate: null,
        status: d.status ?? (d.dependsOn ? 'PENDING' : 'READY'), statusReason: null, attempts: 0, remediatesTaskId: null, repositoryId: null,
        executor: d.executor ?? 'agent', waitPolicy: null, orderHint: 0, staffingOverride: d.agent ? { assignees: [d.agent] } : null,
        createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
      }).id;
    }
    h.repo.missions.update(mission.id, { status: 'EXECUTING' });
    return { mission, dir, t: out };
  };
  const task = (id) => h.repo.tasks.get(id);
  const settled = (id) => h.until(() => ['SUCCEEDED', 'FAILED', 'BLOCKED', 'AWAITING_APPROVAL', 'AWAITING_HUMAN'].includes(task(id).status), 20000);
  const runsOf = (id) => [...h.repo.runs.listByTask(id)].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const promptOf = (dir, run) => { const p = join(dir, 'prompts', `${run.id}.txt`); return existsSync(p) ? readFileSync(p, 'utf8') : ''; };
  const live = (id) => { const all = h.repo.artifacts.listByTask(id); const sup = new Set(all.map((a) => a.supersedes)); return all.filter((a) => !sup.has(a.id)); };
  const events = (missionId, type) => h.repo.events.listByMission(missionId).filter((e) => e.body.type === type);

  // ---- C1: a round continues the settled session
  {
    const { mission, dir, t } = await addMission([{ key: 'doc', agent: A.c1 }]);
    await settled(t.doc);
    check('C1: round 1 succeeds on its first run as purpose round', task(t.doc).status === 'SUCCEEDED' && runsOf(t.doc)[0]?.purpose === 'round' && runsOf(t.doc)[0]?.round === 1, runsOf(t.doc));
    const given = h.services.feedback.give(caller, t.doc, { text: 'Shorter intro' });
    await settled(t.doc);
    const [, second] = runsOf(t.doc);
    const prompt = promptOf(dir, second);
    check('C1: round 2 succeeded', task(t.doc).status === 'SUCCEEDED' && task(t.doc).round === 2, task(t.doc));
    check('C1: the run is purpose round, round 2, on the same session', second?.purpose === 'round' && second.round === 2 && second.externalSessionId === 'sess-c1', second);
    check('C1: the runtime was asked to resume', h.repo.events.listByRun(second.id).some((e) => e.body.type === 'checkpoint' && e.body.label === 'session.resumed'));
    check('C1: the continued prompt is the request with the previous output and the numbered note',
      prompt.startsWith('This is round 2 of this task.') && prompt.includes('Your previous output') && prompt.includes(`1. ${given.feedback.id} (`) && prompt.includes('Shorter intro'), prompt.slice(0, 400));
    check('C1: nothing frames it as a gate failure', !prompt.includes('did not satisfy this task'));
    check('C1: the emptied folder is written back in full, not edited in place', prompt.includes('Write each file back in full') && !prompt.includes('Edit the files in place'));
    check('C1: the note is addressed in round 2', h.repo.feedback.get(given.feedback.id).status === 'addressed' && h.repo.feedback.get(given.feedback.id).round === 2);
    const [art] = live(t.doc);
    check('C1: the new artifact is round 2 and cites the note', art?.round === 2 && art.handoff.changed[0].feedback === given.feedback.id, art);
    check('C1: feedback.addressed is recorded', events(mission.id, 'feedback.addressed').some((e) => e.body.feedbackId === given.feedback.id && e.body.round === 2 && e.body.declined === false));
  }

  // ---- a session the runtime lost: the round restarts fresh with the full prompt
  {
    const { mission, dir, t } = await addMission([{ key: 'doc', agent: A.lost }]);
    await settled(t.doc);
    h.services.feedback.give(caller, t.doc, { text: 'Shorter intro' });
    await settled(t.doc);
    const [, second] = runsOf(t.doc);
    check('lost session: round 2 still succeeds', task(t.doc).status === 'SUCCEEDED' && task(t.doc).round === 2);
    check('lost session: the fresh prompt is the full context with the brief', promptOf(dir, second).includes('Required output') && promptOf(dir, second).includes('Feedback to address'));
    check('lost session: a note says it started fresh', events(mission.id, 'note').some((e) => /could no longer be resumed/.test(e.body.text)));
  }

  // ---- C4: a note while running is delivered at pass end, same round, attempts unchanged
  {
    const { dir, t } = await addMission([{ key: 'doc', agent: A.slow }]);
    await h.until(() => h.repo.runs.listByTask(t.doc).some((r) => r.status === 'RUNNING'));
    const given = h.services.feedback.give(caller, t.doc, { text: 'Mention the pricing page' });
    check('C4: the note is queued', given.feedback.status === 'queued');
    await settled(t.doc);
    const runs = runsOf(t.doc);
    check('C4: the task succeeded in round 1 with one counted attempt', task(t.doc).status === 'SUCCEEDED' && task(t.doc).round === 1 && task(t.doc).attempts === 1, task(t.doc));
    check('C4: exactly one extra pass, purpose feedback, round 1, same session', runs.length === 2 && runs[1].purpose === 'feedback' && runs[1].round === 1 && runs[1].externalSessionId === 'sess-c4', runs.map((r) => [r.purpose, r.round]));
    check('C4: the note is addressed in round 1', h.repo.feedback.get(given.feedback.id).status === 'addressed' && h.repo.feedback.get(given.feedback.id).round === 1);
    check('C4: the delivery prompt carries the note', promptOf(dir, runs[1]).includes(given.feedback.id));
    check('C4: the delivery pass edits the files it just wrote, in place', promptOf(dir, runs[1]).includes('Edit the files in place'));
  }

  // ---- C5 and C6: two notes before the round; one citation missing on the first try
  {
    const { dir, t } = await addMission([{ key: 'doc', agent: A.partial }]);
    await settled(t.doc);
    const first = h.services.feedback.give(caller, t.doc, { text: 'Shorter intro' });
    const second = h.services.feedback.give(caller, t.doc, { text: 'Friendlier button copy' });
    check('C5: the second note joins the round that has not started yet', first.roundStarted === 2 && second.feedback.status === 'open' && second.feedback.round === 2);
    await settled(t.doc);
    const runs = runsOf(t.doc).filter((r) => r.round === 2);
    check('C6: the first round-2 attempt was refused, the retry named the missing id and passed',
      runs.length === 2 && promptOf(dir, runs[1]).includes(`must cite ${second.feedback.id}`) && task(t.doc).status === 'SUCCEEDED', runs.map((r) => r.purpose));
    check('C6: the retry is a counted retry in round 2', runs[1].purpose === 'retry' && task(t.doc).attempts === 3);
    // The person reads a line about the round; the agent's retry prompt above still names the id.
    const refused = h.repo.events.listByMission(runs[0].missionId)
      .find((e) => e.taskId === t.doc && e.body.type === 'task.status' && e.body.from === 'RUNNING' && e.body.to === 'READY');
    check('C1: the refused attempt reads "Round 2 left 1 note unanswered; trying again." with no id and no missing artifact',
      refused?.body.reason === 'Round 2 left 1 note unanswered; trying again.', refused?.body.reason);
    check('C5: both notes are cited and addressed in round 2',
      [first, second].every((g) => h.repo.feedback.get(g.feedback.id).status === 'addressed' && h.repo.feedback.get(g.feedback.id).round === 2)
      && live(t.doc)[0].handoff.changed[0].feedback === `${first.feedback.id}, ${second.feedback.id}`);
  }

  // ---- C9: a decline is a citation
  {
    const { mission, t } = await addMission([{ key: 'doc', agent: A.decline }]);
    await settled(t.doc);
    const given = h.services.feedback.give(caller, t.doc, { text: 'Add a video' });
    await settled(t.doc);
    check('C9: a declined note is addressed, and the event says it was declined',
      h.repo.feedback.get(given.feedback.id).status === 'addressed' && events(mission.id, 'feedback.addressed').some((e) => e.body.feedbackId === given.feedback.id && e.body.declined === true));
  }

  // ---- C12: retry from blocked with a note is a request
  {
    const { dir, t } = await addMission([{ key: 'doc', agent: A.lazy, maxAttempts: 1 }]);
    await settled(t.doc);
    check('C12: without a note the lazy agent blocks the task', task(t.doc).status === 'BLOCKED', task(t.doc));
    await h.services.missions.retryTask(caller, t.doc, { note: 'Write the brief, even a short one' });
    await settled(t.doc);
    const last = runsOf(t.doc).at(-1);
    const prompt = promptOf(dir, last);
    check('C12: the retry ran as round 2 and succeeded', task(t.doc).status === 'SUCCEEDED' && last.round === 2 && last.purpose === 'round');
    check('C12: the note reaches the agent as a request, not a gate failure',
      prompt.includes('Feedback to address') && prompt.includes('Write the brief, even a short one') && !prompt.includes("did not satisfy this task's completion gate"), prompt.slice(-1500));
  }

  // ---- polish: the exhausted-retries card gets a person-readable summary, never the gate's verbatim detail
  {
    const { mission, t } = await addMission([{ key: 'doc', agent: A.neverCites }]);
    await settled(t.doc);
    const given = h.services.feedback.give(caller, t.doc, { text: 'Shorter intro' });
    await h.until(() => task(t.doc).status === 'BLOCKED', 20000);
    check('polish: an agent that never cites the note exhausts round 2\'s retries and blocks',
      task(t.doc).status === 'BLOCKED', task(t.doc));
    const stuck = h.repo.approvals.list({ missionId: mission.id, statuses: ['PENDING'] }).find((a) => a.kind === 'intervention' && a.taskId === t.doc);
    const measurement = stuck?.evidence.find((e) => e.label === 'Last measurement')?.value;
    check('polish: the intervention card\'s summary is person-readable, naming the round and the attempts, not the gate\'s raw measurement',
      measurement === 'Round 2 still left 1 note unanswered after 3 attempts.', measurement);
    check('polish: the card\'s summary carries no raw id and no file path',
      measurement !== undefined && !/fb_|tsk_|art_|\.md/.test(measurement), measurement);
    check('polish: the agent still gets the verbatim gate detail, with the note id, in retryFeedback for its next attempt',
      typeof task(t.doc).retryFeedback === 'string' && task(t.doc).retryFeedback.includes(given.feedback.id), task(t.doc).retryFeedback);
  }

  // ---- run inputs, keep flags and redo against the new version
  {
    const buildAgent = agent('Builder', profile('builder', [
      { kind: 'write-file', path: '.tandemise/out/ChangeSet.md', content: ['---', 'type: ChangeSet', 'title: Build', 'handoff:', '  headline: Built', 'branch: b', 'commits: []', 'filesChanged: 0', 'testsRun: []', 'knownLimitations: []', '---', '', 'Built.'].join('\n') }, done,
    ]), ['development']);
    const { mission, t } = await addMission([
      { key: 'design', agent: A.c1 },
      { key: 'build', agent: buildAgent, roleId: 'development', dependsOn: ['design'], expectedOutputs: ['ChangeSet'], inputArtifacts: [{ type: 'DesignBrief', required: true }] },
    ]);
    await settled(t.design); await settled(t.build);
    const v1 = live(t.design)[0];
    const buildRun = runsOf(t.build)[0];
    check('run_inputs records the design artifact the build was given', h.repo.runInputs.listByRun(buildRun.id).includes(v1.id));

    const keep = h.services.feedback.give(caller, t.design, { text: 'Darker header' });
    check('the build is listed as a consumer of v1', keep.impact?.dependents[0]?.key === 'build' && keep.impact.dependents[0].usedVersion === 1, keep.impact);
    h.services.feedback.startRound(caller, t.design, { feedbackIds: [keep.feedback.id], downstream: 'keep' });
    await settled(t.design);
    const attention = events(mission.id, 'task.attention').find((e) => e.taskId === t.build);
    check('C2 keep: the kept build is flagged "Built against design v1; v2 is out."', task(t.build).needsAttention === true && attention?.body.note === 'Built against design v1; v2 is out.', attention?.body);
    check('C1: a passed round with every note cited never reads as missing an artifact',
      !h.repo.events.listByMission(mission.id).some((e) => e.taskId === t.design && e.body.type === 'task.status' && /Missing expected artifacts/.test(e.body.reason ?? '')));

    const redo = h.services.feedback.give(caller, t.design, { text: 'Lighter footer' });
    h.services.feedback.startRound(caller, t.design, { feedbackIds: [redo.feedback.id], downstream: 'redo' });
    check('C2 redo: the build waits again', task(t.build).status === 'PENDING');
    await settled(t.design);
    await h.until(() => runsOf(t.build).length === 2 && task(t.build).status === 'SUCCEEDED', 20000);
    check('C2 redo: the build reran against v3', h.repo.runInputs.listByRun(runsOf(t.build)[1].id).includes(live(t.design)[0].id) && live(t.design)[0].round === 3);
  }

  // ---- C8 offline: a person's step
  {
    const { t } = await addMission([{ key: 'docs', executor: 'human', expectedOutputs: ['Evidence'] }]);
    await h.until(() => task(t.docs).status === 'AWAITING_HUMAN');
    const given = h.services.feedback.give(caller, t.docs, { text: 'Mention the pricing page' });
    await h.services.missions.completeTask(caller, t.docs, { result: 'README: pricing is on /pricing.' });
    check('C8: completing the step addresses the note in round 1, and the output is round 1',
      h.repo.feedback.get(given.feedback.id).status === 'addressed' && h.repo.feedback.get(given.feedback.id).round === 1 && live(t.docs)[0]?.round === 1);
  }

  // Waits without ticking, so nothing new is dispatched while a pass settles.
  const settle = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end && !fn()) await new Promise((r) => setTimeout(r, 40)); return fn(); };

  // ---- a note queued on a pass that fails its gate rides with the counted retry
  {
    const flaky = agent('Flaky', profile('flaky', [promptFile, { kind: 'delay', ms: 1500 }, cited(), done], { captures: { fb: FB_ALL } }));
    const { dir, t } = await addMission([{ key: 'doc', agent: flaky }]);
    await h.until(() => h.repo.runs.listByTask(t.doc).some((r) => r.status === 'RUNNING'));
    const given = h.services.feedback.give(caller, t.doc, { text: 'Mention the pricing page' });
    await settled(t.doc);
    const runs = runsOf(t.doc);
    check('queued on a failing pass: the retry carries the note, cites it and passes in round 1',
      task(t.doc).status === 'SUCCEEDED' && task(t.doc).round === 1 && task(t.doc).attempts === 2
        && eq(runs.map((r) => r.purpose), ['round', 'retry']) && promptOf(dir, runs[1]).includes(given.feedback.id), { task: task(t.doc), runs: runs.map((r) => r.purpose) });
    check('queued on a failing pass: the note is addressed in round 1, never left open',
      h.repo.feedback.get(given.feedback.id).status === 'addressed' && h.repo.feedback.get(given.feedback.id).round === 1);
  }

  // ---- a Redo while a dependent's delivery pass runs: PENDING stands and the pass leaves no output
  {
    const relay = agent('Relay', profile('relay', [session('sess-relay'), promptFile, write(brief()), { kind: 'delay', ms: 1500 }, { kind: 'delay', ms: 10000, when: IN_ROUND }, cited(), done], { captures: { fb: FB_ALL } }));
    // The upstream output is another type: an output of the same type downstream would supersede it.
    const changeSet = ['---', 'type: ChangeSet', 'title: Build', 'handoff:', '  headline: Built', '  changed:', '    - what: "Built it"', '      feedback: "{{fb}}"',
      'branch: b', 'commits: []', 'filesChanged: 0', 'testsRun: []', 'knownLimitations: []', '---', '', 'Built.'].join('\n');
    const builder = agent('Upstream builder', profile('upstream', [{ kind: 'write-file', path: '.tandemise/out/ChangeSet.md', content: changeSet }, done], { captures: { fb: FB_ALL } }), ['development']);
    const { t } = await addMission([
      { key: 'up', agent: builder, roleId: 'development', expectedOutputs: ['ChangeSet'] },
      { key: 'down', agent: relay, dependsOn: ['up'], inputArtifacts: [{ type: 'ChangeSet', required: true }] },
    ]);
    await settled(t.up);
    await h.until(() => h.repo.runs.listByTask(t.down).some((r) => r.status === 'RUNNING'));
    const note = h.services.feedback.give(caller, t.down, { text: 'Name the pricing page' });
    await settle(() => h.repo.runs.listByTask(t.down).some((r) => r.purpose === 'feedback' && r.status === 'RUNNING'));
    const redo = h.services.feedback.give(caller, t.up, { text: 'Darker header' });
    h.services.feedback.startRound(caller, t.up, { feedbackIds: [redo.feedback.id], downstream: 'redo' });
    await settle(() => h.repo.runs.listByTask(t.down).every((r) => !['STARTING', 'RUNNING'].includes(r.status)));
    await new Promise((r) => setTimeout(r, 200));
    const delivery = runsOf(t.down).find((r) => r.purpose === 'feedback');
    check('redo during delivery: the dependent stays PENDING and the pass is cancelled',
      task(t.down).status === 'PENDING' && delivery?.status === 'CANCELLED', { s: task(t.down).status, r: task(t.down).statusReason, run: delivery?.status });
    check('redo during delivery: nothing the overtaken attempt wrote is live', live(t.down).length === 0, live(t.down).map((a) => a.id));
    await h.until(() => task(t.down).status === 'SUCCEEDED', 30000);
    check('redo during delivery: the redone dependent later answers the note',
      task(t.down).status === 'SUCCEEDED' && h.repo.feedback.get(note.feedback.id).status === 'addressed', { s: task(t.down).status, fb: h.repo.feedback.get(note.feedback.id) });
  }

  // ---- a delivery pass never runs without an admitted slot
  {
    const { RUNTIME_MANAGER } = await import('@tandemise/runtimes-core');
    const manager = h.container.resolve(RUNTIME_MANAGER);
    const soloId = h.repo.profiles.create({
      id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name: 'solo', executablePath: null, args: [],
      settings: { script: { steps: [session('sess-solo'), promptFile, write(brief()), { kind: 'delay', ms: 1500 }, cited(), done], captures: { fb: FB_ALL } } },
      capabilities: [], enabled: true, maxConcurrent: 1, createdAt: now(), updatedAt: now(),
    }).id;
    const soloA = agent('Solo A', soloId);
    const soloB = agent('Solo B', soloId);
    const checks = h.container.resolve(h.app.CHECK_SERVICE);
    const original = checks.run;
    let peak = 0;
    const sampler = setInterval(() => { peak = Math.max(peak, manager.inFlight(soloId)); }, 5);
    const first = await addMission([{ key: 'doc', agent: soloA }]);
    let given = null;
    let other = null;
    checks.run = async function (request) {
      if (request.task.id === first.t.doc && given === null) {
        // The first run gave its slot back (no note waited); now a note arrives and another task takes the slot.
        given = h.services.feedback.give(caller, first.t.doc, { text: 'Mention the pricing page' });
        other = await addMission([{ key: 'doc', agent: soloB }]);
        await h.until(() => h.repo.runs.listByTask(other.t.doc).some((r) => r.status === 'RUNNING'));
      }
      return original.call(this, request);
    };
    await settled(first.t.doc);
    checks.run = original;
    await settled(other.t.doc);
    clearInterval(sampler);
    check('no free slot: the delivery pass does not run, and the profile never exceeds its limit',
      peak <= 1 && task(first.t.doc).status === 'SUCCEEDED' && runsOf(first.t.doc).length === 1, { peak, s: task(first.t.doc).status, runs: runsOf(first.t.doc).map((r) => r.purpose) });
    await h.until(() => h.repo.feedback.get(given.feedback.id).status === 'open');
    check('no free slot: the note waits open for a round, and the timeline says why',
      h.repo.feedback.get(given.feedback.id).status === 'open' && events(first.mission.id, 'note').some((e) => /cannot take another pass/.test(e.body.text)));
  }

  // ---- a delivery pass that breaks at the runtime never fails the attempt that passed (spec §4, tighten rules)
  for (const code of ['RUNTIME_FAILED', 'RUNTIME_SIGNED_OUT']) {
    const dropout = agent(`Dropout ${code}`, profile(`dropout-${code}`, [session(`sess-${code}`), promptFile, write(brief()), { kind: 'delay', ms: 1500 },
      { kind: 'fail', code, message: 'The runtime went away', retryable: true, when: IN_ROUND }, cited(), done], { captures: { fb: FB_ALL } }));
    const { mission, t } = await addMission([{ key: 'doc', agent: dropout }]);
    await h.until(() => h.repo.runs.listByTask(t.doc).some((r) => r.status === 'RUNNING'));
    const given = h.services.feedback.give(caller, t.doc, { text: 'Mention the pricing page' });
    await settled(t.doc);
    const runs = runsOf(t.doc);
    check(`delivery breaks (${code}): the passed attempt stands, with no attempt counted`,
      task(t.doc).status === 'SUCCEEDED' && task(t.doc).attempts === 1 && eq(runs.map((r) => r.purpose), ['round', 'feedback']) && live(t.doc)[0]?.createdByRunId === runs[0].id
        && !h.repo.runs.listByTask(t.doc).some((r) => r.status === 'RESUMABLE'),
      { s: task(t.doc).status, a: task(t.doc).attempts, runs: runs.map((r) => [r.purpose, r.status]) });
    await h.until(() => h.repo.feedback.get(given.feedback.id).status === 'open');
    check(`delivery breaks (${code}): the note waits open, and a warning says so`,
      h.repo.feedback.get(given.feedback.id).status === 'open' && events(mission.id, 'note').some((e) => /did not finish/.test(e.body.text)));
  }

  // ---- a delivery pass breaks the citations: notes that arrived during it ride with the counted retry, which edits the first draft
  {
    const breaker = agent('Breaker', profile('breaker', [session('sess-brk'), promptFile, write(brief()), { kind: 'delay', ms: 1500 },
      { ...cited('{{fb}}'), when: { promptIncludes: 'must cite' } }, done], { captures: { fb: FB_ALL } }));
    const { dir, t } = await addMission([{ key: 'doc', agent: breaker }]);
    await h.until(() => h.repo.runs.listByTask(t.doc).some((r) => r.status === 'RUNNING'));
    const one = h.services.feedback.give(caller, t.doc, { text: 'Shorter intro' });
    await settle(() => h.repo.runs.listByTask(t.doc).some((r) => r.purpose === 'feedback' && r.status === 'RUNNING'));
    const two = h.services.feedback.give(caller, t.doc, { text: 'Friendlier button copy' });
    check('broken delivery: the second note is queued on the delivery pass', two.feedback.status === 'queued');
    await settled(t.doc);
    const runs = runsOf(t.doc);
    check('broken delivery: the retry is counted and carries both notes, addressed in round 1',
      task(t.doc).status === 'SUCCEEDED' && task(t.doc).attempts === 2 && eq(runs.map((r) => r.purpose), ['round', 'feedback', 'retry'])
        && [one, two].every((g) => h.repo.feedback.get(g.feedback.id).status === 'addressed' && h.repo.feedback.get(g.feedback.id).round === 1),
      { s: task(t.doc).status, a: task(t.doc).attempts, runs: runs.map((r) => r.purpose), fb: [one, two].map((g) => h.repo.feedback.get(g.feedback.id).status) });
    check('broken delivery: the round-1 retry is shown its first draft as previous output', promptOf(dir, runs[2]).includes('Your previous output'));
  }

  // ---- a draft the delivery pass leaves untouched keeps its over-budget flag
  {
    const REQUIRED = { promptIncludes: 'Required output' };
    const long = [brief().trimEnd(), 'word '.repeat(700), ''].join('\n');
    const evidence = (changed) => ['---', 'type: Evidence', 'title: Notes', 'handoff:', '  headline: Notes',
      ...(changed ? ['  changed:', '    - what: "Named the pricing page"', '      feedback: "{{fb}}"'] : []), '---', '', 'Notes.', ''].join('\n');
    const twofold = agent('Twofold', profile('twofold', [session('sess-two'), promptFile, { ...write(long), when: REQUIRED },
      { kind: 'write-file', path: '.tandemise/out/Evidence.md', content: evidence(false), when: REQUIRED }, { kind: 'delay', ms: 1500, when: REQUIRED },
      { kind: 'write-file', path: '.tandemise/out/Evidence.md', content: evidence(true), when: IN_ROUND }, done], { captures: { fb: FB_ALL } }));
    const { mission, t } = await addMission([{ key: 'doc', agent: twofold, expectedOutputs: ['Evidence', 'DesignBrief'] }]);
    await h.until(() => h.repo.runs.listByTask(t.doc).some((r) => r.status === 'RUNNING'));
    const given = h.services.feedback.give(caller, t.doc, { text: 'Name the pricing page' });
    await settled(t.doc);
    const design = live(t.doc).find((a) => a.type === 'DesignBrief');
    check('untouched over-budget draft: it keeps its flag and still earns the tighten pass',
      task(t.doc).status === 'SUCCEEDED' && design?.overBudget === true
        && events(mission.id, 'artifact.tighten_requested').some((e) => e.taskId === t.doc && e.body.types.includes('DesignBrief'))
        && h.repo.feedback.get(given.feedback.id).status === 'addressed',
      { s: task(t.doc).status, r: task(t.doc).statusReason, design: design?.overBudget, runs: runsOf(t.doc).map((r) => r.purpose) });
  }

  // ---- a round edits this task's own newest output, whatever another task superseded
  {
    const { mission, t } = await addMission([
      { key: 'implement', status: 'SUCCEEDED', roleId: 'development', expectedOutputs: ['ChangeSet'] },
      { key: 'fix', status: 'SUCCEEDED', roleId: 'development', expectedOutputs: ['ChangeSet'] },
    ]);
    const put = async (taskId, body, supersedes, createdAt) => {
      const stored = await h.repo.store.write({ workspaceId: ws, missionId: mission.id, taskId, type: 'ChangeSet', title: 'Build', body, mediaType: 'text/markdown', supersedes });
      return h.repo.artifacts.create({ ...stored, supersedes, createdAt, authorId: 'system:runtime', responsibleId: null, recordedBy: 'system', handoff: null, wordCount: 1, overBudget: false, round: 1 });
    };
    const v1 = await put(t.implement, 'implement v1', null, '2026-09-14T11:00:00.000Z');
    const fixed = await put(t.fix, 'fix', v1.id, '2026-09-14T11:01:00.000Z');
    h.repo.tasks.update(t.implement, { round: 2 });
    const before = await h.rounds.openRound(task(t.implement));
    check('previous output: a version another task superseded is still this task\'s previous output', eq(before?.previous.map((d) => d.manifest.id), [v1.id]), before?.previous.map((d) => d.manifest.id));
    const v2 = await put(t.implement, 'implement v2', fixed.id, '2026-09-14T11:02:00.000Z');
    const after = await h.rounds.openRound(task(t.implement));
    check('previous output: only this task\'s newest version, once', eq(after?.previous.map((d) => d.manifest.id), [v2.id]), after?.previous.map((d) => d.manifest.id));
  }

  // ---- the daemon stops: during a first pass a queued note rides with the resumed start;
  //      during a delivery pass the round settles from the output before it and the note waits
  {
    const hold = agent('Hold', profile('hold', [session('sess-hold'), promptFile, write(brief()), { kind: 'delay', ms: 30000 }, done], { captures: { fb: FB_ALL } }));
    const stall = agent('Stall', profile('stall', [session('sess-stall'), promptFile, write(brief()), { kind: 'delay', ms: 1500 }, { kind: 'delay', ms: 30000, when: IN_ROUND }, cited(), done], { captures: { fb: FB_ALL } }));
    const first = await addMission([{ key: 'doc', agent: hold }]);
    const second = await addMission([{ key: 'doc', agent: stall }]);
    await h.until(() => [first.t.doc, second.t.doc].every((id) => h.repo.runs.listByTask(id).some((r) => r.status === 'RUNNING')));
    const onFirst = h.services.feedback.give(caller, first.t.doc, { text: 'Shorter intro' });
    const onSecond = h.services.feedback.give(caller, second.t.doc, { text: 'Shorter intro' });
    await settle(() => h.repo.runs.listByTask(second.t.doc).some((r) => r.purpose === 'feedback' && r.status === 'RUNNING'));
    await h.scheduler.stop();
    check('stop during a pass: the task goes back to the queue and its note is in the round, not stranded',
      task(first.t.doc).status === 'READY' && h.repo.feedback.get(onFirst.feedback.id).status === 'in_round', { s: task(first.t.doc).status, fb: h.repo.feedback.get(onFirst.feedback.id).status });
    const stalled = runsOf(second.t.doc);
    check('stop during delivery: the round settles from the output before it, with no attempt consumed',
      task(second.t.doc).status === 'SUCCEEDED' && task(second.t.doc).attempts === 1 && stalled.length === 2 && stalled[1].status === 'INTERRUPTED',
      { s: task(second.t.doc).status, a: task(second.t.doc).attempts, runs: stalled.map((r) => [r.purpose, r.status]) });
    check('stop during delivery: the note goes back to waiting and the sweep leaves it open',
      h.repo.feedback.get(onSecond.feedback.id).status === 'queued' && h.rounds.releaseStranded() >= 1 && h.repo.feedback.get(onSecond.feedback.id).status === 'open'
        && h.repo.feedback.get(onFirst.feedback.id).status === 'in_round');
  }

  await h.container.dispose();
  clearInterval(keepAlive);
}

section('reviews: request changes, checks and AI findings');
{
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { systemClock, ids } = await import('@tandemise/shared');
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const D = await import('@tandemise/domain');
  const keepAlive = setInterval(() => {}, 1000);
  const HOME = mkdtempSync(join(tmpdir(), 'trv-'));
  const h = await engineHarness(HOME, 'rounds-reviews-check');
  const now = () => systemClock.now();
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Reviews' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const task = (id) => h.repo.tasks.get(id);
  const settled = (id) => h.until(() => ['SUCCEEDED', 'FAILED', 'BLOCKED', 'AWAITING_APPROVAL', 'AWAITING_HUMAN'].includes(task(id).status), 20000);
  const byKey = (missionId) => Object.fromEntries(h.repo.tasks.listByMission(missionId).map((t) => [t.key, t]));
  const profile = (name, steps, extra = {}) => h.repo.profiles.create({
    id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name, executablePath: null, args: [],
    settings: { script: { steps, ...extra } }, capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
  }).id;
  const doc = (type, front, changed) => ({
    kind: 'write-file', path: `.tandemise/out/${type}.md`,
    content: ['---', `type: ${type}`, `title: ${type}`, 'handoff:', `  headline: ${type} ready`,
      ...(changed ? ['  changed:', '    - what: "Fixed what the reviewer found"', '      feedback: "{{fb}}"'] : []), ...front, '---', '', `${type}.`].join('\n'),
  });
  const CHANGE = ['branch: b', 'commits: []', 'filesChanged: 1', 'testsRun: []', 'knownLimitations: []'];
  const IN_ROUND = { promptIncludes: 'Feedback to address' };
  const builder = profile('builder', [doc('ChangeSet', CHANGE), { ...doc('ChangeSet', CHANGE, true), when: IN_ROUND }, { kind: 'complete' }], { captures: { fb: '^\\d+\\. (fb_[0-9a-z]{20}) \\(' } });
  const blocking = ['verdict: fail', 'reviewedRef: HEAD', 'findings:', '  - severity: blocking', '    title: "The greeting ignores the name"', '    location: hello.txt'];
  const passing = ['verdict: pass', 'reviewedRef: HEAD', 'findings: []'];
  // Blocks until the ChangeSet it reads cites feedback; the later write wins.
  const reviewer = profile('reviewer', [doc('ReviewReport', blocking), { ...doc('ReviewReport', passing), when: { promptIncludes: 'feedback: "fb_' } }, { kind: 'complete' }]);
  const stubborn = profile('stubborn', [doc('ReviewReport', blocking), { kind: 'complete' }]);
  const agent = (name, profileId, roleIds) => h.services.team.addMember(caller, ws, { kind: 'agent', name, reportsTo: owner, roleIds, runtimeProfileIds: [profileId] }).id;
  const buildAgent = agent('Builder', builder, ['development']);
  const reviewAgent = agent('Review agent', reviewer, ['review']);
  const stubbornAgent = agent('Stubborn reviewer', stubborn, ['review']);

  let seq = 0;
  const addMission = async (defs) => {
    const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Ship the hello page', title: `R${++seq}` });
    const dir = h.paths.mission(ws, mission.id);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const t = {};
    for (const d of defs) {
      t[d.key] = h.repo.tasks.add({
        id: ids.task(), missionId: mission.id, key: d.key, title: d.key, objective: 'o', roleId: d.roleId, dependsOn: d.dependsOn ?? [],
        requiredCapabilities: [], inputArtifacts: d.inputArtifacts ?? [], expectedOutputs: d.expectedOutputs,
        executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false },
        retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' }, completionGate: d.completionGate ?? null,
        status: d.dependsOn ? 'PENDING' : 'READY', statusReason: null, attempts: 0, remediatesTaskId: null, repositoryId: null,
        executor: 'agent', waitPolicy: null, orderHint: d.order ?? 0, staffingOverride: d.staffing ?? null,
        createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
      }).id;
    }
    h.repo.missions.update(mission.id, { status: 'EXECUTING' });
    return { mission, t };
  };
  const blockingReview = [{ by: 'responsible', mode: 'blocking', when: 'always' }];

  // ---- C3: a blocking review card offers Request changes, and it starts a round of the same task
  {
    const { mission, t } = await addMission([{ key: 'build', roleId: 'development', expectedOutputs: ['ChangeSet'], staffing: { assignees: [buildAgent], reviews: blockingReview } }]);
    await settled(t.build);
    const [card] = h.repo.approvals.pendingForTask(t.build);
    check('C3: the card offers Approve, Request changes, Reject without changes', eq(card?.options.map((o) => [o.id, o.label]),
      [['approve', 'Approve'], ['request_changes', 'Request changes'], ['reject', 'Reject without changes']]), card?.options);
    check('C3: Request changes without a note is refused', await code(() => h.services.approvals.decide(caller, card.id, { optionId: 'request_changes' })) === 'VALIDATION');
    await h.services.approvals.decide(caller, card.id, { optionId: 'request_changes', note: 'Escape the visitor name' });
    check('C3: the same task is round 2 and no _revision_ task exists',
      task(t.build).round === 2 && task(t.build).status === 'READY' && Object.keys(byKey(mission.id)).every((k) => !k.includes('_revision_')), Object.keys(byKey(mission.id)));
    const item = h.repo.feedback.listByTask(t.build)[0];
    check('C3: the note is a feedback item in round 2', item?.text === 'Escape the visitor name' && item.status === 'in_round' && item.round === 2 && item.authorId === owner);
    await settled(t.build);
    check('C3: the review pipeline runs again for round 2', h.repo.approvals.pendingForTask(t.build).length === 1 && task(t.build).status === 'AWAITING_APPROVAL');
    const [again] = h.repo.approvals.pendingForTask(t.build);
    await h.services.approvals.decide(caller, again.id, { optionId: 'reject' });
    check('Reject without changes blocks the task', task(t.build).status === 'BLOCKED', task(t.build).statusReason);
  }

  // ---- fix 1: on a card that offers Request changes, Reject without changes blocks even with a note
  {
    const { t } = await addMission([{ key: 'firm', roleId: 'development', expectedOutputs: ['ChangeSet'], staffing: { assignees: [buildAgent], reviews: blockingReview } }]);
    await settled(t.firm);
    const [card] = h.repo.approvals.pendingForTask(t.firm);
    await h.services.approvals.decide(caller, card.id, { optionId: 'reject', note: 'Not this at all.' });
    check('fix 1: reject with a note on a three-option card blocks the task and starts no round',
      task(t.firm).status === 'BLOCKED' && task(t.firm).round === 1 && h.repo.feedback.listByTask(t.firm).length === 0,
      [task(t.firm).status, task(t.firm).round, h.repo.feedback.listByTask(t.firm).length]);
  }

  // ---- a card from before P2 (approve/reject only): reject with a note is a round too
  {
    const { t } = await addMission([{ key: 'legacy', roleId: 'development', expectedOutputs: ['ChangeSet'], staffing: { assignees: [buildAgent], reviews: blockingReview } }]);
    await settled(t.legacy);
    const [card] = h.repo.approvals.pendingForTask(t.legacy);
    h.repo.approvals.update(card.id, { options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] });
    await h.services.approvals.decide(caller, card.id, { optionId: 'reject', note: 'Tighten the copy.' });
    check('legacy card: reject with a note starts round 2', task(t.legacy).round === 2 && task(t.legacy).status === 'READY');
  }

  // ---- a check's "Needs changes" becomes feedback (spec §10)
  {
    const after = [{ by: 'responsible', mode: 'after', when: 'always' }];
    const { t } = await addMission([{ key: 'arch', roleId: 'development', expectedOutputs: ['ChangeSet'], staffing: { assignees: [buildAgent], reviews: after } }]);
    await settled(t.arch);
    const [check1] = h.repo.approvals.pendingForTask(t.arch);
    await h.services.approvals.decide(caller, check1.id, { optionId: 'needs_changes', note: 'Split the service boundary.' });
    check('needs changes with no consumers starts round 2', task(t.arch).round === 2 && task(t.arch).status === 'READY' && h.repo.feedback.listByTask(t.arch)[0]?.status === 'in_round');
  }

  // ---- C7: blocking findings from an AI reviewer become feedback and a round; the review is redone and passes
  {
    const { mission, t } = await addMission([
      { key: 'build', roleId: 'development', expectedOutputs: ['ChangeSet'], staffing: { assignees: [buildAgent] } },
      { key: 'review', roleId: 'review', dependsOn: ['build'], order: 1, expectedOutputs: ['ReviewReport'], inputArtifacts: [{ type: 'ChangeSet', required: true }], completionGate: 'artifact.ReviewReport.exists', staffing: { assignees: [reviewAgent] } },
    ]);
    await h.until(() => h.repo.feedback.listByTask(t.build).length > 0, 20000);
    const [finding] = h.repo.feedback.listByTask(t.build);
    check('C7: the finding is a feedback item on build, authored by the review agent and recorded by the engine',
      finding?.authorId === reviewAgent && finding.recordedBy === D.SYSTEM_ACTOR && /The greeting ignores the name/.test(finding.text), finding);
    check('C7: build started round 2 and review waits to be redone', task(t.build).round === 2 && task(t.review).status === 'PENDING', [task(t.build).status, task(t.review).status]);
    await h.until(() => task(t.review).status === 'SUCCEEDED' && h.repo.runs.listByTask(t.review).length === 2, 30000);
    check('C7: the redone review passes and no fix task was planned', !Object.keys(byKey(mission.id)).some((k) => k.startsWith('fix_')) && h.repo.feedback.get(finding.id).status === 'addressed', Object.keys(byKey(mission.id)));
  }

  // ---- fix 6: stopping what a review round overtook fails after the commit: the findings stay a round, never fix tasks too
  {
    const stopOvertaken = h.rounds.stopOvertaken;
    h.rounds.stopOvertaken = () => { throw new Error('cancel failed'); };
    const { mission, t } = await addMission([
      { key: 'build', roleId: 'development', expectedOutputs: ['ChangeSet'], staffing: { assignees: [buildAgent] } },
      { key: 'review', roleId: 'review', dependsOn: ['build'], order: 1, expectedOutputs: ['ReviewReport'], inputArtifacts: [{ type: 'ChangeSet', required: true }], completionGate: 'artifact.ReviewReport.exists', staffing: { assignees: [stubbornAgent] } },
    ]);
    await h.until(() => task(t.build).round >= 2, 20000);
    await h.until(() => false, 500);
    h.rounds.stopOvertaken = stopOvertaken;
    check('fix 6: a failed stop after the commit plans no fix tasks beside the round',
      task(t.build).round >= 2 && !Object.keys(byKey(mission.id)).some((k) => k.startsWith('fix_')), Object.keys(byKey(mission.id)));
  }

  // ---- fix 2: a review that declared no inputs, so its run recorded none, is still redone after the round
  {
    const { t } = await addMission([
      { key: 'build', roleId: 'development', expectedOutputs: ['ChangeSet'], staffing: { assignees: [buildAgent] } },
      { key: 'review', roleId: 'review', dependsOn: ['build'], order: 1, expectedOutputs: ['ReviewReport'], completionGate: 'artifact.ReviewReport.exists', staffing: { assignees: [stubbornAgent] } },
    ]);
    await h.until(() => h.repo.runs.listByTask(t.review).length >= 2 || task(t.build).round >= 2 && ['BLOCKED', 'FAILED'].includes(task(t.review).status), 30000);
    const reviewRuns = [...h.repo.runs.listByTask(t.review)].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const round2 = h.repo.runs.listByTask(t.build).find((r) => r.round === 2);
    check('fix 2: a review with no inputArtifacts gets a second run after the reviewed round',
      task(t.build).round >= 2 && reviewRuns.length >= 2 && round2 !== undefined && reviewRuns[1].startedAt > round2.startedAt,
      { round: task(t.build).round, runs: reviewRuns.length, review: task(t.review).status });
  }

  // ---- the cap: after three AI-started rounds the review escalates instead of a fourth
  {
    const { mission, t } = await addMission([
      { key: 'build', roleId: 'development', expectedOutputs: ['ChangeSet'], staffing: { assignees: [buildAgent] } },
      { key: 'review', roleId: 'review', dependsOn: ['build'], order: 1, expectedOutputs: ['ReviewReport'], inputArtifacts: [{ type: 'ChangeSet', required: true }], completionGate: 'artifact.ReviewReport.exists', staffing: { assignees: [stubbornAgent] } },
    ]);
    await h.until(() => h.repo.approvals.list({ missionId: mission.id, statuses: ['PENDING'] }).some((a) => a.kind === 'intervention'), 60000);
    check('cap: build reached round 4 (three AI rounds) and no further', task(t.build).round === 1 + h.app.MAX_REMEDIATION_CYCLES, task(t.build).round);
    check('cap: the mission is blocked on an intervention card', h.repo.missions.get(mission.id).status === 'BLOCKED');
    const stuck = h.repo.approvals.list({ missionId: mission.id, statuses: ['PENDING'] }).find((a) => a.kind === 'intervention');
    check('fix 4: the escalation reads right for rounds too, with no "remediation cycles"', stuck !== undefined && !/remediation cycles/.test(stuck.rationale), stuck?.rationale);
  }

  // ---- QA defects keep the fix-task flow
  {
    const qaReport = ['results:', '  - criterion: AC1', '    outcome: FAIL', '    evidence: seen', 'blockingDefects: 1'];
    const qa = agent('QA agent', profile('qa', [doc('QAReport', qaReport), { kind: 'complete' }]), ['qa']);
    const { mission } = await addMission([
      { key: 'build', roleId: 'development', expectedOutputs: ['ChangeSet'], staffing: { assignees: [buildAgent] } },
      { key: 'qa', roleId: 'qa', dependsOn: ['build'], order: 1, expectedOutputs: ['QAReport'], completionGate: 'artifact.QAReport.exists', staffing: { assignees: [qa] } },
    ]);
    await h.until(() => Object.keys(byKey(mission.id)).some((k) => k.startsWith('fix_qa_')), 20000);
    check('QA: a blocking defect still becomes fix_ and recheck tasks, and no feedback', Object.keys(byKey(mission.id)).includes('qa_recheck_1') && h.repo.feedback.listByMission(mission.id).length === 0);
  }

  // ---- deciding a card, from records: kept consumers, a check on used output, a running task, and a round that fails to start
  {
    const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Greet visitors', title: 'Records' });
    h.repo.missions.update(mission.id, { status: 'EXECUTING' });
    const f = fixtures(h, ws, mission.id);
    h.db.handle.pragma('foreign_keys = OFF');   // runs point at assignments and targets this fixture does not create
    const pendingOn = (id) => h.repo.approvals.pendingForTask(id);

    // Round 2 awaits review, while build still stands on round 1's version (kept when round 2 started).
    const design = f.addTask('design', 'AWAITING_APPROVAL', { id: 'tsk_rv_design', round: 2 });
    const dV1 = f.addArtifact(design, 'DesignBrief', { id: 'art_rv_design_1', createdAt: f.at(5) });
    f.addRun(design, { id: 'run_rv_design_1', startedAt: f.at(10) });
    const build = f.addTask('build', 'SUCCEEDED', { id: 'tsk_rv_build', dependsOn: ['design'], roleId: 'development', expectedOutputs: ['ChangeSet'], inputArtifacts: [{ type: 'DesignBrief', required: true }] });
    h.repo.runInputs.record(f.addRun(build, { id: 'run_rv_build_1', startedAt: f.at(12) }).id, [dV1.id]);
    f.addArtifact(design, 'DesignBrief', { id: 'art_rv_design_2', supersedes: dV1.id, createdAt: f.at(15), round: 2 });
    f.addRun(design, { id: 'run_rv_design_2', attempt: 2, startedAt: f.at(20), round: 2 });
    const card = f.addCard(design, { id: 'apr_rv_design' });

    // A round that fails to start takes the decision and the note with it.
    const begin = h.rounds.beginRound;
    h.rounds.beginRound = () => { throw new Error('disk full'); };
    const failed = await code(() => h.services.approvals.decide(caller, card.id, { optionId: 'request_changes', note: 'Warmer greeting' }));
    h.rounds.beginRound = begin;
    check('a round that fails to start leaves the card pending, no note and the task as it was',
      failed !== 'ok' && h.repo.approvals.get(card.id).status === 'PENDING' && h.repo.feedback.listByTask(design.id).length === 0 && task(design.id).status === 'AWAITING_APPROVAL',
      [failed, h.repo.approvals.get(card.id).status, h.repo.feedback.listByTask(design.id).length, task(design.id).status]);

    await h.services.approvals.decide(caller, card.id, { optionId: 'request_changes', note: 'Warmer greeting' });
    check('request changes past kept work: round 3 starts and build keeps its version',
      task(design.id).round === 3 && task(design.id).status === 'READY' && task(build.id).status === 'SUCCEEDED', [task(design.id).round, task(design.id).status, task(build.id).status]);
    const decided = h.repo.approvals.get(card.id);
    check('the card is decided once, as Request changes by you, and nothing is left pending on the task',
      decided.status === 'REJECTED' && decided.selectedOptionId === 'request_changes' && decided.decidedBy === owner && pendingOn(design.id).length === 0, decided);

    // A check on output that work already used: the note waits for the person's call.
    const spec = f.addTask('spec', 'SUCCEEDED', { id: 'tsk_rv_spec', roleId: 'product', expectedOutputs: ['ProductSpec'] });
    const sV1 = f.addArtifact(spec, 'ProductSpec', { id: 'art_rv_spec_1', createdAt: f.at(5) });
    f.addRun(spec, { id: 'run_rv_spec_1', startedAt: f.at(4) });
    const impl = f.addTask('impl', 'SUCCEEDED', { id: 'tsk_rv_impl', dependsOn: ['spec'], roleId: 'development', expectedOutputs: ['ChangeSet'], inputArtifacts: [{ type: 'ProductSpec', required: true }] });
    h.repo.runInputs.record(f.addRun(impl, { id: 'run_rv_impl_1', startedAt: f.at(12) }).id, [sV1.id]);
    const checkCard = f.addCard(spec, { id: 'apr_rv_spec', kind: 'check' });
    h.repo.approvals.update(checkCard.id, { options: [{ id: 'looks_good', label: 'Looks good' }, { id: 'needs_changes', label: 'Needs changes' }] });
    await h.services.approvals.decide(caller, checkCard.id, { optionId: 'needs_changes', note: 'Cover the empty state.' });
    const [waiting] = h.repo.feedback.listByTask(spec.id);
    check('needs changes on used output: the note waits open, and nothing reopens',
      waiting?.status === 'open' && task(spec.id).round === 1 && task(spec.id).status === 'SUCCEEDED' && task(impl.id).status === 'SUCCEEDED',
      [waiting?.status, task(spec.id).round, task(spec.id).status]);

    // A check on a task that is running again: the pass reads the note when it ends.
    const copy = f.addTask('copy', 'RUNNING', { id: 'tsk_rv_copy', roleId: 'product', expectedOutputs: ['ProductSpec'] });
    f.addRun(copy, { id: 'run_rv_copy_1', status: 'RUNNING', startedAt: f.at(4) });
    const runningCheck = f.addCard(copy, { id: 'apr_rv_copy', kind: 'check' });
    h.repo.approvals.update(runningCheck.id, { options: [{ id: 'looks_good', label: 'Looks good' }, { id: 'needs_changes', label: 'Needs changes' }] });
    await h.services.approvals.decide(caller, runningCheck.id, { optionId: 'needs_changes', note: 'Shorter headline.' });
    const [queued] = h.repo.feedback.listByTask(copy.id);
    check('needs changes on a running task: the note is queued for the pass', queued?.status === 'queued' && task(copy.id).status === 'RUNNING', [queued?.status, task(copy.id).status]);

    // fix 5: a check answered while a later round's output card waits: that card is decided Request changes, not withdrawn.
    const later = f.addTask('later', 'AWAITING_APPROVAL', { id: 'tsk_rv_later', round: 2, roleId: 'product', expectedOutputs: ['ProductSpec'] });
    f.addRun(later, { id: 'run_rv_later_2', startedAt: f.at(20), round: 2 });
    const laterCheck = f.addCard(later, { id: 'apr_rv_later_check', kind: 'check' });
    h.repo.approvals.update(laterCheck.id, { options: [{ id: 'looks_good', label: 'Looks good' }, { id: 'needs_changes', label: 'Needs changes' }] });
    const laterOutput = f.addCard(later, { id: 'apr_rv_later_output' });
    await h.services.approvals.decide(caller, laterCheck.id, { optionId: 'needs_changes', note: 'Name the plans.' });
    const out = h.repo.approvals.get(laterOutput.id);
    check('fix 5: the pending output card is decided as Request changes with the note, and round 3 starts',
      out.status === 'REJECTED' && out.selectedOptionId === 'request_changes' && out.decisionNote === 'Name the plans.' && out.decidedBy === owner
        && task(later.id).round === 3 && task(later.id).status === 'READY', [out.status, out.selectedOptionId, task(later.id).round]);

    // fix 3: findings on a reviewed task that is already going again are notes on its round, and the review waits to be redone.
    const evaluate = (review, runId) => h.repo.evaluations.createEvaluation({
      id: ids.evaluation(), missionId: mission.id, taskId: review.id, runId, evaluatorRoleId: 'review', verdict: 'fail', summary: 's',
      findings: [{ severity: 'blocking', title: 'Greeting ignores the name', detail: '', location: null, suggestedFix: null }], criteriaCoverage: [], createdAt: f.at(40),
    });
    const kinds = {};
    for (const [key, status] of [['moving', 'RUNNING'], ['queuedup', 'READY']]) {
      const reviewed = f.addTask(key, status, { id: `tsk_rv_${key}`, round: 2, roleId: 'development', expectedOutputs: ['ChangeSet'] });
      f.addArtifact(reviewed, 'ChangeSet', { id: `art_rv_${key}`, createdAt: f.at(5) });
      const review = f.addTask(`${key}_review`, 'SUCCEEDED', { id: `tsk_rv_${key}_review`, dependsOn: [key], roleId: 'review', expectedOutputs: ['ReviewReport'] });
      evaluate(review, f.addRun(review, { id: `run_rv_${key}_review`, startedAt: f.at(30) }).id);
      const routed = h.rounds.fromReviewFindings(task(review.id), h.repo.missions.get(mission.id));
      kinds[key] = { kind: routed.kind, notes: h.repo.feedback.listByTask(reviewed.id).map((i) => [i.status, i.round]), review: task(review.id).status, round: task(reviewed.id).round };
    }
    check('fix 3: on a running task the findings are queued for its pass, and no round or fix task starts',
      kinds.moving.kind === 'noted' && eq(kinds.moving.notes, [['queued', 2]]) && kinds.moving.round === 2, kinds.moving);
    check('fix 3: on a task waiting to run the findings are attached to its round', kinds.queuedup.kind === 'noted' && eq(kinds.queuedup.notes, [['open', 2]]), kinds.queuedup);
    check('fix 3: the review waits to be redone once the round lands', kinds.moving.review === 'PENDING' && kinds.queuedup.review === 'PENDING', kinds);
    check('fix 3: no fix task is planned', !h.repo.tasks.listByMission(mission.id).some((x) => x.key.startsWith('fix_')));

    // Plan ruling 14: the cap counts distinct rounds holding any agent- or runtime-authored note. A dormant open
    // person note (a check's "Needs changes" that waited because work used the output) swept into the next AI
    // round must not hide that round from the cap.
    const worked = f.addTask('worked', 'SUCCEEDED', { id: 'tsk_rv_worked', round: 3, roleId: 'development', expectedOutputs: ['ChangeSet'] });
    f.addArtifact(worked, 'ChangeSet', { id: 'art_rv_worked', createdAt: f.at(5) });
    for (const round of [2, 3]) {
      const item = h.rounds.record({ task: worked, text: `finding ${round}`, artifactId: null, authorId: reviewAgent, recordedBy: 'system', status: 'open', round: null });
      h.repo.feedback.update(item.id, { status: 'addressed', round });
    }
    h.rounds.record({ task: worked, text: 'Cover the empty state.', artifactId: null, authorId: owner, recordedBy: owner, status: 'open', round: null });
    const workedReview = f.addTask('worked_review', 'SUCCEEDED', { id: 'tsk_rv_worked_review', dependsOn: ['worked'], roleId: 'review', expectedOutputs: ['ReviewReport'] });
    evaluate(workedReview, f.addRun(workedReview, { id: 'run_rv_worked_review', startedAt: f.at(30) }).id);
    const third = h.rounds.fromReviewFindings(task(workedReview.id), h.repo.missions.get(mission.id));
    check('cap: after two AI rounds a third finding starts round 4, sweeping in the dormant person note',
      third.kind === 'round' && task(worked.id).round === 4 && h.repo.feedback.listByTask(worked.id).filter((i) => i.round === 4).length === 2, third.kind);
    h.repo.tasks.update(worked.id, { status: 'SUCCEEDED' });
    h.repo.tasks.update(workedReview.id, { status: 'SUCCEEDED' });
    evaluate(workedReview, f.addRun(workedReview, { id: 'run_rv_worked_review_2', attempt: 2, startedAt: f.at(50) }).id);
    const fourth = h.rounds.fromReviewFindings(task(workedReview.id), h.repo.missions.get(mission.id));
    check('cap: the round with the person note still counts, so the fourth finding escalates', fourth.kind === 'exhausted' && task(worked.id).round === 4, [fourth.kind, task(worked.id).round]);

    // The noted path holds the review's dependents with a reason about the reviewed task's round.
    const held = f.addTask('held', 'RUNNING', { id: 'tsk_rv_held', round: 2, roleId: 'development', expectedOutputs: ['ChangeSet'] });
    f.addArtifact(held, 'ChangeSet', { id: 'art_rv_held', createdAt: f.at(5) });
    const heldReview = f.addTask('held_review', 'SUCCEEDED', { id: 'tsk_rv_held_review', dependsOn: ['held'], roleId: 'review', expectedOutputs: ['ReviewReport'] });
    const afterReview = f.addTask('after_review', 'READY', { id: 'tsk_rv_after_review', dependsOn: ['held_review'], startedAt: null });
    evaluate(heldReview, f.addRun(heldReview, { id: 'run_rv_held_review', startedAt: f.at(30) }).id);
    h.rounds.fromReviewFindings(task(heldReview.id), h.repo.missions.get(mission.id));
    check("noted: the review's dependent waits on the reviewed task's round, and says so",
      task(afterReview.id).status === 'PENDING' && task(afterReview.id).statusReason === "Waiting for 'held' round 2.", task(afterReview.id));

    // Needs changes without a note keeps P0's flag.
    const plain = f.addTask('plain', 'SUCCEEDED', { id: 'tsk_rv_plain', roleId: 'product', expectedOutputs: ['ProductSpec'] });
    const plainCheck = f.addCard(plain, { id: 'apr_rv_plain', kind: 'check' });
    h.repo.approvals.update(plainCheck.id, { options: [{ id: 'looks_good', label: 'Looks good' }, { id: 'needs_changes', label: 'Needs changes' }] });
    await h.services.approvals.decide(caller, plainCheck.id, { optionId: 'needs_changes' });
    check('needs changes without a note flags the task and writes no feedback',
      task(plain.id).needsAttention === true && task(plain.id).round === 1 && h.repo.feedback.listByTask(plain.id).length === 0);
  }

  await h.container.dispose();
  clearInterval(keepAlive);
}

section('final review: engine, service and view fixes');
{
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { systemClock, ids } = await import('@tandemise/shared');
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const D = await import('@tandemise/domain');
  const keepAlive = setInterval(() => {}, 1000);
  const HOME = mkdtempSync(join(tmpdir(), 'trf-'));
  const h = await engineHarness(HOME, 'rounds-final-check');
  const now = () => systemClock.now();
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Final' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const task = (id) => h.repo.tasks.get(id);
  const message = async (fn) => { try { await fn(); return ''; } catch (e) { return `${e.code}: ${e.message}`; } };
  const gitInit = (dir) => {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  };
  const fixtureMission = async (title) => {
    const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Greet visitors', title });
    h.repo.missions.update(mission.id, { status: 'EXECUTING' });
    return { mission, f: fixtures(h, ws, mission.id) };
  };
  h.db.handle.pragma('foreign_keys = OFF');   // runs point at assignments and targets these fixtures do not create

  // ---- A1: a delivery pass that changes the work is checked again before it is judged
  {
    const repoDir = join(HOME, 'checked-repo');
    gitInit(repoDir);
    const repository = h.container.resolve(h.app.REPO_REPOSITORY).create({
      id: ids.repository(), workspaceId: ws, name: 'checked', path: repoDir, defaultBranch: 'main', remoteUrl: null,
      checks: { ...D.NO_CHECKS, test: 'test ! -f broken' },
    });
    const changeSet = (changed) => ['---', 'type: ChangeSet', 'title: Build', 'handoff:', '  headline: Built',
      ...(changed ? ['  changed:', '    - what: "Named the pricing page"', '      feedback: "{{fb}}"'] : []),
      'branch: b', 'commits: []', 'filesChanged: 1', 'testsRun: []', 'knownLimitations: []', '---', '', 'Built.', ''].join('\n');
    const IN_ROUND = { promptIncludes: 'Feedback to address' };
    const profileId = h.repo.profiles.create({
      id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name: 'breaks-tests', executablePath: null, args: [],
      settings: { script: { steps: [
        { kind: 'checkpoint', sessionId: 'sess-a1', label: 'session.init' },
        { kind: 'write-file', path: '.tandemise/out/ChangeSet.md', content: changeSet(false) },
        { kind: 'delay', ms: 1500 },
        { kind: 'write-file', path: 'broken', content: 'the delivery broke the tests', when: IN_ROUND },
        { kind: 'write-file', path: '.tandemise/out/ChangeSet.md', content: changeSet(true), when: IN_ROUND },
        { kind: 'complete', summary: 'done' },
      ], captures: { fb: '^\\d+\\. (fb_[0-9a-z]{20}) \\(' } } },
      capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
    }).id;
    const breaker = h.services.team.addMember(caller, ws, { kind: 'agent', name: 'Test breaker', reportsTo: owner, roleIds: ['development'], runtimeProfileIds: [profileId] }).id;
    const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Build', title: 'A1' });
    gitInit(h.paths.mission(ws, mission.id));
    const build = h.repo.tasks.add({
      id: ids.task(), missionId: mission.id, key: 'build', title: 'build', objective: 'o', roleId: 'development', dependsOn: [], requiredCapabilities: [],
      inputArtifacts: [], expectedOutputs: ['ChangeSet'], executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
      approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'block' },
      completionGate: 'checks.tests == PASS', status: 'READY', statusReason: null, attempts: 0, remediatesTaskId: null, repositoryId: repository.id,
      executor: 'agent', waitPolicy: null, orderHint: 0, staffingOverride: { assignees: [breaker] }, createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
    }).id;
    h.repo.missions.update(mission.id, { status: 'EXECUTING' });
    await h.until(() => h.repo.runs.listByTask(build).some((r) => r.status === 'RUNNING'), 10000);
    h.services.feedback.give(caller, build, { text: 'Name the pricing page' });
    await h.until(() => ['SUCCEEDED', 'BLOCKED', 'FAILED', 'AWAITING_APPROVAL'].includes(task(build).status), 20000);
    const delivery = h.repo.runs.listByTask(build).find((r) => r.purpose === 'feedback');
    const gates = h.repo.events.listByMission(mission.id).filter((e) => e.body.type === 'gate.evaluated');
    check('A1: the delivery pass that broke the tests fails the gate on the new check results',
      delivery !== undefined && task(build).status === 'BLOCKED' && gates.at(-1)?.runId === delivery.id && gates.at(-1)?.body.passed === false,
      { s: task(build).status, delivery: delivery?.status, gates: gates.map((g) => [g.runId === delivery?.id, g.body.passed]) });
    check('A1: the checks ran again for the delivery run',
      h.container.resolve(h.app.EVALUATION_REPOSITORY).listChecks(build).some((c) => c.runId === delivery?.id && c.outcome === 'FAIL'));
  }

  // ---- A2: a daemon killed during a round-2 tighten lands the round when it is settled on restart
  {
    const { mission, f } = await fixtureMission('A2');
    const design = f.addTask('design', 'RUNNING', { id: 'tsk_a2_design', round: 2, attempts: 2 });
    h.repo.tasks.update(design.id, { retryPolicy: { maxAttempts: 4, backoffMs: 0, onExhausted: 'block' } });
    const v1 = f.addArtifact(design, 'DesignBrief', { id: 'art_a2_v1', round: 1, createdAt: f.at(5) });
    const build = f.addTask('build', 'SUCCEEDED', { id: 'tsk_a2_build', dependsOn: ['design'], roleId: 'development', expectedOutputs: ['ChangeSet'], inputArtifacts: [{ type: 'DesignBrief', required: true }] });
    h.repo.runInputs.record(f.addRun(build, { id: 'run_a2_build', startedAt: f.at(8) }).id, [v1.id]);
    const note = h.rounds.record({ task: design, text: 'Warmer greeting', artifactId: null, authorId: owner, recordedBy: owner, status: 'open', round: null });
    h.repo.feedback.update(note.id, { status: 'in_round', round: 2 });
    const first = f.addRun(design, { id: 'run_a2_round', attempt: 2, startedAt: f.at(20), round: 2 });
    const draft = f.addArtifact(design, 'DesignBrief', { id: 'art_a2_v2', round: 2, supersedes: v1.id, createdAt: f.at(25), changed: [{ what: 'Warmer greeting', feedback: note.id }] });
    h.db.handle.prepare('UPDATE artifacts SET over_budget = 1, created_by_run_id = ? WHERE id = ?').run(first.id, draft.id);
    const scope = { workspaceId: ws, missionId: mission.id, taskId: design.id, roleId: 'design' };
    h.recorder.record(scope, { type: 'task.status', from: 'READY', to: 'RUNNING' });
    h.recorder.record({ ...scope, runId: first.id }, { type: 'artifact.tighten_requested', types: ['DesignBrief'], attempt: 2 });
    f.addRun(design, { id: 'run_a2_tighten', attempt: 3, status: 'RUNNING', startedAt: f.at(30), round: 2 });
    h.repo.runs.update('run_a2_tighten', { purpose: 'tighten' });
    await h.container.resolve(h.app.RECOVERY_SERVICE).run();
    await h.until(() => task(design.id).status === 'SUCCEEDED', 10000);
    check('A2: after the restart the round settles, and its cited note is addressed in round 2',
      task(design.id).status === 'SUCCEEDED' && h.repo.feedback.get(note.id).status === 'addressed' && h.repo.feedback.get(note.id).round === 2,
      { s: task(design.id).status, r: task(design.id).statusReason, fb: h.repo.feedback.get(note.id) });
    check('A2: the build kept on round 1 is told a newer version is out', task(build.id).needsAttention === true, task(build.id));
  }

  // ---- A3: work downstream that has not run is held when upstream goes again, and a start card waits for it
  {
    const { mission, f } = await fixtureMission('A3');
    const design = f.addTask('design', 'SUCCEEDED', { id: 'tsk_a3_design' });
    f.addArtifact(design, 'DesignBrief', { id: 'art_a3_design' });
    const docs = f.addTask('docs', 'AWAITING_HUMAN', { id: 'tsk_a3_docs', dependsOn: ['design'], executor: 'human', startedAt: null, attempts: 0, expectedOutputs: ['Evidence'] });
    const gated = f.addTask('gated', 'AWAITING_APPROVAL', { id: 'tsk_a3_gated', dependsOn: ['design'], startedAt: null, attempts: 0 });
    const startCard = f.addCard(gated, { id: 'apr_a3_gated' });
    h.repo.approvals.update(startCard.id, { evidence: [] });
    const given = h.services.feedback.give(caller, design.id, { text: 'Calmer colours' });
    check('A3: the round starts on design, with nothing that used it', given.roundStarted === 2, given);
    check("A3: a person step downstream waits again, and says for what",
      task(docs.id).status === 'PENDING' && task(docs.id).statusReason === "Waiting for round 2 of 'design'.", [task(docs.id).status, task(docs.id).statusReason]);
    check('A3: the person step cannot be completed on the old version',
      await code(() => h.services.missions.completeTask(caller, docs.id, { result: 'Done anyway' })) !== 'ok' && task(docs.id).status === 'PENDING');
    check('A3: a start card downstream is withdrawn and its task waits again',
      task(gated.id).status === 'PENDING' && h.repo.approvals.get(startCard.id).status === 'CANCELLED', [task(gated.id).status, h.repo.approvals.get(startCard.id).status]);
    // A start card approved while a dependency is going again does not let the task run on the old version.
    const late = f.addTask('late', 'AWAITING_APPROVAL', { id: 'tsk_a3_late', dependsOn: ['design'], startedAt: null, attempts: 0 });
    const lateCard = f.addCard(late, { id: 'apr_a3_late' });
    h.repo.approvals.update(lateCard.id, { evidence: [], options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] });
    await h.services.approvals.decide(caller, lateCard.id, { optionId: 'approve' });
    check('A3: approving a start card while its dependency is not done leaves the task waiting, not READY',
      task(late.id).status === 'PENDING', [task(late.id).status, task(late.id).statusReason]);
    void mission;
  }

  // ---- A4: a dependent redone in a later round is told its input changed, not asked to cite nothing
  {
    const { mission, f } = await fixtureMission('A4');
    const design = f.addTask('design', 'READY', { id: 'tsk_a4_design', round: 3 });
    const build = f.addTask('build', 'PENDING', { id: 'tsk_a4_build', dependsOn: ['design'], round: 2, roleId: 'development', expectedOutputs: ['ChangeSet'] });
    const earlierNote = h.rounds.record({ task: build, text: 'Log the visitor name', artifactId: null, authorId: owner, recordedBy: owner, status: 'open', round: null });
    h.repo.feedback.update(earlierNote.id, { status: 'addressed', round: 2 });
    f.addRun(build, { id: 'run_a4_build', startedAt: f.at(20), round: 2 });
    h.recorder.record({ workspaceId: ws, missionId: mission.id, taskId: design.id, roleId: 'design', actorId: owner },
      { type: 'task.round_started', round: 3, feedbackIds: [], downstream: 'redo', redone: ['build'] });
    const brief = await h.rounds.openRound(task(build.id));
    const text = brief === null ? '' : h.app.renderRoundBrief(brief, (type) => `.tandemise/out/${type}.md`);
    check("A4: the redone dependent's brief says what changed upstream", text.includes("Work this builds on changed: 'design' round 3. Update your previous output to match; keep what still applies."), text.slice(0, 300));
    check('A4: it has no empty "Feedback to address" and no instruction to cite every item',
      text !== '' && !text.includes('Feedback to address') && !text.includes('Cite every item') && !text.includes('asked for changes'), text);
    check("A4: notes addressed in this task's own round are still context", text.includes('Log the visitor name'), text);
  }

  // ---- A5: a cancelled mission takes no more rounds
  {
    const { mission, f } = await fixtureMission('A5');
    const doc = f.addTask('doc', 'SUCCEEDED', { id: 'tsk_a5_doc' });
    f.addArtifact(doc, 'DesignBrief', { id: 'art_a5_doc' });
    const open = h.rounds.record({ task: doc, text: 'Before the cancel', artifactId: null, authorId: owner, recordedBy: owner, status: 'open', round: null });
    h.repo.missions.update(mission.id, { status: 'CANCELLED' });
    const refusedGive = await message(() => h.services.feedback.give(caller, doc.id, { text: 'After the cancel' }));
    const refusedStart = await message(() => h.services.feedback.startRound(caller, doc.id, { feedbackIds: [open.id], downstream: 'keep' }));
    check('A5: giving feedback on a cancelled mission is refused, in words a person reads',
      refusedGive === 'PRECONDITION_FAILED: This mission was cancelled; start a new mission to continue this work.', refusedGive);
    check('A5: starting a round on a cancelled mission is refused the same way',
      refusedStart === 'PRECONDITION_FAILED: This mission was cancelled; start a new mission to continue this work.' && task(doc.id).round === 1, refusedStart);
    const card = h.services.projections.missionFeed(mission.id, caller, { doneLimit: 100 }).done.find((c) => c.key === 'doc');
    check('A5: its cards offer no Request changes', card?.canRequestChanges === false, card?.canRequestChanges);
  }

  // ---- B1 and B2: a retry note wakes the scheduler after its commit; refusals name tasks and outputs, not ids
  {
    const { mission, f } = await fixtureMission('B');
    const failed = f.addTask('failed', 'FAILED', { id: 'tsk_b_failed' });
    const wakes = [];
    const wake = h.scheduler.wake;
    h.scheduler.wake = () => { wakes.push(h.db.handle.inTransaction); };
    await h.services.missions.retryTask(caller, failed.id, { note: 'Use the brand palette' });
    h.scheduler.wake = wake;
    check('B1: a retry that becomes a round wakes the scheduler only after its unit has committed',
      wakes.length > 0 && wakes.every((inside) => inside === false) && task(failed.id).round === 2, wakes);
    const design = f.addTask('design', 'SUCCEEDED', { id: 'tsk_b_design' });
    const dV1 = f.addArtifact(design, 'DesignBrief', { id: 'art_b_design' });
    const build = f.addTask('build', 'SUCCEEDED', { id: 'tsk_b_build', dependsOn: ['design'], expectedOutputs: ['ChangeSet'] });
    h.repo.runInputs.record(f.addRun(build, { id: 'run_b_build' }).id, [dV1.id]);
    const lonely = f.addTask('lonely', 'SUCCEEDED', { id: 'tsk_b_lonely' });
    const note = h.services.feedback.give(caller, design.id, { text: 'Darker header' });
    const redoWrong = await message(() => h.services.feedback.startRound(caller, design.id, { feedbackIds: [note.feedback.id], downstream: 'redo', redoTaskIds: [lonely.id] }));
    const wrongOutput = await message(() => h.services.feedback.give(caller, lonely.id, { text: 'x', artifactId: dV1.id }));
    // B3: "Start round" sends "none" when its fresh read saw nothing downstream; a consumer that appeared since is refused, never kept silently.
    const { startRoundRequest } = await import('@tandemise/api-contract');
    check('B3: a round request may say that nothing downstream is affected', startRoundRequest.safeParse({ feedbackIds: ['fb_x'], downstream: 'none' }).success);
    const noneWithConsumer = await message(() => h.services.feedback.startRound(caller, design.id, { feedbackIds: [note.feedback.id], downstream: 'none' }));
    check('B3: "none" past work that used the output is refused and changes nothing',
      noneWithConsumer.startsWith('VALIDATION') && task(design.id).round === 1 && h.repo.feedback.get(note.feedback.id).status === 'open', noneWithConsumer);
    check('B2: refusals about tasks and outputs carry no raw ids',
      redoWrong !== '' && wrongOutput !== '' && !/tsk_|art_/.test(redoWrong) && !/tsk_|art_/.test(wrongOutput), [redoWrong, wrongOutput]);
    void mission;
  }

  // ---- B4: a round joins every open note, and the card it decides quotes all of them
  {
    const { f } = await fixtureMission('B4');
    const reviewed = f.addTask('reviewed', 'AWAITING_APPROVAL', { id: 'tsk_b4_reviewed' });
    f.addRun(reviewed, { id: 'run_b4_reviewed', startedAt: f.at(20) });
    const card = f.addCard(reviewed, { id: 'apr_b4_reviewed' });
    const first = h.rounds.record({ task: reviewed, text: 'Bigger buttons', artifactId: null, authorId: owner, recordedBy: owner, status: 'open', round: null });
    const second = h.rounds.record({ task: reviewed, text: 'Friendlier copy', artifactId: null, authorId: owner, recordedBy: owner, status: 'open', round: null });
    h.services.feedback.startRound(caller, reviewed.id, { feedbackIds: [first.id], downstream: 'keep' });
    const decided = h.repo.approvals.get(card.id);
    check('B4: the decided card quotes every note that joined the round',
      decided.status === 'REJECTED' && decided.decisionNote.includes('Bigger buttons') && decided.decisionNote.includes('Friendlier copy')
        && h.repo.feedback.get(second.id).status === 'in_round', decided.decisionNote);
    // The composer's flash says how many notes the round took, which is more than the one just sent when others waited.
    const waited = f.addTask('waited', 'SUCCEEDED', { id: 'tsk_b4_waited' });
    f.addArtifact(waited, 'DesignBrief', { id: 'art_b4_waited' });
    h.rounds.record({ task: waited, text: 'An earlier note', artifactId: null, authorId: owner, recordedBy: owner, status: 'open', round: null });
    const sent = h.services.feedback.give(caller, waited.id, { text: 'And this one' });
    check('B4: a note that starts a round reports every note the round carries', sent.roundStarted === 2 && sent.roundNotes === 2, sent);
  }

  // ---- B5: a planned task that names no inputs reads what its dependencies produce
  {
    const plan = h.app.parsePlanResponse(JSON.stringify({ summary: 's', tasks: [
      { key: 'spec', title: 'Spec', objective: 'o', roleId: 'product', expectedOutputs: ['ProductSpec'] },
      { key: 'design', title: 'Design', objective: 'o', roleId: 'design', dependsOn: ['spec'], expectedOutputs: ['DesignBrief'] },
      { key: 'build', title: 'Build', objective: 'o', roleId: 'development', dependsOn: ['design'], inputArtifacts: [{ type: 'ProductSpec', required: true }], expectedOutputs: ['ChangeSet'] },
    ] }));
    const tasks = plan.ok ? h.app.materializePlan(plan.value, 'msn_b5', systemClock, [], { inferInputs: true }) : [];
    const byKey = Object.fromEntries(tasks.map((t) => [t.key, t]));
    check('B5: a planned task with no inputs reads the types its direct dependencies produce',
      eq(byKey.design?.inputArtifacts, [{ type: 'ProductSpec', required: false }]), byKey.design?.inputArtifacts);
    check('B5: inputs the planner named are kept as written', eq(byKey.build?.inputArtifacts, [{ type: 'ProductSpec', required: true }]), byKey.build?.inputArtifacts);
    check('C7: one task reads "1 task", not "1 tasks"', h.app.describePlan({ summary: '', tasks: [byKey.spec] }) === '1 task: product', plan.ok && h.app.describePlan({ summary: '', tasks: [byKey.spec] }));
  }

  // ---- C2 and C3: a round's reason names no one, and a card counts the notes a round that has not run will carry
  {
    const { mission, f } = await fixtureMission('C');
    const lone = f.addTask('lone', 'SUCCEEDED', { id: 'tsk_c_lone' });
    f.addArtifact(lone, 'DesignBrief', { id: 'art_c_lone' });
    h.repo.missions.update(mission.id, { status: 'PAUSED' });
    h.services.feedback.give(caller, lone.id, { text: 'Shorter intro' });
    h.services.feedback.give(caller, lone.id, { text: 'Friendlier button' });
    check('C2: the round reason names no one', task(lone.id).statusReason === 'Round 2: changes requested', task(lone.id).statusReason);
    const card = h.services.projections.missionFeed(mission.id, caller, { doneLimit: 100 }).inProgress.find((c) => c.key === 'lone');
    check('C3: the card of a round that has not run carries both of its notes',
      card?.openFeedback.length === 2 && card.openFeedback.every((i) => i.round === 2), card?.openFeedback.map((i) => [i.status, i.round]));
  }

  // ---- C5: a kept consumer is flagged by the engine, as work on an older version
  {
    const { mission, f } = await fixtureMission('C5');
    const design = f.addTask('design', 'SUCCEEDED', { id: 'tsk_c5_design', round: 2 });
    const v1 = f.addArtifact(design, 'DesignBrief', { id: 'art_c5_v1', round: 1, createdAt: f.at(5) });
    const build = f.addTask('build', 'SUCCEEDED', { id: 'tsk_c5_build', dependsOn: ['design'], roleId: 'development', expectedOutputs: ['ChangeSet'] });
    h.repo.runInputs.record(f.addRun(build, { id: 'run_c5_build', startedAt: f.at(8) }).id, [v1.id]);
    const v2 = f.addArtifact(design, 'DesignBrief', { id: 'art_c5_v2', round: 2, supersedes: v1.id, createdAt: f.at(25) });
    h.rounds.onRoundLanded(task(design.id), [v2], { workspaceId: ws, missionId: mission.id, taskId: design.id, roleId: 'design', actorId: 'mem_design_agent' });
    const flag = h.repo.events.listByMission(mission.id).find((e) => e.body.type === 'task.attention' && e.taskId === build.id);
    check('C5: the flag is the engine\'s, marked as work on an older version of design',
      flag?.actorId === D.SYSTEM_ACTOR && flag.body.kind === 'stale_input' && flag.body.upstream === 'design', flag && { actor: flag.actorId, body: flag.body });
    // Polish: the flag carries no role, so the timeline credits it to
    // Tandemise/system - not to the consumer's own role label ('Developer'),
    // which would read as if that role reported the stale-input note itself.
    check('polish: the kept-consumer flag carries no roleId, so the timeline credits it to Tandemise, not the consumer\'s role',
      flag?.roleId === null || flag?.roleId === undefined, flag && { roleId: flag.roleId });
    const view = await h.services.projections.taskView(build.id);
    check('C5: the task view says why the task is flagged', view.attention?.kind === 'stale_input' && view.attention.upstream === 'design', view.attention);
  }

  await h.container.dispose();
  clearInterval(keepAlive);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
