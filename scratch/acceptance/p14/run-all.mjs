#!/usr/bin/env node
// P14 acceptance: GitHub issues in and out, in the real window, on a brand-new installation.
//
//   node scratch/acceptance/p14/run-all.mjs [--keep-going] [--only=o01,o03] [--hold]
//
// Fresh TANDEMISE_HOME + project (p0/setup.mjs) whose checkout gets a GitHub
// remote, the daemon from this checkout's build with a fake `gh` first on its
// PATH (scratch/fake-gh.mjs: issues and comments from a JSON file, every call
// recorded), the real desktop window with its own user-data-dir and CDP on
// 9349, then O1-O4 in order. Writes p14/evidence/REPORT.md.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { installFakeGh } from '../../fake-gh.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const LINK = process.env.ACCEPTANCE_LINK ?? '/tmp/tdm-p14';
const PORT = Number(process.env.CDP_PORT ?? 9349);
const EVIDENCE = join(here, 'evidence');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\n### ${m}`);

// ---------------------------------------------------------------- fresh install
try { execFileSync('pkill', ['-f', `user-data-dir=${LINK}/electron`]); } catch { /* none */ }
if (existsSync(`${LINK}/env.json`)) { try { process.kill(JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8')).pid); } catch { /* gone */ } }
await sleep(1500);
// Socket paths must stay under macOS's 104-byte limit, so the run lives behind a short symlink.
const real = join(process.env.ACCEPTANCE_REAL_DIR ?? tmpdir(), `tdm-p14-run-${Date.now().toString(36)}`);
mkdirSync(real, { recursive: true });
rmSync(LINK, { force: true });
symlinkSync(real, LINK);
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

// The fake GitHub: an empty repository example/hello-site; each scenario files its own issues.
const ghBin = installFakeGh(`${LINK}/gh`, { login: 'hello-site-bot' });

log('setup');
execFileSync(process.execPath, [join(here, '../p0/setup.mjs'), LINK], {
  env: { ...process.env, PATH: `${ghBin}:${process.env.PATH}`, SCRIPTED_DELAY_MS: '1200', SCRIPTED_STATE_DIR: `${LINK}/scripted-state` },
  stdio: ['ignore', 'pipe', 'inherit'],
});
// The project's checkout points at GitHub, as a real one would (the fake gh never reaches the network).
execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/hello-site.git'], { cwd: `${LINK}/project`, stdio: 'ignore' });
// A window behind others stops painting, and a screenshot then never returns: keep it rendering while occluded.
const desktop = spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${PORT}`, `--user-data-dir=${LINK}/electron`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
  cwd: join(repoRoot, 'apps/desktop'),
  env: { ...process.env, TANDEMISE_HOME: `${LINK}/home` },
  stdio: ['ignore', 'ignore', 'ignore'],
  detached: true,
});
desktop.unref();

const keepGoing = process.argv.includes('--keep-going');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');
// No real-model scenario: what reaches GitHub is decided by the daemon from the mission's state.
const scenarios = ['o01-labelled-issue.mjs', 'o02-needs-refinement.mjs', 'o03-complete-and-close.mjs', 'o04-dedupe-and-closed.mjs']
  .filter((file) => !only || only.some((o) => file.includes(o)));

let failed = null;
for (const file of scenarios) {
  log(file);
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, [join(here, 'suite', file)], {
      stdio: 'inherit',
      env: { ...process.env, ACCEPTANCE_SCRATCH: LINK, CDP_PORT: String(PORT), ACCEPTANCE_EVIDENCE_DIR: `${EVIDENCE}/` },
    });
    child.on('close', done);
  });
  const evidence = readdirSync(EVIDENCE).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(EVIDENCE, f), 'utf8')));
  if (code !== 0 || evidence.some((e) => !e.ok)) { failed ??= file; if (!keepGoing) break; }
}

// ---------------------------------------------------------------- stop what this run started
// --hold leaves the window and daemon up for inspection; the next run cleans them up.
if (!process.argv.includes('--hold')) try { process.kill(-desktop.pid, 'SIGTERM'); } catch { /* gone */ }
if (!process.argv.includes('--hold')) {
  try { execFileSync('pkill', ['-f', `user-data-dir=${LINK}/electron`]); } catch { /* none */ }
  try { process.kill(JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8')).pid); } catch { /* gone */ }
}

// ---------------------------------------------------------------- report
const results = readdirSync(EVIDENCE).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(EVIDENCE, f), 'utf8')));
const order = ['O1', 'O2', 'O3', 'O4'];
results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const lines = [
  '# P14 acceptance report',
  '',
  `Run: ${new Date().toISOString()} · build ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim()} · fresh install at ${real}`,
  `Result: **${failed ? `${keepGoing ? 'FAILED at' : 'STOPPED at'} ${failed}` : results.every((r) => r.ok) ? 'ALL PASS' : 'FAILURES'}** (${results.filter((r) => r.ok).length}/${results.length} scenarios)`,
  '',
  '| Scenario | Result | Checks |',
  '|---|---|---|',
  ...results.map((r) => `| ${r.id} — ${r.title} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.checks.filter((c) => c.ok).length}/${r.checks.length} |`),
  '',
  ...results.flatMap((r) => [
    `## ${r.id} — ${r.title}`,
    '',
    ...r.notes.map((n) => `- note: ${n}`),
    ...r.checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.label}${c.observed === undefined ? '' : ` — \`${JSON.stringify(c.observed).slice(0, 220)}\``}`),
    ...r.shots.map((s) => `- screenshot: \`${s.split('/').slice(-1)[0]}\``),
    '',
  ]),
];
writeFileSync(join(EVIDENCE, 'REPORT.md'), lines.join('\n'));
console.log(`\n${lines.slice(0, 6 + results.length + 2).join('\n')}`);
process.exit(failed || !results.every((r) => r.ok) ? 1 : 0);
