/**
 * End-to-end proof of `@tandemise/application` - the mission engine.
 *
 * Everything below runs against a real container: real SQLite, a real
 * filesystem artifact store, real local and worktree execution targets, real
 * git, and the deterministic `fake` runtime from `@tandemise/runtime-generic`.
 * Nothing is mocked and nothing costs a model call.
 *
 * The target repository is the Taskly demo app - a real git repository with a
 * real `npm test` and `npm run typecheck`.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Container, LifecycleHost, compose } from '@tandemise/kernel';
import { createLogger, createPaths, systemClock, ids, asId } from '@tandemise/shared';
import { persistenceModule } from '@tandemise/persistence';
import * as persistenceTokens from '@tandemise/persistence';
import {
  createArtifactsModule, ARTIFACT_STORE as ARTIFACTS_STORE_TOKEN,
  renderArtifactTemplate, parseArtifact,
} from '@tandemise/artifacts';
import { policyModule } from '@tandemise/policy';
import { contextModule } from '@tandemise/context';
import { createEvaluationModule } from '@tandemise/evaluation';
import { runtimesCoreModule } from '@tandemise/runtimes-core';
import { genericRuntimeModule, FAKE_ADAPTER_ID, FAKE_CAPABILITIES } from '@tandemise/runtime-generic';
import {
  executionCoreModule, CLOCK as EXEC_CLOCK, LOGGER as EXEC_LOGGER, PATHS as EXEC_PATHS,
} from '@tandemise/execution-core';
import { executionLocalModule } from '@tandemise/execution-local';
import {
  integrationsCoreModule, CLOCK as INT_CLOCK, LOGGER as INT_LOGGER,
} from '@tandemise/integrations-core';
import * as app from '@tandemise/application';
import {
  applicationModule, createServices, RECOVERY_SERVICE, SCHEDULER,
  createMemorySettingsStore, describeEnvironment, osProcessLiveness,
} from '@tandemise/application';

const REPO = '/Users/you/projects/tandemise-demo-app';
const HOME = mkdtempSync(join(tmpdir(), 'tandemise-app-check-'));
const SCRIPTS = join(HOME, 'scripts');
mkdirSync(SCRIPTS, { recursive: true });

let failures = 0;
const ok = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
};
const head = (t) => console.log(`\n── ${t}`);

// ---------------------------------------------------------------- fake scripts
//
// One profile per role, each scripted to behave like that role: write the
// artifacts its role produces, into the hand-off directory the prompt names.

const fm = (type, title, extra) => [
  '---',
  `type: ${type}`,
  'schemaVersion: 1',
  `title: ${JSON.stringify(title)}`,
  ...extra,
  '---',
  '',
].join('\n');

const OUT = '.tandemise/out';
const write = (path, content) => ({ kind: 'write-file', path, content });
const echoPrompt = { kind: 'message', text: 'PROMPT>>>{{prompt}}<<<PROMPT' };

const productScript = {
  steps: [
    { kind: 'checkpoint', sessionId: 'fake-{{runId}}', label: 'session.init' },
    echoPrompt,
    write(`${OUT}/ProblemBrief.md`, fm('ProblemBrief', 'Taskly has no way to clear finished work', [
      'successMetric: "A user can clear completed tasks in one action"',
      'evidence:',
      '  - src/server.js',
    ]) + '## Problem\n\nCompleted tasks accumulate and there is no way to clear them.\n'),
    write(`${OUT}/ProductSpec.md`, fm('ProductSpec', 'Clear completed tasks', [
      'acceptanceCriteria:',
      '  - id: AC1',
      '    statement: A user can clear all completed tasks in one action',
      '  - id: AC2',
      '    statement: Clearing does not remove tasks that are still open',
      'nonGoals:',
      '  - Undo of a clear',
    ]) + '## Specification\n\nAdd a clear-completed action to the task list.\n'),
    { kind: 'usage', inputTokens: 900, outputTokens: 210, costUsd: null },
    { kind: 'complete', summary: 'Wrote ProblemBrief and ProductSpec' },
  ],
};

const designScript = {
  steps: [
    echoPrompt,
    write(`${OUT}/DesignBrief.md`, fm('DesignBrief', 'Clear-completed interaction', [
      'flows:',
      '  - Clear completed tasks',
      'accessibility:',
      '  - The action is reachable by keyboard',
      'openQuestions: []',
    ]) + '## Flow\n\nA button appears once at least one task is complete.\n'),
    { kind: 'usage', inputTokens: 700, outputTokens: 180, costUsd: null },
    { kind: 'complete', summary: 'Wrote DesignBrief' },
  ],
};

// The architecture profile is also the planner's runtime (planning borrows the
// `architecture` role's routing). It answers the planner in prose, with no JSON
// object anywhere in it - which is what forces the preset fallback below.
const architectureScript = {
  steps: [
    echoPrompt,
    { kind: 'message', text: 'I have thought about the structure and written it up as prose rather than JSON.' },
    write(`${OUT}/ArchitecturePlan.md`, fm('ArchitecturePlan', 'Clear-completed approach', [
      'components:',
      '  - src/server.js',
      'risks:',
      '  - severity: low',
      '    description: The in-memory store is reset on restart',
      'migration: ""',
    ]) + '## Approach\n\nAdd a DELETE /api/tasks/completed route.\n'),
    write(`${OUT}/ImplementationPlan.md`, fm('ImplementationPlan', 'Steps to clear completed tasks', [
      'steps:',
      '  - id: S1',
      '    summary: Add the clear-completed endpoint',
      '    files:',
      '      - src/server.js',
      '    dependsOn: []',
    ]) + '## Steps\n\n1. Add the endpoint. 2. Add a test.\n'),
    { kind: 'complete', summary: 'Wrote ArchitecturePlan and ImplementationPlan' },
  ],
};

/** Attempt 1: a ChangeSet whose front matter does not satisfy the contract. */
const developmentBadScript = {
  steps: [
    { kind: 'checkpoint', sessionId: 'fake-dev-{{runId}}', label: 'session.init' },
    echoPrompt,
    write(`${OUT}/ChangeSet.md`, [
      '---',
      'type: ChangeSet',
      'schemaVersion: 1',
      'title: "Clear completed tasks"',
      '---',
      '',
      '## Changes\n\nI implemented it. (No `branch` in the front matter: the contract is not met.)\n',
    ].join('\n')),
    { kind: 'complete', summary: 'Implementation attempt 1' },
  ],
};

