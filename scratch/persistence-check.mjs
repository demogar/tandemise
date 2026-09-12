// Exercises every @tandemise/persistence repository method against a real
// SQLite file, then reopens the file and proves the data survived.
//
//   node scratch/persistence-check.mjs
//
// Build first: npx tsc -b packages/persistence

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { ids, systemClock } from '../packages/shared/dist/index.js';
import { Container, compose } from '../packages/kernel/dist/index.js';
import {
  APPROVAL_REPOSITORY, ARTIFACT_REPOSITORY, ASSIGNMENT_REPOSITORY, CHECKPOINT_REPOSITORY,
  DATABASE, DECISION_REPOSITORY, EVALUATION_REPOSITORY, EVENT_REPOSITORY,
  EXECUTION_TARGET_REPOSITORY, INTEGRATION_REPOSITORY, LEASE_REPOSITORY, MISSION_REPOSITORY,
  REPO_REPOSITORY, ROLE_REPOSITORY, RUN_REPOSITORY, RUNTIME_PROFILE_REPOSITORY,
  SCHEMA_VERSION, TASK_REPOSITORY, UNIT_OF_WORK, WORKSPACE_REPOSITORY,
  openDatabase, migrate, schemaVersion, persistenceModule,
} from '../packages/persistence/dist/index.js';

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${detail}`}`);
  }
}

function section(title) {
  console.log(`\n== ${title}`);
}

const dir = mkdtempSync(join(tmpdir(), 'tandemise-persistence-'));
const dbPath = join(dir, 'nested', 'tandemise.db');
const now = () => systemClock.now();

function build() {
  const container = new Container();
  compose(container, persistenceModule({ path: dbPath, clock: systemClock }));
  return container;
}

let container = build();
const R = {
  db: container.resolve(DATABASE),
  uow: container.resolve(UNIT_OF_WORK),
  workspaces: container.resolve(WORKSPACE_REPOSITORY),
  repos: container.resolve(REPO_REPOSITORY),
  missions: container.resolve(MISSION_REPOSITORY),
  tasks: container.resolve(TASK_REPOSITORY),
  runs: container.resolve(RUN_REPOSITORY),
  events: container.resolve(EVENT_REPOSITORY),
  artifacts: container.resolve(ARTIFACT_REPOSITORY),
  approvals: container.resolve(APPROVAL_REPOSITORY),
  roles: container.resolve(ROLE_REPOSITORY),
  profiles: container.resolve(RUNTIME_PROFILE_REPOSITORY),
  targets: container.resolve(EXECUTION_TARGET_REPOSITORY),
  integrations: container.resolve(INTEGRATION_REPOSITORY),
  assignments: container.resolve(ASSIGNMENT_REPOSITORY),
  decisions: container.resolve(DECISION_REPOSITORY),
  evaluations: container.resolve(EVALUATION_REPOSITORY),
  checkpoints: container.resolve(CHECKPOINT_REPOSITORY),
  leases: container.resolve(LEASE_REPOSITORY),
};

section('database + migrations');
check('parent directories created and file opened', R.db.path === dbPath);
check('journal_mode is WAL', R.db.handle.pragma('journal_mode', { simple: true }) === 'wal');
check('foreign_keys is ON', R.db.handle.pragma('foreign_keys', { simple: true }) === 1);
check('busy_timeout is 5000', R.db.handle.pragma('busy_timeout', { simple: true }) === 5000);
check('synchronous is NORMAL(1)', R.db.handle.pragma('synchronous', { simple: true }) === 1);
check(`schema at version ${SCHEMA_VERSION}`, schemaVersion(R.db) === SCHEMA_VERSION);
check('migrate() is idempotent', migrate(R.db).applied.length === 0);

const tables = R.db.handle
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);
const REQUIRED_TABLES = [
  'workspaces', 'repositories', 'missions', 'mission_tasks', 'task_dependencies',
  'role_templates', 'runtime_profiles', 'execution_targets', 'integrations',
  'integration_grants', 'worker_assignments', 'runs', 'run_events', 'artifacts',
  'artifact_links', 'decisions', 'approvals', 'policies', 'evaluations', 'check_results',
  'resource_leases', 'checkpoints', 'usage_records',
];
const missing = REQUIRED_TABLES.filter((t) => !tables.includes(t));
check('every MVP.md §20.2 table exists', missing.length === 0, `missing: ${missing.join(', ')}`);

