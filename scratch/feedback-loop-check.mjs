/**
 * The two loops between a worker and the person supervising it.
 *
 *   1. A worker can ask a question, and carry on with the answer.
 *   2. A person can reject a worker's output with a note, and the same role
 *      revises it and brings it back.
 *
 * Driven through the surface a real worker sees - the run-scoped gateway, the
 * real broker, the real policy engine and grant builder - and answered through
 * the real `ApprovalService.decide`, the same call the Approvals screen makes.
 * SQLite is real. The only thing absent is a model, because what is under test
 * is everything around the model.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Container, compose } from '@tandemise/kernel';
import { createLogger, createPaths, systemClock, ids, asId } from '@tandemise/shared';
import { persistenceModule, DATABASE } from '@tandemise/persistence';
import * as persistenceTokens from '@tandemise/persistence';
import { createArtifactsModule, ARTIFACT_STORE as ARTIFACTS_STORE_TOKEN, renderArtifactTemplate, parseArtifact } from '@tandemise/artifacts';
import { policyModule, GRANT_BUILDER, APPROVAL_FACTORY } from '@tandemise/policy';
import { contextModule } from '@tandemise/context';
import { createEvaluationModule } from '@tandemise/evaluation';
import { runtimesCoreModule } from '@tandemise/runtimes-core';
import { genericRuntimeModule } from '@tandemise/runtime-generic';
import { executionCoreModule, CLOCK as EXEC_CLOCK, LOGGER as EXEC_LOGGER, PATHS as EXEC_PATHS } from '@tandemise/execution-core';
import { executionLocalModule } from '@tandemise/execution-local';
import {
  integrationsCoreModule, CLOCK as INT_CLOCK, LOGGER as INT_LOGGER, TOOL_BROKER, RunScopedToolGateway,
} from '@tandemise/integrations-core';
import * as app from '@tandemise/application';
import {
  applicationModule, createServices, createMemorySettingsStore, describeEnvironment, osProcessLiveness,
  createAskHumanTool, RunDeadlines, RunDeadline, BUILT_IN_ROLES,
} from '@tandemise/application';
import { REJECT_OPTION, isAffirmative, CORE_CAPABILITIES } from '@tandemise/domain';

const HOME = mkdtempSync(join(tmpdir(), 'tandemise-ask-'));
// Timeouts here are unref'd by design so a long budget never holds the daemon
// open. In the daemon the HTTP server keeps the loop alive; in a script nothing
// does, and an await on a timeout would end the process instead of settling.
const keepAlive = setInterval(() => {}, 1000);
let failures = 0;
let passed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); }
  else { failures++; console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
};
const head = (t) => console.log(`\n── ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(20); }
  return fn();
};

// ---------------------------------------------------------------- composition

const paths = createPaths(HOME);
mkdirSync(paths.root, { recursive: true });
const log = createLogger({ level: 'error', base: { component: 'ask-check' } });
const container = new Container();
compose(
  container,
  persistenceModule({ path: paths.db, logger: log }),
  createArtifactsModule({ paths }),
  policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
  executionCoreModule, executionLocalModule, integrationsCoreModule, applicationModule,
);
container.bind(EXEC_CLOCK, () => systemClock, { source: 'check' });
container.bind(EXEC_LOGGER, () => log, { source: 'check' });
container.bind(EXEC_PATHS, () => paths, { source: 'check' });
container.bind(INT_CLOCK, () => systemClock, { source: 'check' });
container.bind(INT_LOGGER, () => log, { source: 'check' });
const isToken = (v) => typeof v === 'object' && v !== null && typeof v.description === 'string';
for (const name of Object.keys(app)) {
  const appToken = app[name]; const provider = persistenceTokens[name];
  if (!isToken(appToken) || !isToken(provider)) continue;
  if (!container.has(provider) || container.has(appToken)) continue;
  container.bind(appToken, (r) => r.resolve(provider), { source: `alias:${name}` });
}
const noopBus = { publish: () => {}, subscribe: () => () => {} };
container.bind(app.ARTIFACT_STORE, (r) => r.resolve(ARTIFACTS_STORE_TOKEN), { source: 'alias' });
container.bind(app.ARTIFACT_TEMPLATES, () => ({ render: renderArtifactTemplate }), { source: 'check' });
container.bind(app.ARTIFACT_PARSER, () => ({ parse: parseArtifact }), { source: 'check' });
container.bind(app.EVENT_BUS, () => noopBus, { source: 'check' });
container.bind(app.PROJECTION_BUS, () => ({ invalidate: () => {}, subscribe: () => () => {} }), { source: 'check' });
container.bind(app.SECRET_STORE, () => ({ backend: 'memory', store: async () => 'x', resolve: async () => undefined, remove: async () => {}, list: async () => [] }), { source: 'check' });
container.bind(app.SETTINGS_STORE, () => createMemorySettingsStore(), { source: 'check' });
container.bind(app.SYSTEM_ENVIRONMENT, () => describeEnvironment({ home: HOME, schemaVersion: 1 }), { source: 'check' });
container.bind(app.PROCESS_LIVENESS, () => osProcessLiveness, { source: 'check' });

const services = createServices(container);
const db = container.resolve(DATABASE);
const repo = {
  tasks: container.resolve(app.TASK_REPOSITORY),
  approvals: container.resolve(app.APPROVAL_REPOSITORY),
  assignments: container.resolve(app.ASSIGNMENT_REPOSITORY),
};
const broker = container.resolve(TOOL_BROKER);
const deadlines = container.resolve(app.RUN_DEADLINES);
const grantBuilder = container.resolve(GRANT_BUILDER);

// ------------------------------------------------------------------- fixtures

db.handle.pragma('foreign_keys = OFF');
db.handle.exec(`
  INSERT INTO workspaces (id,name,autonomy,concurrency,routing,default_autonomy_level,knowledge,created_at,updated_at)
    VALUES ('ws1','Beveloce','{"localCodeChanges":"auto","externalWrites":"ask","productionRelease":"ask"}',
            '{"maxTotalWorkers":1}','{}','balanced','{}','2026-01-01','2026-01-01');
  INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,created_at,updated_at)
    VALUES ('m1','ws1','Onboarding','Redesign onboarding','[]','[]','EXECUTING','balanced','p','2026-01-01','2026-01-01');
`);

// Seeded as `WorkspaceService.create` does: a real project always has its roles,
// and plan validation rejects any task whose role the project does not know.
for (const role of BUILT_IN_ROLES) {
  container.resolve(app.ROLE_REPOSITORY).upsert({
    ...role, workspaceId: asId('ws1'), createdAt: '2026-01-01', updatedAt: '2026-01-01',
  });
}

const designRole = BUILT_IN_ROLES.find((r) => r.id === 'design');
let seq = 0;

/** A running design task with a real assignment, grants built by the real builder. */
function runningDesignTask() {
  seq++;
  const taskId = `t${seq}`;
  db.handle.prepare(`
    INSERT INTO mission_tasks (id,mission_id,key,title,objective,role_id,required_capabilities,input_artifacts,
      expected_outputs,execution_policy,approval_policy,retry_policy,status,created_at,updated_at)
    VALUES (?, 'm1', ?, 'Design onboarding', 'Produce the onboarding design', 'design', '[]', '[]', '["DesignBrief"]',
      '{"isolation":"none","maxWallTimeMs":600000,"capabilities":[]}', '{"beforeStart":false,"onCompletion":false}',
      '{"maxAttempts":2,"backoffMs":0,"onExhausted":"block"}', 'RUNNING', '2026-01-01', '2026-01-01')
  `).run(taskId, `design_${seq}`);
  const task = repo.tasks.get(asId(taskId));
  const grants = grantBuilder.build({
    role: { ...designRole, workspaceId: null, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    task,
    autonomy: { localCodeChanges: 'auto', externalWrites: 'ask', productionRelease: 'ask' },
    workingDirectory: HOME,
    artifactRoot: join(HOME, 'artifacts'),
    ttlMs: 600000,
  });
  const assignment = repo.assignments.create({
    id: ids.workerAssignment(), workspaceId: asId('ws1'), missionId: asId('m1'), taskId: task.id,
    roleId: 'design', runtimeProfileId: asId('rp1'), executionTargetId: asId('et1'),
    grants, budgets: { maxWallTimeMs: 600000, maxAttempts: 2 }, createdAt: systemClock.now(),
  });
  // A live run always has a deadline registered; the tool only un-parks a task
  // whose run is still live.
  deadlines.open(assignment.id, 600000);
  return { task, assignment };
}

function contextFor(assignment, signal) {
  return {
    assignment, assignmentId: assignment.id, runId: null, workingDirectory: HOME, logger: log,
    exec: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }, signal,
  };
}

