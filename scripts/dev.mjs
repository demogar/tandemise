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
import { existsSync, readFileSync, rmSync } from 'node:fs';
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

console.log('▸ building…');
await run('npx', ['tsc', '-b', 'tsconfig.build.json']);

let daemon = daemonIsAlive();
let spawned;

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
