#!/usr/bin/env node
// Takes the screenshots in apps/desktop/screenshots from the window seed.mjs started.
//   node scratch/docs-screenshots/capture.mjs              every shot except the daemon-down one
//   node scratch/docs-screenshots/capture.mjs 03-mission-plan,10-team   only these
// The daemon-down shot needs a window with no daemon; offline.mjs takes it.
// Env: DOCS_ROOT (default /tmp/tdm-docs2), DOCS_CDP_PORT (9352), DOCS_OUT (apps/desktop/screenshots).
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect } from '../acceptance/p0/lib/cdp.mjs';

const ROOT = process.env.DOCS_ROOT ?? '/tmp/tdm-docs2';
const PORT = Number(process.env.DOCS_CDP_PORT ?? 9352);
const OUT = process.env.DOCS_OUT ?? fileURLToPath(new URL('../../apps/desktop/screenshots', import.meta.url));
mkdirSync(OUT, { recursive: true });
const S = JSON.parse(readFileSync(`${ROOT}/state.json`, 'utf8'));
const only = process.argv[2]?.split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await connect(PORT, { timeoutMs: 90_000 });
await page.waitForText('Daemon connected', { timeoutMs: 90_000 });
await page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });

// Writes the same key the Settings toggle writes.
const theme = async (t) => { await page.evaluate(`localStorage.setItem('tandemise.theme', '${t}'); document.documentElement.setAttribute('data-theme', '${t}')`); await sleep(300); };
const go = async (hash, wait = 2000) => { await page.navigate(hash); await sleep(wait); await page.evaluate('window.scrollTo(0,0); document.querySelectorAll("main, .page, [class*=scroll]").forEach(e => e.scrollTop = 0)'); await sleep(300); };
const shot = async (name) => { await page.screenshot(`${OUT}/${name}.png`); console.log('shot', name); };
const want = (n) => !only || only.includes(n);
const escape = async () => { await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(400); };
const dark = (hash, wait) => async () => { await theme('dark'); await go(hash, wait); };
const light = (hash, wait) => async () => { await theme('light'); await go(hash, wait); };

// [name, prepare, cleanup?]
const shots = [
  ['01-home', dark('#/', 3000)],
  ['02-missions', dark('#/missions/in-progress', 2500)],
  ['03-mission-plan', dark(`#/missions/${S.a}/plan`, 3000)],
  ['04-mission-timeline', dark(`#/missions/${S.a}/timeline`, 3000)],
  ['05-mission-artifacts', dark(`#/missions/${S.a}/artifacts`, 3000)],
  ['06-mission-checks', dark(`#/missions/${S.a}/checks`, 3000)],
  ['07-mission-metrics', dark(`#/missions/${S.a}/metrics`, 3000)],
  ['08-inbox', dark('#/inbox', 3000)],
  ['09-artifacts', dark('#/artifacts', 2500)],
  ['10-team', dark('#/team', 2500)],
  ['11-runtimes', dark('#/runtimes', 2500)],
  ['12-integrations', dark('#/integrations', 2500)],
  ['13-settings', dark('#/settings', 2000)],
  ['14-new-mission', dark('#/missions/new', 2500)],
  ['15-command-palette', async () => {
    await theme('dark'); await go('#/', 2500);
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: ${process.platform !== 'darwin'}, bubbles: true }))`);
    await sleep(1200);
  }, escape],
  ['16-home-light', light('#/', 3000)],
  ['17-missions-light', light('#/missions/in-progress', 2500)],
  ['18-mission-plan-light', light(`#/missions/${S.a}/plan`, 3000)],
  ['19-inbox-light', light('#/inbox', 3000)],
  ['20-settings-light', light('#/settings', 2000)],
  ['22-mission-done-when', dark(`#/missions/${S.a}`, 3000)],
  ['23-get-it-ready', dark(`#/missions/${S.h}`, 3000)],
  ['24-backlog', dark('#/missions/backlog', 2500)],
  ['25-limit-card', dark(`#/missions/${S.d}`, 3000)],
  ['26-mission-metrics-limit', dark(`#/missions/${S.d}/metrics`, 3000)],
  ['27-inbox-stalled-quiet', dark('#/inbox', 3000)],
  ['28-status-report', async () => {
    await theme('dark'); await go('#/', 2500);
    const before = await page.evaluate('location.hash');
    await page.click('Status report');
    for (let i = 0; i < 60; i++) { const h = await page.evaluate('location.hash'); if (h !== before && h.startsWith('#/artifacts/art_')) break; await sleep(500); }
    await sleep(7000);
  }],
  ['29-routines', dark('#/missions/routines', 2500)],
  ['30-routine-dialog', async () => {
    await theme('dark'); await go('#/missions/routines', 2500);
    await page.click('New routine');
    await sleep(1000);
    await page.click('Nightly: fix failing checks').catch(() => {});
    await page.evaluate('document.activeElement && document.activeElement.blur()');
    await sleep(1200);
  }, escape],
];
for (const [name, prep, after] of shots) {
  if (!want(name)) continue;
  await prep();
  await shot(name);
  if (after) await after();
}
await theme('dark');
page.close();