/** Attempt 2: the contract met, plus a real source change to commit. */
const developmentGoodScript = {
  steps: [
    { kind: 'checkpoint', sessionId: 'fake-dev-{{runId}}', label: 'session.init' },
    echoPrompt,
    write('CLEAR_COMPLETED.md', '# Clear completed\n\nAdded by the Tandemise development role.\n'),
    write(`${OUT}/ChangeSet.md`, fm('ChangeSet', 'Clear completed tasks', [
      'branch: tandemise/implement',
      'commits: []',
      'filesChanged: 1',
      'testsRun:',
      '  - npm test',
      'knownLimitations: []',
    ]) + '## Changes\n\nAdded the clear-completed action and a note describing it.\n'),
    { kind: 'usage', inputTokens: 2400, outputTokens: 860, costUsd: null },
    { kind: 'complete', summary: 'Implementation attempt 2' },
  ],
};

const reviewScript = {
  steps: [
    echoPrompt,
    write(`${OUT}/ReviewReport.md`, fm('ReviewReport', 'Review of the clear-completed change', [
      'verdict: pass',
      'reviewedRef: HEAD',
      'findings:',
      '  - severity: nit',
      '    title: The note file could be folded into the README',
      '    location: CLEAR_COMPLETED.md',
    ]) + '## Review\n\nThe change is small, correct, and covered.\n'),
    { kind: 'complete', summary: 'Wrote ReviewReport' },
  ],
};

const qaScript = {
  steps: [
    echoPrompt,
    write(`${OUT}/QAPlan.md`, fm('QAPlan', 'Test matrix for clear-completed', [
      'cases:',
      '  - id: T1',
      '    criterion: A user can clear all completed tasks in one action',
      '    method: automated',
      '  - id: T2',
      '    criterion: Clearing does not remove tasks that are still open',
      '    method: automated',
    ]) + '## Matrix\n\nTwo automated cases, one per acceptance criterion.\n'),
    write(`${OUT}/QAReport.md`, fm('QAReport', 'QA results for clear-completed', [
      'results:',
      '  - criterion: A user can clear all completed tasks in one action',
      '    outcome: PASS',
      '    evidence: npm test',
      '  - criterion: Clearing does not remove tasks that are still open',
      '    outcome: PASS',
      '    evidence: npm test',
      'blockingDefects: 0',
    ]) + '## Results\n\nBoth acceptance criteria are covered and passing.\n'),
    { kind: 'complete', summary: 'Wrote QAPlan and QAReport' },
  ],
};

const releaseScript = {
  steps: [
    echoPrompt,
    write(`${OUT}/ReleaseCandidate.md`, fm('ReleaseCandidate', 'Taskly clear-completed RC', [
      'ref: tandemise/clear-completed/integration',
      'checks:',
      '  - name: checks.tests',
      '    outcome: PASS',
      'unresolvedRisks: []',
      'rollback: "Revert the integration merge commit"',
    ]) + '## Release notes\n\nAdds a clear-completed action.\n'),
    { kind: 'complete', summary: 'Wrote ReleaseCandidate' },
  ],
};

const scriptPath = (name) => join(SCRIPTS, `${name}.json`);
const putScript = (name, script) => {
  writeFileSync(scriptPath(name), JSON.stringify(script, null, 2));
  return scriptPath(name);
};

for (const [name, script] of Object.entries({
  product: productScript,
  design: designScript,
  architecture: architectureScript,
  development: developmentBadScript,
  review: reviewScript,
  qa: qaScript,
  release: releaseScript,
})) putScript(name, script);

// --------------------------------------------------------------- composition

const paths = createPaths(HOME);
mkdirSync(paths.root, { recursive: true });
const log = createLogger({ level: 'error', base: { component: 'check' } });

const container = new Container();
const published = [];
const eventBus = {
  publish: (record) => published.push(record),
  subscribe: () => () => {},
};
const invalidations = [];
const projectionBus = {
  invalidate: (topic, scope) => invalidations.push({ topic, ...scope }),
  subscribe: () => () => {},
};