section('workspace + repository');
const wsId = ids.workspace();
const workspace = R.workspaces.create({
  id: wsId,
  name: 'Acme',
  defaultRepositoryId: null,
  autonomy: {
    planApproval: 'ask', localCodeChanges: 'auto', externalWrites: 'policy',
    productionRelease: 'ask', financialActions: 'deny',
  },
  concurrency: { maxTotalWorkers: 3, perRuntime: { 'rt-claude': 2 } },
  routing: { development: ['rt-claude'] },
  defaultAutonomyLevel: 'balanced',
  knowledge: {
    productVision: 'ship calm software', architecturePrinciples: null,
    codingStandards: null, designSystem: null, glossary: null,
  },
});
check('workspaces.create assigned timestamps', typeof workspace.createdAt === 'string');
check('workspaces.get round-trips JSON columns', R.workspaces.get(wsId).concurrency.perRuntime['rt-claude'] === 2);
check('workspaces.list', R.workspaces.list().length === 1);

const repoId = ids.repository();
const repo = R.repos.create({
  id: repoId,
  workspaceId: wsId,
  name: 'acme-web',
  path: '/tmp/acme-web',
  defaultBranch: 'main',
  remoteUrl: 'git@github.com:acme/web.git',
  checks: {
    install: 'npm ci', typecheck: 'npm run typecheck', lint: null,
    test: 'npm test', build: 'npm run build', devServer: null, devServerUrl: null,
  },
});
check('repos.create', repo.id === repoId);
check('repos.get', R.repos.get(repoId).checks.test === 'npm test');
check('repos.listByWorkspace', R.repos.listByWorkspace(wsId).length === 1);
check('repos.update', R.repos.update(repoId, { defaultBranch: 'trunk' }).defaultBranch === 'trunk');
check(
  'workspaces.update sets defaultRepositoryId (FK resolves)',
  R.workspaces.update(wsId, { defaultRepositoryId: repoId }).defaultRepositoryId === repoId,
);

section('roles, runtime profiles, integrations');
const globalRole = R.roles.upsert({
  id: 'review', workspaceId: null, name: 'Reviewer', summary: 'reviews work',
  instructions: 'be strict', defaultCapabilities: ['repository.read'],
  producesArtifacts: ['ReviewReport'], consumesArtifacts: ['ChangeSet'],
  defaultIsolation: 'worktree', outputContract: 'findings with severities',
  builtIn: true, createdAt: now(), updatedAt: now(),
});
check('roles.upsert inserts a global role', globalRole.id === 'review');
check('roles.get falls back to the global role', R.roles.get('review', wsId).name === 'Reviewer');
R.roles.upsert({
  ...globalRole, workspaceId: wsId, name: 'Acme Reviewer', builtIn: false, updatedAt: now(),
});
check('workspace override shadows the global role', R.roles.get('review', wsId).name === 'Acme Reviewer');
check('global role still visible with a null scope', R.roles.get('review', null).name === 'Reviewer');
check('roles.list de-duplicates by id', R.roles.list(wsId).length === 1);
R.roles.upsert({ ...globalRole, workspaceId: wsId, name: 'Acme Reviewer v2', updatedAt: now() });
check('roles.upsert updates in place', R.roles.get('review', wsId).name === 'Acme Reviewer v2');
R.roles.remove('review', wsId);
check('roles.remove drops only the override', R.roles.get('review', wsId).name === 'Reviewer');

const profileId = ids.runtimeProfile();
R.profiles.create({
  id: profileId, workspaceId: wsId, adapterId: 'claude-code', name: 'Claude Code',
  executablePath: '/usr/local/bin/claude', args: ['--print'],
  settings: { model: 'sonnet' }, capabilities: ['shell', 'filesystem', 'session_resume'],
  enabled: true, maxConcurrent: 2, createdAt: now(), updatedAt: now(),
});
check('profiles.get round-trips settings', R.profiles.get(profileId).settings.model === 'sonnet');
check('profiles.list(workspace) includes scoped profiles', R.profiles.list(wsId).length === 1);
check('profiles.list(null) excludes scoped profiles', R.profiles.list(null).length === 0);
check('profiles.list() lists everything', R.profiles.list().length === 1);
check('profiles.update', R.profiles.update(profileId, { maxConcurrent: 4 }).maxConcurrent === 4);

const integrationId = ids.integration();
R.integrations.create({
  id: integrationId, workspaceId: wsId, providerId: 'github', name: 'GitHub',
  transport: 'cli', config: { host: 'github.com' }, credentialRef: 'keychain://gh',
  enabledCapabilities: ['github.read', 'github.pr.create'], enabled: true,
  createdAt: now(), updatedAt: now(),
});
check('integrations.get normalizes grants', R.integrations.get(integrationId).enabledCapabilities.length === 2);
check('integrations.listByWorkspace', R.integrations.listByWorkspace(wsId).length === 1);
check(
  'integrations.update rewrites grants',
  R.integrations.update(integrationId, { enabledCapabilities: ['github.read'] }).enabledCapabilities.length === 1,
);
check(
  'grants are queryable by capability',
  R.db.handle.prepare('SELECT COUNT(*) c FROM integration_grants WHERE capability = ?').get('github.read').c === 1,
);

