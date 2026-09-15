#!/usr/bin/env node
// P0 acceptance: one uninterrupted run against a brand-new installation.
//
//   node scratch/acceptance/p0/run-all.mjs [--p1 | --p2] [--skip-claude] [--keep-going] [--only=c01,c04]
//
// Fresh TANDEMISE_HOME + project, daemon from this checkout's build, the real
// desktop window (its own user-data-dir, CDP on 9333), then every scenario in
// order. Stops at the first failing scenario. Writes evidence/REPORT.md.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const LINK = '/tmp/tdm-p0';
const skipClaude = process.argv.includes('--skip-claude');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\n### ${m}`);

// ---------------------------------------------------------------- fresh install
for (const pattern of [`user-data-dir=${LINK}/electron`]) { try { execFileSync('pkill', ['-f', pattern]); } catch { /* none */ } }
if (existsSync(`${LINK}/env.json`)) { try { process.kill(JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8')).pid); } catch { /* gone */ } }
await sleep(1500);
// Socket paths must stay under macOS's 104-byte limit, so the run lives behind a short symlink.
const real = join(process.env.ACCEPTANCE_REAL_DIR ?? tmpdir(), `tdm-p0-run-${Date.now().toString(36)}`);
mkdirSync(real, { recursive: true });
rmSync(LINK, { force: true });
symlinkSync(real, LINK);
rmSync(join(here, 'evidence'), { recursive: true, force: true });

const setup = (delay) => execFileSync(process.execPath, [join(here, 'setup.mjs'), LINK], { env: { ...process.env, SCRIPTED_DELAY_MS: String(delay) }, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const stopDaemon = async () => {
  const { pid } = JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8'));
  try { process.kill(pid); } catch { return; }
  for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); await sleep(250); } catch { return; } }
};

log('setup');
setup(1500);
// A window behind others stops painting, and a screenshot then never returns: keep it rendering while occluded.
const desktop = spawn('npx', ['electron-vite', 'dev', '--', '--remote-debugging-port=9333', `--user-data-dir=${LINK}/electron`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
  cwd: join(repoRoot, 'apps/desktop'),
  env: { ...process.env, TANDEMISE_HOME: `${LINK}/home` },
  stdio: ['ignore', 'ignore', 'ignore'],
  detached: true,
});
desktop.unref();

const P1 = process.argv.includes('--p1');
const P2 = process.argv.includes('--p2');
// Shakeout only: run every scenario even after one fails. A run meant as evidence leaves it off.
const keepGoing = process.argv.includes('--keep-going');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');
const scenarios = (P2 ? [
  ['../../p2/suite/c01-tweak-doc.mjs'],
  ['../../p2/suite/c02-dependents.mjs'],
  ['../../p2/suite/c03-review-request-changes.mjs'],
  ['../../p2/suite/c04-note-while-running.mjs'],
  ['../../p2/suite/c05-c06-notes-and-citations.mjs'],
  ['../../p2/suite/c07-ai-reviewer.mjs'],
  ['../../p2/suite/c08-person-step.mjs'],
  ['../../p2/suite/c09-decline.mjs'],
  ...(skipClaude ? [] : [['../../p2/suite/c10-real-claude.mjs']]),
  ['../../p2/suite/c11-code-round.mjs'],
  ['../../p2/suite/c12-retry-blocked.mjs'],
] : P1 ? [
  ['../../p1/suite/b01-solo-feed.mjs'],
  ['../../p1/suite/b02-needs-you-inline.mjs'],
  ['../../p1/suite/b04-budgets.mjs'],
  ['../../p1/suite/b13-plan-and-checks.mjs'],
  ...(skipClaude ? [] : [['../../p1/suite/b11-real-claude.mjs']]),
] : [
  ['s01-a1-solo.mjs'],
  ['s02-team.mjs'],
  ['s03-team-mission.mjs'],
  ['s04-escalation-signoff.mjs'],
  ['s05-midway.mjs', { daemonDelay: 20000 }],
  ...(skipClaude ? [] : [['s06-real-claude.mjs', { daemonDelay: 1500 }]]),
  ['s07-remove-person.mjs', { daemonDelay: 1500 }],
  ['s04b-pool-escalation.mjs'],
  ['s08-person-review-reassign.mjs'],
]).filter(([file]) => !only || only.some((o) => file.includes(o)));

let failed = null;
for (const [file, opts = {}] of scenarios) {
  if (opts.daemonDelay !== undefined) {
    log(`restart daemon (SCRIPTED_DELAY_MS=${opts.daemonDelay})`);
    await stopDaemon();
    setup(opts.daemonDelay);
    await sleep(4000); // the desktop reconnects to the new daemon by itself
  }
  log(file);
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, [join(here, 'suite', file)], { stdio: 'inherit', env: { ...process.env, ACCEPTANCE_SCRATCH: LINK } });
    child.on('close', done);
  });
  const evidence = readdirSync(join(here, 'evidence')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(here, 'evidence', f), 'utf8')));
  if (code !== 0 || evidence.some((e) => !e.ok)) { failed ??= file; if (!keepGoing) break; }
}

// ---------------------------------------------------------------- report
const results = readdirSync(join(here, 'evidence')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(here, 'evidence', f), 'utf8')));
const order = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'B1', 'B2', 'B3', 'B3a', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12', 'A1', 'TEAM', 'PLAN', 'A2', 'A4', 'A6', 'A8', 'A9a', 'A3', 'A7', 'A9b', 'A13', 'A5', 'A10', 'A12', 'A15', 'A11', 'A16', 'A17', 'A18'];
results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const lines = [
  `# ${P2 ? 'P2' : P1 ? 'P1' : 'P0'} acceptance report`,
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
    ...r.shots.map((s) => `- screenshot: \`${s.split('/').slice(-2).join('/')}\``),
    '',
  ]),
];
writeFileSync(join(here, 'evidence', 'REPORT.md'), lines.join('\n'));
console.log(`\n${lines.slice(0, 6 + results.length + 2).join('\n')}`);
process.exit(failed || !results.every((r) => r.ok) ? 1 : 0);