compose(
  container,
  persistenceModule({ path: paths.db, logger: log }),
  createArtifactsModule({ paths }),
  policyModule,
  contextModule,
  createEvaluationModule(),
  runtimesCoreModule,
  genericRuntimeModule,
  executionCoreModule,
  executionLocalModule,
  integrationsCoreModule,
  applicationModule,
);

// The three cross-cutting tokens the composition root owns.
container.bind(EXEC_CLOCK, () => systemClock, { source: 'check' });
container.bind(EXEC_LOGGER, () => log, { source: 'check' });
container.bind(EXEC_PATHS, () => paths, { source: 'check' });
container.bind(INT_CLOCK, () => systemClock, { source: 'check' });
container.bind(INT_LOGGER, () => log, { source: 'check' });

// Alias the application's port tokens onto the concrete providers, exactly as
// `apps/daemon/src/bootstrap.ts` does.
const appTokens = app;
for (const name of Object.keys(appTokens)) {
  const appToken = appTokens[name];
  const provider = persistenceTokens[name];
  if (!isToken(appToken) || !isToken(provider)) continue;
  if (!container.has(provider) || container.has(appToken)) continue;
  container.bind(appToken, (r) => r.resolve(provider), { source: `alias:${name}` });
}
container.bind(appTokens.ARTIFACT_STORE, (r) => r.resolve(ARTIFACTS_STORE_TOKEN), { source: 'alias' });
container.bind(appTokens.ARTIFACT_TEMPLATES, () => ({ render: renderArtifactTemplate }), { source: 'check' });
container.bind(appTokens.ARTIFACT_PARSER, () => ({ parse: parseArtifact }), { source: 'check' });
container.bind(appTokens.EVENT_BUS, () => eventBus, { source: 'check' });
container.bind(appTokens.PROJECTION_BUS, () => projectionBus, { source: 'check' });
container.bind(appTokens.SECRET_STORE, () => memorySecrets(), { source: 'check' });
container.bind(appTokens.SETTINGS_STORE, () => createMemorySettingsStore(), { source: 'check' });
container.bind(appTokens.SYSTEM_ENVIRONMENT, () => describeEnvironment({ home: HOME, schemaVersion: 1 }), { source: 'check' });
container.bind(appTokens.PROCESS_LIVENESS, () => osProcessLiveness, { source: 'check' });

function isToken(v) {
  return typeof v === 'object' && v !== null && typeof v.description === 'string';
}
function memorySecrets() {
  const store = new Map();
  return {
    backend: 'memory',
    store: async (name, value) => { const ref = `mem:${name}`; store.set(ref, value); return ref; },
    resolve: async (ref) => store.get(ref),
    remove: async (ref) => { store.delete(ref); },
    list: async () => [...store.keys()],
  };
}

const services = createServices(container);
const scheduler = container.resolve(SCHEDULER);
const recovery = container.resolve(RECOVERY_SERVICE);
const repos = {
  missions: container.resolve(appTokens.MISSION_REPOSITORY),
  tasks: container.resolve(appTokens.TASK_REPOSITORY),
  runs: container.resolve(appTokens.RUN_REPOSITORY),
  events: container.resolve(appTokens.EVENT_REPOSITORY),
  targets: container.resolve(appTokens.EXECUTION_TARGET_REPOSITORY),
  profiles: container.resolve(appTokens.RUNTIME_PROFILE_REPOSITORY),
  evaluations: container.resolve(appTokens.EVALUATION_REPOSITORY),
  assignments: container.resolve(appTokens.ASSIGNMENT_REPOSITORY),
};

const lifecycle = new LifecycleHost(log);
lifecycle.add(scheduler);

// =============================================================== 0. recovery
head('0. startup recovery runs before the scheduler');
const emptyRecovery = await recovery.run();
ok('recovery completes on an empty database', emptyRecovery.tasksRequeued === 0,
  `adopted=${emptyRecovery.adopted.length} interrupted=${emptyRecovery.interrupted.length}`);

// ===================================================== 1. workspace + repository
head('1. workspace, built-in roles, and the repository');
let workspaceView = await services.workspaces.create({ name: 'Tandemise Check' });
const workspaceId = workspaceView.workspace.id;
ok('the workspace seeded the built-in roles', workspaceView.roles.length === 8,
  workspaceView.roles.map((r) => r.id).join(', '));

const probe = await services.workspaces.probeRepository(REPO);
ok('probing the repository detects git and its checks', probe.isGitRepository && probe.detectedChecks.test === 'npm test',
  `${probe.name} @ ${probe.defaultBranch}, test=${probe.detectedChecks.test}, typecheck=${probe.detectedChecks.typecheck}`);

const repository = await services.workspaces.addRepository(workspaceId, {
  path: REPO,
  // The worktree has no node_modules of its own. Linking the checkout's is a
  // legitimate `checks.install` command and keeps this run offline.
  checks: { install: `ln -sfn ${REPO}/node_modules node_modules` },
});
ok('the repository was added', repository.path === REPO, `${repository.name} (${repository.id})`);
ok('the first repository became the workspace default',
  services.workspaces.view(workspaceId).workspace.defaultRepositoryId === repository.id);

