// L3 — Delete L1's queued draft in the window, then "Run now": a second mission is added and queued. Then a
// "Weekly status report" routine from its template, "Run now": the row reads "Wrote status report v1" and opens it.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { DEPS, REPORT, backlogRows, clickInRoutine, deleteInWindow, createRoutine, missionsFrom, openBacklog, openLast, openRoutines, readState, routineOf, waitRow, writeState } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('L3', 'Run now adds a mission through the same checks; a status report routine writes the report');
const { l1 } = readState();
if (!l1) throw new Error('L3 needs L1 first');

await deleteInWindow(c, l1.missionId);
ev.check('L1\'s queued draft is deleted in the window', c.sql('SELECT COUNT(*) AS n FROM missions WHERE id = ?', l1.missionId)[0].n === 0);
const before = await routineOf(c, DEPS);
await openRoutines(c);
await clickInRoutine(c, DEPS, 'Run now');
const row = await waitRow(c, DEPS, `Last: Created “${DEPS} · `);
ev.check('after "Run now" the row reads "Last: Created “…”"', row.includes(`Last: Created “${DEPS} · `), row);
await page.screenshot(ev.shot('run-now-created'));
const made = missionsFrom(c, l1.routineId);
const second = made.find((m) => m.id !== l1.missionId);
ev.check('proof (SQL): a new mission, a queued DRAFT', made.length === 1 && second?.status === 'DRAFT' && second?.queued_at !== null, made);
const after = await routineOf(c, DEPS);
ev.check('proof (API): Run now did not move the schedule', after.routine.nextRunAt === before.routine.nextRunAt, [before.routine.nextRunAt, after.routine.nextRunAt]);
ev.check('proof (SQL): recorded as a manual run', c.sql('SELECT trigger FROM routine_runs WHERE routine_id = ? ORDER BY ran_at DESC, rowid DESC LIMIT 1', l1.routineId)[0]?.trigger === 'manual');
await openBacklog(c);
const rows = await backlogRows(c);
ev.check('the Backlog lists it as Ready and queued', rows.some((r) => r.title === second?.title && r.readiness === 'Ready' && r.queue.startsWith('Queued')), rows);

await createRoutine(c, REPORT, async () => {
  const dialog = await page.text('[role=dialog]');
  ev.check('the report template says no agent runs and asks for no Done-when lines', dialog.includes('No agent runs') && !dialog.includes('Done when (one per line)'), dialog.slice(0, 600));
  await page.screenshot(ev.shot('report-template'));
});
await openRoutines(c);
const reportRow = await waitRow(c, REPORT, 'Every Friday at 16:00');
ev.check('the report routine reads "Every Friday at 16:00 · Next: …"', reportRow.includes('Every Friday at 16:00') && reportRow.includes('Next: Fri'), reportRow);
await clickInRoutine(c, REPORT, 'Run now');
const reported = await waitRow(c, REPORT, 'Last: Wrote status report v1');
ev.check('after "Run now" the row reads "Last: Wrote status report v1"', reported.includes('Last: Wrote status report v1'), reported);
await page.screenshot(ev.shot('report-written'));
await openLast(c, REPORT);
await until(async () => /#\/artifacts\/art_/.test(await page.evaluate('location.hash')), { label: 'reader', timeoutMs: 15_000 });
await until(async () => (await page.evaluate(`document.querySelector('.reader__pane')?.innerText ?? ''`)).includes('How this report was made'), { label: 'report text', timeoutMs: 15_000 });
await sleep(500);
const reader = await page.evaluate(`document.querySelector('.reader__pane')?.innerText ?? ''`);
ev.check('the link opens the status report in the reader', reader.includes('At a glance') && reader.includes('No model wrote it.'), reader.slice(0, 300));
await page.screenshot(ev.shot('report-in-reader'));
const report = await routineOf(c, REPORT);
const art = c.sql('SELECT type FROM artifacts WHERE id = ?', report.routine.lastArtifactId)[0];
ev.check('proof (SQL): a StatusReport artifact', art?.type === 'StatusReport', art);
writeState({ l3: { secondMissionId: second?.id, reportRoutineId: report.routine.id } });
c.close(); ev.save();
