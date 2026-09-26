#!/usr/bin/env node
// Stops everything seed.mjs and offline.mjs started: the daemon, the desktop window
// and any demo agent still running (one of them hangs on purpose).
//   node scratch/docs-screenshots/stop.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const ROOT = process.env.DOCS_ROOT ?? '/tmp/tdm-docs2';
const kill = (pid, label) => { try { process.kill(pid, 'SIGTERM'); console.log(`[stop] ${label} ${pid}`); } catch { /* already gone */ } };
const pkill = (pattern) => { try { execFileSync('pkill', ['-f', pattern]); console.log(`[stop] pkill ${pattern}`); } catch { /* none */ } };

if (existsSync(`${ROOT}/env.json`)) kill(JSON.parse(readFileSync(`${ROOT}/env.json`, 'utf8')).pid, 'daemon');
for (const file of ['desktop.pid', 'offline.pid']) {
  if (!existsSync(`${ROOT}/${file}`)) continue;
  const pid = Number(readFileSync(`${ROOT}/${file}`, 'utf8'));
  kill(-pid, `${file} group`); // detached: the pid is its own process group
}
pkill(`user-data-dir=${ROOT}/electron`);
pkill(`${ROOT}/demo-agent.mjs`);