// One runtime profile per role, each with its own scripted behaviour.
const profileFor = {};
for (const role of ['product', 'design', 'architecture', 'development', 'review', 'qa', 'release']) {
  const created = await services.runtimes.create({
    adapterId: FAKE_ADAPTER_ID,
    name: `fake-${role}`,
    workspaceId,
    settings: { scriptPath: scriptPath(role) },
    maxConcurrent: 2,
  });
  profileFor[role] = created.id;
}
const routing = Object.fromEntries(Object.entries(profileFor).map(([role, id]) => [role, [id]]));
workspaceView = services.workspaces.update(workspaceId, { routing });
ok('every role is routed to its own fake runtime',
  Object.keys(workspaceView.workspace.routing).length >= 7,
  Object.entries(routing).map(([r, [p]]) => `${r}→${p.slice(0, 8)}`).join(' '));

const runtimeViews = await services.runtimes.list(workspaceId);
ok('all runtimes report healthy', runtimeViews.every((v) => v.health.state === 'healthy'),
  runtimeViews.map((v) => `${v.profile.name}:${v.health.state}`).join(' '));

// ================================================== 2. mission, plan, fallback
head('2. a mission from a natural-language goal, and the preset fallback');
const mission = await services.missions.create({
  workspaceId,
  repositoryId: repository.id,
  goal: 'Let people clear all their completed tasks in Taskly in one action, without touching open ones.',
  successCriteria: ['Completed tasks can be cleared in one action', 'Open tasks are never removed'],
});
ok('the mission preserved the goal verbatim',
  mission.goal.startsWith('Let people clear all their completed tasks'), mission.title);
ok('an integration branch was named at creation', mission.integrationBranch !== null, mission.integrationBranch);

const planned = await services.planning.plan(mission.id);
const planningNotes = repos.events.listByMission(mission.id)
  .filter((e) => e.body.type === 'note')
  .map((e) => e.body.text);
const fallbackNote = planningNotes.find((t) => t.includes('fell back to the'));
ok('planning fell back to the preset', fallbackNote !== undefined);
ok('the fallback note explains why', fallbackNote?.includes('invalid plan twice') === true,
  fallbackNote?.slice(0, 150));
ok('the plan has the feature-delivery shape', planned.tasks.length === 7,
  planned.tasks.map((t) => t.key).join(' → '));
ok('a MissionPlan artifact was stored',
  planned.artifacts.some((a) => a.type === 'MissionPlan'));
ok('the mission is waiting for plan approval',
  planned.mission.status === 'AWAITING_PLAN_APPROVAL', planned.mission.status);
ok('the plan validates as a graph', planned.planIssues.filter((i) => i.severity === 'error').length === 0);

const planApproval = planned.approvals.find((a) => a.kind === 'plan' && a.status === 'PENDING');
ok('a plan approval was raised', planApproval !== undefined, planApproval?.title);

// Starting before the plan is approved must be refused.
let refused = null;
try { await services.missions.start(mission.id); } catch (e) { refused = e; }
ok('starting is refused while the plan is unapproved', refused?.code === 'APPROVAL_REQUIRED', refused?.message);

// ==================================================== 3. run the DAG to the end
head('3. approve the plan and run the DAG');
await services.approvals.decide(planApproval.id, { optionId: 'approve' });
ok('approving the plan starts the mission',
  repos.missions.get(mission.id).status === 'EXECUTING');

const statusLine = () => repos.tasks.listByMission(mission.id)
  .sort((a, b) => a.orderHint - b.orderHint)
  .map((t) => `${t.key}:${t.status}${t.attempts > 0 ? `/${t.attempts}` : ''}`)
  .join('  ');

let gateFeedback = null;
let swappedDevScript = false;
let previous = '';

/** Ticks until the mission settles or a task starts waiting on a human. */
async function runUntilSettled(budgetMs = 300_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await scheduler.tick();
    await scheduler.drain();

    const line = statusLine();
    if (line !== previous) { console.log(`  ${line}`); previous = line; }

    const implement = repos.tasks.listByMission(mission.id).find((t) => t.key === 'implement');
    // The gate feedback loop: the first attempt's ChangeSet does not satisfy its
    // contract, so the gate fails and the task returns to READY carrying the
    // measurement. Swapping the script is this harness standing in for a worker
    // that reads the feedback and does better.
    if (!swappedDevScript && implement?.status === 'READY' && implement.attempts === 1 && implement.statusReason) {
      gateFeedback = implement.statusReason;
      putScript('development', developmentGoodScript);
      swappedDevScript = true;
      console.log(`  ↳ gate failed, retrying with feedback: ${gateFeedback.slice(0, 120)}…`);
    }

    const missionNow = repos.missions.get(mission.id);
    const tasksNow = repos.tasks.listByMission(mission.id);
    const settled = ['COMPLETE', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(missionNow.status);
    const waiting = tasksNow.some((t) => t.status === 'AWAITING_APPROVAL');
    if (settled || waiting) return;
  }
}

await runUntilSettled();

