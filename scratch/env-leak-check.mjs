/**
 * A worker must not inherit credentials it has no business seeing (MVP.md
 * §19.1, §32 "credential leakage"). The daemon is routinely started from a
 * developer shell carrying tokens for entirely unrelated services.
 */
import { buildRuntimeEnv, withheldEnvNames, BASE_RUNTIME_ENV } from '/Users/you/projects/tandemise/packages/runtimes-core/dist/index.js';

let bad = 0;
const ok = (n, c, d='') => { if (c) console.log(`  ok   ${n}${d?'  '+d:''}`); else { bad++; console.log(`  FAIL ${n}${d?'  '+d:''}`); } };

const source = {
  PATH: '/usr/bin', HOME: '/Users/demo', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', TMPDIR: '/tmp',
  ANTHROPIC_API_KEY: 'sk-ant-secret', CLAUDE_CONFIG_DIR: '/Users/demo/.claude',
  XDG_CONFIG_HOME: '/Users/demo/.config', HTTPS_PROXY: 'http://proxy:8080',
  // None of these belong to an agent runtime.
  GITHUB_TOKEN: 'ghp_leak', AWS_SECRET_ACCESS_KEY: 'aws_leak', AWS_ACCESS_KEY_ID: 'AKIAleak',
  STRIPE_SECRET_KEY: 'sk_live_leak', DATABASE_URL: 'postgres://u:p@h/db',
  OPENAI_API_KEY: 'sk-openai-leak', NPM_TOKEN: 'npm_leak', SLACK_TOKEN: 'xoxb-leak',
};

const env = buildRuntimeEnv({ allowedPrefixes: ['ANTHROPIC_', 'CLAUDE_'], source });

console.log('── the runtime keeps what it needs');
for (const k of ['PATH','HOME','SHELL','LANG','TMPDIR','XDG_CONFIG_HOME','HTTPS_PROXY']) {
  ok(`${k} passed through`, env[k] === source[k]);
}
ok('ANTHROPIC_API_KEY passed through (its own credential)', env.ANTHROPIC_API_KEY === 'sk-ant-secret');
ok('CLAUDE_CONFIG_DIR passed through', env.CLAUDE_CONFIG_DIR === source.CLAUDE_CONFIG_DIR);

console.log('\n── unrelated credentials are withheld');
for (const k of ['GITHUB_TOKEN','AWS_SECRET_ACCESS_KEY','AWS_ACCESS_KEY_ID','STRIPE_SECRET_KEY','DATABASE_URL','OPENAI_API_KEY','NPM_TOKEN','SLACK_TOKEN']) {
  ok(`${k} withheld`, env[k] === undefined, env[k] === undefined ? '' : `LEAKED: ${env[k]}`);
}
const withheld = withheldEnvNames(env, source);
ok('withheldEnvNames reports them all', withheld.length === 8, withheld.join(', '));

console.log('\n── a different runtime gets a different prefix set');
const other = buildRuntimeEnv({ allowedPrefixes: ['OPENAI_'], source });
ok('OPENAI_API_KEY reaches an OpenAI-based runtime', other.OPENAI_API_KEY === 'sk-openai-leak');
ok('ANTHROPIC_API_KEY does NOT reach it', other.ANTHROPIC_API_KEY === undefined);

console.log('\n── overrides win');
const overridden = buildRuntimeEnv({ source, overrides: { PATH: '/sandbox/bin' } });
ok('an explicit override replaces the inherited value', overridden.PATH === '/sandbox/bin');
ok('the base allowlist is non-empty', BASE_RUNTIME_ENV.length > 10);

console.log(`\n${bad === 0 ? 'ALL ENVIRONMENT ISOLATION CHECKS PASSED' : `${bad} FAILED`}`);
process.exit(bad === 0 ? 0 : 1);
