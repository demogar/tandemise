#!/usr/bin/env node
// Verification for native/macos-helper + @tandemise/desktop-control.
// Run: node scratch/desktop-check.mjs
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { ids, systemClock, createLogger } from '../packages/shared/dist/index.js';
import {
  MacOSHelperClient, DesktopIntegrationProvider, HELPER_BINARY_RELATIVE_PATH,
} from '../packages/desktop-control/dist/index.js';

const REPO = resolve(import.meta.dirname, '..');
const BINARY = resolve(REPO, HELPER_BINARY_RELATIVE_PATH);
const OUT = resolve(REPO, 'scratch/out');
const ALLOWED_APP = 'com.apple.calculator';
const DENIED_APP = 'com.apple.Safari';

let failures = 0;
const section = (n) => console.log(`\n${'='.repeat(74)}\n${n}\n${'='.repeat(74)}`);
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { failures += 1; console.log(`  FAIL  ${m}`); };
const show = (v) => JSON.stringify(v, null, 2).split('\n').map((l) => '        ' + l).join('\n');

const client = new MacOSHelperClient({
  binaryPath: BINARY,
  spawn: (cmd, args) => spawn(cmd, args),
  logger: createLogger({ level: 'warn' }),
});

const integration = {
  id: ids.integration(),
  workspaceId: ids.workspace(),
  providerId: 'desktop',
  name: 'macOS desktop',
  transport: 'desktop',
  config: { apps: [] },
  credentialRef: null,
  enabledCapabilities: ['desktop'],
  enabled: true,
  createdAt: systemClock.now(),
  updatedAt: systemClock.now(),
};

/** An assignment allowlisted to Calculator and nothing else. */
const assignment = {
  id: ids.workerAssignment(),
  workspaceId: integration.workspaceId,
  missionId: ids.mission(),
  taskId: ids.task(),
  roleId: 'qa',
  runtimeProfileId: ids.runtimeProfile(),
  executionTargetId: ids.executionTarget(),
  grants: [{ capability: 'desktop', resourceScope: [ALLOWED_APP], approvalMode: 'auto', expiresAt: null }],
  budgets: { maxWallTimeMs: 600000, maxAttempts: 1 },
  createdAt: systemClock.now(),
};

const ctx = {
  assignment,
  assignmentId: assignment.id,
  runId: null,
  workingDirectory: REPO,
  logger: createLogger({ level: 'warn' }),
  exec: { run: async () => { throw new Error('no exec in this check'); } },
  signal: new AbortController().signal,
};

const provider = new DesktopIntegrationProvider(client, systemClock);
const tools = Object.fromEntries(provider.tools(integration).map((t) => [t.name, t]));

const call = async (name, input) => {
  const tool = tools[name];
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.execute(ctx, tool.inputSchema.parse(input));
};
const expectFail = async (label, fn) => {
  try {
    const r = await fn();
    bad(`${label}: expected a failure, got ${JSON.stringify(r).slice(0, 160)}`);
    return null;
  } catch (e) {
    console.log(`  ---   ${label}\n        ${e.code ?? 'ERR'}: ${e.message}`);
    return e;
  }
};