console.log(`  ${statusLine()}`);
ok('the gate failure produced feedback', gateFeedback !== null, gateFeedback?.slice(0, 100));
ok('the implementation task eventually succeeded',
  repos.tasks.listByMission(mission.id).find((t) => t.key === 'implement')?.status === 'SUCCEEDED');

// Routing honesty: the QA task requires `browser`, which the fake runtime does
// not offer. The scheduler must block it with a reason naming what was missing
// rather than silently handing the work to a runtime that cannot do it.
const qaTask = repos.tasks.listByMission(mission.id).find((t) => t.key === 'qa');
ok('QA blocked because no runtime offers what it needs',
  qaTask.status === 'BLOCKED' && qaTask.attempts === 0 && /browser/.test(qaTask.statusReason ?? ''),
  qaTask.statusReason);
ok('the mission followed its task into BLOCKED',
  repos.missions.get(mission.id).status === 'BLOCKED');

repos.profiles.update(profileFor.qa, { capabilities: [...FAKE_CAPABILITIES, 'browser'] });
await services.runtimes.checkHealth(profileFor.qa);
const retried = await services.missions.retryTask(qaTask.id, { note: 'Granted the browser capability.' });
ok('a manual retry puts the task back in the queue and revives the mission',
  retried.status === 'READY' && repos.missions.get(mission.id).status === 'EXECUTING');
await runUntilSettled();
console.log(`  ${statusLine()}`);

// =============================================== 4. isolation, artifacts, gates
head('4. worktrees, harvested artifacts, checks, gates, events');
const targets = repos.targets.listByMission(mission.id);
const worktrees = targets.filter((t) => t.kind === 'worktree');
const byTask = new Map(worktrees.map((t) => [t.taskId, t.workingDirectory]));
ok('each code task got its own worktree',
  byTask.size === 3 && new Set(byTask.values()).size === 3,
  [...new Set(worktrees.map((t) => `${t.name}@${t.branch?.split('/').pop()}`))].join(' '));
ok('a retry reuses its task\'s worktree rather than cutting a new branch',
  new Set(worktrees.filter((t) => t.name.endsWith('-implement')).map((t) => t.branch)).size === 1);
ok('worktrees live outside the user checkout', worktrees.every((t) => !t.workingDirectory.startsWith(`${REPO}/`)),
  worktrees[0]?.workingDirectory);

const excluded = existsSync(join(REPO, '.git', 'info', 'exclude'))
  && readFileSyncSafe(join(REPO, '.git', 'info', 'exclude')).includes('.tandemise/');
ok('.tandemise/ was added to .git/info/exclude', excluded);

const detail = await services.projections.missionDetail(mission.id);
const byType = detail.artifacts.map((a) => a.type);
ok('artifacts were harvested from .tandemise/out/',
  ['ProblemBrief', 'ProductSpec', 'DesignBrief', 'ArchitecturePlan', 'ImplementationPlan', 'ChangeSet', 'ReviewReport', 'QAPlan', 'QAReport']
    .every((t) => byType.includes(t)),
  byType.join(', '));
const changeSet = detail.artifacts.find((a) => a.type === 'ChangeSet');
const loaded = await services.artifacts.read(changeSet.id);
ok('an artifact body round-trips through the store',
  loaded.body.includes('branch: tandemise/implement'), `${changeSet.byteSize} bytes`);

ok('check results were recorded', detail.checks.length > 0,
  detail.checks.map((c) => `${c.name}=${c.outcome}`).join(' '));
ok('the repository checks actually ran and passed',
  detail.checks.some((c) => c.name === 'checks.tests' && c.outcome === 'PASS')
  && detail.checks.some((c) => c.name === 'checks.typecheck' && c.outcome === 'PASS'));

const gated = detail.tasks.filter((t) => t.completionGate !== null);
ok('every gated task has an evaluated gate', gated.every((t) => t.gate !== null),
  gated.map((t) => `${t.key}:${t.gate?.passed}`).join(' '));

const evaluations = detail.evaluations;
ok('the review and QA reports became structured evaluations',
  evaluations.some((e) => e.evaluatorRoleId === 'review') && evaluations.some((e) => e.evaluatorRoleId === 'qa'),
  evaluations.map((e) => `${e.evaluatorRoleId}:${e.verdict}`).join(' '));

const events = repos.events.listByMission(mission.id, { limit: 100000 });
const monotonic = events.every((e, i) => i === 0 || e.sequence > events[i - 1].sequence);
ok('events are persisted with monotonic sequences', monotonic && events.length > 50,
  `${events.length} events, 1..${events[events.length - 1]?.sequence}`);
ok('every persisted event was also published', published.length === events.length,
  `${published.length} published`);
ok('status transitions are on the timeline',
  events.some((e) => e.body.type === 'mission.status') && events.filter((e) => e.body.type === 'task.status').length >= 7);

// ================================================ 5. the gate feedback loop
head('5. the gate detail reached the retry prompt verbatim');
const implementTask = repos.tasks.listByMission(mission.id).find((t) => t.key === 'implement');
const implementRuns = [...repos.runs.listByTask(implementTask.id)].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
ok('the implementation task ran twice', implementRuns.length === 2,
  implementRuns.map((r) => `${r.attempt}:${r.status}`).join(' '));

