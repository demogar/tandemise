// A4 — A daemon built from other code than the app: About says so, names both
// commits and says exactly what to do. The daemon is restarted with the
// TANDEMISE_BUILD knob, then again without it, and the warning goes away.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { aboutRows, aboutText, clickInAbout, gitSha, openAbout, pbcopy, pbpaste, restartDaemon } from '../common.mjs';

const c = await context();
const ev = new Evidence('A4', 'A stale daemon shows a mismatch warning that says to restart it');
const stale = await restartDaemon(c, { TANDEMISE_BUILD: '0000000' });
ev.note(`daemon restarted with TANDEMISE_BUILD=0000000 (pid ${stale.pid})`);
const warned = await c.until(async () => {
  await openAbout(c).catch(() => undefined);
  const t = await aboutText(c);
  return t.includes('different code') && t;
}, { label: 'mismatch warning', timeoutMs: 45_000, everyMs: 1500 }).catch(async () => aboutText(c));
ev.check('the warning says the daemon was built from different code', warned.includes('The daemon was built from different code than the app.'), warned);
ev.check(`it names both commits (${gitSha} and 0000000)`, warned.includes(`built from commit ${gitSha} but the daemon from 0000000`), warned);
ev.check('it says what to do: build, kill the daemon\'s pid, start it again', warned.includes('npm run build') && warned.includes(`kill ${stale.pid}`) && warned.includes('npm run daemon'), warned);
ev.check('the Daemon row shows the other commit', (await aboutRows(c)).Daemon?.endsWith('(0000000)'), (await aboutRows(c)).Daemon);
await c.page.screenshot(ev.shot('mismatch-warning'));

const saved = pbpaste();
try {
  await clickInAbout(c, 'Copy diagnostics');
  await c.sleep(800);
  const clip = pbpaste();
  ev.check('the copied diagnostics record the mismatch', clip.includes(`Mismatch: build (app ${gitSha}, daemon 0000000)`), clip.split('\n').slice(-2));
  ev.check('and still no token', !clip.includes(stale.token) && !/bearer/i.test(clip));
} finally {
  pbcopy(saved);
}

const fresh = await restartDaemon(c);
ev.note(`daemon restarted from this build (pid ${fresh.pid})`);
const cleared = await c.until(async () => {
  await openAbout(c).catch(() => undefined);
  const t = await aboutText(c);
  const rows = await aboutRows(c);
  return !t.includes('different code') && rows.Daemon?.endsWith(`(${gitSha})`) && rows['Daemon status']?.endsWith(`process ${fresh.pid}`) && t;
}, { label: 'warning cleared', timeoutMs: 45_000, everyMs: 1500 }).catch(() => false);
ev.check('after restarting the daemon from this build the warning is gone', Boolean(cleared), cleared || (await aboutText(c)));
c.close(); ev.save();
