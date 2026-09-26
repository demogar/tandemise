// Shared by the P15 scenarios: Project → Setup as code, the files it writes in
// the acceptance project, and the folder the (test-hooked) picker returns.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCRATCH, readState, writeState } from '../p0/lib/ctx.mjs';

export { readState, writeState };
export { setRoleModels, roleOf } from '../p12/common.mjs';

/** The project's `.tandemise` folder, and one file in it. */
export const setupDir = (c) => join(c.env.project, '.tandemise');
export const readSetupFile = (c, path) => readFileSync(join(setupDir(c), path), 'utf8');
export const writeSetupFile = (c, path, text) => writeFileSync(join(setupDir(c), path), text);

/** What the folder picker returns next (TANDEMISE_TEST_PICK_DIRECTORY). */
export function pickDirectory(path) {
  writeFileSync(`${SCRATCH}/pick-directory`, path);
}

/** Project → the "Setup as code" section, scrolled into view. */
export async function openSetup(c) {
  const { page, until, sleep } = c;
  await page.navigate('#/project');
  await until(() => page.evaluate(`Boolean(document.querySelector('section[aria-label="Setup as code"]'))`), { label: 'Setup as code section', timeoutMs: 20_000 });
  await page.evaluate(`document.querySelector('section[aria-label="Setup as code"]').scrollIntoView({ block: 'start' })`);
  await sleep(500);
}

export const setupText = (c) => c.page.evaluate(`document.querySelector('section[aria-label="Setup as code"]')?.innerText ?? ''`);

/** Clicks a button inside the section by its visible text (prefix match). */
export async function clickInSetup(c, label) {
  const ok = await c.page.evaluate(`(() => {
    const s = document.querySelector('section[aria-label="Setup as code"]');
    const b = s && [...s.querySelectorAll('button')].find((x) => x.offsetParent && !x.disabled && x.innerText.trim().startsWith(${JSON.stringify(label)}));
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    b.click();
    return true;
  })()`);
  if (!ok) throw new Error(`no enabled "${label}" button in Setup as code`);
}

/** Exports to the acceptance project from the window; returns the hash the section shows. */
export async function exportInWindow(c) {
  await openSetup(c);
  await c.page.select('Export to repository', 'acceptance-project');
  // A second export of the same setup shows the same words, so "done" is read
  // from the export record's time (proof only), then the window is read.
  const at = async () => (await c.api.get(`/v1/workspaces/${c.env.workspaceId}/setup`)).lastExport?.at ?? null;
  const before = await at();
  await clickInSetup(c, 'Export');
  await c.until(async () => { const now = await at(); return now !== null && now !== before; }, { label: 'export recorded', timeoutMs: 20_000 });
  const text = await c.until(async () => { const t = await setupText(c); return /Content hash ([0-9a-f]{12})/.test(t) && !t.includes('Exporting…') && t; }, { label: 'export result', timeoutMs: 20_000 });
  return { text, hash: /Content hash ([0-9a-f]{12})/.exec(text)[1] };
}

/** Import from `folder` in the window: returns the preview's text once it is shown. */
export async function previewInWindow(c, folder) {
  pickDirectory(folder);
  await openSetup(c);
  await clickInSetup(c, 'Import from a folder');
  await c.until(() => c.page.evaluate(`Boolean(document.querySelector('[aria-label="Import preview"]'))`), { label: 'import preview', timeoutMs: 20_000 });
  await c.sleep(400);
  return c.page.evaluate(`document.querySelector('[aria-label="Import preview"]').innerText`);
}

/** The preview's rows, as the table shows them: [aria-label, text]. */
export const previewRows = (c) => c.page.evaluate(`[...document.querySelectorAll('[aria-label="Import preview"] tbody tr')].map((r) => [r.getAttribute('aria-label'), r.innerText])`);

export async function applyInWindow(c) {
  await clickInSetup(c, 'Apply');
  return c.until(async () => { const t = await c.page.evaluate(`document.querySelector('[aria-label="Import applied"]')?.innerText ?? ''`); return t || false; }, { label: 'applied', timeoutMs: 20_000 });
}

/** 1360×900, the size the docs screenshots are taken at, so evidence shots can go straight into the guide. */
export async function docsSize(c) {
  await c.page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.sleep(300);
}