/** The pending card for a task, as the Approvals screen lists it. */
const pendingFor = (taskId) =>
  services.approvals.list({ missionId: 'm1', status: 'PENDING' }).map((v) => v.approval).find((a) => a.taskId === taskId);

// =================================================================== the rule

head('A choice is answered, not approved');
ok('picking an option on a choice is affirmative', isAffirmative('choice', 'figma'));
ok('declining a choice is not', !isAffirmative('choice', REJECT_OPTION));
ok('an action still needs an explicit approve', !isAffirmative('action', 'figma'));
ok('an action approve is affirmative', isAffirmative('action', 'approve'));

// ============================================================ what a worker sees

head('Every worker can ask, without asking permission to');
for (const role of BUILT_IN_ROLES) {
  ok(`${role.id} holds human.ask`, role.defaultCapabilities.includes(CORE_CAPABILITIES.humanAsk));
}
{
  const { assignment } = runningDesignTask();
  const grant = assignment.grants.find((g) => g.capability === 'human.ask');
  ok('the grant builder issues human.ask', grant !== undefined);
  ok('human.ask is auto-allowed, never ask-mode', grant?.approvalMode === 'auto', grant?.approvalMode);
  const gateway = RunScopedToolGateway.for(broker, assignment, systemClock);
  ok('ask_human is on the worker\'s run-scoped surface', gateway.names().includes('ask_human'),
     `[${gateway.names().join(', ')}]`);
}