try {
  mkdirSync(OUT, { recursive: true });

  // -------------------------------------------------------------- 2. ping
  section('2. Start the helper, ping, permissions');
  console.log(`binary: ${BINARY}`);
  const ping = await client.ping();
  console.log(show(ping));
  ping.version && ping.operations.length === 15 ? ok('ping: 15 operations advertised') : bad('ping shape');

  const perms = await client.permissions();
  console.log(show(perms));
  console.log(`\n  >>> accessibility=${perms.accessibility}  screenRecording=${perms.screenRecording}  screenLocked=${perms.screenLocked}`);

  // ---------------------------------------------------------- 3. listApps
  section('3. listApps - real running applications');
  const running = await client.listApps();
  const named = running.apps.filter((a) => a.bundleId);
  console.log(show(named.slice(0, 5)));
  console.log(`        ... ${running.count} total`);
  named.length > 5 && named.some((a) => a.pid > 0) ? ok(`listApps: ${running.count} running apps`) : bad('listApps');

  // ------------------------------------------------- 4. listInstalledApps
  section('4. listInstalledApps - real apps on disk');
  const installed = await client.listInstalledApps();
  const calc = installed.apps.find((a) => a.bundleId === ALLOWED_APP);
  console.log(show(installed.apps.slice(0, 5)));
  console.log(`        ... ${installed.count} total`);
  console.log(`        Calculator: ${JSON.stringify(calc)}`);
  calc ? ok(`listInstalledApps: ${installed.count} apps, Calculator found at ${calc.path}`) : bad('Calculator not found');

  // ---------------------------------------------------- 5. Calculator flow
  section('5. Calculator: launch -> inspect -> find -> click -> screenshot');
  const launched = await call('desktop.launch', { app: ALLOWED_APP });
  console.log(`  launch: ${launched.summary}`);
  console.log(show(launched.output));

  const uiWorks = perms.accessibility && !perms.screenLocked;
  if (!uiWorks) {
    const why = !perms.accessibility ? 'Accessibility is NOT granted' : 'the screen is LOCKED';
    console.log(`\n  >>> ${why}: proving every UI op fails cleanly with an actionable message.\n`);
    for (const [label, fn] of [
      ['desktop.inspect', () => call('desktop.inspect', { app: ALLOWED_APP })],
      ['desktop.find', () => call('desktop.find', { app: ALLOWED_APP, role: 'AXButton' })],
      ['desktop.click', () => call('desktop.click', { app: ALLOWED_APP, role: 'AXButton', label: '1' })],
      ['desktop.type', () => call('desktop.type', { app: ALLOWED_APP, text: '7' })],
      ['desktop.shortcut', () => call('desktop.shortcut', { app: ALLOWED_APP, keys: ['CMD', 'C'] })],
      ['desktop.screenshot', () => call('desktop.screenshot', { app: ALLOWED_APP })],
    ]) {
      const e = await expectFail(label, fn);
      if (e && ['PERMISSION_DENIED', 'PRECONDITION_FAILED'].includes(e.code) && e.message.length > 40) {
        ok(`${label}: clean ${e.code}, no crash`);
      } else if (e) {
        bad(`${label}: unexpected code ${e?.code}`);
      }
    }
  } else {
    const tree = await call('desktop.inspect', { app: ALLOWED_APP, maxDepth: 14 });
    console.log(`  inspect: ${tree.summary}`);
    const found = await call('desktop.find', { app: ALLOWED_APP, role: 'AXButton', limit: 60 });
    console.log(`  find: ${found.summary}`);
    console.log(show(found.output.matches.slice(0, 10)));
    const button = found.output.matches.find((m) => [m.title, m.label].includes('1'))
      ?? found.output.matches.find((m) => m.title || m.label);
    if (!button) { bad('no labelled AXButton found in Calculator'); }
    else {
      console.log(`  clicking: ${JSON.stringify(button)}`);
      const clicked = await call('desktop.click', { app: ALLOWED_APP, path: button.path });
      console.log(`  click: ${clicked.summary}`);
      console.log(show(clicked.output));
      clicked.output.method === 'accessibility' ? ok('click: semantic AXPress, no coordinates') : bad('click used coordinates');
    }
    const shot = await call('desktop.screenshot', { app: ALLOWED_APP });
    const png = shot.evidence[0];
    const path = resolve(OUT, png.filename);
    writeFileSync(path, png.bytes);
    console.log(`  screenshot: ${shot.summary}`);
    console.log(`  saved ${path} (${png.bytes.length} bytes)`);
    png.bytes.length > 1000 && png.bytes[0] === 0x89 ? ok(`screenshot: valid PNG, ${png.bytes.length} bytes`) : bad('screenshot not a PNG');
  }

  // ----------------------------------------------------- 6. app allowlist
  section('6. App allowlist enforcement (MVP.md §19.2)');
  console.log(`  assignment grant: capability=desktop resourceScope=[${ALLOWED_APP}]`);
  for (const [label, fn] of [
    [`desktop.inspect on ${DENIED_APP} (not allowlisted)`, () => call('desktop.inspect', { app: DENIED_APP })],
    [`desktop.launch on ${DENIED_APP} (not allowlisted)`, () => call('desktop.launch', { app: DENIED_APP })],
    [`desktop.click on ${DENIED_APP} (not allowlisted)`, () => call('desktop.click', { app: DENIED_APP, role: 'AXButton' })],
    ['desktop.screenshot of the whole display (scope is not *)', () => call('desktop.screenshot', { display: true })],
  ]) {
    const e = await expectFail(label, fn);
    e?.code === 'PERMISSION_DENIED' ? ok(`${label}: denied`) : bad(`${label}: code was ${e?.code}`);
  }

  const empty = { ...ctx, assignment: { ...assignment, grants: [] } };
  const e = await expectFail('desktop.inspect with no desktop grant at all', async () => {
    const t = tools['desktop.inspect'];
    return t.execute(empty, t.inputSchema.parse({ app: ALLOWED_APP }));
  });
  e?.code === 'PERMISSION_DENIED' ? ok('no grant: denied by default (default deny)') : bad('no grant not denied');

  const filtered = await call('desktop.list_apps', { installed: true });
  console.log(`\n  list_apps under the allowlist: ${filtered.summary}`);
  console.log(show(filtered.output));
  filtered.output.running.concat(filtered.output.installed).every((a) => a.bundleId === ALLOWED_APP)
    ? ok('list_apps reports only allowlisted apps') : bad('list_apps leaked a non-allowlisted app');

  // -------------------------------------------------------- provider health
  section('7. Provider healthCheck');
  const health = await provider.healthCheck(integration, {
    exec: ctx.exec, logger: ctx.logger, clock: systemClock, signal: ctx.signal,
  });
  console.log(show(health));
  health.detail.length > 20 ? ok(`healthCheck: ${health.state}`) : bad('healthCheck detail is not actionable');

  // ------------------------------------------------------ restart-on-death
  section('8. Client restarts the helper after it dies');
  await client.call('shutdown', {}, (await import('zod')).z.object({ stopping: (await import('zod')).z.boolean() }));
  await new Promise((r) => setTimeout(r, 300));
  const afterDeath = await client.ping();
  afterDeath.version ? ok(`helper respawned after exit (new pid ${afterDeath.pid})`) : bad('no respawn');
} catch (e) {
  failures += 1;
  console.error('\nUNCAUGHT:', e);
} finally {
  await client.stop();
  section(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
