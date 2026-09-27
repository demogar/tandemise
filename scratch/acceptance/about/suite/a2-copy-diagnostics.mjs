// A2 — Copy diagnostics puts a plain-text block on the clipboard with both
// versions, the schema and the data folder, and never the bearer token.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { appVersion, clickInAbout, gitSha, openAbout, pbcopy, pbpaste } from '../common.mjs';

const c = await context();
const ev = new Evidence('A2', 'Copy diagnostics copies versions and the data folder, never the token');
const saved = pbpaste();
try {
  pbcopy('(clipboard before the click)');
  await openAbout(c);
  await clickInAbout(c, 'Copy diagnostics');
  const label = await c.until(() => c.page.evaluate(`[...document.querySelectorAll('section[data-section="about"] button')].map((b) => b.innerText.trim()).find((t) => t === 'Copied' || t === 'Could not copy')`), { label: 'button feedback', timeoutMs: 5_000 }).catch(() => null);
  ev.check('the button says Copied', label === 'Copied', label);
  await c.page.screenshot(ev.shot('copied'));
  const clip = pbpaste();
  const system = await c.api.get('/v1/system');
  ev.note(`clipboard:\n${clip}`);
  ev.check('the clipboard changed and starts with "Tandemise diagnostics"', clip.startsWith('Tandemise diagnostics'), clip.slice(0, 40));
  ev.check('it has the app version and commit', clip.includes(`Version: ${appVersion} (${gitSha})`));
  ev.check('it has the daemon version and commit', clip.includes(`Version: ${system.daemonVersion} (${system.daemonBuild})`));
  ev.check('it has the schema, status, uptime and data folder', clip.includes(`Database schema: ${system.schemaVersion}`) && clip.includes('Status: Running') && clip.includes('Uptime: ') && clip.includes(`Data folder: ${c.env.home}`));
  ev.check('it has Electron, Chromium, Node and the OS', ['Electron: ', 'Chromium: ', 'Node (app): ', 'Node (daemon): ', 'OS: macOS '].every((s) => clip.includes(s)));
  ev.check('it has no bearer token (the one in daemon.json)', !clip.includes(c.env.token) && !/bearer/i.test(clip) && !/token/i.test(clip), c.env.token.length);
  ev.check('it records no mismatch', clip.includes('Mismatch: none'));
} finally {
  pbcopy(saved);
}
c.close(); ev.save();
