/**
 * A run granted `artifact.write` but not `filesystem.write` must be able to
 * deliver its artifact, and only its artifact.
 *
 * Found by running a research mission in the real app: every product, finance
 * and design run did its work and then failed `artifact.*.exists`, because
 * Write was disallowed for any run without `filesystem.write` - the documents
 * ended up pasted into the transcript instead of `.tandemise/out/`.
 *
 * The CLI half (an `Edit(.tandemise/out/**)` rule permits exactly that
 * directory under `--permission-mode default`, and refuses a write elsewhere
 * without prompting) was verified against Claude Code 2.1.269 by hand; this
 * pins the flags that rely on it.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { buildInvocation } = await import(join(root, 'packages/runtime-claude/dist/index.js'));

let bad = 0;
const ok = (n, c, d = '') => { if (c) console.log(`  ok   ${n}${d ? '  ' + d : ''}`); else { bad++; console.log(`  FAIL ${n}${d ? '  ' + d : ''}`); } };
const flag = (args, name) => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1]; };
const invoke = (grants, settings = {}) => buildInvocation({
  runId: 'run_x', prompt: 'p', workingDirectory: '/tmp/wt', grants, allowedRoots: [], mcpConfigPath: null,
  maxWallTimeMs: 1000, signal: new AbortController().signal, log: null,
  profile: { id: 'rt', adapterId: 'claude-code', settings, args: [], executablePath: null },
}, null).args;

console.log('── artifact.write without filesystem.write\n');
{
  const args = invoke(['repository.read', 'filesystem.read', 'artifact.write']);
  const disallowed = flag(args, '--disallowed-tools');
  ok('Write stays offered', !disallowed.split(',').includes('Write'), disallowed);
  ok('Edit stays offered', !disallowed.split(',').includes('Edit'));
  ok('Bash is still disallowed', disallowed.split(',').includes('Bash'));
  ok('NotebookEdit is still disallowed', disallowed.split(',').includes('NotebookEdit'));
  ok('writes are allowed only under .tandemise/out', flag(args, '--allowed-tools') === 'Edit(.tandemise/out/**)', flag(args, '--allowed-tools'));
  ok('permission mode stays default, so unmatched writes are refused', flag(args, '--permission-mode') === 'default');
}

console.log('\n── neither grant: fully read-only, as before\n');
{
  const args = invoke(['repository.read', 'filesystem.read']);
  const disallowed = flag(args, '--disallowed-tools').split(',');
  ok('Write disallowed', disallowed.includes('Write') && disallowed.includes('Edit'));
  ok('no allow rule', !args.includes('--allowed-tools'));
}

console.log('\n── filesystem.write: unscoped, as before\n');
{
  const args = invoke(['filesystem.write', 'shell.exec', 'artifact.write']);
  ok('nothing disallowed', !args.includes('--disallowed-tools'));
  ok('no artifact-only rule', !args.includes('--allowed-tools'));
}

console.log('\n── profile allow rules are kept alongside\n');
{
  const args = invoke(['artifact.write'], { allowedTools: 'WebFetch' });
  ok('both rules present', flag(args, '--allowed-tools') === 'Edit(.tandemise/out/**),WebFetch', flag(args, '--allowed-tools'));
}

console.log('\n── the user\'s own MCP servers never reach a run\n');
{
  const noTools = invoke(['repository.read']);
  ok('a run with no granted tools is still strict', noTools.includes('--strict-mcp-config'), noTools.join(' '));
  ok('and its MCP config is empty', flag(noTools, '--mcp-config') === '{"mcpServers":{}}');
}

console.log('\n── granted connected-app tools are callable headless\n');
{
  const withTools = buildInvocation({
    runId: 'run_x', prompt: 'p', workingDirectory: '/tmp/wt', grants: ['design', 'artifact.write'], allowedRoots: [],
    mcpConfigPath: '/tmp/mcp.json', maxWallTimeMs: 1000, signal: new AbortController().signal, log: null,
    profile: { id: 'rt', adapterId: 'claude-code', settings: {}, args: [], executablePath: null },
  }, null).args;
  // Verified by hand against Claude Code 2.1.269: without this rule every
  // mcp__tandemise__* call is refused in -p mode; with it the call goes through
  // and Tandemise's own policy gate decides.
  ok('the Tandemise gateway server is allowed', flag(withTools, '--allowed-tools').split(',').includes('mcp__tandemise'), flag(withTools, '--allowed-tools'));
  ok('and only that server', flag(withTools, '--mcp-config') === '/tmp/mcp.json' && withTools.includes('--strict-mcp-config'));
}

console.log(`\n${bad === 0 ? 'ALL ARTIFACT WRITE SCOPE CHECKS PASSED' : `${bad} FAILED`}`);
process.exit(bad === 0 ? 0 : 1);