section('mission + tasks');
const missionId = ids.mission();
const mission = R.missions.create({
  id: missionId, workspaceId: wsId, repositoryId: repoId, title: 'Onboarding flow',
  goal: 'Ship a first-run onboarding flow', constraints: ['no new deps'],
  successCriteria: ['activation up 10%'], autonomy: 'balanced', baseBranch: 'main',
});
check('missions.create defaults to DRAFT', mission.status === 'DRAFT');
check('missions.get', R.missions.get(missionId).constraints[0] === 'no new deps');
check('missions.list by workspace', R.missions.list({ workspaceId: wsId }).length === 1);
check('missions.list filters by status', R.missions.list({ statuses: ['EXECUTING'] }).length === 0);
check('missions.list honours limit', R.missions.list({ limit: 0 }).length === 0);
check('missions.update', R.missions.update(missionId, { status: 'EXECUTING' }).status === 'EXECUTING');

const taskIds = [ids.task(), ids.task(), ids.task()];
const mkTask = (id, key, status, deps, orderHint) => ({
  id, missionId, key, title: `Task ${key}`, objective: `do ${key}`, roleId: 'development',
  dependsOn: deps, requiredCapabilities: ['filesystem.write'],
  inputArtifacts: [{ type: 'ImplementationPlan', required: true }],
  expectedOutputs: ['ChangeSet'],
  executionPolicy: { isolation: 'worktree', maxWallTimeMs: 600000, capabilities: ['shell.exec'] },
  approvalPolicy: { beforeStart: false, onCompletion: true },
  retryPolicy: { maxAttempts: 2, backoffMs: 5000, onExhausted: 'block' },
  completionGate: 'checks.typecheck == PASS && review.blocking_findings == 0',
  status, statusReason: null, attempts: 0, remediatesTaskId: null, orderHint,
  createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
});

const written = R.tasks.replaceAll(missionId, [
  mkTask(taskIds[0], 'plan', 'SUCCEEDED', [], 0),
  mkTask(taskIds[1], 'build', 'RUNNING', ['plan', 'plan'], 1),
]);
check('tasks.replaceAll returns what it wrote', written.length === 2);
check('duplicate dependencies collapse', written[1].dependsOn.length === 1);
check('tasks.listByMission is ordered by orderHint', R.tasks.listByMission(missionId)[0].key === 'plan');
check('tasks.get hydrates dependsOn', R.tasks.get(taskIds[1]).dependsOn[0] === 'plan');
check('tasks.getByKey', R.tasks.getByKey(missionId, 'build').id === taskIds[1]);
check('tasks.listByStatus spans missions', R.tasks.listByStatus(['RUNNING']).length === 1);
R.tasks.add(mkTask(taskIds[2], 'qa', 'PENDING', ['build'], 2));
check('tasks.add', R.tasks.listByMission(missionId).length === 3);
check(
  'tasks.update merges and keeps identity',
  R.tasks.update(taskIds[2], { status: 'BLOCKED', statusReason: 'waiting on build' }).status === 'BLOCKED',
);
check('tasks.update preserves dependsOn', R.tasks.get(taskIds[2]).dependsOn[0] === 'build');
check(
  'gate expression survives the round trip',
  R.tasks.get(taskIds[0]).completionGate === 'checks.typecheck == PASS && review.blocking_findings == 0',
);

section('targets, assignments, runs');
const targetId = ids.executionTarget();
R.targets.create({
  id: targetId, workspaceId: wsId, missionId, taskId: taskIds[1], kind: 'worktree',
  name: 'wt-build', workingDirectory: '/tmp/wt-build', branch: 'tandemise/build',
  baseBranch: 'main', status: 'PROVISIONING', detail: null, createdAt: now(), releasedAt: null,
});
check('targets.get', R.targets.get(targetId).kind === 'worktree');
check('targets.listByMission', R.targets.listByMission(missionId).length === 1);
check('targets.update', R.targets.update(targetId, { status: 'READY' }).status === 'READY');
check('targets.listByStatus', R.targets.listByStatus(['READY', 'IN_USE']).length === 1);

