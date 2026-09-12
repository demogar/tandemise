#!/usr/bin/env node
/**
 * `npm run dev` — builds, starts tandemd, then starts the desktop app.
 *
 * The daemon runs as its own process rather than inside Electron, which is the
 * architecture (MVP.md §7.1) and also what lets better-sqlite3 load against the
 * system Node ABI instead of Electron's. Ctrl-C stops the desktop; the daemon is
 * left running deliberately, because closing the window is not supposed to stop
 * work in progress. Pass --stop-daemon to shut it down too.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = process.env.TANDEMISE_HOME ?? join(homedir(), '.tandemise');
const connectionFile = join(home, 'daemon.json');
const stopDaemonOnExit = process.argv.includes('--stop-daemon');

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    child.on('error', reject);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function daemonIsAlive() {
  if (!existsSync(connectionFile)) return null;
  try {
    const info = JSON.parse(readFileSync(connectionFile, 'utf8'));
    process.kill(info.pid, 0);
    return info;
  } catch (e) {
    return e?.code === 'EPERM' ? JSON.parse(readFileSync(connectionFile, 'utf8')) : null;
  }
}

/**
 * Whether a running daemon predates the build we just produced.
 *
 * Leaving the daemon up across restarts is the point - closing the window is
 * not supposed to stop work. But a daemon started before the code it is running
 * was rebuilt serves the *old* API shape to a freshly built desktop, and the
 * failure that produces is remote from its cause: a screen reading a field the
 * old daemon never sends throws during render, and React answers by unmounting
 * the window. So a stale daemon is restarted rather than reused.
 */
function daemonIsStale(info) {
  if (typeof info?.startedAt !== 'string') return true;
  const startedAt = Date.parse(info.startedAt);
  if (Number.isNaN(startedAt)) return true;
  return newestBuildTime(join(root, 'apps/daemon/dist')) > startedAt;
}

function newestBuildTime(dir) {
  let newest = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  try {
    walk(dir);
  } catch {
    return 0;
  }
  return newest;
}

async function stopDaemon(info) {
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await sleep(150);
    try {
      process.kill(info.pid, 0);
    } catch {
      return;
    }
  }
  try {
    process.kill(info.pid, 'SIGKILL');
  } catch { /* already gone */ }
}

console.log('▸ building…');
await run('npx', ['tsc', '-b', 'tsconfig.build.json']);

let daemon = daemonIsAlive();
let spawned;

if (daemon && daemonIsStale(daemon)) {
  console.log(`▸ daemon at ${daemon.url} predates this build — restarting it`);
  await stopDaemon(daemon);
  daemon = null;
}

if (daemon) {
  console.log(`▸ daemon already running at ${daemon.url} (pid ${daemon.pid})`);
} else {
  if (existsSync(connectionFile)) rmSync(connectionFile, { force: true });
  console.log('▸ starting tandemd…');
  spawned = spawn(process.execPath, [join(root, 'apps/daemon/dist/main.js')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, TANDEMISE_HOME: home },
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !daemon) {
    await sleep(250);
    daemon = daemonIsAlive();
  }
  if (!daemon) {
    console.error('✗ daemon did not report ready within 30s');
    spawned.kill('SIGTERM');
    process.exit(1);
  }
  console.log(`▸ daemon ready at ${daemon.url}`);
}

console.log('▸ starting desktop…');
const desktop = spawn('npm', ['run', '-w', '@tandemise/desktop', 'dev'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, TANDEMISE_HOME: home },
});

const shutdown = () => {
  desktop.kill('SIGTERM');
  if (stopDaemonOnExit && spawned) {
    console.log('\n▸ stopping daemon');
    spawned.kill('SIGTERM');
  } else if (daemon) {
    console.log(`\n▸ daemon left running at ${daemon.url} — stop it with: kill ${daemon.pid}`);
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
desktop.on('exit', shutdown);
