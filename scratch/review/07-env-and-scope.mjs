// (a) Environment control: execution-local honours the allowlist; the Claude
//     adapter hands the child the daemon's whole environment.
// (b) Domain / path scope matching - attempts to defeat it.
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProcessEnv } from '../../packages/execution-core/dist/process-supervisor.js';
import { NodeProcessSupervisor } from '../../packages/execution-local/dist/process/node-process-supervisor.js';
import { nullLogger } from '../../packages/shared/dist/index.js';
import { matchesScope, hostOf, inferResourceKind } from '../../packages/policy/dist/scope.js';

process.env['GITHUB_TOKEN'] = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
process.env['AWS_SECRET_ACCESS_KEY'] = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
process.env['ANTHROPIC_API_KEY'] = 'sk-ant-SECRETSECRETSECRET';

console.log('=== (a) child environment ===');
const viaSupervisor = buildProcessEnv({});
console.log('buildProcessEnv({})      keys:', Object.keys(viaSupervisor).sort().join(', '));
console.log('  leaks GITHUB_TOKEN? ->', 'GITHUB_TOKEN' in viaSupervisor);

// what ClaudeCodeAdapter#run passes: `env: process.env` (adapter.ts:160)
const sandbox = mkdtempSync(join(tmpdir(), 'tdm-env-'));
const probe = join(sandbox, 'probe.sh');
writeFileSync(probe, '#!/bin/sh\nenv | grep -c -E "^(GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY|ANTHROPIC_API_KEY)="\n');
chmodSync(probe, 0o755);

const sup = new NodeProcessSupervisor(nullLogger);
const scoped = await sup.run({ command: probe, cwd: sandbox });
console.log('  via ProcessSupervisor    : secret vars visible to child =', scoped.stdout.trim());
const inherited = await sup.run({ command: probe, cwd: sandbox, inheritEnv: true });
console.log('  with inheritEnv:true     : secret vars visible to child =', inherited.stdout.trim());
console.log('  ClaudeCodeAdapter uses `env: process.env` and never goes through the supervisor at all,');
console.log('  so a Claude run is permanently in the `inheritEnv: true` shape with no opt-out.');
rmSync(sandbox, { recursive: true, force: true });

console.log('\n=== (b) domain scope ===');
const domainCases = [
  ['*.example.com', 'https://api.example.com/x', true],
  ['*.example.com', 'https://evil-example.com/x', false],
  ['*.example.com', 'https://example.com.evil.net/x', false],
  ['*.example.com', 'https://example.com', false],
  ['example.com', 'https://example.com.evil.net', false],
  ['example.com', 'https://user:pw@example.com/', true],
  ['example.com', 'https://example.com@evil.net/', false],
  ['example.com', 'https://example.com.', true],
  ['example.com', 'https://EXAMPLE.com:443/x', true],
  ['*.example.com', 'https://a.b.example.com', true],
];
for (const [entry, resource, want] of domainCases) {
  const got = matchesScope('domain', resource, [entry]).matched;
  console.log(`${got === want ? 'ok  ' : 'BAD '} ${entry.padEnd(16)} vs ${resource.padEnd(34)} -> ${got} (host=${hostOf(resource)})`);
}

console.log('\n=== (b) path scope ===');
const pathCases = [
  ['/a/b', '/a/b/c', true],
  ['/a/b', '/a/bc', false],
  ['/a/b', '/a/bc/d', false],
  ['/a/b', '/a/b/../../etc/passwd', false],
  ['/a/b', '/a/b', true],
  ['/a/b', '/a/b/../b/ok', true],
];
for (const [entry, resource, want] of pathCases) {
  const got = matchesScope('path', resource, [entry]).matched;
  console.log(`${got === want ? 'ok  ' : 'BAD '} root ${entry.padEnd(6)} vs ${resource.padEnd(24)} -> ${got}`);
}

console.log('\n=== (b) resource-kind inference ===');
for (const [cap, res] of [
  ['filesystem.write', 'src/app.ts'],
  ['filesystem.write', '/wt/src/app.ts'],
  ['shell.exec', 'node_modules'],
]) {
  console.log(`  inferResourceKind(${cap}, ${JSON.stringify(res)}) = ${inferResourceKind(cap, res)}`);
}
const rel = matchesScope(inferResourceKind('filesystem.write', 'src/app.ts'), 'src/app.ts', ['/wt']);
console.log('  -> a RELATIVE path under the granted root matches?', rel.matched, `(${rel.reason})`);
