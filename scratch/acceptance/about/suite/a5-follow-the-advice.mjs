// A5 — The warning's advice works as written: with a stale daemon running,
// kill the process id the warning names and run `npm run daemon` in the
// repository (as a person would in a terminal); the window reconnects by
// itself and About shows matching commits and no warning.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { context, SCRATCH } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { aboutRows, aboutText, gitSha, openAbout, repoRoot, restartDaemon } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('A5', 'Following the warning (kill the pid, npm run daemon) brings the app and daemon back in step');
const stale = await restartDaemon(c, { TANDEMISE_BUILD: '0000000' });
const warned = await until(async () => {
  await openAbout(c).catch(() => undefined);
  const t = await aboutText(c);
  return t.includes('different code') && t;
}, { label: 'mismatch warning', timeoutMs: 45_000, everyMs: 1500 }).catch(async () => aboutText(c));
const named = Number(/kill (\d+)/.exec(warned)?.[1]);
ev.check('the warning names the stale daemon\'s process id', named === stale.pid, { named, pid: stale.pid });

// What the person does in a terminal.
process.kill(named, 'SIGTERM');
const down = await until(() => page.evaluate(`document.body.innerText.includes('The Tandemise daemon is not running')`), { label: 'daemon-down screen', timeoutMs: 30_000 }).catch(() => false);
ev.check('the window notices the daemon stopped', down);
await page.screenshot(ev.shot('daemon-stopped'));
const npm = spawn('npm', ['run', 'daemon'], { cwd: repoRoot, detached: true, stdio: 'ignore', env: { ...process.env, TANDEMISE_HOME: c.env.home } });
npm.unref();
ev.note('ran `npm run daemon` in the repository with the run\'s TANDEMISE_HOME');
const handshake = join(c.env.home, 'daemon.json');
const fresh = await until(() => {
  if (!existsSync(handshake)) return false;
  const h = JSON.parse(readFileSync(handshake, 'utf8'));
  return h.pid !== stale.pid && h;
}, { label: 'a new daemon handshake', timeoutMs: 45_000 }).catch(() => null);
ev.check('npm run daemon started a new daemon', fresh !== null, fresh?.pid);
if (fresh) {
  // Hand the new daemon to the run so its cleanup stops it.
  const envFile = join(SCRATCH, 'env.json');
  writeFileSync(envFile, JSON.stringify({ ...JSON.parse(readFileSync(envFile, 'utf8')), url: fresh.url, token: fresh.token, pid: fresh.pid }, null, 2));
}
const cleared = await until(async () => {
  await openAbout(c).catch(() => undefined);
  const t = await aboutText(c);
  const rows = await aboutRows(c);
  return !t.includes('different code') && rows.Daemon?.endsWith(`(${gitSha})`) && rows['Daemon status']?.endsWith(`process ${fresh?.pid}`) && rows;
}, { label: 'matching daemon', timeoutMs: 45_000, everyMs: 1500 }).catch(async () => aboutRows(c));
ev.check(`without pressing anything, About shows the new daemon at ${gitSha} and no warning`, cleared?.Daemon?.endsWith(`(${gitSha})`) && !(await aboutText(c)).includes('different code'), cleared);
await sleep(300);
await page.screenshot(ev.shot('matching-again'));
c.close(); ev.save();
