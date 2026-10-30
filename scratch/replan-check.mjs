// Replan the rest: a new plan for what is left, keeping what is done
// (docs/superpowers/specs/2026-10-09-replan-the-rest-design.md).
//
//   npm run build && node scratch/replan-check.mjs
import { mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const D = await import('@tandemise/domain');
const app = await import('@tandemise/application');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

section('what a replan keeps');
{
  const t = (key, extra = {}) => ({ id: `t_${key}`, key, dependsOn: [], attempts: 0, startedAt: null, round: 1, status: 'PENDING', ...extra });
  const tasks = [
    t('upload', { status: 'SKIPPED' }),
    t('intake', { dependsOn: ['upload'], attempts: 1, startedAt: 'x', status: 'SUCCEEDED' }),
    t('answer', { dependsOn: ['intake'] }),
    t('person', { dependsOn: ['intake'], status: 'AWAITING_HUMAN', startedAt: 'x' }),
    t('ran_once', { dependsOn: ['intake'] }),
    t('never', { dependsOn: ['answer'], status: 'SKIPPED' }),
  ];
  const split = D.splitForReplan(tasks, new Set(['t_ran_once']));
  check('started steps are kept: an attempt, a start, a run', eq(split.kept.map((x) => x.key).sort(), ['intake', 'person', 'ran_once', 'upload']), split.kept.map((x) => x.key));
  check('a step a kept one depends on is kept, though it never ran (an upload placeholder)', split.kept.some((x) => x.key === 'upload'));
  check('steps that never started are replaced, a SKIPPED one too', eq(split.replaced.map((x) => x.key).sort(), ['answer', 'never']), split.replaced.map((x) => x.key));
  check('a later round counts as started', D.isStarted(t('r', { round: 2 }), false));
  check('a running step refuses a replan, by name', D.replanRefusal([t('build', { status: 'RUNNING' })], new Set()) === "Wait for 'build' to finish, or stop it, before planning the rest again.");
  check('a live run refuses it too', D.replanRefusal([t('x', { status: 'AWAITING_APPROVAL' })], new Set(['t_x'])) !== null);
  check('a person step does not', D.replanRefusal([t('p', { status: 'AWAITING_HUMAN' })], new Set()) === null);
  check('the card line', D.describeReplan(1, 2, 1) === 'Keeps 1 step already started · replaces 2 steps not started · adds 1 step', D.describeReplan(1, 2, 1));
  check('EXECUTING may enter PLANNING (the service guards it)', D.canTransition('EXECUTING', 'PLANNING'));
}

section('a new key that collides with a kept one is renamed');
{
  const planned = (key, dependsOn = []) => ({ key, dependsOn, title: key, objective: key, roleId: 'qa' });
  const renamed = app.renameAgainst({ summary: 's', tasks: [planned('intake', ['intake']), planned('tailor', ['intake'])] }, new Set(['intake']));
  check('the new step gets a free key', renamed.tasks[0].key === 'intake_2', renamed.tasks.map((t) => t.key));
  check('a new step depending on the colliding key follows it', eq(renamed.tasks[1].dependsOn, ['intake_2']), renamed.tasks[1].dependsOn);
}

section('the planner is told what is done');
{
  const prompt = app.buildPlannerPrompt({
    mission: { goal: 'Apply', constraints: [], successCriteria: [], autonomy: 'balanced' },
    repository: null, roles: [], preset: app.findPreset('quick-change'), availableCapabilities: [], repositoryContext: null,
    alreadyDone: {
      reason: 'Ask Ashby first.',
      steps: [{ key: 'intake', title: 'Intake', roleId: 'product', status: 'SUCCEEDED', round: 1, headline: 'US-only', points: ['14 cities'], stop: 'Nothing to tailor.', outputs: [{ id: 'art_1', type: 'Evidence' }] }],
    },
  });
  check('an Already done section, before the preset', prompt.indexOf('# Already done: plan only the rest') > 0 && prompt.indexOf('# Already done') < prompt.indexOf('# The starting shape'));
  check('it carries the kept step, what it found, its stop and outputs', ['`intake` (product, succeeded)', 'Found: US-only', '14 cities', 'Said the plan no longer fits: Nothing to tailor.', 'Evidence (art_1)'].every((s) => prompt.includes(s)));
  check('and the reason, in the person\'s words', prompt.includes('Ask Ashby first.'));
  check('rule 2 allows a kept key as a dependency', prompt.includes('references keys that exist in this plan, or the keys under Already done'));
  const plain = app.buildPlannerPrompt({ mission: { goal: 'Apply', constraints: [], successCriteria: [], autonomy: 'balanced' }, repository: null, roles: [], preset: app.findPreset('quick-change'), availableCapabilities: [], repositoryContext: null });
  check('a first plan has neither', !plain.includes('Already done'));
}

// ------------------------------------------------------------------ engine
async function engineHarness(HOME) {
  const { Container, compose } = await import('@tandemise/kernel');
  const { createLogger, createPaths, systemClock } = await import('@tandemise/shared');
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

  const paths = createPaths(HOME);
  mkdirSync(paths.root, { recursive: true });
  const log = createLogger({ level: 'error', base: { component: 'replan-check' } });
  const container = new Container();
  compose(
    container,
    persistenceTokens.persistenceModule({ path: paths.db, logger: log }),
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
    runInputs: container.resolve(app.RUN_INPUT_REPOSITORY),
    artifacts: container.resolve(app.ARTIFACT_REPOSITORY),
    profiles: container.resolve(app.RUNTIME_PROFILE_REPOSITORY),
    approvals: container.resolve(app.APPROVAL_REPOSITORY),
    proposals: container.resolve(app.PLAN_PROPOSAL_REPOSITORY),
    events: container.resolve(app.EVENT_REPOSITORY),
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 10000, every = 40) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await scheduler.tick();
      const v = fn();
      if (v) return v;
      await sleep(every);
    }
    return fn();
  };
  return { services, scheduler, repo, paths, until };
}

