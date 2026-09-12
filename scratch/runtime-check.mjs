// Verification harness for the runtime abstraction. Runs the real Claude Code
// CLI, the fake runtime, and a cancellation escalation.
//
//   node scratch/runtime-check.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { ids, nullLogger } from '@tandemise/shared';
import { Container, compose } from '@tandemise/kernel';
import { RUNTIME_MANAGER, RUNTIME_REGISTRY, runtimesCoreModule } from '@tandemise/runtimes-core';
import { ClaudeCodeAdapter, buildInvocation, claudeRuntimeModule, permissionMode } from '@tandemise/runtime-claude';
import { FakeRuntimeAdapter, genericRuntimeModule, GenericCliAdapter } from '@tandemise/runtime-generic';

const MODEL = 'claude-haiku-4-5-20251001';
let failures = 0;

function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function profile(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: ids.runtimeProfile(),
    workspaceId: ids.workspace(),
    adapterId: 'claude-code',
    name: 'verification',
    executablePath: null,
    args: [],
    settings: {},
    capabilities: [],
    enabled: true,
    maxConcurrent: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function request(overrides) {
  return {
    runId: ids.run(),
    prompt: 'noop',
    workingDirectory: process.cwd(),
    grants: [],
    allowedRoots: [],
    mcpConfigPath: null,
    maxWallTimeMs: 180_000,
    signal: new AbortController().signal,
    log: nullLogger,
    ...overrides,
  };
}

function processAlive(pid) {
  try {
    execFileSync('ps', ['-p', String(pid)], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 1. discovery
async function step1Discovery() {
  section('1. Claude Code discovery');
  const adapter = new ClaudeCodeAdapter();
  const discovery = await adapter.discover();
  console.log(`  ${JSON.stringify(discovery, null, 2).split('\n').join('\n  ')}`);
  check('detected', discovery.detected === true);
  check('executable found', typeof discovery.executablePath === 'string', discovery.executablePath ?? 'null');
  check('version parsed', /^\d+\.\d+\.\d+/.test(discovery.version ?? ''), discovery.version ?? 'null');

  const health = await adapter.healthCheck(profile());
  console.log(`  healthCheck -> ${health.state} (${health.detail})`);
  check('health healthy', health.state === 'healthy');
  return adapter;
}

// ------------------------------------------------------------- 2. real run
async function step2RealRun(adapter) {
  section('2. Real Claude Code run (haiku, 180s budget)');
  const dir = mkdtempSync(join(tmpdir(), 'tandemise-rt-'));
  const req = request({
    profile: profile({ settings: { model: MODEL } }),
    prompt: 'Create a file called hello.txt containing the word TANDEMISE, then reply DONE.',
    workingDirectory: dir,
    grants: ['filesystem.write', 'filesystem.read'],
    maxWallTimeMs: 180_000,
  });

  const invocation = buildInvocation(req, null);
  console.log(`  argv: ${JSON.stringify(invocation.args)}`);

  const seen = [];
  const byType = new Map();
  for await (const event of adapter.start(req)) {
    seen.push(event.type);
    byType.set(event.type, event);
    const preview =
      event.type === 'message' ? event.text.slice(0, 80).replace(/\n/g, ' ') :
      event.type === 'tool.started' ? `${event.tool} ${event.inputSummary.slice(0, 60)}` :
      event.type === 'tool.completed' ? `${event.tool} ${event.outcome}` :
      event.type === 'file.changed' ? `${event.change} ${event.path}` :
      event.type === 'checkpoint' ? `session=${event.externalSessionId}` :
      event.type === 'usage' ? `in=${event.inputTokens} out=${event.outputTokens} cost=${event.costUsd}` :
      event.type === 'completed' ? `summary=${(event.summary ?? '').slice(0, 60)}` :
      event.type === 'failed' ? `${event.code}: ${event.message}` :
      event.type === 'thinking_summary' ? event.text.slice(0, 60) :
      event.type === 'raw' ? `${event.channel}: ${event.text.slice(0, 60)}` : '';
    console.log(`  -> ${event.type}${preview ? ` | ${preview}` : ''}`);
  }

  console.log(`\n  event order: ${seen.join(' -> ')}`);
  const helloPath = join(dir, 'hello.txt');
  check('checkpoint with external session id',
    typeof byType.get('checkpoint')?.externalSessionId === 'string',
    byType.get('checkpoint')?.externalSessionId ?? 'none');
  check('file.changed emitted', byType.has('file.changed'),
    byType.get('file.changed') ? `${byType.get('file.changed').change} ${byType.get('file.changed').path}` : '');
  check('usage emitted', byType.has('usage'));
  check('completed emitted', byType.has('completed'));
  check('hello.txt exists on disk', existsSync(helloPath));
  if (existsSync(helloPath)) {
    const content = readFileSync(helloPath, 'utf8');
    console.log(`  hello.txt: ${JSON.stringify(content)}`);
    check('hello.txt contains TANDEMISE', content.includes('TANDEMISE'));
  }
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 3. fake
async function step3Fake() {
  section('3. Fake runtime (default script)');
  const adapter = new FakeRuntimeAdapter();
  const dir = mkdtempSync(join(tmpdir(), 'tandemise-fake-'));
  const req = request({
    profile: profile({ adapterId: 'fake' }),
    prompt: 'Draft the release notes.',
    workingDirectory: dir,
    maxWallTimeMs: 5_000,
  });
  for await (const event of adapter.start(req)) {
    console.log(`  -> ${event.type} | ${JSON.stringify(event).slice(0, 120)}`);
  }
  const artifact = join(dir, 'tandemise-fake-artifact.md');
  check('fake wrote a real artifact', existsSync(artifact), artifact);

  section('3b. Fake runtime (scripted failure + rate limit)');
  const scripted = new FakeRuntimeAdapter({
    script: {
      steps: [
        { kind: 'message', text: 'Attempting the task.' },
        { kind: 'rate-limit', detail: 'Simulated: seven_day quota rejected' },
        { kind: 'fail', code: 'rate_limit', message: 'Quota exhausted', retryable: true },
      ],
    },
  });
  const failures2 = [];
  for await (const event of scripted.start(request({
    profile: profile({ adapterId: 'fake' }),
    workingDirectory: dir,
    maxWallTimeMs: 5_000,
  }))) {
    failures2.push(event);
    console.log(`  -> ${event.type} | ${JSON.stringify(event).slice(0, 120)}`);
  }
  const failed = failures2.find((e) => e.type === 'failed');
  check('scripted failure is retryable', failed?.retryable === true, failed?.code ?? 'none');
  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------ 4. cancellation
async function step4Cancellation(adapter) {
  section('4. Cancellation (abort after 3s, child must be gone)');
  const dir = mkdtempSync(join(tmpdir(), 'tandemise-cancel-'));
  const controller = new AbortController();
  const req = request({
    profile: profile({ settings: { model: MODEL } }),
    prompt: 'Count slowly from 1 to 200, writing one number per line, then reply DONE.',
    workingDirectory: dir,
    grants: ['filesystem.read'],
    maxWallTimeMs: 120_000,
    signal: controller.signal,
  });

  const stream = adapter.start(req);
  const iterator = stream[Symbol.asyncIterator]();
  const first = iterator.next();
  // The child is spawned on the first pull; give it a moment to exist.
  await sleep(1500);
  const pid = adapter.pid(req.runId);
  console.log(`  child pid: ${pid}`);
  check('pid reported while running', typeof pid === 'number' && processAlive(pid));

  await first;
  await sleep(3000);
  console.log('  aborting…');
  controller.abort();

  const tail = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    tail.push(next.value.type);
  }
  console.log(`  events after abort: ${tail.join(', ') || '(none)'}`);
  check('terminal failed event', tail.includes('failed') || tail.length === 0);

  // The escalation is SIGTERM then SIGKILL; allow the grace period to elapse.
  for (let i = 0; i < 30 && processAlive(pid); i += 1) await sleep(250);
  check('child process is gone', !processAlive(pid), `ps -p ${pid}`);
  check('adapter forgot the run', adapter.pid(req.runId) === null);
  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------- 5. wiring + pure decisions
async function step5Wiring() {
  section('5. Module composition, routing and flag mapping');
  const container = compose(new Container(), runtimesCoreModule, claudeRuntimeModule, genericRuntimeModule);
  const registry = container.resolve(RUNTIME_REGISTRY);
  console.log(`  registered adapters: ${registry.ids().join(', ')}`);
  check('claude-code registered', registry.has('claude-code'));
  check('generic-cli registered', registry.has('generic-cli'));
  check('fake registered', registry.has('fake'));
  check('capability query works', registry.providing('shell', 'git').map((d) => d.id).sort().join(',') === 'claude-code,fake',
    registry.providing('shell', 'git').map((d) => d.id).join(','));

  const manager = container.resolve(RUNTIME_MANAGER);
  const discoveries = await manager.discoverAll();
  for (const d of discoveries) console.log(`  discover ${d.adapterId}: detected=${d.detected} — ${d.detail.slice(0, 80)}`);
  check('generic-cli degrades gracefully', discoveries.find((d) => d.adapterId === 'generic-cli')?.detected === false);

  const disabled = profile({ adapterId: 'claude-code', enabled: false });
  const fake = profile({ adapterId: 'fake' });
  const selected = await manager.select([disabled, fake], ['shell', 'git']);
  check('select skips disabled and picks a healthy candidate', selected.ok && selected.value.profile.id === fake.id,
    selected.ok ? selected.value.adapter.id : JSON.stringify(selected.error));

  const impossible = await manager.select([fake], ['computer_use']);
  check('select explains failure', !impossible.ok, impossible.ok ? '' : impossible.error.rejections[0]?.reason);

  // Permission-mode derivation (documented in cli-args.ts).
  check("no write/shell -> 'default'", permissionMode([], {}) === 'default');
  check("write only -> 'acceptEdits'", permissionMode(['filesystem.write'], {}) === 'acceptEdits');
  check("write + shell -> 'bypassPermissions'",
    permissionMode(['filesystem.write', 'shell.exec'], {}) === 'bypassPermissions');
  check('profile override wins', permissionMode(['filesystem.write', 'shell.exec'], { permissionMode: 'plan' }) === 'plan');

  const noGrants = buildInvocation(request({ profile: profile(), workingDirectory: process.cwd() }), null);
  const disallowed = noGrants.args[noGrants.args.indexOf('--disallowed-tools') + 1];
  console.log(`  ungranted run disallows: ${disallowed}`);
  check('ungranted run disallows Bash and Write',
    disallowed.includes('Bash') && disallowed.includes('Write'));

  const resumed = buildInvocation(request({ profile: profile(), workingDirectory: process.cwd() }), 'sess-123');
  check('resume passes --resume', resumed.args.includes('--resume') && resumed.args.includes('sess-123'));

  // Generic CLI, wired by configuration alone.
  section('5b. Generic CLI adapter driven purely by profile settings');
  const generic = new GenericCliAdapter();
  const genericProfile = profile({
    adapterId: 'generic-cli',
    settings: {
      command: '/bin/sh',
      args: ['-c', 'echo "working on: $0"; echo done', '{{prompt}}'],
      promptVia: 'arg',
      outputFormat: 'text',
      versionArgs: [],
    },
  });
  for await (const event of generic.start(request({
    profile: genericProfile,
    prompt: 'ship the thing',
    workingDirectory: process.cwd(),
    maxWallTimeMs: 10_000,
  }))) {
    console.log(`  -> ${event.type} | ${JSON.stringify(event).slice(0, 100)}`);
  }
}

const claude = await step1Discovery();
await step5Wiring();
await step3Fake();
await step2RealRun(claude);
await step4Cancellation(claude);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
