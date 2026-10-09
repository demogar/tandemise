// Plan fit: a step's handoff can say `stop`, and the steps after it wait for a person
// (docs/superpowers/specs/2026-10-03-plan-fit-design.md).
//
//   npm run build && node scratch/plan-fit-check.mjs
import { handoffSchema, renderArtifactTemplate } from '@tandemise/artifacts';

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);

section('the handoff can say stop');
{
  const stop = 'The role is US-only, so the steps after this have nothing to work on.';
  const parsed = handoffSchema.safeParse({ headline: 'Stopped before the CV', stop: `  ${stop}  ` });
  check('stop is accepted and trimmed', parsed.success && parsed.data.stop === stop, parsed.success ? parsed.data : parsed.error.issues);
  const absent = handoffSchema.safeParse({ headline: 'Done' });
  check('a handoff without stop has no stop key (stored handoffs stay as they were)', absent.success && !('stop' in absent.data), absent.success ? absent.data : null);
  const blank = handoffSchema.safeParse({ headline: 'Done', stop: '' });
  check('a blank stop means no stop', blank.success && !('stop' in blank.data), blank.success ? blank.data : blank.error.issues);
  const long = handoffSchema.safeParse({ headline: 'Done', stop: 'x'.repeat(201) });
  check('a stop over 200 characters is refused, naming the field', !long.success && long.error.issues.some((i) => /handoff\.stop/.test(i.message)), long.success ? null : long.error.issues.map((i) => i.message));
  const template = renderArtifactTemplate('DesignBrief') ?? '';
  check('every template tells the worker what stop is for', /^  stop: <.*steps after yours should not run as planned/m.test(template), template.slice(0, 1500));
}

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
  return { app, container, services, scheduler, repo, recorder, paths, until };
}


