/**
 * Per-profile identity for Claude Code runtimes.
 *
 * Two profiles of the same adapter are only genuinely two workers if they can
 * run under different config directories - different login, different settings,
 * different MCP servers. This drives the real env builder and the real binary.
 */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { buildRuntimeEnv } from '../packages/runtimes-core/dist/runtime-env.js';
import { PARENT_SESSION_ENV, resolveConfigDir } from '../packages/runtime-claude/dist/settings.js';

let passed = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
};

const envFor = (settings, source) => {
  const configDir = resolveConfigDir(settings);
  return buildRuntimeEnv({
    allowedPrefixes: ['ANTHROPIC_', 'CLAUDE_'],
    allowedNames: ['SSH_AUTH_SOCK', 'GIT_ASKPASS', 'COLORTERM'],
    deniedNames: PARENT_SESSION_ENV,
    source,
    ...(configDir === null ? {} : { overrides: { CLAUDE_CONFIG_DIR: configDir } }),
  });
};

console.log('── configDir resolution');
ok('~ is expanded', resolveConfigDir({ configDir: '~/.claude-home' }) === `${homedir()}/.claude-home`,
  resolveConfigDir({ configDir: '~/.claude-home' }));
ok('absolute is kept', resolveConfigDir({ configDir: '/opt/claude' }) === '/opt/claude');
ok('absent means inherit', resolveConfigDir({}) === null);
ok('a relative path is refused', (() => {
  try { resolveConfigDir({ configDir: 'claude-home' }); return false; } catch { return true; }
})());

console.log('\n── two profiles, two identities');
const source = { PATH: process.env.PATH, HOME: homedir(), CLAUDE_CONFIG_DIR: '/inherited/from/daemon' };
const a = envFor({ configDir: '~/.claude-home' }, source);
const b = envFor({ configDir: '~/.claude' }, source);
ok('profile A gets its own config dir', a.CLAUDE_CONFIG_DIR === `${homedir()}/.claude-home`, a.CLAUDE_CONFIG_DIR);
ok('profile B gets its own config dir', b.CLAUDE_CONFIG_DIR === `${homedir()}/.claude`, b.CLAUDE_CONFIG_DIR);
ok('a profile overrides what the daemon inherited', a.CLAUDE_CONFIG_DIR !== source.CLAUDE_CONFIG_DIR);
ok('an unset profile still inherits', envFor({}, source).CLAUDE_CONFIG_DIR === '/inherited/from/daemon');

console.log('\n── a parent session does not leak into a worker');
const parent = {
  PATH: process.env.PATH, HOME: homedir(),
  CLAUDE_CODE_MESSAGING_TOKEN: 'secret-token', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock',
  CLAUDE_CODE_SESSION_ID: 'parent-session', CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192', ANTHROPIC_BASE_URL: 'https://example.invalid',
};
const child = envFor({}, parent);
for (const name of ['CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT']) {
  ok(`${name} is withheld`, !(name in child));
}
ok('real user config still passes', child.CLAUDE_CODE_MAX_OUTPUT_TOKENS === '8192');
ok('vendor config still passes', child.ANTHROPIC_BASE_URL === 'https://example.invalid');

console.log('\n── the real binary honours it');
const bin = '/Users/you/.local/bin/claude';
for (const dir of ['~/.claude-home', '~/.claude']) {
  const env = envFor({ configDir: dir }, { PATH: process.env.PATH, HOME: homedir() });
  const res = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 30_000 });
  ok(`runs under ${dir}`, res.status === 0, (res.stdout || res.stderr || '').trim().split('\n')[0]);
}

console.log('\n' + '─'.repeat(60));
console.log(failures.length === 0
  ? `ALL ${passed} PROFILE ENV CHECKS PASSED`
  : `${passed} passed, ${failures.length} FAILED:\n  - ${failures.join('\n  - ')}`);
process.exit(failures.length === 0 ? 0 : 1);
