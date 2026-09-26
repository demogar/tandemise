// Shared by the About scenarios: open Settings → About, read its rows, restart
// the daemon (optionally with the TANDEMISE_BUILD knob), and ask macOS for the
// native About panel through Accessibility.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCRATCH } from '../p0/lib/ctx.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../../..');
export const gitSha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
export const appVersion = JSON.parse(readFileSync(join(repoRoot, 'apps/desktop/package.json'), 'utf8')).version;
export const noticeCopyright = readFileSync(join(repoRoot, 'NOTICE'), 'utf8').split('\n').find((l) => l.startsWith('Copyright')).trim();

const SECTION = 'section[data-section="about"]';

/** Settings, scrolled to About, once it has the daemon's answer. */
export async function openAbout(c) {
  const { page, until, sleep } = c;
  await page.navigate('#/settings');
  await until(() => page.evaluate(`(() => { const s = document.querySelector('${SECTION}'); if (!s) return false; s.scrollIntoView({ block: 'start' }); return /Database schema\\s+Version \\d+/.test(s.innerText); })()`), { label: 'About section with the daemon facts', timeoutMs: 20_000 });
  await sleep(500);
}

/** The About section's text, and its rows as { label: value }. */
export async function aboutText(c) {
  return c.page.evaluate(`document.querySelector('${SECTION}')?.innerText ?? ''`);
}
export async function aboutRows(c) {
  return c.page.evaluate(`Object.fromEntries([...document.querySelectorAll('${SECTION} tr')].map((tr) => [tr.cells[0].innerText.trim(), tr.cells[1].innerText.replace(/\\s+/g, ' ').trim()]))`);
}
/**
 * A real mouse click (CDP Input events, so the page gets a user gesture) on a
 * button in About. The run's window usually sits behind other windows, and an
 * unfocused document may not write to the clipboard, so focus is emulated the
 * way a person's click would give it.
 */
export async function clickInAbout(c, label) {
  const rect = await c.page.evaluate(`(() => { const b = [...document.querySelectorAll('${SECTION} button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)}); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!rect) throw new Error(`no "${label}" button in About`);
  await c.page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  for (const type of ['mousePressed', 'mouseReleased']) {
    await c.page.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  }
}

/** Stops the run's daemon and starts a new one from this checkout (setup.mjs), with extra env. */
export async function restartDaemon(c, extraEnv = {}) {
  const env = JSON.parse(readFileSync(join(SCRATCH, 'env.json'), 'utf8'));
  try { process.kill(env.pid, 'SIGTERM'); } catch { /* gone */ }
  await c.until(() => { try { process.kill(env.pid, 0); return false; } catch { return true; } }, { label: 'old daemon gone', timeoutMs: 20_000 });
  execFileSync(process.execPath, [join(repoRoot, 'scratch/acceptance/p0/setup.mjs'), SCRATCH], {
    env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(readFileSync(join(SCRATCH, 'env.json'), 'utf8'));
}

/** The pid of this run's Electron main process (not a helper). */
export function electronPid() {
  const out = execFileSync('pgrep', ['-f', `MacOS/Electron .*user-data-dir=${SCRATCH}/electron`], { encoding: 'utf8' }).trim().split('\n');
  return Number(out[0]);
}

/**
 * Runs AppleScript inside `tell` this run's Electron process; throws if
 * Accessibility is not allowed. A `tell` block, not a variable: System Events
 * turns a stored process reference into one by name, and every dev window is
 * named "Electron", so a variable would silently talk to another app.
 */
export function systemEvents(pid, body) {
  return execFileSync('osascript', ['-e', `tell application "System Events"
  tell (first process whose unix id is ${pid})
${body}
  end tell
end tell`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The system clipboard as text (macOS). */
export const pbpaste = () => execFileSync('pbpaste', { encoding: 'utf8' });
export const pbcopy = (text) => execFileSync('pbcopy', { input: text });