// ============================================================ the loop, answered

head('The designer asks which tool, and the answer comes back');
{
  const { task, assignment } = runningDesignTask();
  const gateway = RunScopedToolGateway.for(broker, assignment, systemClock);
  const controller = new AbortController();

  const call = gateway.invoke('ask_human', {
    question: 'Which tool should I design the onboarding flow in?',
    context: 'The repo links no design file, and three design integrations are connected.',
    options: [
      { id: 'figma', label: 'Figma', description: 'Where the existing component library lives.' },
      { id: 'canva', label: 'Canva' },
      { id: 'claude_design', label: 'Claude Design' },
    ],
    recommended: 'figma',
  }, contextFor(assignment, controller.signal));

  const card = await until(() => pendingFor(task.id));
  ok('the question arrives in the approvals inbox', card !== undefined);
  ok('as a choice', card?.kind === 'choice', card?.kind);
  ok('titled with the question', card?.title?.startsWith('Which tool'), card?.title);
  ok('offering the worker\'s options plus a way to decline',
     JSON.stringify(card?.options.map((o) => o.id)) === JSON.stringify(['figma', 'canva', 'claude_design', REJECT_OPTION]),
     card?.options.map((o) => o.id).join(','));
  ok('with the worker\'s recommendation', card?.recommendedOptionId === 'figma');
  ok('the task is parked as AWAITING_INPUT', repo.tasks.get(task.id)?.status === 'AWAITING_INPUT');
  ok('its reason is the question', repo.tasks.get(task.id)?.statusReason?.includes('Which tool'),
     repo.tasks.get(task.id)?.statusReason);

  // Answered exactly as the Approvals screen does.
  const decided = (await services.approvals.decide(card.id, { optionId: 'figma', note: 'Figma. File: figma.com/file/abc' })).approval;
  ok('picking Figma records APPROVED, not REJECTED', decided.status === 'APPROVED', decided.status);

  const result = await call;
  ok('the tool call succeeds', result.outcome === 'ok', `${result.outcome} ${result.error?.message ?? ''}`);
  ok('the worker learns it was answered', result.output?.answered === true);
  ok('the worker learns which option', result.output?.choice === 'figma', result.output?.choice);
  ok('the worker gets the note verbatim', result.output?.answer === 'Figma. File: figma.com/file/abc', result.output?.answer);
  ok('the task is RUNNING again', repo.tasks.get(task.id)?.status === 'RUNNING', repo.tasks.get(task.id)?.status);
  ok('with its question cleared', repo.tasks.get(task.id)?.statusReason === null);
  deadlines.close(assignment.id);
}

