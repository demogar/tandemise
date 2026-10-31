#!/usr/bin/env node
// Relay acceptance (docs/superpowers/specs/2026-10-30-relay-design.md, §Acceptance, "Real app"), in real windows,
// on brand-new installations.
//
//   node scratch/acceptance/relay/run-all.mjs [--keep-going] [--only=r01,r03] [--hold]
//
// Window A: a fresh TANDEMISE_HOME + project (p0/setup.mjs), its daemon from this checkout's build, the real
// desktop with its own user-data-dir and CDP on 9351. From r02 on, window B the same way (CDP 9352, its own
// home and daemon) and one relay from apps/relay/dist on a free loopback port, with the test clock knob on.
// Evidence and REPORT.md go to docs/superpowers/evidence/2026-10-30-relay/.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const LINK_A = process.env.ACCEPTANCE_LINK ?? '/tmp/tdm-relay';
const LINK_B = process.env.ACCEPTANCE_LINK_B ?? '/tmp/tdm-relay-b';
const PORT_A = Number(process.env.CDP_PORT ?? 9351);
const PORT_B = Number(process.env.CDP_PORT_B ?? 9352);
const EVIDENCE = join(repoRoot, 'docs/superpowers/evidence/2026-10-30-relay');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\n### ${m}`);

const keepGoing = process.argv.includes('--keep-going');
const hold = process.argv.includes('--hold');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');
const ALL = ['r01-solo.mjs', 'r02-connect.mjs', 'r03-invite.mjs', 'r04-live-claims.mjs', 'r05-take-over.mjs', 'r06-offline.mjs'];
const scenarios = ALL.filter((file) => existsSync(join(here, 'suite', file)) && (!only || only.some((o) => file.startsWith(o))));
const needsTeam = scenarios.some((f) => !f.startsWith('r01'));

// ---------------------------------------------------------------- fresh installs
for (const link of [LINK_A, LINK_B]) {
  try { execFileSync('pkill', ['-f', `user-data-dir=${link}/electron`]); } catch { /* none */ }
  if (existsSync(`${link}/env.json`)) { try { process.kill(JSON.parse(readFileSync(`${link}/env.json`, 'utf8')).pid); } catch { /* gone */ } }
  if (existsSync(`${link}/relay.json`)) { try { process.kill(JSON.parse(readFileSync(`${link}/relay.json`, 'utf8')).pid); } catch { /* gone */ } }
}
await sleep(1500);
mkdirSync(EVIDENCE, { recursive: true });
for (const f of readdirSync(EVIDENCE)) if (/^R\d.*\.(png|json)$/.test(f)) unlinkSync(join(EVIDENCE, f));

const desktops = [];
function install(link, port) {
  const real = join(process.env.ACCEPTANCE_REAL_DIR ?? tmpdir(), `${link.split('/').pop()}-run-${Date.now().toString(36)}`);
  mkdirSync(real, { recursive: true });
  rmSync(link, { force: true });
  symlinkSync(real, link);
  log(`setup ${link}`);
  execFileSync(process.execPath, [join(repoRoot, 'scratch/acceptance/p0/setup.mjs'), link], {
    env: { ...process.env, SCRIPTED_DELAY_MS: '800', TANDEMISE_TICK_MS: '500' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const desktop = spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${port}`, `--user-data-dir=${link}/electron`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
    cwd: join(repoRoot, 'apps/desktop'),
    env: { ...process.env, TANDEMISE_HOME: `${link}/home` },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  desktop.unref();
  desktops.push(desktop);
  return real;
}

const freePort = () => new Promise((done) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });

/** Starts the relay from this checkout's build on a fixed loopback port; restartable on the same DB and port. */
export async function startRelay(port, db) {
  const out = openSync(`${LINK_A}/relay.log`, 'a');
  const child = spawn(process.execPath, [join(repoRoot, 'apps/relay/dist/main.js')], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, RELAY_HOST: '127.0.0.1', RELAY_PORT: String(port), RELAY_DB: db, RELAY_PUBLIC_URL: `http://127.0.0.1:${port}`, RELAY_TEST_CLOCK: '1', RELAY_TEAM_NAME: 'Acceptance team' },
  });
  child.unref();
  return child.pid;
}

const realA = install(LINK_A, PORT_A);
let realB = null;
if (needsTeam) {
  realB = install(LINK_B, PORT_B);
  const port = await freePort();
  const db = `${LINK_A}/relay.db`;
  const pid = await startRelay(port, db);
  // The first start prints the admin invite once; the scenarios read it from the log.
  const deadline = Date.now() + 15_000;
  let invite = null;
  while (Date.now() < deadline && invite === null) {
    await sleep(300);
    invite = /Admin invite: (TRI-[0-9A-Z-]+)/.exec(existsSync(`${LINK_A}/relay.log`) ? readFileSync(`${LINK_A}/relay.log`, 'utf8') : '')?.[1] ?? null;
  }
  if (invite === null) throw new Error(`relay did not print an admin invite; see ${LINK_A}/relay.log`);
  writeFileSync(`${LINK_A}/relay.json`, JSON.stringify({ pid, port, db, url: `http://127.0.0.1:${port}`, invite }, null, 2));
}

let failed = null;
for (const file of scenarios) {
  log(file);
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, [join(here, 'suite', file)], {
      stdio: 'inherit',
      env: {
        ...process.env, ACCEPTANCE_SCRATCH: LINK_A, ACCEPTANCE_SCRATCH_B: LINK_B, CDP_PORT: String(PORT_A), CDP_PORT_B: String(PORT_B),
        ACCEPTANCE_EVIDENCE_DIR: `${EVIDENCE}/`, RELAY_RUN_ALL: join(here, 'run-all.mjs'),
      },
    });
    child.on('close', done);
  });
  const evidence = readdirSync(EVIDENCE).filter((f) => /^R\d.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(EVIDENCE, f), 'utf8')));
  if (code !== 0 || evidence.some((e) => !e.ok)) { failed ??= file; if (!keepGoing) break; }
}

// ---------------------------------------------------------------- stop what this run started
if (!hold) {
  for (const d of desktops) { try { process.kill(-d.pid, 'SIGTERM'); } catch { /* gone */ } }
  for (const link of [LINK_A, LINK_B]) {
    try { execFileSync('pkill', ['-f', `user-data-dir=${link}/electron`]); } catch { /* none */ }
    try { process.kill(JSON.parse(readFileSync(`${link}/env.json`, 'utf8')).pid); } catch { /* gone */ }
    try { process.kill(JSON.parse(readFileSync(`${link}/relay.json`, 'utf8')).pid); } catch { /* gone */ }
  }
}

// ---------------------------------------------------------------- report
const results = readdirSync(EVIDENCE).filter((f) => /^R\d.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(EVIDENCE, f), 'utf8')));
results.sort((x, y) => x.id.localeCompare(y.id));
const lines = [
  '# Relay acceptance report',
  '',
  `Run: ${new Date().toISOString()} · build ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim()} · fresh installs at ${realA}${realB ? ` and ${realB}` : ''}`,
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
    ...r.shots.map((s) => `- screenshot: [${s.split('/').slice(-1)[0]}](${s.split('/').slice(-1)[0]})`),
    '',
  ]),
];
writeFileSync(join(EVIDENCE, 'REPORT.md'), lines.join('\n'));
console.log(`\n${lines.slice(0, 6 + results.length + 2).join('\n')}`);
process.exit(failed || !results.every((r) => r.ok) ? 1 : 0);
