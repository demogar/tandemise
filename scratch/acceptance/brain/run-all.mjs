#!/usr/bin/env node
// The brain (#51) acceptance: B1-B9 in two real windows, on two brand-new installations that share one brain.
//
//   node scratch/acceptance/brain/run-all.mjs [--keep-going] [--only=b01,b03] [--hold]
//
// Two fresh TANDEMISE_HOMEs (p0/setup.mjs), each with the daemon from this checkout's build and its own
// desktop window over CDP (home 1 on 9363, home 2 on 9364). Both daemons get a fake `gh` first on PATH and a
// git config (GIT_CONFIG_GLOBAL) that turns https://github.com/ into local bare repositories under the run, so
// nothing reaches the network. Both run with TANDEMISE_TEST_ROUTES=1, which enables the daemon's
// test-only routes (B4 stands in for a hold through POST /v1/test/events until #50 lands). A Generic CLI "Brain
// agent" answers the reflector and promoter and hands every other prompt to the P0 scripted agent.
// Writes evidence to docs/superpowers/evidence/2026-10-30-brain/.
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const LINK1 = process.env.ACCEPTANCE_LINK ?? '/tmp/tdm-brain';
const LINK2 = `${LINK1}2`;
const PORT1 = Number(process.env.CDP_PORT ?? 9363);
const PORT2 = PORT1 + 1;
const EVIDENCE = join(repoRoot, 'docs/superpowers/evidence/2026-10-30-brain');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\n### ${m}`);

// ---------------------------------------------------------------- fresh installs
for (const link of [LINK1, LINK2]) {
  try { execFileSync('pkill', ['-f', `user-data-dir=${link}/electron`]); } catch { /* none */ }
  if (existsSync(`${link}/env.json`)) { try { process.kill(JSON.parse(readFileSync(`${link}/env.json`, 'utf8')).pid); } catch { /* gone */ } }
}
await sleep(1500);
const stamp = Date.now().toString(36);
for (const [link, n] of [[LINK1, 1], [LINK2, 2]]) {
  const real = join(process.env.ACCEPTANCE_REAL_DIR ?? tmpdir(), `tdm-brain${n}-run-${stamp}`);
  mkdirSync(real, { recursive: true });
  rmSync(link, { force: true });
  symlinkSync(real, link);
}
mkdirSync(EVIDENCE, { recursive: true });
for (const f of readdirSync(EVIDENCE)) if (/^B\d.*\.(json|png)$/.test(f)) rmSync(join(EVIDENCE, f));

// The fake gh and the git config both daemons share.
const fake = { bin: `${LINK1}/bin`, log: `${LINK1}/gh-log.jsonl`, state: `${LINK1}/gh-state`, remotes: `${LINK1}/remotes`, gitconfig: `${LINK1}/gitconfig` };
mkdirSync(fake.bin, { recursive: true });
mkdirSync(fake.remotes, { recursive: true });
writeFileSync(join(fake.bin, 'gh'), `#!/bin/sh\nFAKE_GH_LOG='${fake.log}' FAKE_GH_STATE='${fake.state}' FAKE_GH_REMOTES='${fake.remotes}' exec '${process.execPath}' '${join(repoRoot, 'scratch/brain-fixtures/fake-gh.mjs')}' "$@"\n`);
chmodSync(join(fake.bin, 'gh'), 0o755);
writeFileSync(fake.gitconfig, `[url "file://${fake.remotes}/"]\n\tinsteadOf = https://github.com/\n[protocol "file"]\n\tallow = always\n[user]\n\tname = Acceptance\n\temail = acceptance@example.invalid\n[init]\n\tdefaultBranch = main\n`);
const daemonEnv = { ...process.env, PATH: `${fake.bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: fake.gitconfig, TANDEMISE_TEST_ROUTES: '1' };
writeFileSync(`${LINK1}/brain-acceptance.json`, JSON.stringify({ ...fake, link2: LINK2, port2: PORT2 }, null, 2));

log('setup');
for (const link of [LINK1, LINK2]) {
  execFileSync(process.execPath, [join(here, '../p0/setup.mjs'), link], {
    env: { ...daemonEnv, SCRIPTED_DELAY_MS: '300', SCRIPTED_STATE_DIR: `${link}/scripted-state` },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // The Brain agent, routed to the roles the brain's passes and these missions use.
  const env = JSON.parse(readFileSync(`${link}/env.json`, 'utf8'));
  const api = async (method, path, body) => {
    const res = await fetch(`${env.url}${path}`, { method, headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  const agent = await api('POST', '/v1/runtimes', {
    adapterId: 'generic-cli', name: 'Brain agent', workspaceId: null, maxConcurrent: 4, enabled: true,
    settings: { command: process.execPath, args: [join(here, 'brain-agent.mjs')], promptVia: 'stdin', outputFormat: 'text', capabilities: ['reasoning', 'tool_calling', 'shell', 'git', 'filesystem', 'mcp'] },
  });
  const agentId = agent.profile?.id ?? agent.id;
  await api('PATCH', `/v1/workspaces/${env.workspaceId}`, { routing: { development: [agentId], architecture: [agentId], review: [agentId], qa: [agentId], product: [agentId] } });
  writeFileSync(`${link}/env.json`, JSON.stringify({ ...env, brainAgentId: agentId }, null, 2));
}

const windows = [];
for (const [link, port] of [[LINK1, PORT1], [LINK2, PORT2]]) {
  const desktop = spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${port}`, `--user-data-dir=${link}/electron`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
    cwd: join(repoRoot, 'apps/desktop'),
    env: { ...daemonEnv, TANDEMISE_HOME: `${link}/home` },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  desktop.unref();
  windows.push(desktop);
  // Two electron-vite dev servers starting at once fight over the renderer port; let the first settle.
  await sleep(8000);
}

