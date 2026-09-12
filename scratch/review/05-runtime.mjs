// Line assembly, event mapping and manager accounting.
import { LineAssembler } from '../../packages/runtimes-core/dist/line-assembler.js';
import { RuntimeManager } from '../../packages/runtimes-core/dist/manager.js';
import { RuntimeRegistry } from '../../packages/runtimes-core/dist/registry.js';
import { ClaudeEventMapper } from '../../packages/runtime-claude/dist/event-mapper.js';

console.log('=== LineAssembler ===');
{
  // a) partial line across chunks - correct
  const la = new LineAssembler();
  console.log('split line  :', JSON.stringify([...la.push('{"a":1'), ...la.push('}\n{"b":2}\n')]));

  // b) multi-byte split. LineAssembler takes a *string*, so correctness depends
  //    entirely on the caller using setEncoding/StringDecoder. Simulate the
  //    naive `chunk.toString()` the adapter does NOT do, for contrast:
  const buf = Buffer.from('{"t":"héllo 🎉"}\n', 'utf8');
  const naive = buf.subarray(0, 10).toString() + buf.subarray(10).toString();
  console.log('naive toString round-trip ok? ', naive === buf.toString());
  console.log('  (adapter.ts:224 calls stdout.setEncoding("utf8") -> Node uses StringDecoder, so this is safe)');

  // c) the ceiling throws AFTER complete lines were already extracted -> they are lost
  const small = new LineAssembler(16);
  try {
    small.push('good-line-1\ngood-line-2\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    console.log('overlong line: no throw <-- unexpected');
  } catch (e) {
    console.log('overlong line: threw', e.code, '- and "good-line-1"/"good-line-2" were discarded with it');
  }
}

console.log('\n=== ClaudeEventMapper ===');
{
  const m = new ClaudeEventMapper({ fileExists: () => false, onQuotaWarning: () => {} });
  const toolUse = (name, input) => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name, input }] },
  });

  for (const name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']) {
    const input = name === 'NotebookEdit'
      ? { notebook_path: '/wt/n.ipynb' }
      : name === 'Bash' ? { command: 'rm x' } : { file_path: '/wt/a.ts' };
    const events = m.map(toolUse(name, input));
    const fc = events.filter((e) => e.type === 'file.changed');
    console.log(`${name.padEnd(13)} -> file.changed: ${fc.length ? JSON.stringify(fc[0]) : 'NONE'}`);
  }

  // tool_use with no file_path at all
  console.log('Write w/o path ->', JSON.stringify(m.map(toolUse('Write', {}))));

  // relative file_path: `fileExists` is node:fs.existsSync bound to the DAEMON cwd,
  // not the run's working directory.
  const m2 = new ClaudeEventMapper({ fileExists: (p) => { console.log('  fileExists() got:', JSON.stringify(p)); return false; }, onQuotaWarning: () => {} });
  m2.map(toolUse('Write', { file_path: 'src/a.ts' }));
}

console.log('\n=== RuntimeManager concurrency accounting ===');
{
  const profile = {
    id: 'rp_1', adapterId: 'fake', enabled: true, maxConcurrent: 1,
    updatedAt: '2026-01-01T00:00:00.000Z', settings: {}, args: [], executablePath: null,
  };
  const adapter = {
    id: 'fake', displayName: 'fake', baseCapabilities: ['shell'],
    capabilities: () => ['shell'],
    async discover() { return {}; },
    async healthCheck() { return { profileId: 'rp_1', state: 'healthy', version: '1', detail: '', checkedAt: '', quotaWarning: null }; },
    start() { return (async function* () { await new Promise(() => {}); })(); },
    async cancel() {}, pid: () => null,
  };
  const mgr = new RuntimeManager({ registry: new RuntimeRegistry([adapter]) });
  const stream = mgr.start({ profile, runId: 'run_1' });
  console.log('after start(), before first next(): inFlight =', mgr.inFlight('rp_1'), ' saturated =', mgr.isSaturated(profile));
  const it = stream[Symbol.asyncIterator]();
  it.next();
  await new Promise((r) => setImmediate(r));
  console.log('after first next()               : inFlight =', mgr.inFlight('rp_1'), ' saturated =', mgr.isSaturated(profile));
  console.log('=> two concurrent start() calls both route before either holds a slot.');
}
