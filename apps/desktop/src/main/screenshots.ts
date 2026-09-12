import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';

/**
 * Development-only capture pass. Enabled by `TANDEMISE_SCREENSHOT_DIR`; drives
 * navigation through the hash router from the main process so the renderer
 * needs no extra bridge member for it.
 */
interface Shot {
  readonly name: string;
  readonly hash: string;
  readonly waitMs?: number;
  readonly theme?: 'light' | 'dark';
  /** Runs in the renderer after navigation - opens an overlay, focuses a field. */
  readonly script?: string;
}

/** Dispatching the real combo exercises the same handler the user hits. */
const OPEN_PALETTE = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))`;

const SHOTS: readonly Shot[] = [
  { name: '01-home', hash: '/' },
  { name: '02-missions', hash: '/missions' },
  { name: '03-mission-plan', hash: '/missions/msn_checkout/plan', waitMs: 1200 },
  { name: '04-mission-timeline', hash: '/missions/msn_checkout/timeline', waitMs: 2500 },
  { name: '05-mission-artifacts', hash: '/missions/msn_checkout/artifacts', waitMs: 1200 },
  { name: '06-mission-checks', hash: '/missions/msn_checkout/checks' },
  { name: '07-mission-metrics', hash: '/missions/msn_checkout/metrics' },
  { name: '08-approvals', hash: '/approvals', waitMs: 1200 },
  { name: '09-artifacts', hash: '/artifacts', waitMs: 1200 },
  { name: '10-workforce', hash: '/workforce' },
  { name: '11-runtimes', hash: '/runtimes' },
  { name: '12-integrations', hash: '/integrations' },
  { name: '13-settings', hash: '/settings' },
  { name: '14-new-mission', hash: '/missions/new' },
  { name: '15-command-palette', hash: '/', waitMs: 900, script: OPEN_PALETTE },
  { name: '16-home-light', hash: '/', theme: 'light' },
  { name: '17-missions-light', hash: '/missions', theme: 'light' },
  { name: '18-mission-plan-light', hash: '/missions/msn_checkout/plan', waitMs: 1200, theme: 'light' },
  { name: '19-approvals-light', hash: '/approvals', waitMs: 1200, theme: 'light' },
  { name: '20-settings-light', hash: '/settings', theme: 'light' },
];

export async function runScreenshotPass(window: BrowserWindow, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await once(window.webContents, 'did-finish-load');
  await delay(2_500);

  // Lets a run capture one state in isolation - the daemon-down screen needs
  // its own launch with no reachable daemon, and re-shooting all twenty would
  // just overwrite the good ones with error states.
  const only = process.env['TANDEMISE_SCREENSHOT_ONLY'];
  const selected = only ? SHOTS.filter((shot) => shot.name.includes(only)) : SHOTS;

  for (const shot of selected) {
    await applyTheme(window, shot.theme);
    await window.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#' + shot.hash)}`);
    await delay(shot.waitMs ?? 800);
    if (shot.script) {
      await window.webContents.executeJavaScript(shot.script);
      // Long enough for the entrance animation to land: capturePage otherwise
      // returns a compositor frame from part-way through the fade.
      await delay(1_200);
    }
    const image = await window.webContents.capturePage();
    await writeFile(join(directory, `${shot.name}.png`), image.toPNG());
    console.log(`[screenshot] ${shot.name}`);
    // Overlays are dismissed with Escape so the next shot starts clean.
    if (shot.script) {
      await window.webContents.executeJavaScript(
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
      );
      await delay(300);
    }
  }

  if (process.env['TANDEMISE_SCREENSHOT_EXIT'] === '1') process.exit(0);
}

/**
 * Writes the same key the Settings toggle writes, so a capture exercises the
 * real preference path rather than a stylesheet swap the app never performs.
 */
async function applyTheme(window: BrowserWindow, theme: 'light' | 'dark' | undefined): Promise<void> {
  const script =
    theme === undefined
      ? `localStorage.removeItem('tandemise.theme'); document.documentElement.removeAttribute('data-theme');`
      : `localStorage.setItem('tandemise.theme', ${JSON.stringify(theme)}); document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});`;
  await window.webContents.executeJavaScript(script);
  await delay(200);
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function once(emitter: NodeJS.EventEmitter, event: string): Promise<void> {
  return new Promise((done) => emitter.once(event, () => done()));
}
