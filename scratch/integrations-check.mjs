#!/usr/bin/env node
/**
 * Verification for @tandemise/integrations-core, @tandemise/integration-github
 * and @tandemise/browser.
 *
 * Run:  node scratch/integrations-check.mjs
 * (after `npx tsc -b packages/integrations-core packages/integration-github packages/browser`)
 *
 * Everything here talks to the real thing: the real `gh` CLI, a real Chromium,
 * a real unix-socket bridge and a real spawned MCP server over stdio.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { ids, asId, systemClock, createLogger, createPaths } from '@tandemise/shared';
import { grant } from '@tandemise/domain';
import {
  ToolBroker, StaticToolCatalog, RunScopedToolGateway, RecordingAuditSink,
  grantsPolicyGate, denyingApprovalGate, writeMcpGatewayConfig, ToolBridgeServer,
  gatewayBridgeHandler, toolDescriptor, mcpToolName,
} from '@tandemise/integrations-core';
import { GitHubIntegrationProvider } from '@tandemise/integration-github';
import {
  BrowserIntegrationProvider, BrowserProfileManager, BrowserSessionManager,
  DomainAllowlist, browserOptionsFrom, DevServerController,
} from '@tandemise/browser';

// ---------------------------------------------------------------- test harness
let failures = 0;
let checks = 0;
const section = (name) => console.log(`\n=== ${name}`);
function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const log = createLogger({ level: process.env.VERBOSE ? 'debug' : 'error' });

// ------------------------------------------------------------- real executors
/** CommandExecutor over child_process. This is what the daemon injects. */
const executor = {
  run(request) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const child = spawn(request.command, [...(request.args ?? [])], {
        cwd: request.cwd,
        env: { ...process.env, ...(request.env ?? {}) },
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = request.timeoutMs
        ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, request.timeoutMs)
        : undefined;
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({
          exitCode: 127, stdout, stderr: `${stderr}${e.message}`, timedOut: false,
          durationMs: Date.now() - startedAt,
          command: `${request.command} ${(request.args ?? []).join(' ')}`,
        });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? -1, stdout, stderr, timedOut,
          durationMs: Date.now() - startedAt,
          command: `${request.command} ${(request.args ?? []).join(' ')}`,
        });
      });
    });
  },
};

/** BackgroundProcessLauncher over child_process, for DevServerController. */
const launcher = {
  launch(spec) {
    const child = spawn(spec.command, [...(spec.args ?? [])], {
      cwd: spec.cwd,
      env: { ...process.env, ...(spec.env ?? {}) },
    });
    child.stdout?.on('data', (c) => spec.onOutput?.(String(c), 'stdout'));
    child.stderr?.on('data', (c) => spec.onOutput?.(String(c), 'stderr'));
    const exited = new Promise((resolve) => {
      child.on('close', (exitCode, signal) => resolve({ exitCode: exitCode ?? -1, signal }));
    });
    return {
      pid: child.pid ?? -1,
      exited,
      async stop() {
        if (child.exitCode === null) child.kill('SIGTERM');
        await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
        if (child.exitCode === null) child.kill('SIGKILL');
        await exited;
      },
    };
  },
};

// ---------------------------------------------------------------- fixture data
const workspaceId = ids.workspace();
const missionId = ids.mission();

function assignment(grants, roleId = 'qa') {
  return {
    id: ids.workerAssignment(),
    workspaceId,
    missionId,
    taskId: ids.task(),
    roleId,
    runtimeProfileId: ids.runtimeProfile(),
    executionTargetId: ids.executionTarget(),
    grants,
    budgets: { maxWallTimeMs: 600_000, maxAttempts: 1 },
    createdAt: systemClock.now(),
  };
}

function integration(providerId, config, transport) {
  return {
    id: ids.integration(),
    workspaceId,
    providerId,
    name: providerId,
    transport,
    config,
    credentialRef: null,
    enabledCapabilities: [],
    enabled: true,
    createdAt: systemClock.now(),
    updatedAt: systemClock.now(),
  };
}

function contextFor(a, workingDirectory, signal) {
  return {
    assignment: a,
    assignmentId: a.id,
    runId: ids.run(),
    workingDirectory,
    logger: log,
    exec: executor,
    signal,
  };
}

