import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';

/**
 * Development-only capture pass. Enabled by `TANDEMISE_SCREENSHOT_DIR`; drives
 * navigation through the hash router from the main process so the renderer
 * needs no extra bridge member for it.
 */
const ROUTES: readonly (readonly [name: string, hash: string, waitMs?: number])[] = [
  ['01-home', '/'],
  ['02-missions', '/missions'],
  ['03-mission-plan', '/missions/msn_checkout/plan', 1200],
  ['04-mission-timeline', '/missions/msn_checkout/timeline', 2500],
  ['05-mission-artifacts', '/missions/msn_checkout/artifacts', 1200],
  ['06-mission-checks', '/missions/msn_checkout/checks'],
  ['07-mission-metrics', '/missions/msn_checkout/metrics'],
  ['08-approvals', '/approvals', 1200],
  ['09-artifacts', '/artifacts', 1200],
  ['10-workforce', '/workforce'],
  ['11-runtimes', '/runtimes'],
  ['12-integrations', '/integrations'],
  ['13-settings', '/settings'],
  ['14-new-mission', '/missions/new'],
];

export async function runScreenshotPass(window: BrowserWindow, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await once(window.webContents, 'did-finish-load');
  await delay(2_500);

  for (const [name, hash, waitMs] of ROUTES) {
    await window.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#' + hash)}`);
    await delay(waitMs ?? 800);
    const image = await window.webContents.capturePage();
    await writeFile(join(directory, `${name}.png`), image.toPNG());
    console.log(`[screenshot] ${name}`);
  }

  if (process.env['TANDEMISE_SCREENSHOT_EXIT'] === '1') process.exit(0);
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function once(emitter: NodeJS.EventEmitter, event: string): Promise<void> {
  return new Promise((done) => emitter.once(event, () => done()));
}
