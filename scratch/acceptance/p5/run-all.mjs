#!/usr/bin/env node
// P5 acceptance: the Done-when ledger, in the real window, on a brand-new installation.
//
//   node scratch/acceptance/p5/run-all.mjs [--keep-going] [--only=e01,e03]
//
// Fresh TANDEMISE_HOME + project (p0/setup.mjs), the daemon from this
// checkout's build, the real desktop window with its own user-data-dir and CDP
// on 9340, then E1-E5 in order. Writes p5/evidence/REPORT.md.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const LINK = '/tmp/tdm-p5';
const PORT = 9340;
const EVIDENCE = join(here, 'evidence');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\n### ${m}`);

// ---------------------------------------------------------------- fresh install
try { execFileSync('pkill', ['-f', `user-data-dir=${LINK}/electron`]); } catch { /* none */ }
if (existsSync(`${LINK}/env.json`)) { try { process.kill(JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8')).pid); } catch { /* gone */ } }
await sleep(1500);
// Socket paths must stay under macOS's 104-byte limit, so the run lives behind a short symlink.
const real = join(process.env.ACCEPTANCE_REAL_DIR ?? tmpdir(), `tdm-p5-run-${Date.now().toString(36)}`);
mkdirSync(real, { recursive: true });
rmSync(LINK, { force: true });
symlinkSync(real, LINK);
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

log('setup');
execFileSync(process.execPath, [join(here, '../p0/setup.mjs'), LINK], { env: { ...process.env, SCRIPTED_DELAY_MS: '1500' }, stdio: ['ignore', 'pipe', 'inherit'] });
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
const scenarios = ['e01-trace.mjs', 'e02-spec-misses.mjs', 'e03-qa-partial.mjs', 'e04-qa-fails.mjs', 'e05-spec-round.mjs']
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
const order = ['E1', 'E2', 'E3', 'E4', 'E5'];
results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const lines = [
  '# P5 acceptance report',
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