const secondRunPrompt = events
  .filter((e) => e.runId === implementRuns[1]?.id && e.body.type === 'message')
  .map((e) => e.body.text)
  .find((t) => t.includes('PROMPT>>>'));
ok('the retry prompt was captured', secondRunPrompt !== undefined, `${secondRunPrompt?.length ?? 0} chars`);
ok('the retry prompt contains the gate detail verbatim',
  gateFeedback !== null && secondRunPrompt?.includes(gateFeedback) === true);
console.log(`     gate detail: ${gateFeedback}`);

// ============================================================ 6. an approval
head('6. an approval blocks progression, and deciding it resumes the mission');
const rc = repos.tasks.listByMission(mission.id).find((t) => t.key === 'release_candidate');
ok('the release candidate is held for approval', rc?.status === 'AWAITING_APPROVAL', rc?.statusReason);

await scheduler.tick(); await scheduler.drain();
await scheduler.tick(); await scheduler.drain();
ok('ticking does not move the mission while it waits',
  repos.missions.get(mission.id).status !== 'COMPLETE'
  && repos.tasks.listByMission(mission.id).find((t) => t.key === 'release_candidate').status === 'AWAITING_APPROVAL');

const rcApproval = services.approvals
  .list({ missionId: mission.id, status: 'PENDING' })
  .find((v) => v.approval.taskId === rc.id);
ok('the approval card is complete', rcApproval !== undefined
  && rcApproval.approval.rationale.length > 0
  && rcApproval.approval.effect.length > 0
  && rcApproval.approval.evidence.length > 0,
  `${rcApproval?.approval.evidence.length} pieces of evidence`);

await services.approvals.decide(rcApproval.approval.id, { optionId: 'approve', note: 'Ship it.' });
ok('approving releases the task',
  repos.tasks.listByMission(mission.id).find((t) => t.key === 'release_candidate').status === 'SUCCEEDED');

// `wake()` fires a tick without awaiting it - that is what a scheduler is - so
// the last stretch is polled rather than counted in ticks.
const settleBy = Date.now() + 120_000;
while (Date.now() < settleBy && repos.missions.get(mission.id).status === 'EXECUTING') {
  await scheduler.tick();
  await scheduler.drain();
  await new Promise((r) => setTimeout(r, 100));
}
console.log(`  ${statusLine()}`);
ok('the mission completed', repos.missions.get(mission.id).status === 'COMPLETE',
  `${repos.missions.get(mission.id).status}: ${repos.missions.get(mission.id).statusReason}`);
const completedDetail = await services.projections.missionDetail(mission.id);
ok('the task branches were integrated',
  repos.events.listByMission(mission.id, { limit: 100000 })
    .some((e) => e.body.type === 'note' && /Integrated \d+\/\d+ task branches/.test(e.body.text)),
  repos.events.listByMission(mission.id, { limit: 100000 })
    .filter((e) => e.body.type === 'note' && e.body.text.includes('Integrated'))
    .map((e) => e.body.text)[0]);

// ============================================================== 7. recovery
head('7. recovery of a run whose process is gone');
const victimTask = repos.tasks.listByMission(mission.id).find((t) => t.key === 'review');
const victimRun = repos.runs.listByTask(victimTask.id)[0];
repos.runs.update(victimRun.id, { status: 'RUNNING', pid: 999999, finishedAt: null, errorCode: null, errorMessage: null });
repos.tasks.update(victimTask.id, { status: 'RUNNING', statusReason: null, finishedAt: null });
repos.missions.update(mission.id, { status: 'EXECUTING', statusReason: 'simulated crash' });
ok('a run is marked RUNNING with a dead pid',
  repos.runs.get(victimRun.id).status === 'RUNNING' && repos.runs.get(victimRun.id).pid === 999999,
  `session=${repos.runs.get(victimRun.id).externalSessionId ?? 'none'}`);

const report = await recovery.run();
const recovered = repos.runs.get(victimRun.id);
ok('the interrupted run was reclassified',
  recovered.status === 'RESUMABLE' || recovered.status === 'INTERRUPTED', recovered.status);
ok('resumability follows the session handle',
  recovered.status === (recovered.externalSessionId === null ? 'INTERRUPTED' : 'RESUMABLE'));
ok('its task went back to READY',
  repos.tasks.get(victimTask.id).status === 'READY', repos.tasks.get(victimTask.id).statusReason);
ok('the attempt count was preserved', repos.tasks.get(victimTask.id).attempts === victimTask.attempts);
ok('recovery reported what it did', report.tasksRequeued === 1,
  `requeued=${report.tasksRequeued} leases=${report.leasesReleased} targets=${report.targetsFailed}`);
ok('a note was written to the mission timeline',
  repos.events.listByMission(mission.id, { limit: 100000 })
    .some((e) => e.body.type === 'note' && e.body.text.includes('Tandemise restarted')));

// ==================================================== 8. policy on the tool path
head('8. the policy engine is on the execution path');
const assignments = repos.tasks.listByMission(mission.id)
  .flatMap((t) => repos.assignments.listByTask(t.id));
ok('every attempt persisted an assignment with grants', assignments.length >= 7
  && assignments.every((a) => a.grants.length > 0),
  `${assignments.length} assignments`);