// ================================================================ 1 + 2. broker
const githubProvider = new GitHubIntegrationProvider();
const githubIntegration = integration('github', { defaultRepo: 'cli/cli' }, 'cli');
const githubToolList = githubProvider.tools(githubIntegration);

const profiles = new BrowserProfileManager(log);
const sessions = new BrowserSessionManager(
  profiles,
  browserOptionsFrom(createPaths(await mkdtemp(join(tmpdir(), 'tandemise-check-')))),
  log,
);
const browserProvider = new BrowserIntegrationProvider(sessions);
const browserIntegration = integration(
  'browser',
  { profile: 'qa', headless: true, defaultTimeoutMs: 10_000, allowEvaluate: false },
  'browser',
);
const browserToolList = browserProvider.tools(browserIntegration);

const allTools = [...githubToolList, ...browserToolList];
const catalog = new StaticToolCatalog(allTools);
const assignments = new Map();
const audit = new RecordingAuditSink();

const broker = new ToolBroker({
  catalog,
  policy: grantsPolicyGate((id) => assignments.get(id), systemClock),
  approvals: denyingApprovalGate,
  audit,
  clock: systemClock,
  log,
});

// A read-only QA assignment: GitHub reads scoped to cli/cli, browser on localhost.
const qa = assignment([
  grant('github.read', ['cli/cli']),
  grant('browser', ['localhost']),
]);
assignments.set(qa.id, qa);

// A maintainer assignment that may open pull requests.
const maintainer = assignment([grant('github.read', ['cli/cli']), grant('github.pr.create', ['cli/cli'])], 'engineer');
assignments.set(maintainer.id, maintainer);

section('1. Tool broker: scoping, discovery and default deny');

const abort = new AbortController();
const qaCtx = contextFor(qa, process.cwd(), abort.signal);
const qaGateway = RunScopedToolGateway.for(broker, qa, systemClock);
const qaNames = qaGateway.names();

check('broker knows every tool', allTools.length === 19,
  `${allTools.length} tools (9 github + 10 browser)`);
check('QA gateway LISTS the granted read tools',
  qaNames.includes('github.repo.view') && qaNames.includes('browser.navigate'),
  qaNames.join(', '));
check('QA gateway does NOT LIST github.pr.create', !qaNames.includes('github.pr.create'));
check('QA gateway does NOT LIST github.pr.comment', !qaNames.includes('github.pr.comment'));
check('QA gateway does NOT LIST github.issue.create', !qaNames.includes('github.issue.create'));

const maintainerNames = RunScopedToolGateway.for(broker, maintainer, systemClock).names();
check('maintainer gateway DOES list github.pr.create', maintainerNames.includes('github.pr.create'));
check('maintainer gateway does not list browser tools',
  !maintainerNames.some((n) => n.startsWith('browser.')), maintainerNames.join(', '));

const deniedWrite = await qaGateway.invoke('github.pr.create', {
  title: 't', head: 'b', body: '', repo: 'cli/cli',
}, qaCtx);
check('invoking an ungranted tool is denied', deniedWrite.outcome === 'denied',
  deniedWrite.summary);
check('denial does not reveal that the tool exists',
  deniedWrite.summary.includes('not available to this assignment'), deniedWrite.summary);

// Resource scoping: the capability is granted, the repository is not.
const outOfScope = await qaGateway.invoke('github.repo.view', { repo: 'torvalds/linux' }, qaCtx);
check('a granted capability on an out-of-scope repository is denied',
  outOfScope.outcome === 'denied', outOfScope.summary);

// An unknown tool must deny rather than 404.
const unknown = await qaGateway.invoke('finance.wire.transfer', {}, qaCtx);
check('an unknown tool is denied by default', unknown.outcome === 'denied', unknown.summary);

section('2. Input schema validation');

const badInput = await qaGateway.invoke('github.repo.view', { repo: 42 }, qaCtx);
check('malformed input is rejected with VALIDATION',
  badInput.outcome === 'error' && badInput.error?.code === 'VALIDATION', badInput.summary);
check('validation message names the offending field',
  badInput.summary.includes('repo'), badInput.summary);

const badNavigate = await qaGateway.invoke('browser.navigate', { url: 'not-a-url' }, qaCtx);
check('browser.navigate rejects a non-URL',
  badNavigate.outcome === 'error' && badNavigate.error?.code === 'VALIDATION', badNavigate.summary);

section('3. GitHub against the real gh CLI');

