// Q2 — Import a changed role: the Developer's model is edited in roles/development.md on disk; Import from the
// repository folder previews exactly one Change (the Developer, "model: base-model → strong-model") and everything
// else the same; Apply; Team → Roles shows the new model in the Developer's "Model" field.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { applyInWindow, previewInWindow, previewRows, readSetupFile, roleOf, writeSetupFile, docsSize } from '../common.mjs';

const c = await context();
const { page } = c;
await docsSize(c);
const ev = new Evidence('Q2', "A role's model edited in the file: one Change in the preview, applied, shown in Team");

const dev = readSetupFile(c, 'roles/development.md');
if (!dev.includes('\nmodel: base-model\n')) throw new Error('Q2 needs Q1 first (roles/development.md with model: base-model)');
writeSetupFile(c, 'roles/development.md', dev.replace('\nmodel: base-model\n', '\nmodel: better-model\n'));
ev.note('edited on disk: roles/development.md model: base-model → better-model');

const preview = await previewInWindow(c, c.env.project);
ev.check('the preview counts one change and nothing else', preview.includes('0 to add · 1 to change · 0 to remove'), preview.slice(0, 300));
const rows = await previewRows(c);
const changed = rows.filter(([label]) => !label.endsWith(': Same'));
ev.check('exactly one row is not Same: "Developer: Change"', changed.length === 1 && changed[0][0] === 'Developer: Change', changed);
ev.check('it says what changes', changed[0]?.[1].includes('model: base-model → better-model'), changed[0]?.[1]);
ev.check('its choice is "Take theirs"', await page.evaluate(`document.querySelector('[aria-label="Choice for Developer"] [aria-pressed="true"]')?.innerText.trim() === 'Take theirs'`));
ev.check('the model is unchanged until Apply (API)', (await roleOf(c, 'development'))?.models?.model === 'base-model');
await page.evaluate(`document.querySelector('[aria-label="Import preview"]').scrollIntoView({ block: 'start' })`);
await c.sleep(300);
await page.screenshot(ev.shot('preview-one-change'));

const applied = await applyInWindow(c);
ev.check('the window says it applied one change', applied.includes('Applied 1 change.') && applied.includes('Changed Developer: model: base-model → better-model'), applied);
await page.screenshot(ev.shot('applied'));

await page.navigate('#/team/roles');
await c.until(() => page.evaluate(`[...document.querySelectorAll('.reader__list .list__row')].some((r) => r.querySelector('.list__title')?.innerText.trim() === 'Developer')`), { label: 'roles list', timeoutMs: 20_000 });
await page.evaluate(`[...document.querySelectorAll('.reader__list .list__row')].find((r) => r.querySelector('.list__title')?.innerText.trim() === 'Developer').click()`);
await c.until(() => page.evaluate(`Boolean(document.querySelector('section[aria-label="Models"]'))`), { label: 'Models section', timeoutMs: 10_000 });
await c.sleep(500);
const field = await page.evaluate(`[...document.querySelectorAll('section[aria-label="Models"] input')].find((i) => i.getAttribute('aria-label') === 'Model')?.value ?? null`);
ev.check('Team → Roles → Developer: the "Model" field reads better-model', field === 'better-model', field);
await page.evaluate(`document.querySelector('section[aria-label="Models"]').scrollIntoView({ block: 'center' })`);
await c.sleep(300);
await page.screenshot(ev.shot('team-shows-new-model'));
ev.check('proof (API): the role\'s model is better-model, its retry model kept', (await roleOf(c, 'development'))?.models?.model === 'better-model' && (await roleOf(c, 'development'))?.models?.escalate?.[0] === 'strong-model', (await roleOf(c, 'development'))?.models);

c.close(); ev.save();