head('An open question, answered in words');
{
  const { task, assignment } = runningDesignTask();
  const gateway = RunScopedToolGateway.for(broker, assignment, systemClock);
  const call = gateway.invoke('ask_human', {
    question: 'What should the empty state say to a first-time user?',
  }, contextFor(assignment, new AbortController().signal));
  const card = await until(() => pendingFor(task.id));
  ok('an open question offers Send answer and decline',
     JSON.stringify(card?.options.map((o) => o.id)) === JSON.stringify(['answer', REJECT_OPTION]));
  await services.approvals.decide(card.id, { optionId: 'answer', note: 'Nothing here yet — add your first route.' });
  const result = await call;
  ok('the written answer reaches the worker', result.output?.answer === 'Nothing here yet — add your first route.');
  ok('and counts as answered', result.output?.answered === true);
}

head('Clicking an option without writing anything still says what was picked');
{
  const { task, assignment } = runningDesignTask();
  const gateway = RunScopedToolGateway.for(broker, assignment, systemClock);
  const call = gateway.invoke('ask_human', {
    question: 'Light or dark first?', options: [{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }],
  }, contextFor(assignment, new AbortController().signal));
  const card = await until(() => pendingFor(task.id));
  await services.approvals.decide(card.id, { optionId: 'dark' });
  const result = await call;
  ok('the answer is the option\'s label, not a generic "Approved."', result.output?.answer === 'Dark', result.output?.answer);
}

// =========================================================== declined, and gone

head('Declining hands the decision back to the worker');
{
  const { task, assignment } = runningDesignTask();
  const gateway = RunScopedToolGateway.for(broker, assignment, systemClock);
  const call = gateway.invoke('ask_human', {
    question: 'Rounded or square buttons?', options: [{ id: 'rounded', label: 'Rounded' }, { id: 'square', label: 'Square' }],
  }, contextFor(assignment, new AbortController().signal));
  const card = await until(() => pendingFor(task.id));
  await services.approvals.decide(card.id, { optionId: REJECT_OPTION });
  const result = await call;
  ok('the call still succeeds - a decline is an answer, not an error', result.outcome === 'ok');
  ok('answered is false', result.output?.answered === false);
  ok('the task does not stay parked', repo.tasks.get(task.id)?.status === 'RUNNING');
  ok('declining a question does not block the mission',
     container.resolve(app.MISSION_REPOSITORY).get(asId('m1'))?.status === 'EXECUTING');
}

head('A run that ends mid-question takes its question out of the inbox');
{
  const { task, assignment } = runningDesignTask();
  const gateway = RunScopedToolGateway.for(broker, assignment, systemClock);
  const controller = new AbortController();
  const call = gateway.invoke('ask_human', { question: 'Should I also cover tablet?' },
    contextFor(assignment, controller.signal));
  const card = await until(() => pendingFor(task.id));
  ok('the question was pending', card !== undefined);
  controller.abort();
  const result = await call;
  ok('the worker is told it went unanswered', result.output?.answered === false);
  const after = repo.approvals.get(card.id);
  ok('the card is CANCELLED, not left pending', after?.status === 'CANCELLED', after?.status);
}

head('An unanswered question expires, and the worker is told to decide');
{
  const { task, assignment } = runningDesignTask();
  // A separate tool over a registry whose park allowance is 250ms, so the
  // timeout path runs without waiting a day for it.
  const shortDeadlines = new RunDeadlines({ maxParkedMs: 250 });
  shortDeadlines.open(assignment.id, 600000);
  const tool = createAskHumanTool({
    approvals: repo.approvals, approvalFactory: container.resolve(APPROVAL_FACTORY),
    tasks: repo.tasks, waiter: container.resolve(app.APPROVAL_WAITER), deadlines: shortDeadlines,
    recorder: container.resolve(app.EVENT_RECORDER), clock: systemClock,
  });
  const execution = await tool.execute(contextFor(assignment, new AbortController().signal), {
    question: 'Which illustration style?',
  });
  ok('the worker is told nobody answered', execution.output.answered === false);
  ok('and told to decide and record the assumption', /Decide yourself/.test(execution.output.answer), execution.output.answer);
  const card = services.approvals.list({ missionId: 'm1' }).map((v) => v.approval).find((a) => a.taskId === task.id);
  ok('the card is EXPIRED', card?.status === 'EXPIRED', card?.status);
  ok('the task is RUNNING again', repo.tasks.get(task.id)?.status === 'RUNNING');
  shortDeadlines.close(assignment.id);
}