section('engine: the steps after a stop wait for a person');
{
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { systemClock, ids } = await import('@tandemise/shared');
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const keepAlive = setInterval(() => {}, 1000);
  const HOME = mkdtempSync(join(tmpdir(), 'tpf-'));
  const h = await engineHarness(HOME, 'plan-fit-check');
  const now = () => systemClock.now();

  const STOP = 'The role is US-only, so the steps after this have nothing to work on.';
  const brief = ({ stop = null, headline = 'Looked into the role', cites = false } = {}) => [
    '---', 'type: DesignBrief', 'title: Intake',
    'handoff:', `  headline: ${headline}`, '  needs: Decide whether to skip it',
    ...(stop === null ? [] : [`  stop: ${stop}`]),
    // A round answers its note, as rounds require; the fake reads the note's id out of the prompt.
    ...(cites ? ['  changed:', '    - what: Checked with the person, so the plan holds', '      feedback: {{fb}}'] : []),
    'flows:', '  - intake', '---', '', '# Intake', '', 'What I found.', '',
  ].join('\n');
  const OUT = '.tandemise/out/DesignBrief.md';
  const done = { kind: 'complete', summary: 'done' };
  const echo = { kind: 'message', text: 'PROMPT {{prompt}}' };
  const profile = (name, steps) => h.repo.profiles.create({
    id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name, executablePath: null,
    args: [], settings: { script: { steps, captures: { fb: '(fb_[0-9a-z]{20})' } } }, capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
  }).id;
  // Stops in its first round; a round briefed with ROUND-NOTE writes the same brief without the stop.
  const stopper = profile('stopper', [echo,
    { kind: 'write-file', path: OUT, content: brief({ stop: STOP, headline: 'The role is US-only' }) },
    { kind: 'write-file', path: OUT, content: brief({ headline: 'Panama counts, so the plan holds', cites: true }), when: { promptIncludes: 'ROUND-NOTE' } },
    done]);
  const plain = profile('plain', [echo, { kind: 'write-file', path: OUT, content: brief() }, done]);

  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Plan fit' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const agentOn = (name, profileId) => h.services.team.addMember(caller, ws, { kind: 'agent', name, reportsTo: owner, roleIds: ['design'], runtimeProfileIds: [profileId] }).id;
  const agents = { stopper: agentOn('Stopper', stopper), plain: agentOn('Plain', plain) };

  let seq = 0;
  /** A chain of steps on the given agents: the first has no dependency, each next depends on the one before. */
  const addMission = async (chain, { title } = {}) => {
    const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Apply to the role', title: title ?? `F${++seq}` });
    const dir = h.paths.mission(ws, mission.id);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const rows = {};
    chain.forEach(([key, agent], index) => {
      const row = {
        id: ids.task(), missionId: mission.id, key, title: key, objective: `Do ${key}`, roleId: 'design',
        dependsOn: index === 0 ? [] : [chain[index - 1][0]], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: ['DesignBrief'],
        executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
        approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'fail' },
        completionGate: null, status: index === 0 ? 'READY' : 'PENDING', statusReason: null,
        attempts: 0, remediatesTaskId: null, repositoryId: null, executor: 'agent', waitPolicy: null, orderHint: index,
        staffingOverride: { assignees: [agents[agent]] },
        createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
      };
      h.repo.tasks.add(row);
      rows[key] = row.id;
    });
    h.repo.missions.update(mission.id, { status: 'EXECUTING' });
    return { mission, t: rows };
  };
  const task = (id) => h.repo.tasks.get(id);
  const cards = (missionId) => h.repo.approvals.list({ missionId }).filter((a) => a.options.some((o) => o.id === 'skip_rest'));
  const live = (taskId) => {
    const all = h.repo.artifacts.listByTask(taskId);
    const superseded = new Set(all.map((a) => a.supersedes).filter(Boolean));
    return all.filter((a) => !superseded.has(a.id));
  };
  const reason = (key) => `Waiting for you: '${key}' says the plan no longer fits.`;

  // ---- a stop holds the next step, once
  const one = await addMission([['intake', 'stopper'], ['answer', 'plain'], ['verify', 'plain']]);
  await h.until(() => task(one.t.intake).status === 'SUCCEEDED' && cards(one.mission.id).length > 0);
  for (let i = 0; i < 5; i++) await h.scheduler.tick();
  const [card] = cards(one.mission.id);
  check('the step that said stop succeeds: its work is done', task(one.t.intake).status === 'SUCCEEDED', task(one.t.intake));
  check('the step after it stays PENDING, saying why', task(one.t.answer).status === 'PENDING' && task(one.t.answer).statusReason === reason('intake'),
    { s: task(one.t.answer).status, r: task(one.t.answer).statusReason });
  // A mission holding only these steps waits on a person; marked BLOCKED, it would never be dispatched again.
  check('the mission keeps EXECUTING while it waits', h.repo.missions.get(one.mission.id).status === 'EXECUTING', h.repo.missions.get(one.mission.id).status);
  check('exactly one card, however many ticks', cards(one.mission.id).length === 1, cards(one.mission.id).length);
  check('the card is an intervention on the stopping step, its rationale the stop', card?.kind === 'intervention' && card.taskId === one.t.intake && card.rationale === STOP, card);
  check('it offers skip, send back, plan the rest again and continue, skip recommended',
    JSON.stringify(card?.options.map((o) => o.id)) === JSON.stringify(['skip_rest', 'request_changes', 'replan_rest', 'continue_plan']) && card.recommendedOptionId === 'skip_rest', card?.options);
  check('it names the stopped output and what it needs', card?.evidence.some((e) => e.kind === 'artifact' && e.value === live(one.t.intake)[0]?.id) && card.evidence.some((e) => e.value === 'Decide whether to skip it'), card?.evidence);
  check('it goes to the person responsible', card?.addressees?.includes(owner), card?.addressees);

  // ---- skip the steps after it
  await h.services.approvals.decide(caller, card.id, { optionId: 'skip_rest' });
  await h.until(() => h.repo.missions.get(one.mission.id).status === 'COMPLETE');
  check('skip: every step after it is SKIPPED, saying why',
    ['answer', 'verify'].every((k) => task(one.t[k]).status === 'SKIPPED' && task(one.t[k]).statusReason === "Skipped: 'intake' said the plan no longer fits."),
    ['answer', 'verify'].map((k) => [task(one.t[k]).status, task(one.t[k]).statusReason]));
  check('skip: the mission finishes on what was done', h.repo.missions.get(one.mission.id).status === 'COMPLETE', h.repo.missions.get(one.mission.id).status);
  check('skip: nothing after it ever ran', h.repo.runs.listByTask(one.t.answer).length === 0 && h.repo.runs.listByTask(one.t.verify).length === 0);

  // ---- continue as planned
  const two = await addMission([['intake', 'stopper'], ['answer', 'plain']]);
  await h.until(() => cards(two.mission.id).length > 0);
  await h.services.approvals.decide(caller, cards(two.mission.id)[0].id, { optionId: 'continue_plan' });
  await h.until(() => task(two.t.answer).status === 'SUCCEEDED');
  check('continue: the next step runs on what it wrote', task(two.t.answer).status === 'SUCCEEDED', task(two.t.answer));
  check('continue: the card reads approved', cards(two.mission.id)[0].status === 'APPROVED', cards(two.mission.id)[0].status);
  check('continue: no second card', cards(two.mission.id).length === 1);

  // ---- send it back with a note
  const three = await addMission([['intake', 'stopper'], ['answer', 'plain']]);
  await h.until(() => cards(three.mission.id).length > 0);
  const empty = await h.services.approvals.decide(caller, cards(three.mission.id)[0].id, { optionId: 'request_changes' }).then(() => null, (e) => e.code);
  check('send back: a note is required', empty === 'VALIDATION', empty);
  await h.services.approvals.decide(caller, cards(three.mission.id)[0].id, { optionId: 'request_changes', note: 'ROUND-NOTE: Panama counts as Americas, go on.' });
  await h.until(() => task(three.t.answer).status === 'SUCCEEDED');
  check('send back: the step ran again as round 2', task(three.t.intake).round === 2 && task(three.t.intake).status === 'SUCCEEDED', task(three.t.intake));
  check('send back: round 2 no longer says stop, so the next step ran on it', task(three.t.answer).status === 'SUCCEEDED' && (live(three.t.intake)[0]?.handoff?.stop ?? null) === null, live(three.t.intake)[0]?.handoff);
  check('send back: no new card for round 2', cards(three.mission.id).length === 1);

  // ---- no stop, no hold
  const four = await addMission([['intake', 'plain'], ['answer', 'plain']]);
  await h.until(() => task(four.t.answer).status === 'SUCCEEDED');
  check('without a stop nothing waits and no card is filed', task(four.t.answer).status === 'SUCCEEDED' && cards(four.mission.id).length === 0);

  clearInterval(keepAlive);
  h.scheduler.stop?.();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