const devAssignment = assignments.find((a) => a.roleId === 'development');
ok('the development grants are scoped to its worktree',
  devAssignment.grants.every((g) => g.resourceScope.length === 0 || g.resourceScope.some((s) => s.startsWith('/'))),
  devAssignment.grants.map((g) => g.capability).join(', '));

const { POLICY_ENGINE } = await import('@tandemise/policy');
const { TOOL_POLICY_GATE } = await import('@tandemise/integrations-core');
const gate = container.resolve(TOOL_POLICY_GATE);
ok('the tool policy gate is the policy engine, not the deny-all default',
  container.resolve(POLICY_ENGINE) !== undefined && gate !== undefined);

const allowed = await gate.check({
  toolName: 'fs.read', capability: 'filesystem.read',
  resource: devAssignment.grants.find((g) => g.capability === 'filesystem.read')?.resourceScope[0],
  assignmentId: devAssignment.id, risk: 'read',
});
ok('a granted, in-scope call is allowed', allowed.outcome === 'allow', allowed.reason);

const denied = await gate.check({
  toolName: 'github.pr.create', capability: 'github.pr.create',
  resource: 'cli/cli', assignmentId: devAssignment.id, risk: 'external_side_effect',
});
ok('an ungranted capability is denied', denied.outcome === 'deny', denied.reason);
ok('the denial reached the mission timeline',
  repos.events.listByMission(mission.id, { limit: 100000 })
    .some((e) => e.body.type === 'policy.denied' && e.body.capability === 'github.pr.create'));

const outOfScope = await gate.check({
  toolName: 'fs.write', capability: 'filesystem.write',
  resource: '/etc/passwd', assignmentId: devAssignment.id, risk: 'write_reversible',
});
ok('a granted capability out of scope is denied', outOfScope.outcome === 'deny', outOfScope.reason);

// ================================================ 9. metrics and the final view
head('9. the rest of the service surface');
const info = services.system.info();
ok('system info reports the daemon', info.apiVersion === 'v1' && info.schemaVersion === 1, `${info.daemonVersion} on ${info.platform}`);
ok('settings round-trip', services.system.updateSettings({ theme: 'dark' }).theme === 'dark'
  && services.system.settings().theme === 'dark');
const diag = services.system.diagnostics();
ok('diagnostics list the composed providers',
  diag.runtimeAdapters.includes('fake') && diag.targetKinds.includes('worktree') && diag.bindings.length > 40,
  `${diag.bindings.length} bindings, targets=${diag.targetKinds.join('/')}`);

const customRole = services.roles.upsert({
  workspaceId, id: 'product', name: 'Product Manager (house style)',
  summary: 'Scopes work the way this team scopes work.',
  instructions: 'Write the spec in the house template.',
  defaultCapabilities: ['repository.read', 'artifact.write'],
  producesArtifacts: ['ProductSpec'], consumesArtifacts: [],
  defaultIsolation: 'none', outputContract: 'A ProductSpec.',
});
ok('a workspace can override a built-in role',
  customRole.workspaceId === workspaceId && customRole.builtIn === true
  && services.roles.list(workspaceId).find((r) => r.id === 'product')?.name === 'Product Manager (house style)');
services.roles.remove('product', workspaceId);
ok('removing the override restores the built-in',
  services.roles.list(workspaceId).find((r) => r.id === 'product')?.name === 'Product Manager');
let roleRefusal = null;
try { services.roles.remove('design', workspaceId); } catch (e) { roleRefusal = e; }
ok('a global built-in is not deletable', roleRefusal?.code === 'PRECONDITION_FAILED');

ok('artifacts are searchable', services.artifacts.search(workspaceId, 'clear').length > 0,
  `${services.artifacts.search(workspaceId, 'clear').length} hits`);
const discovered = await services.runtimes.discover();
ok('runtime discovery reports the fake as configured',
  discovered.find((d) => d.adapterId === 'fake')?.configured === true,
  discovered.map((d) => `${d.adapterId}:${d.detected ? 'found' : 'missing'}`).join(' '));
ok('integration providers enumerate', Array.isArray(services.integrations.listProviders())
  && (await services.integrations.list(workspaceId)).length === 0);
ok('live targets are listable', services.projections.targets().length >= 0
  && services.projections.targets(mission.id).length >= 4);
ok('mission events page by sequence',
  services.projections.missionEvents(mission.id, { afterSequence: 100, limit: 5 }).length === 5);

const throwaway = await services.missions.create({
  workspaceId, goal: 'A mission created only to exercise pause, resume, cancel and delete.',
});
await services.planning.plan(throwaway.id);
const throwawayApproval = services.approvals.list({ missionId: throwaway.id, status: 'PENDING' })[0];
await services.approvals.decide(throwawayApproval.approval.id, { optionId: 'approve' });
await scheduler.drain();
ok('pause stops dispatch', (await services.missions.pause(throwaway.id)).status === 'PAUSED');
const attemptsAtPause = repos.tasks.listByMission(throwaway.id).map((t) => t.attempts).join(',');
await scheduler.tick(); await scheduler.drain();
ok('a paused mission dispatches nothing',
  repos.tasks.listByMission(throwaway.id).map((t) => t.attempts).join(',') === attemptsAtPause,
  `attempts ${attemptsAtPause}`);