const assignmentId = ids.workerAssignment();
R.assignments.create({
  id: assignmentId, workspaceId: wsId, missionId, taskId: taskIds[1], roleId: 'development',
  runtimeProfileId: profileId, executionTargetId: targetId,
  grants: [{ capability: 'filesystem.write', resourceScope: ['/tmp/wt-build'], approvalMode: 'auto', expiresAt: null }],
  budgets: { maxWallTimeMs: 600000, maxAttempts: 2 }, createdAt: now(),
});
check('assignments.get', R.assignments.get(assignmentId).grants[0].capability === 'filesystem.write');
check('assignments.listByTask', R.assignments.listByTask(taskIds[1]).length === 1);

const runId = ids.run();
R.runs.create({
  id: runId, missionId, taskId: taskIds[1], assignmentId, attempt: 1, status: 'RUNNING',
  roleId: 'development', runtimeProfileId: profileId, executionTargetId: targetId,
  externalSessionId: 'sess-abc', pid: 4242, exitCode: null, errorCode: null,
  errorMessage: null, usage: null, startedAt: now(), finishedAt: null, heartbeatAt: null,
});
check('runs.get', R.runs.get(runId).externalSessionId === 'sess-abc');
check('runs.listByTask', R.runs.listByTask(taskIds[1]).length === 1);
check('runs.listByMission', R.runs.listByMission(missionId).length === 1);
check('runs.listByStatus', R.runs.listByStatus(['RUNNING', 'STARTING']).length === 1);
const beatAt = now();
R.runs.heartbeat(runId, beatAt);
check('runs.heartbeat', R.runs.get(runId).heartbeatAt === beatAt);
R.runs.recordUsage(runId, { inputTokens: 1200, outputTokens: 340, costUsd: null, turns: 3 });
R.runs.recordUsage(runId, { inputTokens: 2400, outputTokens: 700, costUsd: null, turns: 6 });
check('runs.recordUsage stores the latest snapshot', R.runs.get(runId).usage.inputTokens === 2400);
check(
  'usage_records keeps every observation',
  R.db.handle.prepare('SELECT COUNT(*) c FROM usage_records WHERE run_id = ?').get(runId).c === 2,
);
check('runs.update', R.runs.update(runId, { status: 'SUCCEEDED', exitCode: 0 }).exitCode === 0);

section('checkpoints');
const cp1 = R.checkpoints.append({
  runId, sequence: 0, label: 'plan-written', externalSessionId: 'sess-abc',
  payload: { files: 3 }, createdAt: now(),
});
const cp2 = R.checkpoints.append({
  runId, sequence: 0, label: 'tests-green', externalSessionId: 'sess-abc',
  payload: { suite: 'unit' }, createdAt: now(),
});
check('checkpoints get monotonic sequences', cp1.sequence === 1 && cp2.sequence === 2);
check('checkpoints.latest', R.checkpoints.latest(runId).label === 'tests-green');
check('checkpoints.list', R.checkpoints.list(runId).length === 2);
check('checkpoint payload round-trips', R.checkpoints.latest(runId).payload.suite === 'unit');

section('event log');
const bodies = [
  { type: 'run.started', attempt: 1, runtime: 'claude-code', target: 'wt-build' },
  { type: 'message', text: 'starting work' },
  { type: 'raw', channel: 'stdout', text: 'npm install' },
  { type: 'file.changed', path: 'src/app.ts', change: 'edit' },
  { type: 'completed', summary: 'done' },
];
const appended = bodies.map((body) =>
  R.events.append({
    id: ids.event(), workspaceId: wsId, missionId, taskId: taskIds[1], runId,
    roleId: 'development', runtimeProfileId: profileId, body, createdAt: now(),
  }),
);
const sequences = appended.map((e) => e.sequence);
check('sequences are 1..n and strictly increasing', JSON.stringify(sequences) === '[1,2,3,4,5]');
check('latestSequence matches', R.events.latestSequence(missionId) === 5);
check('listByMission returns all events', R.events.listByMission(missionId).length === 5);
check(
  'semanticOnly drops the raw line',
  R.events.listByMission(missionId, { semanticOnly: true }).length === 4,
);
check('afterSequence windows the log', R.events.listByMission(missionId, { afterSequence: 3 }).length === 2);
check('limit applies', R.events.listByMission(missionId, { limit: 2 }).length === 2);
check('listByRun', R.events.listByRun(runId).length === 5);
check('event body round-trips', R.events.listByRun(runId, { afterSequence: 4 })[0].body.summary === 'done');

// A second mission proves the sequence counter is per-mission, not global.
const otherMissionId = ids.mission();
R.missions.create({
  id: otherMissionId, workspaceId: wsId, repositoryId: null, title: 'Other',
  goal: 'unrelated', constraints: [], successCriteria: [],
});
const otherEvent = R.events.append({
  id: ids.event(), workspaceId: wsId, missionId: otherMissionId, body: { type: 'note', text: 'hello' },
  createdAt: now(),
});
check('sequences are scoped per mission', otherEvent.sequence === 1);

