// End-to-end ClaudeCodeAdapter against a fake `claude` executable:
//  - multi-byte UTF-8 split across a chunk boundary
//  - an NDJSON line well over 1 MB
//  - a partial line with no trailing newline
//  - cancellation (SIGTERM) while the child is mid-stream
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nullLogger } from '../../packages/shared/dist/index.js';
import { ClaudeCodeAdapter } from '../../packages/runtime-claude/dist/adapter.js';

const sandbox = mkdtempSync(join(tmpdir(), 'tdm-claude-'));
const fake = join(sandbox, 'claude');

// The fake writes raw bytes so we control exactly where chunk boundaries fall.
writeFileSync(fake, `#!/usr/bin/env node
const big = 'X'.repeat(2 * 1024 * 1024);
const line1 = JSON.stringify({ type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'héllo 🎉 café — naïve' }] } }) + '\\n';
const line2 = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: big }] } }) + '\\n';
const line3 = JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1', result: 'done', usage: { input_tokens: 5, output_tokens: 7 }, total_cost_usd: 0.01 });
const buf = Buffer.from(line1, 'utf8');
// split the FIRST line in the middle of the 4-byte emoji
const emojiAt = buf.indexOf(Buffer.from('🎉', 'utf8'));
process.stdout.write(buf.subarray(0, emojiAt + 2));
setTimeout(() => {
  process.stdout.write(buf.subarray(emojiAt + 2));
  process.stdout.write(line2);
  process.stdout.write(line3); // NO trailing newline
  setTimeout(() => process.exit(0), 30);
}, 30);
`);
chmodSync(fake, 0o755);

const baseRequest = (signal) => ({
  runId: 'run_1',
  profile: { id: 'rp_1', adapterId: 'claude-code', executablePath: fake, settings: {}, args: [], enabled: true, maxConcurrent: 1, updatedAt: '' },
  prompt: 'hi',
  workingDirectory: sandbox,
  grants: ['filesystem.write', 'shell.exec'],
  allowedRoots: [],
  mcpConfigPath: null,
  maxWallTimeMs: 30_000,
  signal,
  log: nullLogger,
});

console.log('=== 1. streaming correctness ===');
{
  const adapter = new ClaudeCodeAdapter();
  const seen = [];
  for await (const e of adapter.start(baseRequest(new AbortController().signal))) seen.push(e);
  const msg = seen.find((e) => e.type === 'message');
  console.log('  first message text       :', JSON.stringify(msg?.text));
  console.log('  emoji survived the split ->', msg?.text === 'héllo 🎉 café — naïve');
  const big = seen.filter((e) => e.type === 'message')[1];
  console.log('  2 MB line assembled      ->', big?.text.startsWith('XXXX'), '| clipped to', big?.text.length, 'chars (MAX_TEXT_CHARS=16000 + suffix)');
  console.log('  trailing line w/o \\n     ->', seen.some((e) => e.type === 'completed'), '| usage event ->', seen.some((e) => e.type === 'usage'));
  console.log('  event types              :', seen.map((e) => e.type).join(', '));
}

console.log('\n=== 2. cancellation ===');
{
  const slow = join(sandbox, 'claude-slow');
  writeFileSync(slow, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'working'}]}})+'\\n');\nsetInterval(()=>{},1000);\n`);
  chmodSync(slow, 0o755);

  const adapter = new ClaudeCodeAdapter({ terminationGraceMs: 300 });
  const ac = new AbortController();
  const req = { ...baseRequest(ac.signal), profile: { ...baseRequest(ac.signal).profile, executablePath: slow } };
  const seen = [];
  const started = Date.now();
  setTimeout(() => ac.abort(), 200);
  for await (const e of adapter.start(req)) seen.push(e);
  console.log('  events    :', seen.map((e) => `${e.type}${e.type === 'failed' ? `(${e.code})` : ''}`).join(', '));
  console.log('  elapsed   :', Date.now() - started, 'ms');
  console.log('  pid after :', adapter.pid('run_1'), '(child map cleaned up)');
}

console.log('\n=== 3. wall-time budget vs cancel are distinguished ===');
{
  const slow = join(sandbox, 'claude-slow');
  const adapter = new ClaudeCodeAdapter({ terminationGraceMs: 300 });
  const req = { ...baseRequest(new AbortController().signal), maxWallTimeMs: 250 };
  req.profile = { ...req.profile, executablePath: slow };
  const seen = [];
  for await (const e of adapter.start(req)) seen.push(e);
  const failed = seen.find((e) => e.type === 'failed');
  console.log('  failed code =', failed?.code, '| retryable =', failed?.retryable, '|', failed?.message);
}

rmSync(sandbox, { recursive: true, force: true });
