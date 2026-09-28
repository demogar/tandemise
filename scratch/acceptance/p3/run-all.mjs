#!/usr/bin/env node
// P3a acceptance: handing work in and back, in the real window, on a brand-new installation.
//
//   npm run build && node scratch/acceptance/p3/run-all.mjs [--keep-going] [--only=d1,d3] [--hold]
//
// Fresh TANDEMISE_HOME + project (p0/setup.mjs) behind /tmp/tdm-p3, the daemon from this checkout's
// build with a fake `gh` first on its PATH (fake-gh.mjs, see README.md), the real desktop window with
// its own user-data-dir and CDP on 9337, then D1-D8 in order. Evidence (per-scenario JSON, screenshots,
// REPORT.md) goes to docs/superpowers/evidence/2026-09-27-p3a/, or $ACCEPTANCE_EVIDENCE_DIR.
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const LINK = process.env.ACCEPTANCE_LINK ?? '/tmp/tdm-p3';
const PORT = Number(process.env.CDP_PORT ?? 9337);
const EVIDENCE = resolve(process.env.ACCEPTANCE_EVIDENCE_DIR ?? join(repoRoot, 'docs/superpowers/evidence/2026-09-27-p3a'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\n### ${m}`);

// ---------------------------------------------------------------- fresh install
try { execFileSync('pkill', ['-f', `user-data-dir=${LINK}/electron`]); } catch { /* none */ }
if (existsSync(`${LINK}/env.json`)) { try { process.kill(JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8')).pid); } catch { /* gone */ } }
await sleep(1500);
// Socket paths must stay under macOS's 104-byte limit, so the run lives behind a short symlink.
const real = join(process.env.ACCEPTANCE_REAL_DIR ?? tmpdir(), `tdm-p3-run-${Date.now().toString(36)}`);
mkdirSync(real, { recursive: true });
rmSync(LINK, { recursive: true, force: true });
symlinkSync(real, LINK);
// Only this suite's own files: the folder also holds the evidence README, written by hand.
mkdirSync(EVIDENCE, { recursive: true });
for (const f of readdirSync(EVIDENCE)) if (/^D\d.*\.(json|png|txt)$/.test(f) || f === 'REPORT.md') rmSync(join(EVIDENCE, f));

// The fake gh, first on the daemon's PATH. A shell wrapper with node's absolute path, because the
// daemon's PATH is not guaranteed to find the node that runs this suite.
mkdirSync(`${LINK}/bin`, { recursive: true });
// The state file is named here too: the daemon runs tools with an allowlisted environment (PATH, HOME, …).
writeFileSync(`${LINK}/bin/gh`, `#!/bin/sh\nFAKE_GH_STATE="${LINK}/gh-pr.json" exec "${process.execPath}" "${join(here, 'fake-gh.mjs')}" "$@"\n`);
chmodSync(`${LINK}/bin/gh`, 0o755);

log('setup');
execFileSync(process.execPath, [join(here, '../p0/setup.mjs'), LINK], {
  env: {
    ...process.env,
    PATH: `${LINK}/bin:${process.env.PATH ?? ''}`,
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
const scenarios = ['d1-upload-covers-spec.mjs', 'd2-continue-elsewhere.mjs', 'd3-hand-back-pr.mjs', 'd4-unreadable-link.mjs',
  'd5-held-until-hand-back.mjs', 'd6-workspace-link.mjs', 'd7-attribution.mjs', 'd8-feedback-file.mjs']
  .filter((file) => !only || only.some((o) => file.startsWith(o)));

const results = () => readdirSync(EVIDENCE).filter((f) => /^D\d\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(EVIDENCE, f), 'utf8')));
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
  const id = `D${file[1]}`;
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
const order = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'];
all.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const lines = [
  '# P3a acceptance report',
  '',
  `Run: ${new Date().toISOString()} · build ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim()} · fresh install at ${real}`,
  `Command: \`${['node scratch/acceptance/p3/run-all.mjs', ...process.argv.slice(2)].join(' ')}\``,
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