section('artifacts');
const artifactV1 = R.artifacts.create({
  id: ids.artifact(), workspaceId: wsId, missionId, taskId: taskIds[0], createdByRunId: runId,
  type: 'ImplementationPlan', title: 'Onboarding implementation plan',
  contentRef: 'artifacts/plan-v1.md', mediaType: 'text/markdown', sha256: 'a'.repeat(64),
  byteSize: 1024, schemaVersion: 1,
  sourceRefs: [{ kind: 'git.branch', value: 'tandemise/build', label: 'work branch' }],
  supersedes: null, summary: 'Step by step onboarding plan', createdAt: now(),
});
check('artifacts.get round-trips source refs', R.artifacts.get(artifactV1.id).sourceRefs[0].label === 'work branch');
check('artifacts.listByMission', R.artifacts.listByMission(missionId).length === 1);
check('artifacts.listByMission filters by type', R.artifacts.listByMission(missionId, 'ChangeSet').length === 0);
check('artifacts.listByTask', R.artifacts.listByTask(taskIds[0]).length === 1);
check('artifacts.latest', R.artifacts.latest(missionId, 'ImplementationPlan').id === artifactV1.id);

const artifactV2 = R.artifacts.create({
  ...artifactV1, id: ids.artifact(), title: 'Onboarding implementation plan (revised)',
  contentRef: 'artifacts/plan-v2.md', sha256: 'b'.repeat(64), supersedes: artifactV1.id,
  sourceRefs: [], createdAt: now(),
});
check('latest skips a superseded artifact', R.artifacts.latest(missionId, 'ImplementationPlan').id === artifactV2.id);

const changeSet = R.artifacts.create({
  id: ids.artifact(), workspaceId: wsId, missionId, taskId: taskIds[1], createdByRunId: runId,
  type: 'ChangeSet', title: 'Onboarding wizard component', contentRef: 'artifacts/cs.md',
  mediaType: 'text/markdown', sha256: 'c'.repeat(64), byteSize: 64, schemaVersion: 1,
  sourceRefs: [{ kind: 'github.pr', value: '42' }], supersedes: null,
  summary: 'Adds the wizard shell', createdAt: now(),
});
check('FTS matches on title', R.artifacts.search(wsId, 'onboarding').length === 3);
check('FTS prefix-matches a partial word', R.artifacts.search(wsId, 'wiza').length === 1);
// Both plan revisions carry the same summary, so a summary hit finds both.
check('FTS matches on summary', R.artifacts.search(wsId, 'step by step').length === 2);
check('FTS honours the limit', R.artifacts.search(wsId, 'onboarding', 1).length === 1);
check('FTS is workspace-scoped', R.artifacts.search(ids.workspace(), 'onboarding').length === 0);
// FTS5 operators and an unbalanced quote would be a syntax error if the query
// reached the engine raw; sanitized, they are just terms that match nothing.
check(
  'operator-shaped input is data, not syntax',
  R.artifacts.search(wsId, 'onboarding OR "').length === 0,
);
check('empty query returns nothing', R.artifacts.search(wsId, '   ').length === 0);
R.artifacts.markSuperseded(changeSet.id, artifactV2.id);
check('markSuperseded hides it from latest', R.artifacts.latest(missionId, 'ChangeSet') === undefined);

section('approvals, decisions, evaluations');
const approvalId = ids.approval();
R.approvals.create({
  id: approvalId, workspaceId: wsId, missionId, taskId: taskIds[1], runId,
  kind: 'action', status: 'PENDING', risk: 'external_side_effect',
  title: 'Open a pull request', rationale: 'the change is ready',
  effect: 'creates PR #43 on acme/web',
  evidence: [{ kind: 'artifact', label: 'ChangeSet', value: changeSet.id }],
  options: [{ id: 'approve', label: 'Approve', recommended: true }, { id: 'reject', label: 'Reject' }],
  recommendedOptionId: 'approve', selectedOptionId: null, decidedBy: null,
  decisionNote: null, createdAt: now(), decidedAt: null, expiresAt: null,
});
check('approvals.get', R.approvals.get(approvalId).evidence[0].value === changeSet.id);
check('approvals.list by workspace', R.approvals.list({ workspaceId: wsId }).length === 1);
check('approvals.list by status', R.approvals.list({ statuses: ['APPROVED'] }).length === 0);
check('approvals.pendingForTask', R.approvals.pendingForTask(taskIds[1]).length === 1);
check('mission progress counts pending approvals', R.missions.progress(missionId).pendingApprovals === 1);
check(
  'approvals.update',
  R.approvals.update(approvalId, {
    status: 'APPROVED', selectedOptionId: 'approve', decidedBy: 'demo', decidedAt: now(),
  }).status === 'APPROVED',
);
check('approvals.pendingForTask is now empty', R.approvals.pendingForTask(taskIds[1]).length === 0);

