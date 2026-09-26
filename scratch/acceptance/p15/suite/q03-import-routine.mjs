// Q3 — Import a routine: a routine is added to routines.yaml on disk; the preview shows it as an Add that "arrives
// off"; after Apply, Missions → Routines shows it Off with "Imported — review and turn on", and no mission was made.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { applyInWindow, previewInWindow, previewRows, readSetupFile, writeSetupFile, docsSize } from '../common.mjs';

const c = await context();
const { page } = c;
await docsSize(c);
const ev = new Evidence('Q3', 'An imported routine arrives off, marked "Imported — review and turn on"');

const routines = readSetupFile(c, 'routines.yaml');
writeSetupFile(c, 'routines.yaml', `${routines.trimEnd()}
  - goal: ""
    kind: status_report
    limits: null
    name: Friday status report
    priority: normal
    schedule:
      at: "16:00"
      day: 5
      type: weekly
    successCriteria: []
    workflow: null
`);
ev.note('edited on disk: routines.yaml gains "Friday status report" (weekly, Friday 16:00)');
const missionsBefore = (await c.api.get(`/v1/missions?workspaceId=${c.env.workspaceId}`)).length;

const preview = await previewInWindow(c, c.env.project);
ev.check('the preview counts one to add', preview.includes('1 to add · 0 to change · 0 to remove'), preview.slice(0, 300));
const row = (await previewRows(c)).find(([label]) => label.startsWith('Friday status report'));
ev.check('its row: "Friday status report: Add", arriving off', row?.[0] === 'Friday status report: Add' && row?.[1].includes('Arrives off'), row);
await page.screenshot(ev.shot('preview-routine-add'));

const applied = await applyInWindow(c);
ev.check('applied, and told routines arrive off', applied.includes('Applied 1 change.') && applied.includes('Imported routines are off until you turn them on'), applied);

await page.navigate('#/missions/routines');
const text = await c.until(async () => page.evaluate(`document.querySelector('[aria-label="Routine: Friday status report"]')?.innerText ?? ''`), { label: 'routine row', timeoutMs: 20_000 });
ev.check('Missions → Routines: the row says "Imported — review and turn on"', text.includes('Imported — review and turn on'), text);
ev.check('and it is Off and paused', text.includes('Off') && text.includes('Paused'), text);
ev.check('its switch is off', await page.evaluate(`document.querySelector('[aria-label="Routine: Friday status report"] [role=switch]')?.getAttribute('aria-checked') === 'false'`));
await page.evaluate(`document.querySelector('[aria-label="Routine: Friday status report"]').scrollIntoView({ block: 'center' })`);
await c.sleep(300);
await page.screenshot(ev.shot('routine-off-imported'));
const r = (await c.api.get(`/v1/workspaces/${c.env.workspaceId}/routines`)).find((v) => v.routine.name === 'Friday status report');
ev.check('proof (API): enabled false, no next run', r?.routine.enabled === false && r?.routine.nextRunAt === null, r?.routine);
ev.check('proof (API): nothing started — no new mission', (await c.api.get(`/v1/missions?workspaceId=${c.env.workspaceId}`)).length === missionsBefore);

c.close(); ev.save();
