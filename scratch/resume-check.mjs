/**
 * A resume handle that no longer names a live session must not be able to
 * strand a task.
 *
 * The failure this pins down was real: the daemon exited mid-run, recovery
 * marked the run RESUMABLE, and every attempt afterwards asked Claude Code to
 * `--resume` a session it had already forgotten. The CLI answered
 * "No conversation found with session ID: …", the run failed in a second
 * without producing anything, and the gate reported it as
 * "Missing expected artifacts" - which named the symptom and hid the cause.
 * Nothing ever cleared the RESUMABLE run, so every retry repeated it exactly.
 *
 * Two properties are asserted here:
 *
 *   1. The adapter says *which* failure this is, in the canonical vocabulary,
 *      rather than passing the vendor's subtype through unread.
 *   2. Taking a resume handle consumes it, and a handle the runtime cannot
 *      honour costs the attempt nothing: the run starts fresh instead.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Container, compose } from '@tandemise/kernel';
import { createLogger, createPaths, ids, systemClock, asId } from '@tandemise/shared';
import { persistenceModule, DATABASE } from '@tandemise/persistence';
import * as persistenceTokens from '@tandemise/persistence';
import {
  createArtifactsModule, ARTIFACT_STORE as ARTIFACTS_STORE_TOKEN,
  renderArtifactTemplate, parseArtifact, measureArtifact, deriveHandoff, splitAppendix,
} from '@tandemise/artifacts';
import { policyModule } from '@tandemise/policy';
import { contextModule } from '@tandemise/context';
import { createEvaluationModule } from '@tandemise/evaluation';
import { runtimesCoreModule, SESSION_NOT_FOUND } from '@tandemise/runtimes-core';
import { genericRuntimeModule, FAKE_ADAPTER_ID } from '@tandemise/runtime-generic';
import {
  executionCoreModule, CLOCK as EXEC_CLOCK, LOGGER as EXEC_LOGGER, PATHS as EXEC_PATHS,
} from '@tandemise/execution-core';
import { executionLocalModule } from '@tandemise/execution-local';
import {
  integrationsCoreModule, CLOCK as INT_CLOCK, LOGGER as INT_LOGGER, COMMAND_EXECUTOR, BACKGROUND_PROCESS_LAUNCHER,
} from '@tandemise/integrations-core';
import * as app from '@tandemise/application';
import {
  applicationModule, createServices, SCHEDULER, RECOVERY_SERVICE, BUILT_IN_ROLES,
  createMemorySettingsStore, describeEnvironment, osProcessLiveness,
} from '@tandemise/application';
import { ClaudeCodeAdapter } from '@tandemise/runtime-claude';

const keepAlive = setInterval(() => {}, 1000);

// Short on purpose: a run's tool socket lives under HOME, and macOS caps a Unix
// socket path at 104 bytes - the default temp directory alone is over half.
const HOME = mkdtempSync('/tmp/tnd-resume-');
const log = createLogger({ level: 'error', base: { component: 'resume-check' } });

let failures = 0;
const ok = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
};
const head = (t) => console.log(`\n── ${t}`);

// ------------------------------------------------------- a Claude Code that
// answers exactly as the real CLI did on the stuck task.

const STUB = join(HOME, 'claude-stub');
writeFileSync(STUB, [
  '#!/bin/sh',
  // The verdict on stdout first, the explanation on stderr later: the order
  // that defeats a check made as each event is yielded. Printed unconditionally,
  // so the fresh-start case proves the resume guard, not a quiet stub.
  `echo '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"s1"}'`,
  'sleep 0.3',
  'echo "No conversation found with session ID: dead-session" >&2',
  'exit 1',
].join('\n'));
chmodSync(STUB, 0o755);

// Explains itself at once, then hangs until it is stopped.
const HANGING = join(HOME, 'claude-hanging');
writeFileSync(HANGING, [
  '#!/bin/sh',
  'echo "No conversation found with session ID: dead-session" >&2',
  'sleep 30',
].join('\n'));
chmodSync(HANGING, 0o755);

const profile = {
  id: ids.runtimeProfile(), workspaceId: null, adapterId: 'claude-code', name: 'stub',
  executablePath: STUB, args: [], settings: {}, capabilities: [], enabled: true, maxConcurrent: 1,
  createdAt: systemClock.now(), updatedAt: systemClock.now(),
};
const request = () => ({
  runId: ids.run(), profile, prompt: 'do the thing', workingDirectory: HOME,
  grants: [], allowedRoots: [], mcpConfigPath: null, maxWallTimeMs: 30_000,
  signal: new AbortController().signal, log,
});

async function drain(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

head('1. the adapter names a session the runtime no longer holds');
{
  const adapter = new ClaudeCodeAdapter();
  const resumed = await drain(adapter.resume('dead-session', request()));
  const failed = resumed.find((e) => e.type === 'failed');
  ok('a resume onto a forgotten session fails as SESSION_NOT_FOUND',
    failed?.code === SESSION_NOT_FOUND, `${failed?.code}: ${failed?.message}`);
  ok('the message says what actually happened, not the vendor subtype',
    /resume|session/i.test(failed?.message ?? ''), failed?.message);
  ok('the raw stderr is still in the log',
    resumed.some((e) => e.type === 'raw' && e.text.includes('No conversation found')));

  const controller = new AbortController();
  const hanging = adapter.resume('dead-session', {
    ...request(), profile: { ...profile, executablePath: HANGING }, signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 500);
  const stopped = (await drain(hanging)).find((e) => e.type === 'failed');
  ok('a cancelled resume is reported as cancelled, never as a lost session',
    stopped !== undefined && stopped.code !== SESSION_NOT_FOUND, stopped?.code);

  const fresh = await drain(adapter.start(request()));
  const freshFailure = fresh.find((e) => e.type === 'failed');
  ok('a fresh start keeps the runtime\'s own verdict',
    freshFailure?.code === 'error_during_execution', freshFailure?.code);
}

// ===================================================================== part 2
//
// The executor, driven through the real scheduler against the fake runtime,
// with a session handle the runtime will refuse - exactly the shape of the
// stuck task: a RESUMABLE run left behind by a daemon that died mid-run.

const paths = createPaths(HOME);
mkdirSync(paths.root, { recursive: true });
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
// Owned by the daemon's composition root. This task grants no tool that runs a
// command, so an executor that is never called is the honest stand-in.
container.bind(COMMAND_EXECUTOR, () => ({ run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }), { source: 'check' });
container.bind(BACKGROUND_PROCESS_LAUNCHER, () => ({ launch: async () => { throw new Error('unused'); } }), { source: 'check' });
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
container.bind(app.ARTIFACT_MEASURE, () => ({ measure: measureArtifact, deriveHandoff, splitAppendix }), { source: 'check' });
container.bind(app.EVENT_BUS, () => noopBus, { source: 'check' });
container.bind(app.PROJECTION_BUS, () => ({ invalidate: () => {}, subscribe: () => () => {} }), { source: 'check' });
container.bind(app.SECRET_STORE, () => ({ backend: 'memory', store: async () => 'x', resolve: async () => undefined, remove: async () => {}, list: async () => [] }), { source: 'check' });
container.bind(app.SETTINGS_STORE, () => createMemorySettingsStore(), { source: 'check' });
container.bind(app.SYSTEM_ENVIRONMENT, () => describeEnvironment({ home: HOME, schemaVersion: 1 }), { source: 'check' });
container.bind(app.PROCESS_LIVENESS, () => osProcessLiveness, { source: 'check' });

const services = createServices(container);
const scheduler = container.resolve(SCHEDULER);
const db = container.resolve(DATABASE);
const repo = {
  tasks: container.resolve(app.TASK_REPOSITORY),
  runs: container.resolve(app.RUN_REPOSITORY),
  events: container.resolve(app.EVENT_REPOSITORY),
};

// The fake forgets every session it is asked to continue - a runtime whose
// store has been pruned, which is what Claude Code had become for this task.
const SCRIPT = join(HOME, 'forgetful.json');
writeFileSync(SCRIPT, JSON.stringify({
  resume: 'missing',
  steps: [
    { kind: 'message', text: 'Working from scratch.' },
    { kind: 'complete', summary: 'done' },
  ],
}, null, 2));

const workspace = await services.workspaces.create({ personId: services.identity.localPerson().id }, { name: 'Resume Check' });
const workspaceId = workspace.workspace.id;
const runtime = await services.runtimes.create({
  adapterId: FAKE_ADAPTER_ID, name: 'forgetful', workspaceId,
  settings: { scriptPath: SCRIPT }, maxConcurrent: 1,
});
services.workspaces.update(workspaceId, { routing: { architecture: [runtime.id] } });

db.handle.exec(`
  INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,created_at,updated_at)
    VALUES ('m1', '${workspaceId}', 'Stuck', 'Unstick the architecture step', '[]', '[]', 'EXECUTING', 'balanced', 'p', '2026-01-01', '2026-01-01');
  INSERT INTO mission_tasks (id,mission_id,key,title,objective,role_id,required_capabilities,input_artifacts,
    expected_outputs,execution_policy,approval_policy,retry_policy,status,attempts,created_at,updated_at)
    VALUES ('t1','m1','architecture','Plan it','Plan the change','architecture','[]','[]','[]',
      '{"isolation":"none","maxWallTimeMs":60000,"capabilities":[]}','{"beforeStart":false,"onCompletion":false}',
      '{"maxAttempts":2,"backoffMs":0,"onExhausted":"block"}','READY',1,'2026-01-01','2026-01-01');
`);

// Created by MissionService for a real mission; seeded by hand here. A local
// target is a git checkout, as the real task's was.
const missionDir = paths.mission(workspaceId, 'm1');
mkdirSync(missionDir, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main', missionDir]);
execFileSync('git', ['-C', missionDir, '-c', 'user.name=check', '-c', 'user.email=check@example.com',
  'commit', '-q', '--allow-empty', '-m', 'init']);

// The leftover: a run the daemon never finished, holding a session handle the
// runtime has since forgotten. Exactly what recovery writes.
const deadRun = {
  id: ids.run(), missionId: asId('m1'), taskId: asId('t1'), assignmentId: asId('a0'),
  attempt: 1, status: 'RESUMABLE', roleId: 'architecture', runtimeProfileId: runtime.id,
  executionTargetId: asId('et0'), externalSessionId: 'session-the-runtime-forgot',
  pid: null, exitCode: null, errorCode: 'RESUMABLE',
  errorMessage: 'The daemon exited mid-run; the runtime session can be resumed.',
  usage: null, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z',
  heartbeatAt: '2026-01-01T00:00:00.000Z',
};
db.handle.pragma('foreign_keys = OFF');
repo.runs.create(deadRun);

head('2. a forgotten session costs the attempt nothing');
const budget = Date.now() + 60_000;
while (Date.now() < budget && !['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(repo.tasks.get(asId('t1')).status)) {
  await scheduler.tick();
  await scheduler.drain();
  await new Promise((r) => setTimeout(r, 50));
}
const settled = repo.tasks.get(asId('t1'));
ok('the task is not stuck on the dead session', settled.status === 'SUCCEEDED',
  `${settled.status}: ${settled.statusReason ?? ''}`);
// A resume continues the interrupted attempt rather than starting a new one,
// and falling back to a fresh start must not change that.
ok('the attempt was not spent on the lost handle', settled.attempts === 1,
  `attempts=${settled.attempts} of maxAttempts=2`);
ok('the resumable run was consumed, so a retry cannot repeat it',
  repo.runs.get(deadRun.id).status !== 'RESUMABLE', repo.runs.get(deadRun.id).status);

const attemptRun = repo.runs.listByTask(asId('t1')).find((r) => r.id !== deadRun.id);
ok('the attempt succeeded after starting fresh', attemptRun?.status === 'SUCCEEDED',
  `${attemptRun?.status}: ${attemptRun?.errorCode ?? ''}`);
ok('the dead handle was cleared from the run that took it',
  attemptRun?.externalSessionId !== 'session-the-runtime-forgot', attemptRun?.externalSessionId ?? 'null');
ok('the timeline says why, in words a person can act on',
  repo.events.listByMission(asId('m1'), { limit: 1000 })
    .some((e) => e.body.type === 'note' && /could no longer be resumed/.test(e.body.text)));

ok('the stale-session failure is not on the timeline, which would contradict the success',
  !repo.events.listByMission(asId('m1'), { limit: 1000 })
    .some((e) => e.body.type === 'failed'));

head('3. a second attempt no longer finds anything to resume');
const stillResumable = repo.runs.listByTask(asId('t1')).filter((r) => r.status === 'RESUMABLE');
ok('no run is left claiming to be resumable', stillResumable.length === 0,
  stillResumable.map((r) => r.id).join(', '));

await scheduler.stop?.();
clearInterval(keepAlive);

console.log(`\n${failures === 0 ? 'ALL RESUME CHECKS PASSED' : `${failures} FAILED`}`);
rmSync(HOME, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
