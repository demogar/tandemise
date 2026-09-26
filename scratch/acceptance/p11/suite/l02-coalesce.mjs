// L2 — The clock moves a day on while L1's mission is still queued: the row reads "Skipped: previous run still
// active", there is still one mission from the routine, and that mission's timeline says why.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { DAY, DEPS, advance, missionsFrom, openRoutines, readState, timelineText, waitRow } from '../common.mjs';

const c = await context();
const { page } = c;
const ev = new Evidence('L2', 'A run is skipped while the previous mission from the routine is unfinished');
const { l1 } = readState();
if (!l1) throw new Error('L2 needs L1 first');

ev.check('before: L1\'s mission is still a queued draft', c.sql('SELECT status FROM missions WHERE id = ?', l1.missionId)[0]?.status === 'DRAFT');
await advance(c, DAY);
await openRoutines(c);
const row = await waitRow(c, DEPS, 'Skipped: previous run still active');
ev.check('the row reads "Skipped: previous run still active"', row.includes('Skipped: previous run still active'), row);
ev.check('the run before it is still listed ("Earlier: Created …")', row.includes(`Earlier: Created “${l1.title}”`), row);
await page.screenshot(ev.shot('skipped-previous-active'));
const made = missionsFrom(c, l1.routineId);
ev.check('proof (SQL): still one mission from the routine', made.length === 1, made);
const runs = c.sql('SELECT outcome, trigger, mission_id FROM routine_runs WHERE routine_id = ? ORDER BY ran_at DESC, rowid DESC', l1.routineId);
ev.check('proof (SQL): the skip is a routine_runs row pointing at the unfinished mission', runs[0]?.outcome === 'skipped_active' && runs[0]?.mission_id === l1.missionId, runs);
const timeline = await timelineText(c, l1.missionId);
ev.check('the unfinished mission\'s timeline says the routine skipped a run', timeline.includes('The routine “Weekly dependency updates” skipped its') && timeline.includes('this mission is not finished yet'), timeline.slice(0, 900));
await page.screenshot(ev.shot('timeline-skip-note'));
c.close(); ev.save();