section('engine: plan the rest again from a stop');
{
  const { systemClock, ids } = await import('@tandemise/shared');
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const keepAlive = setInterval(() => {}, 1000);
  const h = await engineHarness(mkdtempSync(join(tmpdir(), 'trp-')));
  // A mission with no repository plans in the Tandemise home, and a local target needs git there.
  execFileSync('git', ['init', '-q', '-b', 'main', h.paths.root]);
  execFileSync('git', ['-C', h.paths.root, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const now = () => systemClock.now();

  const STOP = 'The role is US-only, so the steps after this have nothing to work on.';
  const brief = ({ stop = null, headline = 'Looked into the role' } = {}) => [
    '---', 'type: DesignBrief', 'title: Intake', 'handoff:', `  headline: ${headline}`,
    ...(stop === null ? [] : [`  stop: ${stop}`]),
    'flows:', '  - intake', '---', '', '# Intake', '', 'What I found.', '',
  ].join('\n');
  const OUT = '.tandemise/out/DesignBrief.md';
  const done = { kind: 'complete', summary: 'done' };
  const profile = (name, steps) => h.repo.profiles.create({
    id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name, executablePath: null,
    args: [], settings: { script: { steps } }, capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
  }).id;
  const stopper = profile('stopper', [{ kind: 'write-file', path: OUT, content: brief({ stop: STOP, headline: 'The role is US-only' }) }, done]);
  const plain = profile('plain', [{ kind: 'write-file', path: OUT, content: brief({ headline: 'Did the new step' }) }, done]);
  // The planner answers a replan only when it was told what is done and why; otherwise
  // it writes something no plan parser accepts, which is how a planner failure looks.
  const newStep = (key, dependsOn) => ({
    key, title: key, objective: `Do ${key}`, roleId: 'qa', dependsOn, requiredCapabilities: [],
    inputArtifacts: [{ type: 'DesignBrief', required: true }], expectedOutputs: ['DesignBrief'],
    executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
    approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'fail' }, completionGate: null,
  });
  const plan = JSON.stringify({ summary: 'Ask first, then tailor.', tasks: [newStep('ask', ['intake']), newStep('tailor', ['ask'])] });
  const oldRoutePlan = JSON.stringify({ summary: 'Finish it differently.', tasks: [newStep('finish', ['a'])] });
  const planner = profile('planner', [
    { kind: 'message', text: plan, when: { promptIncludes: 'ASK-ASHBY-FIRST' } },
    { kind: 'message', text: oldRoutePlan, when: { promptIncludes: 'OLD-ROUTE' } },
    { kind: 'message', text: 'I could not make a plan.' },
    done,
  ]);

  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Replan' })).workspace.id;
  h.services.workspaces.update(ws, { routing: { architecture: [planner] } });
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const agentOn = (name, roleIds, profileId) => h.services.team.addMember(caller, ws, { kind: 'agent', name, reportsTo: owner, roleIds, runtimeProfileIds: [profileId] }).id;
  const agents = { stopper: agentOn('Stopper', ['design'], stopper), plain: agentOn('Plain', ['design'], plain) };
  agentOn('Doer', ['qa'], plain);

  let seq = 0;
  const addMission = async (chain, goal = 'Apply to the role') => {
    const mission = await h.services.missions.create(caller, { workspaceId: ws, goal, title: `R${++seq}` });
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
  const tasks = (missionId) => h.repo.tasks.listByMission(missionId);
  const byKey = (missionId, key) => tasks(missionId).find((t) => t.key === key);
  const status = (missionId) => h.repo.missions.get(missionId).status;
  const fitCard = (missionId) => h.repo.approvals.list({ missionId }).find((a) => a.options.some((o) => o.id === 'skip_rest'));
  const planCard = (missionId) => h.repo.approvals.list({ missionId, statuses: ['PENDING'] }).find((a) => a.kind === 'plan');
  const history = (taskId) => ({
    runs: h.repo.runs.listByTask(taskId).map((r) => r.id).sort(),
    artifacts: h.repo.artifacts.listByTask(taskId).map((a) => a.id).sort(),
  });

  // ---- R1: plan the rest again, approve
  const one = await addMission([['intake', 'stopper'], ['answer', 'plain'], ['verify', 'plain']]);
  await h.until(() => fitCard(one.mission.id));
  const card = fitCard(one.mission.id);
  check('the plan-fit card offers Plan the rest again',
    eq(card?.options.map((o) => o.id), ['skip_rest', 'request_changes', 'replan_rest', 'continue_plan']), card?.options.map((o) => o.id));
  const before = history(one.t.intake);
  await h.services.approvals.decide(caller, card.id, { optionId: 'replan_rest', note: 'ASK-ASHBY-FIRST whether Panama counts, then tailor for the Americas.' });
  check('answering it starts planning the rest', ['PLANNING', 'AWAITING_PLAN_APPROVAL'].includes(status(one.mission.id)), status(one.mission.id));
  await h.until(() => planCard(one.mission.id));
  const replanCard = planCard(one.mission.id);
  check('a plan card, always asked, with the kept/replaced/added line',
    replanCard?.evidence.some((e) => e.label === 'Replan' && e.value === 'Keeps 1 step already started · replaces 2 steps not started · adds 2 steps'), replanCard?.evidence);
  check('and the person\'s note', replanCard?.evidence.some((e) => e.label === 'Your note' && e.value.startsWith('ASK-ASHBY-FIRST')));
  check('the mission waits on it', status(one.mission.id) === 'AWAITING_PLAN_APPROVAL', status(one.mission.id));
  check('nothing changed yet: the old steps are all still there', eq(tasks(one.mission.id).map((t) => t.key).sort(), ['answer', 'intake', 'verify']));
  check('the new steps wait beside the card', h.repo.proposals.get(replanCard.id)?.tasks.map((t) => t.key).join() === 'ask,tailor');
  await h.services.approvals.decide(caller, replanCard.id, { optionId: 'approve' });
  check('approved: kept + new, the unstarted ones gone', eq(tasks(one.mission.id).map((t) => t.key).sort(), ['ask', 'intake', 'tailor']), tasks(one.mission.id).map((t) => t.key));
  check('the kept step keeps its id', byKey(one.mission.id, 'intake')?.id === one.t.intake);
  check('the proposal is gone', h.repo.proposals.get(replanCard.id) === undefined);
  await h.until(() => status(one.mission.id) === 'COMPLETE', 15000);
  check('the new steps ran and the mission completed', status(one.mission.id) === 'COMPLETE' && ['ask', 'tailor'].every((k) => byKey(one.mission.id, k)?.status === 'SUCCEEDED'),
    { m: status(one.mission.id), t: tasks(one.mission.id).map((t) => [t.key, t.status, t.statusReason]) });
  check('the kept step\'s runs and outputs are exactly as they were', eq(history(one.t.intake), before), { before, after: history(one.t.intake) });
  const askRun = h.repo.runs.listByTask(byKey(one.mission.id, 'ask').id)[0];
  check('the first new step was handed the kept step\'s output', askRun !== undefined && h.repo.runInputs.listByRun(askRun.id).some((id) => before.artifacts.includes(id)),
    askRun === undefined ? null : h.repo.runInputs.listByRun(askRun.id));

  // ---- R2: reject the replan
  const two = await addMission([['intake', 'stopper'], ['answer', 'plain']]);
  await h.until(() => fitCard(two.mission.id));
  await h.services.approvals.decide(caller, fitCard(two.mission.id).id, { optionId: 'replan_rest', note: 'ASK-ASHBY-FIRST please.' });
  await h.until(() => planCard(two.mission.id));
  await h.services.approvals.decide(caller, planCard(two.mission.id).id, { optionId: 'reject', note: 'Not like that.' });
  check('rejected: the mission is back where it was', status(two.mission.id) === 'EXECUTING', status(two.mission.id));
  check('rejected: the steps are as they were', eq(tasks(two.mission.id).map((t) => t.key).sort(), ['answer', 'intake']) && byKey(two.mission.id, 'answer').status === 'PENDING');
  check('rejected: the plan-fit card is open again', fitCard(two.mission.id)?.status === 'PENDING' && fitCard(two.mission.id).selectedOptionId === null, fitCard(two.mission.id));
  for (let i = 0; i < 4; i++) await h.scheduler.tick();
  check('rejected: the step after the stop is still held', byKey(two.mission.id, 'answer').status === 'PENDING' && h.repo.runs.listByTask(two.t.answer).length === 0, byKey(two.mission.id, 'answer'));
  await h.services.approvals.decide(caller, fitCard(two.mission.id).id, { optionId: 'skip_rest' });
  await h.until(() => status(two.mission.id) === 'COMPLETE');
  check('rejected: the reopened card still works (skip finishes it)', status(two.mission.id) === 'COMPLETE', status(two.mission.id));

  // ---- the planner cannot plan the rest
  const three = await addMission([['intake', 'stopper'], ['answer', 'plain']]);
  await h.until(() => fitCard(three.mission.id));
  await h.services.approvals.decide(caller, fitCard(three.mission.id).id, { optionId: 'replan_rest', note: 'Something the planner cannot answer.' });
  await h.until(() => status(three.mission.id) !== 'PLANNING', 15000);
  check('a failed replan does not fall back to the preset: the mission is back, unchanged',
    status(three.mission.id) === 'EXECUTING' && eq(tasks(three.mission.id).map((t) => t.key).sort(), ['answer', 'intake']), { s: status(three.mission.id), t: tasks(three.mission.id).map((t) => t.key) });
  check('it says why', /^Could not plan the rest: .+ Nothing changed\.$/.test(h.repo.missions.get(three.mission.id).statusReason ?? ''), h.repo.missions.get(three.mission.id).statusReason);
  check('and the plan-fit card is open again', fitCard(three.mission.id)?.status === 'PENDING');

  // ---- R3: the old re-plan route keeps finished work
  const four = await addMission([['a', 'plain'], ['b', 'plain']], 'OLD-ROUTE mission');
  // b never starts (blocked before it could, as a step with no runtime is), so a replan replaces it.
  h.repo.tasks.update(four.t.b, { status: 'BLOCKED', statusReason: 'No runtime can run it.' });
  await h.until(() => byKey(four.mission.id, 'a').status === 'SUCCEEDED');
  h.repo.missions.update(four.mission.id, { status: 'BLOCKED' });
  const aBefore = history(four.t.a);
  await h.services.planning.begin(four.mission.id);
  await h.until(() => planCard(four.mission.id), 15000);
  check('POST /plan with a finished step is a replan of the rest, not a replace-all',
    planCard(four.mission.id)?.evidence.some((e) => e.label === 'Replan') && byKey(four.mission.id, 'a')?.id === four.t.a, planCard(four.mission.id)?.evidence);
  await h.services.approvals.decide(caller, planCard(four.mission.id).id, { optionId: 'approve' });
  check('the finished step, its runs and outputs survive with the same ids', byKey(four.mission.id, 'a')?.id === four.t.a && eq(history(four.t.a), aBefore), { before: aBefore, after: history(four.t.a) });
  check('the unstarted one was replaced', eq(tasks(four.mission.id).map((t) => t.key).sort(), ['a', 'finish']), tasks(four.mission.id).map((t) => t.key));

  // ---- a replan from the header answers the stop card it leaves behind (found in the real window:
  // the new steps depend on the stopping step, and its still-open card held them)
  const seven = await addMission([['intake', 'stopper'], ['answer', 'plain']]);
  await h.until(() => fitCard(seven.mission.id));
  await h.services.planning.replan(seven.mission.id, { note: 'ASK-ASHBY-FIRST' });
  await h.until(() => planCard(seven.mission.id));
  await h.services.approvals.decide(caller, planCard(seven.mission.id).id, { optionId: 'approve' });
  check('approving it answers the open plan-fit card', fitCard(seven.mission.id)?.status !== 'PENDING' && fitCard(seven.mission.id)?.selectedOptionId === 'replan_rest', fitCard(seven.mission.id));
  await h.until(() => status(seven.mission.id) === 'COMPLETE', 15000);
  check('so the new steps run and the mission completes', status(seven.mission.id) === 'COMPLETE', { s: status(seven.mission.id), t: tasks(seven.mission.id).map((t) => [t.key, t.status, t.statusReason]) });

  // ---- a paused mission's replan goes back to paused when rejected (found in the real window:
  // AWAITING_PLAN_APPROVAL could not move to PAUSED, so the mission sat waiting on a decided card)
  const six = await addMission([['intake', 'stopper'], ['answer', 'plain']]);
  await h.until(() => fitCard(six.mission.id));
  h.repo.missions.update(six.mission.id, { status: 'PAUSED' });
  await h.services.planning.replan(six.mission.id, { note: 'ASK-ASHBY-FIRST' });
  await h.until(() => planCard(six.mission.id));
  await h.services.approvals.decide(caller, planCard(six.mission.id).id, { optionId: 'reject' });
  check('a paused mission\'s rejected replan goes back to paused', status(six.mission.id) === 'PAUSED', status(six.mission.id));
  await h.services.planning.replan(six.mission.id, { note: 'nothing the planner can answer' });
  await h.until(() => status(six.mission.id) !== 'PLANNING', 15000);
  check('and one that cannot be planned goes back to paused too', status(six.mission.id) === 'PAUSED', status(six.mission.id));

  // ---- R4: a busy mission is refused
  const five = await addMission([['x', 'plain'], ['y', 'plain']]);
  await h.until(() => byKey(five.mission.id, 'x').status === 'SUCCEEDED');
  h.repo.tasks.update(five.t.y, { status: 'RUNNING' });
  const refused = await h.services.planning.replan(five.mission.id, { note: 'now' }).then(() => null, (e) => e.message);
  check('a step still running refuses the replan, by name', refused === "Wait for 'y' to finish, or stop it, before planning the rest again.", refused);
  check('and nothing changed', status(five.mission.id) === 'EXECUTING');
  h.repo.tasks.update(five.t.y, { status: 'SUCCEEDED' });

  clearInterval(keepAlive);
  h.scheduler.stop?.();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
