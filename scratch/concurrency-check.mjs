/**
 * A runtime's concurrency slot must be held from the moment a run starts, not
 * from the moment someone reads its first event. Routing reads `isSaturated`,
 * so a slot that is not yet claimed lets two schedulers pick the same
 * maxConcurrent:1 profile.
 */
import { RuntimeManager, RuntimeRegistry } from '/Users/you/projects/tandemise/packages/runtimes-core/dist/index.js';
import { createLogger, ids, systemClock } from '/Users/you/projects/tandemise/packages/shared/dist/index.js';

let bad = 0;
const ok = (n, c, d='') => { if (c) console.log(`  ok   ${n}${d?'  '+d:''}`); else { bad++; console.log(`  FAIL ${n}${d?'  '+d:''}`); } };

let release;
const gate = new Promise((r) => { release = r; });

const adapter = {
  id: 'slow', displayName: 'Slow',
  async discover() { return { adapterId: 'slow', displayName: 'Slow', detected: true, executablePath: null, version: '1', capabilities: [], detail: '', suggestedSettings: {} }; },
  async healthCheck(p) { return { profileId: p.id, state: 'healthy', version: '1', detail: '', checkedAt: systemClock.now(), quotaWarning: null }; },
  capabilities() { return ['reasoning']; },
  async *start() { await gate; yield { type: 'completed' }; },
  async cancel() {},
};

const registry = new RuntimeRegistry([adapter]);
const manager = new RuntimeManager({ registry, logger: createLogger({ level: 'error' }), clock: systemClock });

const profile = {
  id: ids.runtimeProfile(), workspaceId: null, adapterId: 'slow', name: 'Slow',
  executablePath: null, args: [], settings: {}, capabilities: ['reasoning'],
  enabled: true, maxConcurrent: 1,
  createdAt: systemClock.now(), updatedAt: systemClock.now(),
};

const request = { runId: ids.run(), profile, prompt: 'x', workingDirectory: '/tmp', grantedCapabilities: [], allowedRoots: ['/tmp'], maxWallTimeMs: 5000, signal: new AbortController().signal, log: createLogger({ level: 'error' }) };

console.log('── the slot is held from start(), before any event is read\n');
ok('idle before start', manager.inFlight(profile.id) === 0);
const stream = manager.start(request);
ok('in flight immediately after start(), with no next() yet', manager.inFlight(profile.id) === 1, `inFlight=${manager.inFlight(profile.id)}`);
ok('profile reports saturated', manager.isSaturated(profile) === true);

release();
for await (const _ of stream) { /* drain */ }
ok('slot released after the stream ends', manager.inFlight(profile.id) === 0);
ok('no longer saturated', manager.isSaturated(profile) === false);

console.log('\n── an abandoned stream does not leak the slot\n');
let release2; const gate2 = new Promise((r) => { release2 = r; });
const adapter2 = { ...adapter, async *start() { yield { type: 'message', text: 'one' }; await gate2; yield { type: 'completed' }; } };
const reg2 = new RuntimeRegistry([adapter2]);
const mgr2 = new RuntimeManager({ registry: reg2, logger: createLogger({ level: 'error' }), clock: systemClock });
const s2 = mgr2.start(request);
ok('claimed', mgr2.inFlight(profile.id) === 1);
for await (const _ of s2) break;   // abandon after the first event
ok('slot released when the consumer breaks early', mgr2.inFlight(profile.id) === 0, `inFlight=${mgr2.inFlight(profile.id)}`);
release2();

console.log(`\n${bad === 0 ? 'ALL CONCURRENCY CHECKS PASSED' : `${bad} FAILED`}`);
process.exit(bad === 0 ? 0 : 1);