const decisionId = ids.decision();
R.decisions.create({
  id: decisionId, workspaceId: wsId, missionId, title: 'Use a wizard, not a modal',
  context: 'first-run experience', decision: 'multi-step wizard',
  rationale: 'lower cognitive load per step',
  alternatives: [{ title: 'Single modal', summary: 'one long form', rejectedBecause: 'too dense' }],
  consequences: ['needs progress state'], status: 'proposed', owner: 'design',
  relatedArtifacts: [artifactV2.id], supersedes: null, createdAt: now(), decidedAt: null,
});
check('decisions.get', R.decisions.get(decisionId).alternatives[0].title === 'Single modal');
check('decisions.listByMission', R.decisions.listByMission(missionId).length === 1);
check('decisions.listByWorkspace', R.decisions.listByWorkspace(wsId).length === 1);
check(
  'decisions.update',
  R.decisions.update(decisionId, { status: 'accepted', decidedAt: now() }).status === 'accepted',
);

R.evaluations.createEvaluation({
  id: ids.evaluation(), missionId, taskId: taskIds[1], runId, evaluatorRoleId: 'review',
  verdict: 'needs_changes', summary: 'two blocking findings',
  findings: [
    { severity: 'blocking', title: 'No error state', detail: 'step 2 has none', location: 'Wizard.tsx', suggestedFix: null },
  ],
  criteriaCoverage: [{ criterion: 'activation up 10%', outcome: 'SKIP', evidence: 'not measurable yet' }],
  createdAt: now(),
});
check('evaluations.listEvaluations', R.evaluations.listEvaluations(taskIds[1])[0].findings.length === 1);

R.evaluations.recordCheck({
  id: 'chk-1', missionId, taskId: taskIds[1], runId, name: 'checks.typecheck', outcome: 'FAIL',
  detail: '3 errors', command: 'npm run typecheck', exitCode: 1, durationMs: 4200,
  outputRef: null, createdAt: '2026-01-01T00:00:00.000Z',
});
R.evaluations.recordCheck({
  id: 'chk-2', missionId, taskId: taskIds[1], runId, name: 'checks.typecheck', outcome: 'PASS',
  detail: 'clean', command: 'npm run typecheck', exitCode: 0, durationMs: 3900,
  outputRef: null, createdAt: '2026-01-01T00:05:00.000Z',
});
R.evaluations.recordCheck({
  id: 'chk-3', missionId, taskId: taskIds[1], runId, name: 'checks.test', outcome: 'PASS',
  detail: '112 passing', command: 'npm test', exitCode: 0, durationMs: 21000,
  outputRef: 'logs/test.txt', createdAt: '2026-01-01T00:06:00.000Z',
});
check('evaluations.listChecks keeps history', R.evaluations.listChecks(taskIds[1]).length === 3);
const latestChecks = R.evaluations.latestChecks(missionId);
check('latestChecks returns one row per check name', latestChecks.length === 2);
check(
  'latestChecks returns the newest measurement',
  latestChecks.find((c) => c.name === 'checks.typecheck').outcome === 'PASS',
);

section('mission progress');
const progress = R.missions.progress(missionId);
check(
  `progress counters: ${JSON.stringify(progress)}`,
  progress.totalTasks === 3 && progress.completed === 1 && progress.running === 1 &&
    progress.blocked === 1 && progress.failed === 0 && progress.pendingApprovals === 0,
);

section('leases');
const first = R.leases.acquire('branch:acme-web:main', { runId, taskId: taskIds[1] }, 60_000);
const second = R.leases.acquire('branch:acme-web:main', { runId: null, taskId: taskIds[2] }, 60_000);
check('the first acquire wins', first !== undefined && first.resourceKey === 'branch:acme-web:main');
check('a contended acquire returns undefined', second === undefined);
check('only one lease row exists for the key', R.leases.listAll().length === 1);
check('renew extends a live lease', R.leases.renew(first.id, 120_000) === true);
check('renew of an unknown lease is false', R.leases.renew('lse_nope', 1000) === false);

// A lease that has already expired must be takeable by the next caller.
const expired = R.leases.acquire('branch:acme-web:feature', { runId }, -1);
check('listExpired finds the lapsed lease', R.leases.listExpired(now()).some((l) => l.id === expired.id));
const stolen = R.leases.acquire('branch:acme-web:feature', { taskId: taskIds[2] }, 60_000);
check('an expired lease can be re-acquired', stolen !== undefined && stolen.id !== expired.id);
check('renew of a lapsed lease is refused', R.leases.renew(expired.id, 1000) === false);
check('still exactly one row per resource key', R.leases.listAll().length === 2);