// ================================================================ the clock

head('The wall-time clock stops while a person thinks');
{
  const d = new RunDeadline(200);
  d.pause();
  await sleep(350);
  ok('a parked run outlives its budget', !d.signal.aborted && !d.expired);
  d.resume();
  await sleep(100);
  ok('resumed, it still has budget left', !d.signal.aborted);
  await sleep(200);
  ok('and expires once the unparked time is spent', d.expired && d.signal.aborted);
  d.dispose();
}
{
  const d = new RunDeadline(150);
  d.pause(); d.pause();       // two questions at once
  d.resume();                 // one answered
  await sleep(250);
  ok('the clock stays stopped while any question is still open', !d.expired && d.parked);
  d.resume();
  await sleep(250);
  ok('and restarts once the last is answered', d.expired);
  d.dispose();
}
{
  const d = new RunDeadline(100);
  await sleep(180);
  ok('an unparked run expires on schedule', d.expired);
  d.dispose();
}


// ============================================================ revision loop

head('Rejecting output with a note becomes the next round of the same work');
{
  const missions = container.resolve(app.MISSION_REPOSITORY);
  const runs = container.resolve(app.RUN_REPOSITORY);
  db.handle.exec(`
    INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,created_at,updated_at)
      VALUES ('m2','ws1','Checkout','Redesign checkout','[]','[]','EXECUTING','balanced','p','2026-01-01','2026-01-01');
  `);
  const now = systemClock.now();
  const base = {
    missionId: asId('m2'), repositoryId: null, executor: 'agent', waitPolicy: null, requiredCapabilities: [],
    executionPolicy: { isolation: 'none', maxWallTimeMs: 600000, capabilities: [] },
    retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' },
    completionGate: null, statusReason: null, attempts: 1, remediatesTaskId: null,
    createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
  };
  const task = (key, over) => repo.tasks.add({
    ...base, id: ids.task(), key, title: key, objective: `Do ${key}`, roleId: 'development',
    dependsOn: [], inputArtifacts: [], expectedOutputs: [], approvalPolicy: { beforeStart: false, onCompletion: false },
    status: 'PENDING', orderHint: 0, ...over,
  });

  const design = task('design', {
    title: 'Design checkout', objective: 'Produce the checkout design.', roleId: 'design',
    expectedOutputs: ['DesignBrief'], approvalPolicy: { beforeStart: false, onCompletion: true },
    status: 'AWAITING_APPROVAL', orderHint: 1,
  });
  const build = task('build', { dependsOn: ['design'], inputArtifacts: [{ type: 'DesignBrief', required: true }], orderHint: 2 });
  task('docs', { dependsOn: ['build'], orderHint: 3 });

  /** A completion approval: created after the attempt's run, as the executor does. */
  const completionCard = (t) => {
    runs.create({
      id: ids.run(), missionId: asId('m2'), taskId: t.id, assignmentId: asId('a'), attempt: 1, status: 'SUCCEEDED',
      roleId: t.roleId, runtimeProfileId: asId('rp1'), executionTargetId: asId('et1'), externalSessionId: null,
      pid: null, exitCode: 0, errorCode: null, errorMessage: null, usage: null,
      startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', heartbeatAt: '2026-01-01T00:01:00.000Z',
    });
    const approval = container.resolve(APPROVAL_FACTORY).createOrThrow({
      workspaceId: asId('ws1'), missionId: asId('m2'), taskId: t.id, kind: 'action', risk: 'write_reversible',
      title: `Approve the output of ${t.title}?`, rationale: 'Output authorizes what follows.',
      effect: 'Approving releases dependents.', evidence: [{ kind: 'text', label: 'Output', value: 'DesignBrief' }],
    });
    repo.approvals.create(approval);
    return approval;
  };
  const byKey = (key) => repo.tasks.listByMission(asId('m2')).find((t) => t.key === key);

  // Round 1.
  const first = completionCard(design);
  await services.approvals.decide(first.id, {
    optionId: REJECT_OPTION,
    note: 'The buttons are too small on mobile.\nUse a 44px touch target.',
  });

  const revision1 = byKey('design_revision_1');
  ok('a revision task is created', revision1 !== undefined);
  ok('by the same role that made it — the designer, not a developer', revision1?.roleId === 'design', revision1?.roleId);
  ok('it starts from the rejected output', revision1?.inputArtifacts.some((r) => r.type === 'DesignBrief'));
  ok('it comes back to you for the same decision', revision1?.approvalPolicy.onCompletion === true);
  ok('your feedback is quoted verbatim in its objective',
     revision1?.objective.includes('> The buttons are too small on mobile.') && revision1?.objective.includes('> Use a 44px touch target.'));
  ok('it keeps the original objective', revision1?.objective.startsWith('Produce the checkout design.'));
  ok('the rejected task is superseded, not blocked', byKey('design')?.status === 'SKIPPED', byKey('design')?.status);
  ok('and says what superseded it', byKey('design')?.statusReason === "Superseded by 'design_revision_1' after your feedback.",
     byKey('design')?.statusReason);
  ok('downstream work now waits on the revision', JSON.stringify(byKey('build')?.dependsOn) === '["design_revision_1"]',
     JSON.stringify(byKey('build')?.dependsOn));
  ok('work further downstream is untouched', JSON.stringify(byKey('docs')?.dependsOn) === '["build"]');
  ok('the mission keeps going', missions.get(asId('m2'))?.status === 'EXECUTING', missions.get(asId('m2'))?.status);

  // Round 2: reject the revision too.
  repo.tasks.update(revision1.id, { status: 'AWAITING_APPROVAL' });
  const second = completionCard(repo.tasks.get(revision1.id));
  await services.approvals.decide(second.id, { optionId: REJECT_OPTION, note: 'Better. Now move the total above the button.' });
  const revision2 = byKey('design_revision_2');
  ok('a second round is numbered from the original, not nested', revision2 !== undefined && byKey('design_revision_1_revision_1') === undefined);
  ok('and builds on the previous revision', JSON.stringify(revision2?.dependsOn) === '["design_revision_1"]');
  ok('downstream follows the latest round', JSON.stringify(byKey('build')?.dependsOn) === '["design_revision_2"]');
  ok('the whole graph is still valid to run', missions.get(asId('m2'))?.status === 'EXECUTING');
  ok('round two is briefed on round two\'s feedback', revision2?.objective.includes('> Better. Now move the total above the button.'));
  ok('and still carries round one\'s, so it cannot be undone',
     revision2?.objective.includes('Round 1:') && revision2?.objective.includes('> Use a 44px touch target.'),
     revision2?.objective.split('\n').filter((l) => l.startsWith('>')).join(' | '));

  // Approve round 2.
  repo.tasks.update(revision2.id, { status: 'AWAITING_APPROVAL' });
  const third = completionCard(repo.tasks.get(revision2.id));
  await services.approvals.decide(third.id, { optionId: 'approve' });
  ok('approving a revision completes it', byKey('design_revision_2')?.status === 'SUCCEEDED');
  ok('and nothing further is spawned', byKey('design_revision_3') === undefined);
}

