/**
 * Selecting a runtime must hold its slot, not merely observe that one is free.
 *
 * The executor selects, then provisions a worktree (seconds of awaits), then
 * starts. With the slot only claimed at start, two tasks dispatched in the same
 * scheduler tick both selected a `maxConcurrent: 1` profile and both ran - seen
 * in the real app as "saturated: 2/1 runs in flight", and as a planner that
 * fell back to a generic preset because the one runtime was double-booked.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { RuntimeManager, RuntimeRegistry } = await import(join(root, 'packages/runtimes-core/dist/index.js'));
const { ids, systemClock } = await import(join(root, 'packages/shared/dist/index.js'));

let bad = 0;
const ok = (n, c, d = '') => { if (c) console.log(`  ok   ${n}${d ? '  ' + d : ''}`); else { bad++; console.log(`  FAIL ${n}${d ? '  ' + d : ''}`); } };
const tick = () => new Promise((r) => setTimeout(r, 5));

const adapter = {
  id: 'slow', displayName: 'Slow',
  async discover() { return { adapterId: 'slow', displayName: 'Slow', detected: true, executablePath: null, version: '1', capabilities: [], detail: '', suggestedSettings: {} }; },
  // A real health probe spawns a process; the await is the window.
  async healthCheck(p) { await tick(); return { profileId: p.id, state: 'healthy', version: '1', detail: '', checkedAt: systemClock.now(), quotaWarning: null }; },
  capabilities() { return ['reasoning']; },
  async *start() { yield { type: 'completed' }; },
  async cancel() {},
  pid() { return null; },
};

const profile = {
  id: ids.runtimeProfile(), workspaceId: null, adapterId: 'slow', name: 'Slow',
  executablePath: null, args: [], settings: {}, capabilities: ['reasoning'],
  enabled: true, maxConcurrent: 1,
  createdAt: systemClock.now(), updatedAt: systemClock.now(),
};
const request = (reservation) => ({
  runId: ids.run(), profile, prompt: 'x', workingDirectory: '/tmp', grants: [], allowedRoots: ['/tmp'],
  mcpConfigPath: null, maxWallTimeMs: 5000, signal: new AbortController().signal,
  log: { child() { return this; }, debug() {}, info() {}, warn() {}, error() {} },
  ...(reservation ? { reservation } : {}),
});
const fresh = () => new RuntimeManager({ registry: new RuntimeRegistry([adapter]), clock: systemClock });

console.log('── two concurrent selections of a maxConcurrent:1 profile\n');
{
  const manager = fresh();
  const [a, b] = await Promise.all([manager.select([profile], ['reasoning']), manager.select([profile], ['reasoning'])]);
  ok('exactly one selection succeeds', [a, b].filter((r) => r.ok).length === 1, `ok=${[a.ok, b.ok]}`);
  const loser = a.ok ? b : a;
  ok('the other is told it is saturated', !loser.ok && /saturated/.test(loser.error.rejections[0]?.reason ?? ''));
}

console.log('\n── a selection holds the slot across the awaits before start()\n');
{
  const manager = fresh();
  const first = await manager.select([profile], ['reasoning']);
  ok('first selection succeeds', first.ok);
  ok('slot is held by the selection', manager.inFlight(profile.id) === 1, `inFlight=${manager.inFlight(profile.id)}`);
  await tick(); await tick(); // "provisioning a worktree"
  const second = await manager.select([profile], ['reasoning']);
  ok('a second selection during provisioning is refused', !second.ok);

  const stream = manager.start(request(first.value.reservation));
  ok('start() takes over the reserved slot rather than claiming another', manager.inFlight(profile.id) === 1, `inFlight=${manager.inFlight(profile.id)}`);
  for await (const _ of stream) { /* drain */ }
  ok('slot released when the run ends', manager.inFlight(profile.id) === 0, `inFlight=${manager.inFlight(profile.id)}`);
  first.value.reservation.release();
  ok('releasing a consumed reservation is a no-op', manager.inFlight(profile.id) === 0, `inFlight=${manager.inFlight(profile.id)}`);
}

console.log('\n── a selection that never starts gives its slot back\n');
{
  const manager = fresh();
  const selection = await manager.select([profile], ['reasoning']);
  selection.value.reservation.release();
  ok('released', manager.inFlight(profile.id) === 0);
  selection.value.reservation.release();
  ok('release is idempotent', manager.inFlight(profile.id) === 0, `inFlight=${manager.inFlight(profile.id)}`);
  const again = await manager.select([profile], ['reasoning']);
  ok('the profile is selectable again', again.ok);
  again.value.reservation.release();
}

console.log('\n── start() without a reservation still claims (planner retries, recovery)\n');
{
  const manager = fresh();
  const stream = manager.start(request());
  ok('claimed', manager.inFlight(profile.id) === 1);
  for await (const _ of stream) { /* drain */ }
  ok('released', manager.inFlight(profile.id) === 0);
}

console.log(`\n${bad === 0 ? 'ALL ROUTING OVERCOMMIT CHECKS PASSED' : `${bad} FAILED`}`);
process.exit(bad === 0 ? 0 : 1);