R.leases.release(stolen.id);
check('release drops the lease', R.leases.listAll().length === 1);
R.leases.releaseByRun(runId);
check('releaseByRun drops every lease held by the run', R.leases.listAll().length === 0);

section('unit of work');
const before = R.missions.get(missionId).title;
try {
  R.uow.transaction(() => {
    R.missions.update(missionId, { title: 'Rolled back' });
    R.tasks.update(taskIds[0], { statusReason: 'also rolled back' });
    throw new Error('boom');
  });
} catch {
  // expected
}
check('a failed transaction rolls every repository back', R.missions.get(missionId).title === before);
check('nested repository transactions roll back too', R.tasks.get(taskIds[0]).statusReason === null);
const uowResult = R.uow.transaction(() => {
  R.missions.update(missionId, { statusReason: 'committed' });
  return 'value';
});
check('a successful transaction commits and returns', uowResult === 'value');
check('committed write is visible', R.missions.get(missionId).statusReason === 'committed');

section('constraints');
let rejected = false;
try {
  R.db.handle.prepare("UPDATE missions SET status = 'NOPE' WHERE id = ?").run(missionId);
} catch {
  rejected = true;
}
check('a CHECK constraint rejects an unknown status', rejected);

let fkRejected = false;
try {
  R.db.handle
    .prepare('INSERT INTO missions (id, workspace_id, repository_id, title, goal, constraints, success_criteria, status, autonomy, workflow_preset, integration_branch, base_branch, status_reason, created_at, updated_at, started_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('msn_orphan', 'ws_missing', null, 't', 'g', '[]', '[]', 'DRAFT', 'balanced', 'standard', null, null, null, now(), now(), null, null);
} catch {
  fkRejected = true;
}
check('a foreign key rejects an orphan mission', fkRejected);

section('close, reopen, and verify durability');
const eventCountBefore = R.events.listByMission(missionId).length;
await container.dispose();

container = build();
const re = {
  db: container.resolve(DATABASE),
  workspaces: container.resolve(WORKSPACE_REPOSITORY),
  missions: container.resolve(MISSION_REPOSITORY),
  tasks: container.resolve(TASK_REPOSITORY),
  runs: container.resolve(RUN_REPOSITORY),
  events: container.resolve(EVENT_REPOSITORY),
  artifacts: container.resolve(ARTIFACT_REPOSITORY),
  approvals: container.resolve(APPROVAL_REPOSITORY),
  checkpoints: container.resolve(CHECKPOINT_REPOSITORY),
  evaluations: container.resolve(EVALUATION_REPOSITORY),
};
check('reopen applies no further migrations', schemaVersion(re.db) === SCHEMA_VERSION);
check('workspace survived', re.workspaces.get(wsId).name === 'Acme');
check('mission survived with its committed patch', re.missions.get(missionId).statusReason === 'committed');
check('tasks and their dependencies survived', re.tasks.get(taskIds[2]).dependsOn[0] === 'build');
check('runs survived', re.runs.get(runId).usage.outputTokens === 700);
check('event log survived', re.events.listByMission(missionId).length === eventCountBefore);
check('event sequence continues after reopen', re.events.append({
  id: ids.event(), workspaceId: wsId, missionId, body: { type: 'note', text: 'after reopen' }, createdAt: now(),
}).sequence === eventCountBefore + 1);
check('artifacts survived, FTS index included', re.artifacts.search(wsId, 'onboarding').length === 3);
check('approval decision survived', re.approvals.get(approvalId).selectedOptionId === 'approve');
check('checkpoints survived', re.checkpoints.latest(runId).sequence === 2);
check('check results survived', re.evaluations.latestChecks(missionId).length === 2);
check('progress recomputes identically', JSON.stringify(re.missions.progress(missionId)) === JSON.stringify(progress));

section('schema version guard');
re.db.handle.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)')
  .run(SCHEMA_VERSION + 7, 'from_the_future', now());
let guarded = false;
let guardMessage = '';
try {
  migrate(re.db);
} catch (err) {
  guarded = err.code === 'PRECONDITION_FAILED';
  guardMessage = err.message;
}
check('a newer schema is refused', guarded, guardMessage);
console.log(`       ${guardMessage}`);

await container.dispose();

