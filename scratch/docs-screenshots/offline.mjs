#!/usr/bin/env node
// Takes 21-daemon-down.png: opens a desktop window whose daemon cannot start, which is
// exactly the screen someone sees when the daemon is not running. Run after stop.mjs.
//   node scratch/docs-screenshots/offline.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../acceptance/p0/lib/cdp.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const ROOT = process.env.DOCS_ROOT ?? '/tmp/tdm-docs2';
const PORT = Number(process.env.DOCS_CDP_PORT ?? 9352);
const OUT = process.env.DOCS_OUT ?? join(REPO, 'apps/desktop/screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = join(ROOT, 'offline-home');
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
const desktop = spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${PORT}`, `--user-data-dir=${ROOT}/electron`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
  cwd: join(REPO, 'apps/desktop'),
  // No handshake file, and a daemon entry that does not exist: the window has nothing to start.
  env: { ...process.env, TANDEMISE_HOME: home, TANDEMISE_DAEMON_ENTRY: join(ROOT, 'no-daemon', 'main.js') },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
desktop.unref();
writeFileSync(join(ROOT, 'offline.pid'), String(desktop.pid));

const page = await connect(PORT, { timeoutMs: 90_000 });
await page.waitForText('The Tandemise daemon is not running', { timeoutMs: 90_000 });
await page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
await page.evaluate(`localStorage.setItem('tandemise.theme', 'dark'); document.documentElement.setAttribute('data-theme', 'dark')`);
await sleep(1200);
await page.screenshot(join(OUT, '21-daemon-down.png'));
console.log('shot 21-daemon-down');
page.close();
try { process.kill(-desktop.pid, 'SIGTERM'); } catch { /* gone */ }
