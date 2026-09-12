/**
 * The whole architecture in one test (MVP.md §12.4).
 *
 * A real Claude Code process is launched with a run-scoped MCP config and
 * `--strict-mcp-config`, and asked to call a tool. The tool it reaches is
 * Tandemise's: brokered, policy-gated, audited, and narrowed to exactly what
 * this assignment's grants allow. A tool the assignment lacks must not even be
 * visible to it.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { McpGatewayProvisioner } from '/Users/you/projects/tandemise/packages/application/dist/index.js';
import { ToolBroker, IntegrationToolCatalog, IntegrationProviderRegistry, RecordingAuditSink } from '/Users/you/projects/tandemise/packages/integrations-core/dist/index.js';
import { GitHubIntegrationProvider } from '/Users/you/projects/tandemise/packages/integration-github/dist/index.js';
import { createToolCommandExecutor } from '/Users/you/projects/tandemise/apps/daemon/dist/tool-exec.js';
import { NodeProcessSupervisor } from '/Users/you/projects/tandemise/packages/execution-local/dist/index.js';
import { createPolicyEngine } from '/Users/you/projects/tandemise/packages/policy/dist/index.js';
import { createLogger, createPaths, ids, systemClock } from '/Users/you/projects/tandemise/packages/shared/dist/index.js';

let bad = 0;
const ok = (n,c,d='') => { if(c) console.log(`  ok   ${n}${d?'  '+d:''}`); else { bad++; console.log(`  FAIL ${n}${d?'  '+d:''}`); } };

const home = mkdtempSync(join(tmpdir(), 'tdm-mcp-'));
const log = createLogger({ level: 'error' });
const paths = createPaths(home);
const supervisor = new NodeProcessSupervisor(log);
const exec = createToolCommandExecutor(supervisor, log);

const workspaceId = ids.workspace(), missionId = ids.mission();
const integration = {
  id: ids.integration(), workspaceId, providerId: 'github', name: 'GitHub',
  transport: 'cli', config: {}, credentialRef: null,
  enabledCapabilities: ['github.read'], enabled: true,
  createdAt: systemClock.now(), updatedAt: systemClock.now(),
};

const registry = new IntegrationProviderRegistry([new GitHubIntegrationProvider()]);
const catalog = new IntegrationToolCatalog(registry, () => [integration], log);
const audit = new RecordingAuditSink();
const policy = createPolicyEngine();

const autonomy = { planApproval:'ask', localCodeChanges:'auto', externalWrites:'policy', productionRelease:'ask', financialActions:'deny' };

// A read-only assignment: github.read only. No PR creation, no browser.
const assignment = {
  id: ids.workerAssignment(), workspaceId, missionId, taskId: ids.task(),
  roleId: 'review', runtimeProfileId: ids.runtimeProfile(), executionTargetId: ids.executionTarget(),
  grants: [{ capability: 'github.read', resourceScope: ['cli/cli'], approvalMode: 'auto', expiresAt: null }],
  budgets: { maxWallTimeMs: 120000, maxAttempts: 1 },
  createdAt: systemClock.now(),
};

const broker = new ToolBroker({
  catalog, audit, clock: systemClock, log,
  policy: {
    async check({ capability, resource }) {
      const d = policy.evaluate({ capability, resource, grants: assignment.grants, autonomy, assignmentId: assignment.id });
      return { outcome: d.outcome, reason: d.reason, risk: d.risk };
    },
  },
  // Nothing in this test should need a human; an approval request here is a
  // failure of the grant set, not a scenario to satisfy.
  approvals: { async requestApproval() { throw new Error('unexpected approval request'); } },
});

const controller = new AbortController();
const provisioner = new McpGatewayProvisioner({ broker, exec, paths, clock: systemClock, log });
const surface = await provisioner.provision({
  runId: ids.run(), workspaceId, missionId, assignment,
  workingDirectory: home, signal: controller.signal,
});

console.log('── the run-scoped tool surface');
ok('an MCP config was written', !!surface.mcpConfigPath, surface.mcpConfigPath);
ok('only granted tools are published', surface.toolNames.every((n) => n.startsWith('github.') && !n.includes('create') && !n.includes('comment')), surface.toolNames.join(', '));
ok('github.pr.create is NOT published', !surface.toolNames.includes('github.pr.create'));
const cfg = JSON.parse(readFileSync(surface.mcpConfigPath, 'utf8'));
ok('the config names exactly one server', Object.keys(cfg.mcpServers).join(',') === 'tandemise');
ok('the socket and token travel in the environment, not the file',
   !!cfg.mcpServers.tandemise.env?.TANDEMISE_TOOL_BRIDGE_TOKEN && !JSON.stringify(cfg.mcpServers.tandemise.args).includes('token'));

console.log('\n── a REAL Claude Code worker calls a Tandemise tool');
const prompt = `Use the tandemise MCP tool "github.repo.view" with repo "cli/cli" to look up that repository. Then reply with ONLY its default branch name, nothing else.`;
const args = ['-p', prompt, '--output-format','stream-json','--verbose',
  '--model','claude-haiku-4-5-20251001','--permission-mode','bypassPermissions',
  '--mcp-config', surface.mcpConfigPath, '--strict-mcp-config'];

const child = spawn('/Users/you/.local/bin/claude', args, { cwd: home, env: process.env });
let out = '', toolCalls = [], finalText = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  out += c;
  for (const line of c.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const o = JSON.parse(line);
      for (const b of o?.message?.content ?? []) {
        if (b.type === 'tool_use') toolCalls.push(b.name);
        if (b.type === 'text' && o.type === 'assistant') finalText = b.text.trim();
      }
    } catch {}
  }
});
const exit = await new Promise((r) => { child.on('close', r); setTimeout(() => { child.kill('SIGKILL'); r(-1); }, 180000); });

console.log('  tool calls observed:', toolCalls.join(', ') || '(none)');
console.log('  final answer:', JSON.stringify(finalText));
ok('the worker called a tandemise-brokered tool', toolCalls.some((t) => t.includes('github_repo_view') || t.includes('repo_view')), toolCalls.join(','));
ok('the tool returned real data through the broker', /trunk/i.test(finalText), finalText);
const invocations = audit.entries();
ok('the invocation is in the audit trail', invocations.length > 0, invocations.map((r)=>`${r.toolName}:${r.decision}`).join(' '));
ok('it was policy-allowed, not bypassed', invocations.some((r) => r.decision === 'allow' && r.capability === 'github.read'));

await surface.dispose();
await supervisor.killAll?.('test over');
console.log(`\n${bad === 0 ? 'MCP GATEWAY END-TO-END OK — a real agent called a policy-gated Tandemise tool' : `${bad} FAILED`}`);
process.exit(bad === 0 ? 0 : 1);