// ---------------------------------------------------------------------------
// Concurrency. Everything above runs on one connection, which proves the SQL is
// right but not that it is safe. These two claims - a lease has one winner, and
// event sequences have no duplicates - are only meaningful across real
// concurrent writers, so they get real ones: separate threads, separate
// connections to the same file, released at the same instant.
// ---------------------------------------------------------------------------
section('concurrency (8 threads, separate connections)');

const raceDir = mkdtempSync(join(tmpdir(), 'tandemise-race-'));
const racePath = join(raceDir, 'race.db');
const raceContainer = new Container();
compose(raceContainer, persistenceModule({ path: racePath, clock: systemClock }));
const raceWsId = ids.workspace();
const raceMissionId = ids.mission();
raceContainer.resolve(WORKSPACE_REPOSITORY).create({
  id: raceWsId, name: 'Race', defaultRepositoryId: null,
  autonomy: {
    planApproval: 'ask', localCodeChanges: 'auto', externalWrites: 'policy',
    productionRelease: 'ask', financialActions: 'deny',
  },
  concurrency: { maxTotalWorkers: 8, perRuntime: {} }, routing: {},
  defaultAutonomyLevel: 'balanced',
  knowledge: { productVision: null, architecturePrinciples: null, codingStandards: null, designSystem: null, glossary: null },
});
raceContainer.resolve(MISSION_REPOSITORY).create({
  id: raceMissionId, workspaceId: raceWsId, repositoryId: null,
  title: 'Race', goal: 'contend', constraints: [], successCriteria: [],
});
await raceContainer.dispose();

const WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
(async () => {
  const P = await import(workerData.pkg);
  const db = P.openDatabase({ path: workerData.dbPath });
  const clock = { now: () => new Date().toISOString(), epochMs: () => Date.now() };
  const leases = new P.SqliteLeaseRepository(db, clock);
  const events = new P.SqliteEventRepository(db);

  // Busy-wait to the agreed instant so the threads actually collide rather than
  // queueing behind each other's start-up.
  while (Date.now() < workerData.startAt) { /* spin */ }

  const lease = leases.acquire(workerData.key, { runId: null, taskId: null }, 60000);
  const appended = [];
  for (let i = 0; i < workerData.eventsPerWorker; i++) {
    appended.push(events.append({
      id: workerData.idPrefix + '_' + i,
      workspaceId: workerData.workspaceId,
      missionId: workerData.missionId,
      body: { type: 'note', text: workerData.idPrefix + ':' + i },
      createdAt: clock.now(),
    }).sequence);
  }
  db.close();
  parentPort.postMessage({ leaseId: lease ? lease.id : null, sequences: appended });
})().catch((err) => parentPort.postMessage({ error: String(err && err.stack ? err.stack : err) }));
`;

const WORKERS = 8;
const EVENTS_PER_WORKER = 25;
const pkgUrl = pathToFileURL(new URL('../packages/persistence/dist/index.js', import.meta.url).pathname).href;
const startAt = Date.now() + 300;

const results = await Promise.all(
  Array.from({ length: WORKERS }, (_, i) =>
    new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          pkg: pkgUrl,
          dbPath: racePath,
          startAt,
          key: 'branch:contended:main',
          workspaceId: raceWsId,
          missionId: raceMissionId,
          idPrefix: `evt_w${i}`,
          eventsPerWorker: EVENTS_PER_WORKER,
        },
      });
      worker.on('message', resolve);
      worker.on('error', reject);
    }),
  ),
);

const errored = results.filter((r) => r.error);
check('every worker completed without error', errored.length === 0, errored[0]?.error);
const winners = results.filter((r) => r.leaseId !== null && r.leaseId !== undefined);
check(
  `exactly one of ${WORKERS} concurrent acquires won (got ${winners.length})`,
  winners.length === 1,
);

const allSequences = results.flatMap((r) => r.sequences ?? []);
const expectedTotal = WORKERS * EVENTS_PER_WORKER;
check(`all ${expectedTotal} concurrent appends succeeded`, allSequences.length === expectedTotal);
check('no two concurrent appends got the same sequence', new Set(allSequences).size === allSequences.length);
check(
  'sequences form an unbroken 1..n run',
  Math.min(...allSequences) === 1 && Math.max(...allSequences) === expectedTotal,
);

const verify = new Container();
compose(verify, persistenceModule({ path: racePath, clock: systemClock }));
check(
  'the log on disk holds every event exactly once',
  verify.resolve(EVENT_REPOSITORY).listByMission(raceMissionId).length === expectedTotal,
);
check(
  'one lease row for the contended key',
  verify.resolve(LEASE_REPOSITORY).listAll().length === 1,
);
await verify.dispose();
rmSync(raceDir, { recursive: true, force: true });

rmSync(dir, { recursive: true, force: true });

console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`ALL ${passed} CHECKS PASSED`);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