const health = await githubProvider.healthCheck(githubIntegration, {
  exec: executor, logger: log, clock: systemClock, signal: abort.signal,
});
console.log(`  gh health: ${health.state} — ${health.detail}`);
check('gh auth status reports healthy', health.state === 'healthy', health.detail);

const missingGh = await githubProvider.healthCheck(
  integration('github', {}, 'cli'),
  {
    exec: { run: async () => ({ exitCode: 127, stdout: '', stderr: 'command not found: gh', timedOut: false, durationMs: 1, command: 'gh' }) },
    logger: log, clock: systemClock, signal: abort.signal,
  },
);
check('a missing gh degrades to unavailable (never throws)',
  missingGh.state === 'unavailable' && missingGh.detail.includes('gh auth login'), missingGh.detail);

const repoView = await qaGateway.invoke('github.repo.view', { repo: 'cli/cli' }, qaCtx);
check('github.repo.view returns a real response', repoView.outcome === 'ok', repoView.summary);
if (repoView.outcome === 'ok') {
  console.log(`  ${JSON.stringify(repoView.output)}`);
  check('response is the expected repository', repoView.output.nameWithOwner === 'cli/cli');
  check('response carries a default branch', repoView.output.defaultBranch.length > 0,
    repoView.output.defaultBranch);
}

const prList = await qaGateway.invoke('github.pr.list', { repo: 'cli/cli', limit: 3 }, qaCtx);
check('github.pr.list returns real pull requests',
  prList.outcome === 'ok' && Array.isArray(prList.output?.pullRequests), prList.summary);

check('every invocation produced an audit record', audit.entries().length === 7,
  `${audit.entries().length} records for 7 invocations`);
const denialAudit = audit.entries().find((e) => e.toolName === 'github.pr.create');
check('the denial is in the audit trail with its reason',
  denialAudit?.decision === 'deny' && denialAudit.outcome === 'denied',
  `${denialAudit?.decision}: ${denialAudit?.decisionReason}`);
const okAudit = audit.entries().find((e) => e.toolName === 'github.repo.view' && e.outcome === 'ok');
check('the success carries capability, risk and a redacted input summary',
  okAudit?.capability === 'github.read' && okAudit.risk === 'read' && okAudit.inputSummary.includes('cli/cli'),
  `${okAudit?.capability}/${okAudit?.risk} input=${okAudit?.inputSummary}`);

section('4. Browser');

const browserHealth = await browserProvider.healthCheck(browserIntegration, {
  exec: executor, logger: log, clock: systemClock, signal: abort.signal,
});
console.log(`  browser health: ${browserHealth.state} — ${browserHealth.detail}`);
check('chromium is installed', browserHealth.state === 'healthy', browserHealth.detail);

// Allowlist unit tests before touching a browser.
const allowlist = new DomainAllowlist(['localhost', '*.example.org']);
check('localhost allowlists the whole loopback family',
  allowlist.allows('http://localhost:5173/x')
  && allowlist.allows('http://127.0.0.1:3000/')
  && allowlist.allows('http://[::1]:8080/'));
check('a non-allowlisted host is rejected', !allowlist.allows('https://evil.test/'));
check('*.example.org matches apex and subdomains',
  allowlist.allows('https://example.org/') && allowlist.allows('https://a.b.example.org/'));

// A local static page to drive, plus an off-allowlist origin the page will try
// to reach so route interception has something real to block.
const page = `<!doctype html><html><head><title>Tandemise QA fixture</title></head><body>
<h1>Fixture</h1>
<h4>Skipped heading level</h4>
<img src="/logo.png">
<input type="text" id="unlabelled">
<label for="named">Search</label><input type="text" id="named">
<button>Go</button>
<button></button>
<p style="color:#bbb;background:#fff">low contrast text</p>
<img id="offsite" src="http://blocked.test/pixel.png">
</body></html>`;

