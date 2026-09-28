#!/usr/bin/env node
// P3b acceptance: evals, in the real window, on a brand-new installation.
//
//   npm run build && node scratch/acceptance/p3-evals/run-all.mjs [--keep-going] [--only=e1,e2] [--hold]
//
// Fresh TANDEMISE_HOME + project (p0/setup.mjs) behind /tmp/tdm-p3b, the daemon from this checkout's build
// with the scripted agent's eval knobs in its environment, the real desktop window with its own
// user-data-dir and CDP on 9338, then E1-E6 in order. Evidence (per-scenario JSON, screenshots, REPORT.md)
// goes to docs/superpowers/evidence/2026-09-27-p3b/, or $ACCEPTANCE_EVIDENCE_DIR.
//
// The daemon's environment reaches every run of the scripted agent (the generic CLI runtime passes it on):
//   SCRIPTED_FAIL_MODEL=bad  a run started with `--model bad` writes nothing, so its gate fails
//   SCRIPTED_COST_USD=0.25   every run reports a cost of $0.25
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshInstall, repoRoot } from './install.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const LINK = process.env.ACCEPTANCE_LINK ?? '/tmp/tdm-p3b';
const PORT = Number(process.env.CDP_PORT ?? 9338);
const EVIDENCE = resolve(process.env.ACCEPTANCE_EVIDENCE_DIR ?? join(repoRoot, 'docs/superpowers/evidence/2026-09-27-p3b'));
const log = (m) => console.log(`\n### ${m}`);

// Only this suite's own files: the folder also holds the evidence README, written by hand.
mkdirSync(EVIDENCE, { recursive: true });
for (const f of readdirSync(EVIDENCE)) if (/^E\d.*\.(json|png|txt)$/.test(f) || f === 'REPORT.md') rmSync(join(EVIDENCE, f));

log('setup');
const install = await freshInstall({
  link: LINK,
  port: PORT,
  prefix: 'tdm-p3b-run',
  daemonEnv: { SCRIPTED_DELAY_MS: '1500', SCRIPTED_FAIL_MODEL: 'bad', SCRIPTED_COST_USD: '0.25' },
});

const keepGoing = process.argv.includes('--keep-going');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');
const scenarios = ['e1-save-case.mjs', 'e2-models-candidate.mjs', 'e3-setup-candidate.mjs', 'e4-spend-cap.mjs', 'e5-from-your-runs.mjs', 'e6-cleanup.mjs']
  .filter((file) => !only || only.some((o) => file.startsWith(o)));

const results = () => readdirSync(EVIDENCE).filter((f) => /^E\d\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(EVIDENCE, f), 'utf8')));
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
  const id = `E${file[1]}`;
  if (code !== 0 && !existsSync(join(EVIDENCE, `${id}.json`))) {
    // A scenario that threw before saving still gets a line in the report.
    writeFileSync(join(EVIDENCE, `${id}.json`), JSON.stringify({ id, title: file, ok: false, checks: [{ label: `the scenario ran to the end (exit ${code})`, ok: false }], notes: [], shots: [] }, null, 2));
  }
  if (code !== 0 || results().some((e) => !e.ok)) { failed ??= file; if (!keepGoing) break; }
}

// ---------------------------------------------------------------- stop what this run started
// --hold leaves the window and daemon up for inspection; the next run cleans them up.
if (!process.argv.includes('--hold')) install.stop();

// ---------------------------------------------------------------- report
const all = results();
const order = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6'];
all.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const lines = [
  '# P3b acceptance report',
  '',
  `Run: ${new Date().toISOString()} · build ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim()} · fresh install at ${install.real}`,
  `Command: \`${['node scratch/acceptance/p3-evals/run-all.mjs', ...process.argv.slice(2)].join(' ')}\``,
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
