/**
 * The Codex CLI is not installed on this machine. That is the interesting case:
 * an adapter for a tool the user has not installed must degrade to an
 * actionable message, never throw, and never claim health it cannot verify.
 */
import { CodexAdapter } from '/Users/you/projects/tandemise/packages/runtime-codex/dist/index.js';
import { createLogger, ids, systemClock } from '/Users/you/projects/tandemise/packages/shared/dist/index.js';

let bad = 0;
const ok = (n, c, d='') => { if (c) console.log(`  ok   ${n}${d?'  '+d:''}`); else { bad++; console.log(`  FAIL ${n}${d?'  '+d:''}`); } };

const adapter = new CodexAdapter();
const profile = {
  id: ids.runtimeProfile(), workspaceId: null, adapterId: adapter.id, name: 'Codex',
  executablePath: null, args: [], settings: {}, capabilities: [],
  enabled: true, maxConcurrent: 1,
  createdAt: systemClock.now(), updatedAt: systemClock.now(),
};

console.log('── discovery with the CLI absent');
const d = await adapter.discover();
ok('discover() does not throw', true);
ok('reports not detected', d.detected === false, `detected=${d.detected}`);
ok('detail names the install command', /npm i -g|install/i.test(d.detail), d.detail);
ok('advertises an adapter id', d.adapterId === adapter.id, d.adapterId);

console.log('\n── health with the CLI absent');
const h = await adapter.healthCheck(profile);
ok('healthCheck() does not throw', true);
ok('state is unavailable', h.state === 'unavailable', h.state);
ok('detail is actionable', h.detail.length > 20, h.detail);
ok('version is null rather than invented', h.version === null);

console.log('\n── starting a run without the CLI fails cleanly');
try {
  const events = [];
  for await (const e of adapter.start({
    runId: ids.run(), profile, prompt: 'hi', workingDirectory: '/tmp',
    grantedCapabilities: [], allowedRoots: ['/tmp'], maxWallTimeMs: 5000,
    signal: new AbortController().signal, log: createLogger({ level: 'error' }),
  })) events.push(e);
  const terminal = events.filter((e) => e.type === 'failed' || e.type === 'completed');
  ok('exactly one terminal event', terminal.length === 1, events.map(e=>e.type).join(','));
  ok('it is a failure naming the missing CLI', terminal[0]?.type === 'failed' && /codex/i.test(terminal[0].message), terminal[0]?.message);
} catch (e) {
  ok('start() surfaces a typed error rather than crashing', e?.code === 'RUNTIME_UNAVAILABLE', `${e?.code}: ${e?.message}`);
}

console.log('\n── capabilities are declared, not guessed');
const caps = adapter.capabilities(profile);
ok('declares capabilities', Array.isArray(caps) && caps.length > 0, caps.join(','));

console.log(`\n${bad === 0 ? 'ALL CODEX ADAPTER CHECKS PASSED (CLI absent, degraded correctly)' : `${bad} FAILED`}`);
process.exit(bad === 0 ? 0 : 1);