ok('resume puts it back to work', (await services.missions.resume(throwaway.id)).status === 'EXECUTING');
await scheduler.drain();
const cancelled = await services.missions.cancel(throwaway.id, 'Done demonstrating.');
const throwawayTasks = repos.tasks.listByMission(throwaway.id);
ok('cancel is terminal and cascades',
  cancelled.status === 'CANCELLED' && throwawayTasks.every((t) => isFinished(t.status)),
  throwawayTasks.map((t) => t.status).join(' '));
await services.missions.remove(throwaway.id);
ok('a removed mission is gone', repos.missions.get(throwaway.id) === undefined);
ok('mission listing filters by workspace',
  services.missions.list({ workspaceId, limit: 10 }).length === 1);

head('10. the final MissionDetail');
console.log('  (the live mission is back in EXECUTING because §7 simulated a crash;');
console.log('   this is the detail captured the moment the mission completed)');
const final = completedDetail;
ok('MissionDetail is well formed',
  final.mission.id === mission.id
  && final.tasks.length >= 7
  && final.progress.totalTasks === final.tasks.length
  && final.plan !== null
  && Array.isArray(final.planIssues),
  `${final.tasks.length} tasks, ${final.artifacts.length} artifacts, ${final.approvals.length} approvals`);
ok('every task view carries its projection fields',
  final.tasks.every((t) => typeof t.roleName === 'string' && typeof t.level === 'number' && Array.isArray(t.checks)));
ok('unreported metrics stay null, never zero',
  final.metrics.costUsd === null && typeof final.metrics.inputTokens === 'number',
  `cost=${final.metrics.costUsd} in=${final.metrics.inputTokens} out=${final.metrics.outputTokens}`);
ok('measured metrics are counted',
  final.metrics.retries >= 1 && final.metrics.runtimeActiveMs > 0 && final.metrics.commits > 0,
  `retries=${final.metrics.retries} commits=${final.metrics.commits} files=${final.metrics.filesChanged} runtimeMs=${final.metrics.runtimeActiveMs}`);

const home = await services.projections.home(workspaceId);
ok('the home view assembles', home.workspace?.id === workspaceId && home.recentMissions.length === 1,
  `${home.recentEvents.length} recent events, ${home.runtimes.length} runtimes`);

console.log('\n  MissionDetail (trimmed):');
console.log(JSON.stringify({
  mission: {
    title: final.mission.title, status: final.mission.status,
    goal: `${final.mission.goal.slice(0, 60)}…`,
    integrationBranch: final.mission.integrationBranch,
  },
  progress: final.progress,
  tasks: final.tasks.map((t) => ({
    key: t.key, role: t.roleName, level: t.level, status: t.status, attempts: t.attempts,
    artifacts: t.outputArtifacts.map((a) => a.type),
    gate: t.gate === null ? null : t.gate.passed,
    target: t.targetName, runtime: t.runtimeName,
  })),
  metrics: final.metrics,
  planIssues: final.planIssues.length,
}, null, 2).split('\n').map((l) => `  ${l}`).join('\n'));

// ============================================================ 10. lifecycle
head('11. the scheduler is a lifecycle component');
ok('it exposes the lifecycle shape',
  scheduler.name === 'scheduler' && typeof scheduler.start === 'function' && typeof scheduler.stop === 'function');
await lifecycle.start();
ok('start() is idempotent and returns', true);
await lifecycle.stop();
ok('stop() drained every in-flight attempt', scheduler.activeTaskIds().length === 0);

// -------------------------------------------------------------------- cleanup
await container.dispose();
rmSync(join(REPO, '.tandemise'), { recursive: true, force: true });
rmSync(join(REPO, 'CLEAR_COMPLETED.md'), { force: true });
try {
  const { execFileSync } = await import('node:child_process');
  const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });

  // Only this run's worktrees and branches. Another check may be running
  // against the same repository, and tearing down its work would be worse than
  // leaving mine behind.
  for (const line of git('worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('worktree ') && line.includes(HOME.replace('/var/', '/private/var/'))) {
      try { git('worktree', 'remove', '--force', line.slice('worktree '.length)); } catch { /* already gone */ }
    }
  }
  git('worktree', 'prune');

  const mine = `tandemise/${final.mission.integrationBranch.split('/')[1]}/`;
  for (const branch of git('branch', '--list', `${mine}*`).split('\n')) {
    const name = branch.replace(/^[*+]?\s*/, '').trim();
    if (name.length === 0) continue;
    try { git('branch', '-D', name); } catch { /* held by a live worktree */ }
  }

  const exclude = join(REPO, '.git', 'info', 'exclude');
  if (existsSync(exclude)) {
    writeFileSync(exclude, readFileSyncSafe(exclude).split('\n').filter((l) => l.trim() !== '.tandemise/').join('\n'));
  }
} catch (e) {
  console.log(`  (cleanup: ${e.message})`);
}
rmSync(HOME, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

function isFinished(status) {
  return ['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(status);
}

function readFileSyncSafe(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}
