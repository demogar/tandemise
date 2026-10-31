// What an updated desktop needs from a daemon left running by the old install
// (issue #58): the daemon says which release it is, in its handshake file and
// its health response, and it can be asked to stop cleanly over HTTP - the one
// way that works on Windows too.
//
// The desktop's half (packaged app + different version -> stop it, start the
// bundled one) is the pure `daemonNeedsReplacing` in daemon-node-check, and in
// the real app scratch/packaged-live-check.mjs --simulate-upgrade.
//
//   npm run build && node scratch/daemon-upgrade-check.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 500)}`}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const poll = async (fn, ms) => { for (const until = Date.now() + ms; Date.now() < until; await sleep(150)) { const v = await fn(); if (v) return v; } return undefined; };

const home = mkdtempSync(join(tmpdir(), 'tdm-upgrade-'));
const daemon = spawn(process.execPath, [join(root, 'apps/daemon/dist/main.js')], {
  cwd: root, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  env: { ...process.env, TANDEMISE_HOME: home, TANDEMISE_OFFLINE: '1', TANDEMISE_LOG_LEVEL: 'error', TANDEMISE_VERSION: '0.8.0' },
});
let stderr = '';
daemon.stderr.on('data', (d) => { stderr += d; });
let exitCode = null;
daemon.on('exit', (code) => { exitCode = code; });
process.on('exit', () => { try { daemon.kill('SIGKILL'); } catch {} rmSync(home, { recursive: true, force: true }); });

const file = join(home, 'daemon.json');
await poll(() => existsSync(file), 30_000);
const conn = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
if (conn === null) { console.error(`daemon did not start:\n${stderr}`); process.exit(1); }

console.log('\n== the daemon says which release it is');
check('daemon.json names its version (here the TANDEMISE_VERSION knob)', conn.version === '0.8.0', conn);
check('daemon.json names its build commit', typeof conn.build === 'string' && conn.build.length > 0, conn.build);
const health = await (await fetch(`${conn.url}/v1/health`)).json();
check('health names the same version and build', health.ok === true && health.version === '0.8.0' && health.build === conn.build, health);

console.log('\n== it stops cleanly when asked over HTTP');
const anonymous = await fetch(`${conn.url}/v1/daemon/shutdown`, { method: 'POST' });
check('an unauthenticated request is refused', anonymous.status === 401 || anonymous.status === 403, anonymous.status);
await sleep(500);
check('…and the daemon keeps running', exitCode === null && (await fetch(`${conn.url}/v1/health`)).ok);
const asked = await fetch(`${conn.url}/v1/daemon/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${conn.token}` } });
const body = await asked.json().catch(() => null);
check('the token holder is told it is stopping', asked.ok && body?.stopping === true && body.pid === conn.pid, { status: asked.status, body });
await poll(() => exitCode !== null, 20_000);
check('the daemon exits 0 (the coordinated shutdown, not a kill)', exitCode === 0, { exitCode, stderr: stderr.slice(-300) });
check('it removed its handshake file on the way out', !existsSync(file));

console.log('\n' + '─'.repeat(60));
console.log(failures.length === 0
  ? `ALL ${passed} DAEMON UPGRADE CHECKS PASSED`
  : `${passed} passed, ${failures.length} FAILED:\n  - ${failures.join('\n  - ')}`);
process.exit(failures.length === 0 ? 0 : 1);