head('A bare "no" does not re-run anything on a guess');
{
  db.handle.exec(`
    INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,created_at,updated_at)
      VALUES ('m3','ws1','Pricing','Pricing page','[]','[]','EXECUTING','balanced','p','2026-01-01','2026-01-01');
  `);
  const now = systemClock.now();
  const t = repo.tasks.add({
    id: ids.task(), missionId: asId('m3'), repositoryId: null, executor: 'agent', waitPolicy: null,
    key: 'copy', title: 'Write pricing copy', objective: 'Write it.', roleId: 'product', dependsOn: [],
    requiredCapabilities: [], inputArtifacts: [], expectedOutputs: ['ProductSpec'],
    executionPolicy: { isolation: 'none', maxWallTimeMs: 600000, capabilities: [] },
    approvalPolicy: { beforeStart: false, onCompletion: true },
    retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' }, completionGate: null,
    status: 'AWAITING_APPROVAL', statusReason: null, attempts: 1, remediatesTaskId: null, orderHint: 0,
    createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
  });
  container.resolve(app.RUN_REPOSITORY).create({
    id: ids.run(), missionId: asId('m3'), taskId: t.id, assignmentId: asId('a'), attempt: 1, status: 'SUCCEEDED',
    roleId: 'product', runtimeProfileId: asId('rp1'), executionTargetId: asId('et1'), externalSessionId: null,
    pid: null, exitCode: 0, errorCode: null, errorMessage: null, usage: null,
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', heartbeatAt: '2026-01-01T00:01:00.000Z',
  });
  const card = container.resolve(APPROVAL_FACTORY).createOrThrow({
    workspaceId: asId('ws1'), missionId: asId('m3'), taskId: t.id, kind: 'action', risk: 'write_reversible',
    title: 'Approve?', rationale: 'r', effect: 'e', evidence: [{ kind: 'text', label: 'x', value: 'y' }],
  });
  repo.approvals.create(card);
  await services.approvals.decide(card.id, { optionId: REJECT_OPTION });
  const after = repo.tasks.get(t.id);
  ok('no revision is created without feedback',
     !repo.tasks.listByMission(asId('m3')).some((x) => x.key.includes('revision')));
  ok('the task is blocked', after?.status === 'BLOCKED');
  // The card is already decided, so "reject again with a note" would be a
  // dead end; the reason points at the action that actually exists.
  ok('and the reason points at something the person can actually do', /Retry the task/.test(after?.statusReason ?? ''), after?.statusReason);
}


