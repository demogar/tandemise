#!/usr/bin/env node
// Plan fit acceptance: a person's step shows what came in, and a step can say the plan no longer fits, in the real window, on a brand-new installation.
//
//   npm run build && node scratch/acceptance/plan-fit/run-all.mjs [--keep-going] [--only=f1] [--hold]
//
// Fresh TANDEMISE_HOME + project (p0/setup.mjs) behind /tmp/tdm-pf, the daemon from this checkout's
// build, the real desktop window with its own user-data-dir and CDP on 9341, then the F scenarios in order. Evidence (per-scenario JSON, screenshots,
// REPORT.md) goes to docs/superpowers/evidence/2026-10-03-plan-fit/, or $ACCEPTANCE_EVIDENCE_DIR.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const LINK = process.env.ACCEPTANCE_LINK ?? '/tmp/tdm-pf';
const PORT = Number(process.env.CDP_PORT ?? 9341);
const EVIDENCE = resolve(process.env.ACCEPTANCE_EVIDENCE_DIR ?? join(repoRoot, 'docs/superpowers/evidence/2026-10-03-plan-fit'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\n### ${m}`);

// ---------------------------------------------------------------- fresh install
try { execFileSync('pkill', ['-f', `user-data-dir=${LINK}/electron`]); } catch { /* none */ }
if (existsSync(`${LINK}/env.json`)) { try { process.kill(JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8')).pid); } catch { /* gone */ } }
await sleep(1500);
// Socket paths must stay under macOS's 104-byte limit, so the run lives behind a short symlink.
const real = join(process.env.ACCEPTANCE_REAL_DIR ?? tmpdir(), `tdm-pf-run-${Date.now().toString(36)}`);
mkdirSync(real, { recursive: true });
rmSync(LINK, { recursive: true, force: true });
symlinkSync(real, LINK);
// Only this suite's own files: the folder also holds the evidence README, written by hand.
mkdirSync(EVIDENCE, { recursive: true });
for (const f of readdirSync(EVIDENCE)) if (/^F\d.*\.(json|png|txt)$/.test(f) || f === 'REPORT.md') rmSync(join(EVIDENCE, f));

log('setup');
execFileSync(process.execPath, [join(here, '../p0/setup.mjs'), LINK], {
  env: {
    ...process.env,
    SCRIPTED_DELAY_MS: '1500',
    SCRIPTED_STATE_DIR: `${LINK}/scripted-state`,
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
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
const scenarios = ['f1-person-sees-what-came-in.mjs', 'f2-stop-then-skip.mjs', 'f3-stop-then-send-back.mjs', 'f4-stop-then-continue.mjs']
  .filter((file) => !only || only.some((o) => file.startsWith(o)));

const results = () => readdirSync(EVIDENCE).filter((f) => /^F\d\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(EVIDENCE, f), 'utf8')));
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
  const id = `F${file[1]}`;
  if (code !== 0 && !existsSync(join(EVIDENCE, `${id}.json`))) {
    // A scenario that threw before saving still gets a line in the report.
    writeFileSync(join(EVIDENCE, `${id}.json`), JSON.stringify({ id, title: file, ok: false, checks: [{ label: `the scenario ran to the end (exit ${code})`, ok: false }], notes: [], shots: [] }, null, 2));
  }
  if (code !== 0 || results().some((e) => !e.ok)) { failed ??= file; if (!keepGoing) break; }
}

// ---------------------------------------------------------------- stop what this run started
// --hold leaves the window and daemon up for inspection; the next run cleans them up.
if (!process.argv.includes('--hold')) {
  try { process.kill(-desktop.pid, 'SIGTERM'); } catch { /* gone */ }
  try { execFileSync('pkill', ['-f', `user-data-dir=${LINK}/electron`]); } catch { /* none */ }
  try { process.kill(JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8')).pid); } catch { /* gone */ }
}

// ---------------------------------------------------------------- report
const all = results();
const order = ['F1', 'F2', 'F3', 'F4'];
all.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const lines = [
  '# Plan fit acceptance report',
  '',
  `Run: ${new Date().toISOString()} · build ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim()} · fresh install at ${real}`,
  `Command: \`${['node scratch/acceptance/plan-fit/run-all.mjs', ...process.argv.slice(2)].join(' ')}\``,
  `Result: **${failed ? `${keepGoing ? 'FAILED at' : 'STOPPED at'} ${failed}` : all.every((r) => r.ok) ? 'ALL PASS' : 'FAILURES'}** (${all.filter((r) => r.ok).length}/${all.length} scenarios)`,
  '',
  '| Scenario | Result | Checks |',
  '|---|---|---|',
  ...all.map((r) => `| ${r.id} — ${r.title} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.checks.filter((c) => c.ok).length}/${r.checks.length} |`),
  '',
  ...all.flatMap((r) => [
    `## ${r.id} — ${r.title}`,
    '',
    ...r.notes.map((n) => `- note: ${n}`),
    ...r.checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.label}${c.observed === undefined ? '' : ` — \`${JSON.stringify(c.observed).slice(0, 300)}\``}`),
    ...r.shots.map((s) => `- screenshot: \`${s.split('/').slice(-1)[0]}\``),
    '',
  ]),
];
writeFileSync(join(EVIDENCE, 'REPORT.md'), lines.join('\n'));
console.log(`\n${lines.slice(0, 8 + all.length + 1).join('\n')}`);
process.exit(failed || !all.every((r) => r.ok) ? 1 : 0);