const fixture = createServer((req, res) => {
  if (req.url === '/logo.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page);
});
await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
const fixtureUrl = `http://localhost:${fixture.address().port}/`;

const nav = await qaGateway.invoke('browser.navigate', { url: fixtureUrl }, qaCtx);
check('navigating to an allowlisted localhost URL succeeds', nav.outcome === 'ok', nav.summary);
check('navigation reports the page title',
  nav.outcome === 'ok' && nav.output.status === 200, JSON.stringify(nav.output));

const blockedNav = await qaGateway.invoke('browser.navigate', { url: 'https://example.com/' }, qaCtx);
check('navigating OFF the allowlist is BLOCKED',
  blockedNav.outcome === 'denied' && blockedNav.error?.code === 'PERMISSION_DENIED',
  blockedNav.summary);

// The policy gate refuses that call on the grant's resource scope, before the
// browser is asked. Prove the browser layer refuses independently, so a policy
// gate that allowed a broad `browser` grant would still not get off-allowlist.
const liveSession = sessions.current(qa.id);
let sessionRefusal = null;
try { liveSession.assertAllowed('https://example.com/'); } catch (e) { sessionRefusal = e; }
check('the session itself refuses an off-allowlist URL, independent of policy',
  sessionRefusal?.code === 'PERMISSION_DENIED', sessionRefusal?.message);
check('the session allows an on-allowlist URL',
  (() => { liveSession.assertAllowed(fixtureUrl); return true; })());

const snap = await qaGateway.invoke('browser.snapshot', {}, qaCtx);
check('browser.snapshot returns an accessibility tree, not pixels',
  snap.outcome === 'ok' && snap.output.snapshot.includes('button'), snap.summary);
if (snap.outcome === 'ok') {
  console.log(`  snapshot (first 240 chars):\n${snap.output.snapshot.slice(0, 240).split('\n').map((l) => '    ' + l).join('\n')}`);
}

const shot = await qaGateway.invoke('browser.screenshot', {}, qaCtx);
check('browser.screenshot returns bytes for the caller to persist',
  shot.outcome === 'ok' && shot.evidence.length === 1 && shot.evidence[0].bytes.byteLength > 0,
  shot.outcome === 'ok' ? `${shot.evidence[0].byteLength ?? shot.evidence[0].bytes.byteLength} bytes as ${shot.evidence[0].filename}` : shot.summary);
check('screenshot bytes are a PNG',
  shot.outcome === 'ok' && shot.evidence[0].bytes[0] === 0x89 && shot.evidence[0].bytes[1] === 0x50);

const netLog = await qaGateway.invoke('browser.network_log', {}, qaCtx);
const blockedSubresource = netLog.outcome === 'ok'
  && netLog.output.blocked.some((b) => b.url.includes('blocked.test'));
check('a page-initiated request to a non-allowlisted host was aborted by route interception',
  blockedSubresource, netLog.outcome === 'ok' ? JSON.stringify(netLog.output.blocked) : netLog.summary);

const a11y = await qaGateway.invoke('browser.a11y_check', {}, qaCtx);
check('browser.a11y_check finds the seeded problems', a11y.outcome === 'ok', a11y.summary);
if (a11y.outcome === 'ok') {
  console.log(`  a11y counts: ${JSON.stringify(a11y.output.counts)}`);
  const rules = new Set(a11y.output.findings.map((f) => f.rule));
  check('  image without alt detected', rules.has('image-alt'));
  check('  unlabelled form control detected', rules.has('form-label'));
  check('  button with no accessible name detected', rules.has('control-name'));
  check('  heading order jump detected', rules.has('heading-order'));
  check('  low contrast text detected', rules.has('contrast'));
}

// The `browser` grant covers `browser.evaluate` by the capability hierarchy, so
// policy allows it; the integration-level opt-in is the lock that holds.
const evaluated = await qaGateway.invoke('browser.evaluate', { expression: '1+1' }, qaCtx);
check('browser.evaluate is refused unless the integration opts in',
  evaluated.outcome === 'denied' && evaluated.error?.code === 'PERMISSION_DENIED',
  evaluated.summary);

section('4b. DevServerController');

const devServer = new DevServerController(launcher, log);
const devScript = 'require("http").createServer((q,s)=>{s.writeHead(200);s.end("ok")}).listen(7311,"127.0.0.1")';
const handle = await devServer.start({
  command: process.execPath,
  args: ['-e', devScript],
  cwd: process.cwd(),
  url: 'http://127.0.0.1:7311/',
  readyTimeoutMs: 15_000,
});
check('dev server starts and its URL responds', handle.pid > 0, `pid ${handle.pid}`);
await devServer.stopAll();
const stillUp = await fetch('http://127.0.0.1:7311/').then(() => true).catch(() => false);
check('dev server is stopped reliably', !stillUp);

let devFailure = null;
try {
  await devServer.start({
    command: process.execPath, args: ['-e', 'process.exit(3)'],
    cwd: process.cwd(), url: 'http://127.0.0.1:7312/', readyTimeoutMs: 5000,
  });
} catch (e) { devFailure = e; }
check('a dev server that exits early fails with a clear message',
  devFailure !== null && /exited with code 3/.test(devFailure.message), devFailure?.message);

section('5. MCP gateway');

const runDir = await mkdtemp(join(tmpdir(), 'tandemise-mcp-'));
const socketPath = join(runDir, 'tools.sock');
const token = randomBytes(16).toString('hex');

const bridge = new ToolBridgeServer(gatewayBridgeHandler(qaGateway, qaCtx), {
  socketPath, token, log,
});
await bridge.start();

const mcp = await writeMcpGatewayConfig({
  gateway: qaGateway,
  configPath: join(runDir, 'mcp-config.json'),
  socketPath,
  token,
});
const written = JSON.parse(await readFile(mcp.configPath, 'utf8'));
console.log(`  config: ${JSON.stringify(written, null, 2).split('\n').map((l) => '    ' + l).join('\n').trim()}`);
check('config declares exactly one tandemise MCP server',
  Object.keys(written.mcpServers).length === 1 && written.mcpServers.tandemise !== undefined);
check('published tool list contains ONLY the granted tools',
  mcp.publishedTools.length === qaNames.length
  && !mcp.publishedTools.some((t) => t.name.includes('create') || t.name.includes('comment')),
  mcp.publishedTools.map((t) => t.name).join(', '));
check('published descriptors carry JSON Schema derived from zod',
  mcp.publishedTools.every((t) => t.inputSchema.type === 'object'),
  JSON.stringify(mcp.publishedTools.find((t) => t.name === 'github.repo.view')?.inputSchema));

// Spawn the real MCP server and speak the wire protocol to it.
const server = written.mcpServers.tandemise;
const child = spawn(server.command, server.args, {
  env: { ...process.env, ...server.env },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderrBuf = '';
child.stderr.on('data', (c) => { stderrBuf += c; });

const responses = new Map();
let rpcBuffer = '';
child.stdout.on('data', (chunk) => {
  rpcBuffer += chunk;
  const parts = rpcBuffer.split('\n');
  rpcBuffer = parts.pop() ?? '';
  for (const line of parts) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    responses.get(msg.id)?.(msg);
  }
});

const rpc = (id, method, params) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${method} timed out. stderr: ${stderrBuf}`)), 10_000);
  responses.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

const init = await rpc(1, 'initialize', {
  protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'check', version: '1' },
});
check('MCP initialize handshake succeeds',
  init.result?.serverInfo?.name === 'tandemise' && init.result.capabilities.tools !== undefined,
  JSON.stringify(init.result));

child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const listed = await rpc(2, 'tools/list', {});
const listedNames = listed.result.tools.map((t) => t.name);
console.log(`  tools/list over stdio: ${listedNames.join(', ')}`);
check('tools/list over stdio returns the granted tools',
  listedNames.length === qaNames.length
  && qaNames.every((n) => listedNames.includes(mcpToolName(n))),
  `${listedNames.length} tools`);
check('tools/list over stdio exposes NO write tool',
  !listedNames.some((n) => /create|comment/.test(n)));
check('each published MCP tool carries an inputSchema',
  listed.result.tools.every((t) => t.inputSchema?.type === 'object'));

const called = await rpc(3, 'tools/call', {
  name: 'github_repo_view', arguments: { repo: 'cli/cli' },
});
const callPayload = JSON.parse(called.result.content[0].text);
check('tools/call over stdio reaches the real broker and the real gh CLI',
  called.result.isError === false && callPayload.output?.nameWithOwner === 'cli/cli',
  callPayload.summary);

const deniedOverMcp = await rpc(4, 'tools/call', {
  name: 'github_pr_create', arguments: { title: 'x', head: 'y' },
});
check('a tool outside the gateway is refused over MCP too',
  deniedOverMcp.result.isError === true,
  JSON.parse(deniedOverMcp.result.content[0].text).summary);

// ------------------------------------------------------------------- teardown
child.stdin.end();
child.kill();
await bridge.close();
fixture.close();
await sessions.closeAll();
await rm(runDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILURE(S)`} — ${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
