// D2 — "Continue elsewhere" on a running design step, in the window. The card then says "Waiting for your
// work in Figma" with a Hand back button; the timeline shows the park (task.parked_external in the raw log);
// the Desk on Home counts one more thing waiting on you, and the Inbox lists it. The step's agent was
// stopped, and the step stayed AWAITING_EXTERNAL rather than settling CANCELLED.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { card, continueElsewhere, docsSize, ensureTeam, startMission, waitTask, writeState } from '../common.mjs';

const c = await context();
const { page, api, until, sleep } = c;
await docsSize(c);
const ev = new Evidence('D2', 'Continue elsewhere on a design step: waiting for your work in Figma');
await ensureTeam(c);

// SCRIPTED_SLOW_20S: every step's first pass takes 20 s, so the design is still running when it is taken elsewhere.
const goal = 'Hello page, taken to Figma SCRIPTED_SLOW_20S';
const missionId = await startMission(c, goal, 'P2 chain');
writeState({ d2: { missionId, goal } });
await waitTask(c, missionId, 'design', (t) => t.status === 'RUNNING', 'design running', 60_000);

const desk = async () => (await api.get(`/v1/home?workspaceId=${c.env.workspaceId}`).catch(() => null))?.metrics?.needsYou ?? null;
/** The Desk's "Needs you" card on Home, as the window shows it. */
const deskCard = async () => {
  await page.navigate('#/');
  return until(() => page.evaluate(`document.querySelector('section[aria-label="Desk"] a[aria-label="Needs you"]')?.innerText ?? false`), { label: 'Desk', timeoutMs: 20_000 });
};
const number = (s) => Number(/(\d+)/.exec(s)?.[1] ?? NaN);
const before = await deskCard();
const needsBefore = await desk();

const { dialog, prefilled, parked } = await continueElsewhere(c, missionId, 'design', undefined, { shot: ev.shot('continue-dialog') });
ev.check('the dialog says the agent stops and dependent work waits', dialog.includes('The agent stops, and work that needs this step waits until you hand it back.'), dialog);
ev.check('the tool is prefilled with Figma for a design step', prefilled === 'Figma', prefilled);
ev.check('proof (API): the step is AWAITING_EXTERNAL, parked in Figma, "Continued in Figma"', parked.status === 'AWAITING_EXTERNAL' && parked.parkedExternal.tool === 'Figma' && parked.statusReason === 'Continued in Figma', { status: parked.status, parkedExternal: parked.parkedExternal, statusReason: parked.statusReason });

await page.navigate(`#/missions/${missionId}`);
const text = await until(async () => { const t = await card(c, 'design'); return t.includes('Waiting for your work in Figma') && t; }, { label: 'parked card', timeoutMs: 20_000 }).catch(() => card(c, 'design'));
ev.check('the design card says "Waiting for your work in Figma"', text.includes('Waiting for your work in Figma'), text);
ev.check('the card offers Hand back, and no longer Continue elsewhere', /Hand back/.test(text) && !/Continue elsewhere/.test(text), text);
await page.evaluate(`document.querySelector('[data-feed-card="design"]')?.scrollIntoView({ block: 'center' })`);
await page.screenshot(ev.shot('parked-card'));

// The agent's run was stopped, and the park survived its end.
await sleep(3000);
const runs = c.runs(parked.id);
const after = await c.task(missionId, 'design');
ev.check('the running pass was stopped, and the step is still parked afterwards (not CANCELLED)', runs.length >= 1 && runs.every((r) => r.status !== 'RUNNING') && after.status === 'AWAITING_EXTERNAL' && after.parkedExternal?.tool === 'Figma', { runs: runs.map((r) => r.status), status: after.status });

// Timeline: the product-language row, then the raw log with the event itself.
await page.navigate(`#/missions/${missionId}/timeline`);
const timeline = await until(async () => { const t = await page.text('main'); return t.includes('Continued in Figma') && t; }, { label: 'timeline row', timeoutMs: 20_000 }).catch(() => page.text('main'));
ev.check('the timeline shows "Continued in Figma"', timeline.includes('Continued in Figma'), timeline.slice(Math.max(0, timeline.indexOf('Continued in Figma') - 200), timeline.indexOf('Continued in Figma') + 60));
await page.screenshot(ev.shot('timeline'));
await page.click('Raw log');
const raw = await until(async () => { const t = await page.text('main'); return t.includes('task.parked_external') && t; }, { label: 'raw log', timeoutMs: 10_000 }).catch(() => page.text('main'));
const rawLine = raw.split('\n').find((l) => l.includes('task.parked_external')) ?? '';
ev.check('the raw log shows task.parked_external {"tool":"Figma"}', rawLine.includes('task.parked_external') && rawLine.includes('"tool":"Figma"'), rawLine);
await page.evaluate(`[...document.querySelectorAll('main *')].find((e) => e.children.length === 0 && e.innerText?.includes('task.parked_external'))?.scrollIntoView({ block: 'center' })`);
await page.screenshot(ev.shot('timeline-raw'));
await page.click('Raw log');

// The Desk counts it.
const needsAfter = await until(async () => { const n = await desk(); return n !== null && n > (needsBefore ?? 0) && n; }, { label: 'desk count', timeoutMs: 20_000 }).catch(desk);
ev.check('proof (API): the Desk\'s "needs you" count went up by one', needsBefore !== null && needsAfter === needsBefore + 1, { before: needsBefore, after: needsAfter });
const shown = await until(async () => { const t = await deskCard(); return number(t) === number(before) + 1 && t; }, { label: 'Desk card +1', timeoutMs: 20_000 }).catch(deskCard);
ev.check('the Desk\'s "Needs you" card on Home counts one more', number(shown) === number(before) + 1, { before, after: shown });
await page.screenshot(ev.shot('desk'));

await page.navigate('#/inbox');
const row = await until(() => page.evaluate(`[...document.querySelectorAll('.inbox__row')].find((r) => r.innerText.includes('Waiting for your work in Figma'))?.innerText ?? false`), { label: 'inbox row', timeoutMs: 20_000 }).catch(() => '');
ev.check('the Inbox lists it as "Waiting for your work in Figma", with Hand back', row.includes('Waiting for your work in Figma') && row.includes('Hand back'), row);
await page.screenshot(ev.shot('inbox'));

// Nothing downstream ran while it was away.
const build = await c.task(missionId, 'build');
ev.check('build has not started: it waits for the design', build.status === 'PENDING' && build.runCount === 0, { status: build.status, statusReason: build.statusReason });

c.close(); ev.save();