const keepGoing = process.argv.includes('--keep-going');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');
const scenarios = ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09']
  .map((id) => readdirSync(join(here, 'suite')).find((f) => f.startsWith(id)))
  .filter((file) => file !== undefined && (!only || only.some((o) => file.includes(o))));

let failed = null;
for (const file of scenarios) {
  log(file);
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, [join(here, 'suite', file)], {
      stdio: 'inherit',
      env: { ...daemonEnv, ACCEPTANCE_SCRATCH: LINK1, CDP_PORT: String(PORT1), ACCEPTANCE_EVIDENCE_DIR: `${EVIDENCE}/` },
    });
    child.on('close', done);
  });
  const evidence = readdirSync(EVIDENCE).filter((f) => /^B\d.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(EVIDENCE, f), 'utf8')));
  if (code !== 0 || evidence.some((e) => !e.ok)) { failed ??= file; if (!keepGoing) break; }
}

if (!process.argv.includes('--hold')) {
  for (const w of windows) try { process.kill(-w.pid, 'SIGTERM'); } catch { /* gone */ }
  for (const link of [LINK1, LINK2]) {
    try { execFileSync('pkill', ['-f', `user-data-dir=${link}/electron`]); } catch { /* none */ }
    try { process.kill(JSON.parse(readFileSync(`${link}/env.json`, 'utf8')).pid); } catch { /* gone */ }
  }
}

// ---------------------------------------------------------------- report
const results = readdirSync(EVIDENCE).filter((f) => /^B\d.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(EVIDENCE, f), 'utf8')));
results.sort((a, b) => a.id.localeCompare(b.id));
const lines = [
  '# Brain (#51) acceptance report',
  '',
  `Run: ${new Date().toISOString()} · build ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim()} · two fresh installs at ${LINK1} and ${LINK2}`,
  `Result: **${failed ? `${keepGoing ? 'FAILED at' : 'STOPPED at'} ${failed}` : results.every((r) => r.ok) && results.length === 9 ? 'ALL PASS' : 'FAILURES'}** (${results.filter((r) => r.ok).length}/${results.length} scenarios)`,
  '',
  '| Scenario | Result | Checks |',
  '|---|---|---|',
  ...results.map((r) => `| ${r.id} — ${r.title} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.checks.filter((c) => c.ok).length}/${r.checks.length} |`),
  '',
  ...results.flatMap((r) => [
    `## ${r.id} — ${r.title}`,
    '',
    ...r.notes.map((n) => `- note: ${n}`),
    ...r.checks.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} ${c.label}${c.observed === undefined ? '' : ` — \`${JSON.stringify(c.observed).slice(0, 220)}\``}`),
    ...r.shots.map((s) => `- screenshot: \`${s.split('/').slice(-1)[0]}\``),
    '',
  ]),
];
writeFileSync(join(EVIDENCE, 'REPORT.md'), lines.join('\n'));
console.log(`\n${lines.slice(0, 6 + results.length + 2).join('\n')}`);
process.exit(failed || !results.every((r) => r.ok) ? 1 : 0);
