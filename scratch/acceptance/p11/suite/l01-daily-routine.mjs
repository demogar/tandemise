// L1 — New routine from the "Weekly dependency updates" template, changed to every day at a time an hour ahead.
// The row reads "Next: …". The daemon's clock is moved two hours on (test knob): a mission "Weekly dependency
// updates · …" is in the Backlog, queued and ready; its Done-when lists U1–U3; its header says "From routine: …".
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { DEPS, HOUR, advance, backlogRows, clockNow, createRoutine, hhmm, missionsFrom, openBacklog, openLast, openRoutines, routineOf, routineRow, waitRow, writeState } from '../common.mjs';

const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('L1', 'A daily routine adds a queued, ready mission when its time comes');

const now = await clockNow(c);
const at = hhmm(now + HOUR);
ev.note(`daemon clock ${new Date(now).toString()}; routine set to every day at ${at}`);
await createRoutine(c, DEPS, async () => {
  const dialog = await page.text('[role=dialog]');
  ev.check('the dialog offers the three starters', ['Weekly dependency updates', 'Nightly: fix failing checks', 'Weekly status report'].every((t) => dialog.includes(t)), dialog.slice(0, 200));
  const lines = await page.evaluate(`[...document.querySelectorAll('[role=dialog] textarea')].map((t) => t.value)`);
  ev.check('the template filled the goal and three Done-when lines', lines.length === 2 && lines[0].startsWith('Update the project') && lines[1].split('\n').length === 3, lines);
  await page.screenshot(ev.shot('template-filled'));
  await page.click('Every day');
  await page.fill('Time', at);
  await sleep(300);
});
await openRoutines(c);
const row = await waitRow(c, DEPS, 'Next: ');
ev.check(`the row reads "Every day at ${at} · Next: …" and "Has not run yet."`, row.includes(`Every day at ${at}`) && /Next: \w{3} \d\d:\d\d/.test(row) && row.includes('Has not run yet.'), row);
await page.screenshot(ev.shot('routine-next-run'));
const view = await routineOf(c, DEPS);
const next = Date.parse(view.routine.nextRunAt);
ev.check('proof (API): the next run is about an hour ahead on the daemon\'s clock', next > now && next - now <= HOUR + 60_000, { now: new Date(now).toISOString(), next: view.routine.nextRunAt });
ev.check('proof (SQL): no mission yet', missionsFrom(c, view.routine.id).length === 0);

await advance(c, 2 * HOUR);
const after = await waitRow(c, DEPS, `Last: Created “${DEPS} · `);
ev.check(`after the clock moves on, the row reads "Last: Created “${DEPS} · …”"`, after.includes(`Last: Created “${DEPS} · `), after);
ev.check('and the next run is tomorrow', /Next: \w{3} \d\d:\d\d/.test(after), after);
await page.screenshot(ev.shot('routine-created-mission'));
const made = missionsFrom(c, view.routine.id);
ev.check('proof (SQL): one mission, a queued DRAFT, normal priority', made.length === 1 && made[0].status === 'DRAFT' && made[0].queued_at !== null && made[0].priority === 'normal', made);
const missionId = made[0]?.id;
const title = made[0]?.title ?? '';

await openBacklog(c);
const rows = await backlogRows(c);
const inBacklog = rows.find((r) => r.title === title);
ev.check(`the Backlog lists "${title}" as Ready and "Queued · 1/1"`, inBacklog?.readiness === 'Ready' && inBacklog?.queue === 'Queued · 1/1', rows);
await page.screenshot(ev.shot('backlog-queued'));

await openRoutines(c);
await openLast(c, DEPS);
await until(async () => (await page.evaluate('location.hash')) === `#/missions/${missionId}`, { label: 'mission page', timeoutMs: 15_000 });
await page.waitForText('From routine: Weekly dependency updates', { timeoutMs: 15_000 }).catch(() => undefined);
const body = await page.text('body');
ev.check('the mission header says "From routine: Weekly dependency updates"', body.includes('From routine: Weekly dependency updates'), body.slice(0, 400));
const doneWhen = await page.evaluate(`document.querySelector('section[aria-label="Done when"]')?.innerText ?? ''`);
ev.check('its Done when lists U1–U3 with the template\'s lines', ['U1', 'U2', 'U3', 'The test suite passes after the updates'].every((t) => doneWhen.includes(t)), doneWhen);
await page.screenshot(ev.shot('mission-from-routine'));
const criteria = await api.get(`/v1/missions/${missionId}/criteria`);
ev.check('proof (API): the ledger is U1, U2, U3 from the routine', criteria.map((k) => k.key).join(',') === 'U1,U2,U3', criteria.map((k) => `${k.key} ${k.statement}`));
const raw = await api.get(`/v1/missions/${missionId}/events`);
const events = (Array.isArray(raw) ? raw : raw.events ?? raw.items ?? []).map((e) => e.body?.text ?? '');
ev.check('proof (API): the timeline says which routine made it', events.some((t) => t.startsWith('Created by the routine “Weekly dependency updates” (')), events.filter(Boolean).slice(0, 4));

writeState({ l1: { routineId: view.routine.id, missionId, title } });
c.close(); ev.save();
