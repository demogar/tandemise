/**
 * Proves the runtime-agnosticism claim: a second, entirely different agent CLI
 * is driven to completion through the GENERIC adapter with no new code — only
 * configuration on a RuntimeProfile.
 */
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenericCliAdapter } from '/Users/you/projects/tandemise/packages/runtime-generic/dist/index.js';
import { createLogger, ids } from '/Users/you/projects/tandemise/packages/shared/dist/index.js';

const dir = mkdtempSync(join(tmpdir(), 'tandemise-generic-'));

// Two entirely different agent CLIs, wired through the SAME generic adapter
// using nothing but RuntimeProfile settings. No Tandemise code is aware that
// either of these tools exists.
const CANDIDATES = [
  {
    label: 'Gemini CLI (text output)',
    command: '/Users/you/.nvm/versions/node/v20.10.0/bin/gemini',
    args: ['--output-format', 'text', '--approval-mode', 'yolo', '{{prompt}}'],
    outputFormat: 'text',
  },
  {
    label: 'Claude Code (ndjson, mapped by config)',
    command: '/Users/you/.local/bin/claude',
    args: ['-p', '{{prompt}}', '--output-format', 'stream-json', '--verbose',
           '--model', 'claude-haiku-4-5-20251001', '--permission-mode', 'acceptEdits'],
    outputFormat: 'ndjson',
    eventMap: { typeField: 'type', types: { assistant: 'ignore', result: 'completed', system: 'ignore', user: 'ignore' }, sessionField: 'session_id' },
  },
];
const log = createLogger({ level: 'warn' });
const adapter = new GenericCliAdapter();

// Everything below is DATA a user could type into the Runtimes screen.
function profileFor(c) { return {
  id: ids.runtimeProfile(),
  workspaceId: null,
  adapterId: adapter.id,
  name: 'Gemini CLI',
  args: [],
  executablePath: c.command,
  settings: {
    command: c.command,
    args: c.args,
    promptVia: 'arg',
    outputFormat: c.outputFormat,
    versionArgs: ['--version'],
    capabilities: ['reasoning', 'shell', 'filesystem', 'tool_calling'],
    ...(c.eventMap ? { eventMap: c.eventMap } : {}),
  },
  capabilities: ['reasoning', 'shell', 'filesystem', 'tool_calling'],
  enabled: true,
  maxConcurrent: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}; }

for (const c of CANDIDATES) {
  const profile = profileFor(c);
  console.log(`\n${'='.repeat(62)}\n${c.label}\n${'='.repeat(62)}`);

  const h = await adapter.healthCheck(profile);
  console.log('  health:', h.state, '|', h.detail);
  if (h.state !== 'healthy') { console.log('  skipping run — runtime not healthy'); continue; }

  const marker = `generic-${c.outputFormat}-was-here.txt`;
  const controller = new AbortController();
  const seen = [];
  try {
    for await (const ev of adapter.start({
      runId: ids.run(),
      profile,
      prompt: `Create a file named ${marker} in the current directory containing exactly the word TANDEMISE. Then reply DONE.`,
      workingDirectory: dir,
      grantedCapabilities: ['filesystem.write', 'shell.exec'],
      allowedRoots: [dir],
      maxWallTimeMs: 240_000,
      signal: controller.signal,
      log,
    })) {
      seen.push(ev.type);
      if (ev.type !== 'raw') console.log('  ->', ev.type, '|', JSON.stringify(ev).slice(0, 130));
    }
  } catch (e) {
    console.log('  run threw:', e?.message ?? e);
  }

  const target = join(dir, marker);
  const created = existsSync(target);
  console.log('  event types:', [...new Set(seen)].join(', '));
  console.log('  file created:', created, created ? `contents=${JSON.stringify(readFileSync(target,'utf8').trim())}` : '');
  console.log(created ? '  ✅ a real agent CLI ran to completion through the generic adapter — zero new code'
                      : '  ⚠️  no file produced (see events above)');
}
console.log('\ndir:', dir);
