/**
 * A signed-out runtime must make work wait, not fail.
 *
 * Seen for real: Claude Code's login expired, and every attempt at a product
 * spec ended three seconds in with "Failed to authenticate: OAuth session
 * expired and could not be refreshed" - reported under the result subtype
 * `success`, classified as not worth retrying. Both attempts were spent in ten
 * seconds and the mission blocked on a login, with the gate adding "Missing
 * expected artifacts" as though the worker had done the job badly.
 *
 * Asserted here, one layer at a time:
 *   1. The adapter names the failure canonically and reports the profile
 *      unavailable with the action a person must take - until it runs again.
 *   2. Routing treats such a profile as a reason to wait, not to block.
 *   3. The executor hands the attempt back and the task waits, then carries on
 *      by itself once the runtime works.
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
import { runtimesCoreModule, RuntimeManager, RuntimeRegistry, RUNTIME_SIGNED_OUT, onlyBusy, onlyWaiting } from '@tandemise/runtimes-core';
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
const HOME = mkdtempSync('/tmp/tnd-signin-');
const log = createLogger({ level: 'error', base: { component: 'signin-check' } });

let failures = 0;
const ok = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
};
const head = (t) => console.log(`\n── ${t}`);
const drain = async (stream) => { const out = []; for await (const e of stream) out.push(e); return out; };
const stub = (name, lines) => {
  const path = join(HOME, name);
  writeFileSync(path, ['#!/bin/sh', 'if [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi', ...lines].join('\n'));
  chmodSync(path, 0o755);
  return path;
};

// Exactly the record the real CLI printed on the stuck product spec.
const EXPIRED = stub('claude-expired', [
  `echo '{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate: OAuth session expired and could not be refreshed","session_id":"s1"}'`,
  'exit 1',
]);
const WORKING = stub('claude-working', [
  `echo '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s2"}'`,
]);

const profile = (executablePath, id = 'rp_signin') => ({
  id, workspaceId: null, adapterId: 'claude-code', name: 'stub', executablePath, args: [],
  settings: {}, capabilities: [], enabled: true, maxConcurrent: 1,
  createdAt: '2026-01-01', updatedAt: '2026-01-01',
});
const request = (p) => ({
  runId: ids.run(), profile: p, prompt: 'write the spec', workingDirectory: HOME, grants: [],
  allowedRoots: [], mcpConfigPath: null, maxWallTimeMs: 30_000, signal: new AbortController().signal, log,
});

head('1. the adapter names a sign-in failure and says what to do');
{
  const adapter = new ClaudeCodeAdapter();
  const events = await drain(adapter.start(request(profile(EXPIRED))));
  const failed = events.find((e) => e.type === 'failed');
  ok('an expired login fails as RUNTIME_SIGNED_OUT, not as "success"', failed?.code === RUNTIME_SIGNED_OUT, failed?.code);
  ok('the message keeps the CLI\'s own words', failed?.message.includes('OAuth session expired') === true, failed?.message);
  ok('the message says what to do', /sign in/i.test(failed?.message ?? ''));

  const health = await adapter.healthCheck(profile(EXPIRED));
  ok('the profile now reports unavailable', health.state === 'unavailable', health.state);
  ok('with the action a person must take', typeof health.actionRequired === 'string' && /sign in/i.test(health.actionRequired),
    health.actionRequired);

  const other = await adapter.healthCheck(profile(EXPIRED, 'rp_other_login'));
  ok('another profile - another login - is not tarred with it', other.actionRequired === undefined, other.state);

  const TESTER = stub('claude-tester', [
    `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Opening the login page."}]},"session_id":"s3"}'`,
    `echo '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"The page said: not logged in","session_id":"s3"}'`,
    'exit 1',
  ]);
  const tested = (await drain(adapter.start(request(profile(TESTER, 'rp_tester'))))).find((e) => e.type === 'failed');
  ok('a run that did work and then met sign-in words keeps its own failure', tested?.code === 'error_max_turns', tested?.code);
  ok('and does not mark its profile signed out',
    (await adapter.healthCheck(profile(TESTER, 'rp_tester'))).actionRequired === undefined);

  const worked = await drain(adapter.start(request(profile(WORKING))));
  ok('the same profile working again completes', worked.some((e) => e.type === 'completed'));
  const recovered = await adapter.healthCheck(profile(WORKING));
  ok('and clears the sign-in requirement at once', recovered.state === 'healthy' && recovered.actionRequired === undefined,
    `${recovered.state} ${recovered.actionRequired ?? ''}`);
}

head('2. routing waits on a runtime that is waiting on a person');
{
  const waiting = {
    id: 'waiting', displayName: 'Waiting', baseCapabilities: [],
    async discover() { return {}; },
    async healthCheck(p) {
      return { profileId: p.id, state: 'unavailable', version: '1', detail: 'signed out', checkedAt: '2026-01-01',
        quotaWarning: null, actionRequired: 'Sign in again' };
    },
    capabilities() { return ['reasoning']; },
    async *start() {}, async cancel() {}, pid() { return null; },
  };
  const manager = new RuntimeManager({ registry: new RuntimeRegistry([waiting]), logger: log, clock: systemClock });
  const selected = await manager.select([{ ...profile(null, 'rp_w'), adapterId: 'waiting', capabilities: ['reasoning'] }], ['reasoning']);
  ok('selection fails', !selected.ok);
  ok('the rejection is marked as waiting on a person', selected.error?.rejections[0]?.awaitingPerson === true,
    selected.error?.rejections[0]?.reason);
  ok('which counts as waiting', onlyWaiting(selected.error));
  ok('but not as busy - the two keep their meanings', !onlyBusy(selected.error));
}

// ===================================================================== part 3

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


const SCRIPT = join(HOME, 'worker.json');
const signedOut = { steps: [{ kind: 'fail', code: RUNTIME_SIGNED_OUT, message: 'Claude Code is signed out.', retryable: true }] };
const working = { steps: [{ kind: 'message', text: 'PROMPT>>>{{prompt}}<<<PROMPT' }, { kind: 'complete', summary: 'done' }] };
writeFileSync(SCRIPT, JSON.stringify(signedOut));

const workspace = await services.workspaces.create({ personId: services.identity.localPerson().id }, { name: 'Sign-in Check' });
const workspaceId = workspace.workspace.id;
const runtime = await services.runtimes.create({
  adapterId: FAKE_ADAPTER_ID, name: 'signed-out', workspaceId, settings: { scriptPath: SCRIPT }, maxConcurrent: 2,
});
services.workspaces.update(workspaceId, { routing: { product: [runtime.id] } });

const missionDir = paths.mission(workspaceId, 'm1');
mkdirSync(missionDir, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main', missionDir]);
execFileSync('git', ['-C', missionDir, '-c', 'user.name=check', '-c', 'user.email=check@example.com',
  'commit', '-q', '--allow-empty', '-m', 'init']);

// t1 was interrupted by a restart and holds a session to resume. t2 failed its
// gate once and waits to be retried with that measurement.
const GATE = 'Missing expected artifacts: ProblemBrief.';
const taskRow = (id, key, reason) => `('${id}','m1','${key}','Spec it','Write the spec','product','[]','[]','[]',
  '{"isolation":"none","maxWallTimeMs":60000,"capabilities":[]}','{"beforeStart":false,"onCompletion":false}',
  '{"maxAttempts":2,"backoffMs":0,"onExhausted":"block"}','READY',1,${reason},${reason},'2026-01-01','2026-01-01')`;
db.handle.exec(`
  INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,created_at,updated_at)
    VALUES ('m1', '${workspaceId}', 'Spec', 'Write the spec', '[]', '[]', 'EXECUTING', 'balanced', 'p', '2026-01-01', '2026-01-01');
  INSERT INTO mission_tasks (id,mission_id,key,title,objective,role_id,required_capabilities,input_artifacts,
    expected_outputs,execution_policy,approval_policy,retry_policy,status,attempts,status_reason,retry_feedback,created_at,updated_at)
    VALUES ${taskRow('t1', 'resumed_spec', 'NULL')}, ${taskRow('t2', 'retried_spec', `'${GATE}'`)};
`);
db.handle.pragma('foreign_keys = OFF');
repo.runs.create({
  id: ids.run(), missionId: asId('m1'), taskId: asId('t1'), assignmentId: asId('a0'), attempt: 1,
  status: 'RESUMABLE', roleId: 'product', runtimeProfileId: runtime.id, executionTargetId: asId('et0'),
  externalSessionId: 'session-before-restart', pid: null, exitCode: null, errorCode: 'RESUMABLE',
  errorMessage: 'The daemon exited mid-run.', usage: null, startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z', heartbeatAt: '2026-01-01T00:00:00.000Z',
});

const tick = async () => { await scheduler.tick(); await scheduler.drain(); };
const task = (id) => repo.tasks.get(asId(id));
const runsOf = (id) => repo.runs.listByTask(asId(id));

head('3. tasks wait for the sign-in, then carry on by themselves');
// Several ticks, each well inside the wait: a loop that spent an attempt per
// tick would exhaust a two-attempt budget and block long before the last.
for (let i = 0; i < 6; i++) { await tick(); await new Promise((r) => setTimeout(r, 100)); }
for (const id of ['t1', 't2']) {
  ok(`${id}: not blocked on the login`, task(id).status === 'READY', `${task(id).status}: ${task(id).statusReason}`);
  ok(`${id}: says it is waiting for you`, /^Waiting for you: .*signed out/.test(task(id).statusReason ?? ''));
  ok(`${id}: no attempt was spent`, task(id).attempts === 1, `attempts=${task(id).attempts}`);
}
ok('it tried once, not once per tick', runsOf('t2').length === 1, `${runsOf('t2').length} runs`);
ok('the gate\'s feedback survived the wait, apart from the row\'s line', task('t2').retryFeedback === GATE, task('t2').retryFeedback);
ok('the resumed session was not lost to the sign-in failure',
  runsOf('t1').some((r) => r.status === 'RESUMABLE' && r.externalSessionId === 'session-before-restart'),
  runsOf('t1').map((r) => `${r.status}:${r.externalSessionId}`).join(' '));
ok('the mission is still executing', container.resolve(app.MISSION_REPOSITORY).get(asId('m1')).status === 'EXECUTING');

// The person signs in.
writeFileSync(SCRIPT, JSON.stringify(working));
const until = Date.now() + 45_000;
while (Date.now() < until && !['t1', 't2'].every((id) => task(id).status === 'SUCCEEDED')) {
  await tick(); await new Promise((r) => setTimeout(r, 250));
}
for (const id of ['t1', 't2']) {
  ok(`${id}: finished without anyone retrying it`, task(id).status === 'SUCCEEDED', `${task(id).status}: ${task(id).statusReason ?? ''}`);
}
const events = repo.events.listByMission(asId('m1'), { limit: 5000 });
ok('the interrupted task continued its session after the sign-in',
  events.some((e) => e.taskId === 't1' && e.body.type === 'checkpoint' && e.body.label === 'session.resumed'
    && e.body.externalSessionId === 'session-before-restart'));
ok('the interrupted task\'s resume did not count as a new attempt', task('t1').attempts === 1, `attempts=${task('t1').attempts}`);
const prompt = events.find((e) => e.taskId === 't2' && e.body.type === 'message' && e.body.text.startsWith('PROMPT>>>'));
ok('the retry was told what the gate found, not that it was signed out',
  prompt?.body.text.includes(GATE) === true && !/signed out/.test(prompt?.body.text ?? ''),
  prompt === undefined ? 'no prompt' : 'prompt quoted the gate');
ok('a success clears the owed feedback', task('t2').retryFeedback === null, String(task('t2').retryFeedback));

clearInterval(keepAlive);
console.log(`\n${failures === 0 ? 'ALL SIGN-IN CHECKS PASSED' : `${failures} FAILED`}`);
rmSync(HOME, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