// ============================================================ restart

head('A question that outlives its run cannot disturb the next attempt');
{
  const { task, assignment } = runningDesignTask();
  const gateway = RunScopedToolGateway.for(broker, assignment, systemClock);
  const call = gateway.invoke('ask_human', { question: 'Stale question?' }, contextFor(assignment, new AbortController().signal));
  const card = await until(() => pendingFor(task.id));
  // The run ends underneath the question, and a new attempt parks on its own.
  deadlines.close(assignment.id);
  repo.tasks.update(task.id, { status: 'AWAITING_INPUT', statusReason: 'Waiting for your answer: the new attempt' });
  await services.approvals.decide(card.id, { optionId: 'answer', note: 'late answer' });
  await call;
  ok('the next attempt stays parked on its own question', repo.tasks.get(task.id)?.status === 'AWAITING_INPUT',
     repo.tasks.get(task.id)?.status);
}

head('A worker cannot offer an option that collides with the card\'s own');
{
  const { assignment } = runningDesignTask();
  const gateway = RunScopedToolGateway.for(broker, assignment, systemClock);
  const result = await gateway.invoke('ask_human', {
    question: 'Ship it?', options: [{ id: 'reject', label: 'Reject the PR' }, { id: 'merge', label: 'Merge' }],
  }, contextFor(assignment, new AbortController().signal));
  ok('an option id of "reject" is refused with a reason the worker can act on',
     result.outcome === 'error' && /reserved/.test(result.error?.message ?? ''), result.error?.message);
}

head('A restart while a worker waits on a question does not strand the mission');
{
  const { task, assignment } = runningDesignTask();
  const gateway = RunScopedToolGateway.for(broker, assignment, systemClock);
  const controller = new AbortController();
  // The worker asks, and then the daemon dies: the run row is left RUNNING
  // with a pid that no longer exists, exactly as a crash leaves it.
  const call = gateway.invoke('ask_human', { question: 'Which copy tone?' }, contextFor(assignment, controller.signal));
  const card = await until(() => pendingFor(task.id));
  container.resolve(app.RUN_REPOSITORY).create({
    id: ids.run(), missionId: asId('m1'), taskId: task.id, assignmentId: assignment.id, attempt: 1, status: 'RUNNING',
    roleId: 'design', runtimeProfileId: asId('rp1'), executionTargetId: asId('et1'), externalSessionId: null,
    pid: 999999, exitCode: null, errorCode: null, errorMessage: null, usage: null,
    startedAt: systemClock.now(), finishedAt: null, heartbeatAt: systemClock.now(),
  });
  ok('before: parked, with a pending question', repo.tasks.get(task.id)?.status === 'AWAITING_INPUT' && card !== undefined);

  await container.resolve(app.RECOVERY_SERVICE).run();

  ok('the task is requeued rather than left parked forever', repo.tasks.get(task.id)?.status === 'READY',
     repo.tasks.get(task.id)?.status);
  const after = repo.approvals.get(card.id);
  ok('its question is withdrawn from the inbox', after?.status === 'CANCELLED', after?.status);
  ok('saying why', /restarted/.test(after?.decisionNote ?? ''), after?.decisionNote);
  controller.abort();
  await call;
}

clearInterval(keepAlive);
rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
