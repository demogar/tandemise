// L4 — Turn the routine off; move the clock two days on: the row reads "Paused" and no mission is added. Turn it
// back on: it shows a next run after now, and nothing is caught up.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { DAY, DEPS, advance, clickInRoutine, deleteInWindow, clockNow, missionsFrom, openRoutines, readState, routineOf, waitRow } from '../common.mjs';

const c = await context();
const { page, sleep } = c;
const ev = new Evidence('L4', 'A routine that is off never fires, and turning it on catches nothing up');
const { l1, l3 } = readState();
if (!l1 || !l3) throw new Error('L4 needs L1 and L3 first');

// Not coalescing: with its last mission deleted, only "off" can be why nothing is added.
await deleteInWindow(c, l3.secondMissionId);
await openRoutines(c);
await clickInRoutine(c, DEPS, 'Enabled');
const off = await waitRow(c, DEPS, 'Paused');
ev.check('the switch turns it off: the row reads "Off" and "Paused"', off.includes('Paused') && off.includes('Off'), off);
const count = missionsFrom(c, l1.routineId).length;
const runsBefore = c.sql('SELECT COUNT(*) AS n FROM routine_runs WHERE routine_id = ?', l1.routineId)[0].n;
ev.check('proof (API): no next run while off', (await routineOf(c, DEPS)).routine.nextRunAt === null);

await advance(c, 2 * DAY);
await openRoutines(c);
await sleep(1500);
const still = await waitRow(c, DEPS, 'Paused');
ev.check('two days later it still reads "Paused"', still.includes('Paused'), still);
await page.screenshot(ev.shot('paused-two-days'));
ev.check('proof (SQL): no mission and no run while it was off', missionsFrom(c, l1.routineId).length === count && c.sql('SELECT COUNT(*) AS n FROM routine_runs WHERE routine_id = ?', l1.routineId)[0].n === runsBefore);

await clickInRoutine(c, DEPS, 'Enabled');
const on = await waitRow(c, DEPS, 'Next: ');
ev.check('turned on: the row reads "On" and "Next: …"', on.includes('Next: ') && on.includes('On'), on);
await page.screenshot(ev.shot('turned-on'));
const now = await clockNow(c);
const view = await routineOf(c, DEPS);
ev.check('proof (API): the next run is after now, within a day', Date.parse(view.routine.nextRunAt) > now && Date.parse(view.routine.nextRunAt) - now <= DAY, { now: new Date(now).toISOString(), next: view.routine.nextRunAt });
await sleep(4000);
ev.check('proof (SQL): turning it on caught nothing up', missionsFrom(c, l1.routineId).length === count && c.sql('SELECT COUNT(*) AS n FROM routine_runs WHERE routine_id = ?', l1.routineId)[0].n === runsBefore);
c.close(); ev.save();
