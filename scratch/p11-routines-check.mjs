// P11: routines. Standing work (weekly dependency updates, nightly failing
// checks, a weekly status report) adds itself to the backlog on a simple
// schedule, ready to plan, with its Done-when lines, priority and limits. It
// never plans or runs anything itself: the readiness gate, the WIP limit and
// the monthly hard limit still decide.
//
//   npm run build && node scratch/p11-routines-check.mjs
//
// Runs in America/New_York so daylight saving changes are real. Pure schedule
// maths and decisions first, then the engine with a clock the check moves by
// hand (real SQLite, real services, no scheduler thread), then a real daemon
// with the test clock knob (TANDEMISE_CLOCK_OFFSET_MS), restarted to prove a
// catch-up after downtime.
process.env.TZ = 'America/New_York';

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 700)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const D = await import('@tandemise/domain');
const app = await import('@tandemise/application');
const A = await import('@tandemise/artifacts');

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ------------------------------------------------------------------ pure schedule
section('pure: schedules in the daemon\'s local time zone');
{
  check('the check runs in America/New_York', new Date(local(2026, 7, 1)).getTimezoneOffset() === 240 && new Date(local(2026, 12, 1)).getTimezoneOffset() === 300);
  const daily = { type: 'daily', at: '09:00' };
  // Monday 28 September 2026, 08:00.
  const mon8 = local(2026, 9, 28, 8, 0);
  check('daily: later the same day', D.firstSlotAfter(daily, mon8) === local(2026, 9, 28, 9, 0), iso(D.firstSlotAfter(daily, mon8)));
  check('daily: exactly at the slot moves to the next day (strictly after)', D.firstSlotAfter(daily, local(2026, 9, 28, 9, 0)) === local(2026, 9, 29, 9, 0));
  check('daily: after the time, tomorrow', D.firstSlotAfter(daily, local(2026, 9, 28, 17, 0)) === local(2026, 9, 29, 9, 0));
  check('daily: across the month end', D.firstSlotAfter(daily, local(2026, 9, 30, 10, 0)) === local(2026, 10, 1, 9, 0));
  const weekly = { type: 'weekly', day: 1, at: '09:00' }; // Monday
  check('weekly: Monday 09:00 from Monday 08:00 is today', D.firstSlotAfter(weekly, mon8) === local(2026, 9, 28, 9, 0));
  check('weekly: from Monday 10:00 is next Monday', D.firstSlotAfter(weekly, local(2026, 9, 28, 10, 0)) === local(2026, 10, 5, 9, 0));
  check('weekly: Friday 16:00 from Saturday is next Friday', D.firstSlotAfter({ type: 'weekly', day: 5, at: '16:00' }, local(2026, 9, 26, 12, 0)) === local(2026, 10, 2, 16, 0));
  const every6 = { type: 'hourly', every: 6 };
  check('every 6 hours: six hours after', D.firstSlotAfter(every6, mon8) === mon8 + 6 * HOUR);

  // Clocks go forward 2027-03-14 at 02:00 (to 03:00): 02:30 does not exist that day.
  const nightly = { type: 'daily', at: '02:30' };
  const gap = D.firstSlotAfter(nightly, local(2027, 3, 13, 12, 0));
  check('spring forward: 02:30 on the gap day fires at 03:30 EDT (07:30Z)', iso(gap) === '2027-03-14T07:30:00.000Z', iso(gap));
  check('spring forward: the day after is 02:30 EDT again', iso(D.firstSlotAfter(nightly, gap)) === '2027-03-15T06:30:00.000Z', iso(D.firstSlotAfter(nightly, gap)));
  check('spring forward: the day before is 02:30 EST', iso(D.firstSlotAfter(nightly, local(2027, 3, 12, 12, 0))) === '2027-03-13T07:30:00.000Z');
  // Clocks go back 2026-11-01 at 02:00 (to 01:00): 01:30 happens twice.
  const late = { type: 'daily', at: '01:30' };
  const first = D.firstSlotAfter(late, local(2026, 10, 31, 12, 0));
  check('fall back: 01:30 fires at its first occurrence (05:30Z, EDT)', iso(first) === '2026-11-01T05:30:00.000Z', iso(first));
  const second = D.firstSlotAfter(late, first);
  check('fall back: and not again an hour later; next is 01:30 EST the next day', iso(second) === '2026-11-02T06:30:00.000Z', iso(second));
  check('fall back: from inside the repeated hour, still the next day', D.firstSlotAfter(late, first + HOUR) === second);
  // Elapsed time: six real hours even across the changes.
  const beforeSpring = local(2027, 3, 13, 23, 0);
  check('every 6 hours across spring forward is 6 real hours', D.firstSlotAfter(every6, beforeSpring) - beforeSpring === 6 * HOUR);
  const beforeFall = local(2026, 10, 31, 23, 0);
  check('every 6 hours across fall back is 6 real hours', D.firstSlotAfter(every6, beforeFall) - beforeFall === 6 * HOUR);
  const weeklyAcross = { type: 'weekly', day: 0, at: '09:00' }; // Sunday
  check('weekly across fall back keeps the wall clock (09:00 EST, 14:00Z)', iso(D.firstSlotAfter(weeklyAcross, local(2026, 10, 25, 10, 0))) === '2026-11-01T14:00:00.000Z');

  // Due slots: everything from the stored next run up to now.
  const due1 = D.dueSlots(daily, local(2026, 9, 28, 9, 0), local(2026, 9, 28, 9, 0));
  check('due: exactly at the slot is one due slot', due1.count === 1 && due1.nextMs === local(2026, 9, 29, 9, 0), due1);
  const due0 = D.dueSlots(daily, local(2026, 9, 28, 9, 0), local(2026, 9, 28, 8, 59));
  check('due: before the slot, none, and the next run stays', due0.count === 0 && due0.nextMs === local(2026, 9, 28, 9, 0), due0);
  const due4 = D.dueSlots(daily, local(2026, 9, 28, 9, 0), local(2026, 10, 1, 10, 0));
  check('due: four days of downtime is four slots, next is tomorrow 09:00', due4.count === 4 && due4.firstMs === local(2026, 9, 28, 9, 0) && due4.lastMs === local(2026, 10, 1, 9, 0) && due4.nextMs === local(2026, 10, 2, 9, 0), due4);
  const dueDst = D.dueSlots(nightly, local(2027, 3, 13, 2, 30), local(2027, 3, 15, 3, 0));
  check('due: across spring forward three nightly slots, each once', dueDst.count === 3, dueDst);
  const dueYears = D.dueSlots(every6, mon8, mon8 + 400 * DAY);
  check('due: a long downtime is counted without firing more than once', dueYears.count === 1601 && dueYears.nextMs > mon8 + 400 * DAY, dueYears.count);

  check('schedule words', D.scheduleLabel(daily) === 'Every day at 09:00' && D.scheduleLabel(weekly) === 'Every Monday at 09:00' && D.scheduleLabel(every6) === 'Every 6 hours' && D.scheduleLabel({ type: 'hourly', every: 1 }) === 'Every hour', [D.scheduleLabel(daily), D.scheduleLabel(weekly), D.scheduleLabel(every6)]);
  check('next-run words within a week', D.nextRunLabel(local(2026, 10, 4, 9, 0), mon8) === 'Next: Sun 09:00', D.nextRunLabel(local(2026, 10, 4, 9, 0), mon8));
  check('next-run words a week or more away name the date', D.nextRunLabel(local(2026, 10, 5, 9, 0), mon8) === 'Next: Mon 5 Oct 09:00', D.nextRunLabel(local(2026, 10, 5, 9, 0), mon8));
  check('a paused routine has no next run', D.nextRunLabel(null, mon8) === 'Paused');
  check('mission title carries the run\'s day', D.routineMissionTitle('Weekly dependency updates', local(2026, 9, 28, 9, 0)) === 'Weekly dependency updates · Mon 28 Sep');
  check('{date} in the goal is the local date', D.routineGoal('Bump deps ({date})', local(2026, 9, 28, 23, 30)) === 'Bump deps (2026-09-28)');
  check('schedule validation', D.scheduleProblem({ type: 'daily', at: '25:00' }) !== null && D.scheduleProblem({ type: 'hourly', every: 5 }) !== null && D.scheduleProblem({ type: 'weekly', day: 7, at: '09:00' }) !== null && D.scheduleProblem(daily) === null);
  const source = readFileSync(join(here, '../packages/domain/dist/entities/routine.js'), 'utf8');
  check('the schedule maths read no clock', !/Date\.now\(|new Date\(\)/.test(source));
  const mirror = readFileSync(join(here, '../apps/desktop/src/renderer/src/lib/domain.ts'), 'utf8').replace(/\\'/g, "'");
  check('the window\'s copy of the templates says the same words', D.ROUTINE_TEMPLATES.every((t) => [t.name, t.goal, t.description, ...t.successCriteria].every((w) => mirror.includes(w)) && mirror.includes(`at: '${t.schedule.at ?? ''}'`)));
  check('three starter templates, each with Done-when lines', D.ROUTINE_TEMPLATES.length === 3 && eq(D.ROUTINE_TEMPLATES.map((t) => t.name), ['Weekly dependency updates', 'Nightly: fix failing checks', 'Weekly status report']) && D.ROUTINE_TEMPLATES.every((t) => t.successCriteria.length >= 2 && D.scheduleProblem(t.schedule) === null));
}

section('pure: what a due routine does');
{
  const run = D.decideRoutineRun({ kind: 'mission', due: 1, previousActive: false, limitReason: null });
  check('one due slot runs', run.action === 'run' && run.missed === 0, run);
  const catchUp = D.decideRoutineRun({ kind: 'mission', due: 4, previousActive: false, limitReason: null });
  check('four due slots: one catch-up run, three missed', catchUp.action === 'run' && catchUp.missed === 3, catchUp);
  const active = D.decideRoutineRun({ kind: 'mission', due: 1, previousActive: true, limitReason: null });
  check('previous mission active: skipped, noted', active.action === 'skip' && active.outcome === 'skipped_active' && active.detail === 'Skipped: previous run still active', active);
  const activeCatchUp = D.decideRoutineRun({ kind: 'mission', due: 3, previousActive: true, limitReason: null });
  check('the catch-up is skipped too when the previous is active; the rest still missed', activeCatchUp.action === 'skip' && activeCatchUp.missed === 2, activeCatchUp);
  const limit = D.decideRoutineRun({ kind: 'mission', due: 1, previousActive: false, limitReason: 'Monthly limit reached: this project used 61 of 60 agent minutes this month' });
  check('monthly hard limit: skipped, noted with the reason', limit.action === 'skip' && limit.outcome === 'skipped_limit' && limit.detail === 'Skipped: Monthly limit reached: this project used 61 of 60 agent minutes this month', limit);
  check('nothing due, nothing done', D.decideRoutineRun({ kind: 'mission', due: 0, previousActive: false, limitReason: null }).action === 'none');
  check('a status report ignores coalescing and the limit (it runs no agent)', D.decideRoutineRun({ kind: 'status_report', due: 1, previousActive: true, limitReason: 'Limit reached' }).action === 'run');
  check('missed words name the count and the span', D.missedNote(3, local(2026, 9, 28, 9, 0), local(2026, 9, 30, 9, 0)) === 'Missed 3 runs while Tandemise was not running (Mon 09:00 to Wed 09:00); ran once to catch up.', D.missedNote(3, local(2026, 9, 28, 9, 0), local(2026, 9, 30, 9, 0)));
  check('one missed run in the singular', D.missedNote(1, local(2026, 9, 28, 9, 0), local(2026, 9, 28, 9, 0)).startsWith('Missed 1 run while Tandemise was not running (Mon 09:00);'));
}

// ------------------------------------------------------------ the engine, hand-moved clock
async function engineHarness(HOME, clock) {
  const { Container, compose } = await import('@tandemise/kernel');
  const { createLogger, createPaths } = await import('@tandemise/shared');
  const persistenceTokens = await import('@tandemise/persistence');
  const { policyModule } = await import('@tandemise/policy');
  const { contextModule } = await import('@tandemise/context');
  const { createEvaluationModule } = await import('@tandemise/evaluation');
  const { runtimesCoreModule } = await import('@tandemise/runtimes-core');
  const { genericRuntimeModule } = await import('@tandemise/runtime-generic');
  const { executionCoreModule, CLOCK: EXEC_CLOCK, LOGGER: EXEC_LOGGER, PATHS: EXEC_PATHS } = await import('@tandemise/execution-core');
  const { executionLocalModule } = await import('@tandemise/execution-local');
  const { integrationsCoreModule, CLOCK: INT_CLOCK, LOGGER: INT_LOGGER, COMMAND_EXECUTOR, BACKGROUND_PROCESS_LAUNCHER } = await import('@tandemise/integrations-core');
  const paths = createPaths(HOME);
  mkdirSync(paths.root, { recursive: true });
  const log = createLogger({ level: 'error', base: { component: 'p11-check' } });
  const container = new Container();
  compose(
    container,
    persistenceTokens.persistenceModule({ path: paths.db, logger: log, clock }),
    A.createArtifactsModule({ paths }),
    policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
    executionCoreModule, executionLocalModule, integrationsCoreModule, app.createApplicationModule({ localPersonName: 'Demo' }),
  );
  container.bind(EXEC_CLOCK, () => clock, { source: 'check' });
  container.bind(EXEC_LOGGER, () => log, { source: 'check' });
  container.bind(EXEC_PATHS, () => paths, { source: 'check' });
  container.bind(INT_CLOCK, () => clock, { source: 'check' });
  container.bind(INT_LOGGER, () => log, { source: 'check' });
  container.bind(COMMAND_EXECUTOR, () => ({ run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }), { source: 'check' });
  container.bind(BACKGROUND_PROCESS_LAUNCHER, () => ({ launch: async () => { throw new Error('unused'); } }), { source: 'check' });
  const isToken = (v) => typeof v === 'object' && v !== null && typeof v.description === 'string';
  for (const name of Object.keys(app)) {
    const appToken = app[name]; const provider = persistenceTokens[name];
    if (!isToken(appToken) || !isToken(provider)) continue;
    if (!container.has(provider) || container.has(appToken)) continue;
    container.bind(appToken, (r) => r.resolve(provider), { source: `alias:${name}` });
  }
  container.bind(app.ARTIFACT_STORE, (r) => r.resolve(A.ARTIFACT_STORE), { source: 'alias' });
  container.bind(app.ARTIFACT_TEMPLATES, () => ({ render: A.renderArtifactTemplate }), { source: 'check' });
  container.bind(app.ARTIFACT_PARSER, () => ({ parse: A.parseArtifact }), { source: 'check' });
  container.bind(app.ARTIFACT_MEASURE, () => ({ measure: A.measureArtifact, deriveHandoff: A.deriveHandoff, splitAppendix: A.splitAppendix }), { source: 'check' });
  container.bind(app.EVENT_BUS, () => ({ publish: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.PROJECTION_BUS, () => ({ invalidate: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.SECRET_STORE, () => ({ backend: 'memory', store: async () => 'x', resolve: async () => undefined, remove: async () => {}, list: async () => [] }), { source: 'check' });
  container.bind(app.SETTINGS_STORE, () => app.createMemorySettingsStore(), { source: 'check' });
  container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home: HOME, schemaVersion: 1 }), { source: 'check' });
  container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });
  const services = app.createServices(container);
  const repo = {
    workspaces: container.resolve(app.WORKSPACE_REPOSITORY),
    missions: container.resolve(app.MISSION_REPOSITORY),
    criteria: container.resolve(app.MISSION_CRITERIA_REPOSITORY),
    questions: container.resolve(app.MISSION_QUESTION_REPOSITORY),
    events: container.resolve(app.EVENT_REPOSITORY),
    routines: container.resolve(app.ROUTINE_REPOSITORY),
  };
  const db = container.resolve(persistenceTokens.DATABASE);
  return { container, services, repo, db };
}

section('engine: a routine fires from the injected clock, once per slot, and never past a gate');
{
  const keepAlive = setInterval(() => {}, 1000);
  const HOME = mkdtempSync(join(tmpdir(), 'tdr-'));
  // Monday 28 September 2026, 08:00 local. Moved only by this check.
  const clock = { ms: local(2026, 9, 28, 8, 0), now() { return new Date(this.ms).toISOString(); }, epochMs() { return this.ms; } };
  const at = (ms) => { clock.ms = ms; };
  const h = await engineHarness(HOME, clock);
  try {
    const caller = { personId: h.services.identity.localPerson().id };
    const ws = (await h.services.workspaces.create(caller, { name: 'Routines' })).workspace.id;
    const R = h.services.routines;
    const fromRoutine = (id) => h.repo.missions.list({ workspaceId: ws }).filter((m) => m.routineId === id);
    const runsOf = (id) => h.repo.routines.recentRuns(id, 50);

    let refused = null;
    try { R.create(caller, ws, { name: 'No criteria', kind: 'mission', goal: 'Do the weekly thing', successCriteria: [' '], schedule: { type: 'daily', at: '09:00' } }); } catch (e) { refused = e; }
    check('a mission routine without a Done-when line is refused', refused?.code === 'VALIDATION' && /Done-when/.test(refused.message), refused?.message);
    let badSchedule = null;
    try { R.create(caller, ws, { name: 'Odd', kind: 'mission', goal: 'Do it', successCriteria: ['It is done'], schedule: { type: 'hourly', every: 5 } }); } catch (e) { badSchedule = e; }
    check('a schedule outside the presets is refused', badSchedule?.code === 'VALIDATION', badSchedule?.message);

    const limits = [{ metric: 'agent_minutes', amount: 30, warnPercent: 80 }];
    const deps = R.create(caller, ws, {
      name: 'Weekly dependency updates', kind: 'mission', goal: 'Update the dependencies ({date})',
      successCriteria: ['Every dependency is current', 'The tests pass'], priority: 'high', limits,
      schedule: { type: 'daily', at: '09:00' },
    });
    const id = deps.routine.id;
    check('created: next run is today 09:00', deps.routine.nextRunAt === iso(local(2026, 9, 28, 9, 0)) && deps.nextRunLabel === 'Next: Mon 09:00', deps);
    check('created: schedule words', deps.scheduleLabel === 'Every day at 09:00');

    at(local(2026, 9, 28, 8, 59));
    await R.tick();
    check('a tick before the time does nothing', fromRoutine(id).length === 0 && runsOf(id).length === 0);

    at(local(2026, 9, 28, 9, 0));
    await R.tick();
    const [m1] = fromRoutine(id);
    check('at the time: one mission', fromRoutine(id).length === 1, fromRoutine(id).map((m) => m.title));
    check('it is a queued DRAFT (the backlog decides the rest)', m1?.status === 'DRAFT' && m1?.queuedAt !== null, m1);
    check('title, goal, priority and limits come from the routine', m1?.title === 'Weekly dependency updates · Mon 28 Sep' && m1?.goal === 'Update the dependencies (2026-09-28)' && m1?.priority === 'high' && eq(m1?.limits, limits), m1);
    const ledger = h.repo.criteria.listActive(m1.id).map((c) => `${c.key} ${c.statement}`);
    check('Done-when lines are U1…Un (P5)', eq(ledger, ['U1 Every dependency is current', 'U2 The tests pass']), ledger);
    check('so it is ready to plan by construction (P6)', h.services.readiness?.evaluate?.(m1.id)?.ready ?? h.container.resolve(app.READINESS_SERVICE).evaluate(m1.id).ready);
    const view1 = R.list(ws).find((v) => v.routine.id === id);
    check('the routine moved on to tomorrow 09:00', view1.routine.nextRunAt === iso(local(2026, 9, 29, 9, 0)) && view1.nextRunLabel === 'Next: Tue 09:00', view1.routine.nextRunAt);
    check('last outcome names the mission', view1.lastLabel === 'Created “Weekly dependency updates · Mon 28 Sep”' && view1.routine.lastMissionId === m1.id, view1.lastLabel);
    const notes = h.repo.events.listByMission(m1.id).map((e) => e.body?.text ?? '').join(' | ');
    check('the mission\'s timeline says which routine made it', notes.includes('Created by the routine “Weekly dependency updates” (Mon 09:00 run).'), notes);

    await R.tick();
    check('ticking again at the same instant does nothing', fromRoutine(id).length === 1 && runsOf(id).length === 1);

    // Coalesce: the previous one is still a queued draft.
    at(local(2026, 9, 29, 9, 0));
    await R.tick();
    const view2 = R.list(ws).find((v) => v.routine.id === id);
    check('previous run still active: skipped, no second mission', fromRoutine(id).length === 1 && view2.lastLabel === 'Skipped: previous run still active', view2.lastLabel);
    check('the skip is a routine run row', runsOf(id)[0]?.outcome === 'skipped_active');
    const noteOnPrevious = h.repo.events.listByMission(m1.id).map((e) => e.body?.text ?? '').join(' | ');
    check('and a note on the unfinished mission', noteOnPrevious.includes('skipped its Tue 09:00 run: this mission is not finished yet'), noteOnPrevious);

    // Downtime: cancelled, then nothing ran from Wednesday to Friday.
    await h.services.missions.cancel(m1.id);
    at(local(2026, 10, 2, 10, 0));
    await R.tick();
    check('after three days down: exactly one catch-up mission', fromRoutine(id).length === 2, fromRoutine(id).map((m) => m.title));
    const recent = runsOf(id);
    check('the other two are one "missed" row, noted', recent[1]?.outcome === 'missed' && recent[1]?.skippedCount === 2 && recent[1]?.detail === 'Missed 2 runs while Tandemise was not running (Wed 09:00 to Thu 09:00); ran once to catch up.', recent.slice(0, 2));
    check('the catch-up is the newest row', recent[0]?.outcome === 'created');
    check('next run is tomorrow 09:00, not a backlog of slots', R.list(ws).find((v) => v.routine.id === id).routine.nextRunAt === iso(local(2026, 10, 3, 9, 0)));

    // Re-entrant ticks never fire one slot twice.
    for (const m of fromRoutine(id)) if (m.status === 'DRAFT') await h.services.missions.cancel(m.id);
    at(local(2026, 10, 3, 9, 0));
    await Promise.all([R.tick(), R.tick(), R.tick()]);
    check('three overlapping ticks create one mission', fromRoutine(id).length === 3, fromRoutine(id).length);

    // Paused means paused.
    for (const m of fromRoutine(id)) if (m.status === 'DRAFT') await h.services.missions.cancel(m.id);
    const off = R.update(id, { enabled: false });
    check('turned off: no next run, "Paused"', off.routine.nextRunAt === null && off.nextRunLabel === 'Paused', off);
    at(local(2026, 10, 6, 12, 0));
    await R.tick();
    check('a paused routine never fires', fromRoutine(id).length === 3);
    const on = R.update(id, { enabled: true });
    check('turned on: next run is the first slot after now, nothing caught up', on.routine.nextRunAt === iso(local(2026, 10, 7, 9, 0)), on.routine.nextRunAt);
    await R.tick();
    check('and nothing fires on turning it on', fromRoutine(id).length === 3);

    // The monthly hard limit (P8) skips the run.
    h.repo.workspaces.update(ws, { monthlyLimits: [{ metric: 'agent_minutes', amount: 1, warnPercent: 80 }] });
    h.db.handle.pragma('foreign_keys = OFF');
    const any = fromRoutine(id)[0];
    h.db.handle.prepare('INSERT INTO usage_records (run_id, mission_id, wall_time_ms, recorded_at) VALUES (?, ?, ?, ?)').run('run_fake', any.id, 5 * 60_000, iso(local(2026, 10, 6, 11, 0)));
    h.db.handle.pragma('foreign_keys = ON');
    at(local(2026, 10, 7, 9, 0));
    await R.tick();
    const limited = R.list(ws).find((v) => v.routine.id === id);
    check('at the monthly hard limit: skipped, noted with the reason, no mission', fromRoutine(id).length === 3 && limited.routine.lastOutcome === 'skipped_limit' && limited.lastLabel.startsWith('Skipped: Monthly limit reached: this project used 5 of 1 agent minute'), limited.lastLabel);
    const nowRefused = await R.runNow(caller, id);
    check('Run now obeys the limit too', nowRefused.routine.lastOutcome === 'skipped_limit' && fromRoutine(id).length === 3);
    check('Run now does not move the schedule', nowRefused.routine.nextRunAt === iso(local(2026, 10, 8, 9, 0)), nowRefused.routine.nextRunAt);
    h.repo.workspaces.update(ws, { monthlyLimits: [] });
    const manual = await R.runNow(caller, id);
    check('limit lifted: Run now creates a queued draft', fromRoutine(id).length === 4 && manual.routine.lastOutcome === 'created', manual.lastLabel);
    check('the manual run is recorded as manual', runsOf(id)[0]?.trigger === 'manual');
    const again = await R.runNow(caller, id);
    check('Run now obeys coalescing', again.routine.lastOutcome === 'skipped_active' && fromRoutine(id).length === 4);

    // The readiness gate and the WIP limit still decide (P6, P7).
    const drafted = fromRoutine(id).find((m) => m.status === 'DRAFT');
    await h.services.backlog.pull();
    check('WIP limit off: the routine\'s mission stays a queued draft', h.repo.missions.get(drafted.id).status === 'DRAFT');
    const busy = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Something else in progress', successCriteria: ['Done'] });
    h.repo.missions.update(busy.id, { status: 'EXECUTING' });
    h.repo.workspaces.update(ws, { maxActiveMissions: 1 });
    await h.services.backlog.pull();
    check('WIP full: still a queued draft', h.repo.missions.get(drafted.id).status === 'DRAFT');
    h.db.handle.pragma('foreign_keys = OFF');
    const [question] = h.repo.questions.replaceOpen(drafted.id, 'art_fake', [{ text: 'Which package manager?', why: 'The lockfile differs.', options: [] }]);
    h.db.handle.pragma('foreign_keys = ON');
    h.repo.missions.update(busy.id, { status: 'CANCELLED' });
    const readiness = h.container.resolve(app.READINESS_SERVICE);
    check('an open question makes it not ready', readiness.evaluate(drafted.id).ready === false);
    await h.services.backlog.pull();
    check('room under the WIP limit, but not ready: not pulled', h.repo.missions.get(drafted.id).status === 'DRAFT');
    h.repo.questions.answer(question.id, 'npm', 'check');
    await h.services.backlog.pull();
    const pulled = h.repo.events.listByMission(drafted.id).some((e) => e.body?.type === 'mission.pulled');
    check('answered and room: pulled by the backlog, not by the routine', pulled && h.repo.missions.get(drafted.id).status !== 'DRAFT', h.repo.missions.get(drafted.id).status);
    h.repo.workspaces.update(ws, { maxActiveMissions: null });

    // A status report routine writes the P10 report.
    const report = R.create(caller, ws, { name: 'Weekly status report', kind: 'status_report', goal: '', successCriteria: [], schedule: { type: 'weekly', day: 5, at: '16:00' } });
    check('a report routine needs no Done-when lines; Friday 16:00', report.routine.nextRunAt === iso(local(2026, 10, 9, 16, 0)) && report.scheduleLabel === 'Every Friday at 16:00', report.routine.nextRunAt);
    const r1 = await R.runNow(caller, report.routine.id);
    check('Run now writes status report v1', r1.routine.lastOutcome === 'reported' && r1.lastLabel === 'Wrote status report v1' && typeof r1.routine.lastArtifactId === 'string', r1.lastLabel);
    at(local(2026, 10, 9, 16, 0));
    await R.tick();
    const r2 = R.list(ws).find((v) => v.routine.id === report.routine.id);
    check('on schedule: v2', r2.lastLabel === 'Wrote status report v2', r2.lastLabel);

    const sourceOf = (f) => readFileSync(join(here, `../packages/application/dist/services/${f}`), 'utf8');
    const src = sourceOf('routine-service.js');
    check('the routine service reads no wall clock', !/Date\.now\(/.test(src));
    check('the routine service never plans, starts or admits work itself', !/planning|planNow|begin\(|\.admit\(|scheduler/i.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
    check('it only ever creates queued missions', /queued:\s*true/.test(src));

    R.remove(report.routine.id);
    check('deleted', R.list(ws).every((v) => v.routine.id !== report.routine.id));
  } finally {
    clearInterval(keepAlive);
    await h.container.dispose?.();
    rmSync(HOME, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the daemon
const root = mkdtempSync(join(tmpdir(), 'tdr-d-'));
const home = join(root, 'h');
const repo = join(root, 'r');
const gitConfig = join(root, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Routine Tester\n\temail = routines@example.com\n');
process.env.GIT_CONFIG_GLOBAL = gitConfig;
delete process.env.TANDEMISE_OWNER_NAME;
delete process.env.TANDEMISE_CLOCK_OFFSET_MS;
execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
writeFileSync(join(repo, 'README.md'), '# routines check\n');
execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore' });

globalThis.__sqlite = await import('node:sqlite');
const { startDaemon } = await import('../apps/daemon/dist/main.js');
let daemon;
let token;
const api = async (method, path, body) => {
  const res = await fetch(`${daemon.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
const start = async (extra = {}) => {
  daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 200, ...extra });
  token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const poll = async (fn, ms = 20_000) => {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(150)) { const v = await fn(); if (v) return v; }
  return undefined;
};
const sql = (q, ...p) => {
  const db = new globalThis.__sqlite.DatabaseSync(join(home, 'tandemise.db'), { readOnly: true });
  try { return db.prepare(q).all(...p); } finally { db.close(); }
};

try {
  section('daemon: without the knob there is no test clock');
  await start();
  {
    const r = await api('POST', '/v1/test/clock', { advanceMs: 1000 });
    check('POST /v1/test/clock is 404 without TANDEMISE_CLOCK_OFFSET_MS', r.status === 404, r.status);
    const system = await api('GET', '/v1/system');
    check('schema version is at least 16', system.body?.schemaVersion >= 16, system.body?.schemaVersion);
    const cols = (t) => sql(`SELECT name FROM pragma_table_info('${t}')`).map((c) => c.name);
    check('routines has the roadmap columns', ['id', 'workspace_id', 'name', 'kind', 'goal', 'success_criteria', 'priority', 'limits', 'schedule', 'enabled', 'next_run_at', 'last_run_at'].every((c) => cols('routines').includes(c)), cols('routines'));
    check('routine_runs exists', ['routine_id', 'trigger', 'outcome', 'detail', 'skipped_count', 'mission_id'].every((c) => cols('routine_runs').includes(c)));
    check('missions.routine_id exists', cols('missions').includes('routine_id'));
    const table = sql("SELECT sql FROM sqlite_master WHERE name = 'routines'")[0]?.sql ?? '';
    check('kind and outcome are CHECKed', table.includes("kind IN ('mission','status_report')") && table.includes("'skipped_active'"), table);
  }
  await daemon.stop();

  section('daemon: the test clock, a routine, a restart after downtime');
  await start({ clockOffsetMs: 0 });
  let ws;
  let routineId;
  {
    const wsRes = await api('POST', '/v1/workspaces', { name: 'Routines', repositoryPath: repo });
    ws = wsRes.body?.workspace?.id;
    const refused = await api('POST', `/v1/workspaces/${ws}/routines`, { name: 'No lines', kind: 'mission', goal: 'Weekly work', successCriteria: [], schedule: { type: 'daily', at: '09:00' } });
    check('POST routine without Done-when lines is 400', refused.status === 400 && /Done-when/.test(refused.body?.error?.message ?? ''), refused.body);
    const clockNow = (await api('POST', '/v1/test/clock', { advanceMs: 0 })).body;
    check('the test clock answers with its time', typeof clockNow?.now === 'string' && clockNow.offsetMs === 0, clockNow);
    const inAnHour = new Date(Date.parse(clockNow.now) + HOUR);
    const at = `${String(inAnHour.getHours()).padStart(2, '0')}:${String(inAnHour.getMinutes()).padStart(2, '0')}`;
    const created = await api('POST', `/v1/workspaces/${ws}/routines`, {
      name: 'Nightly: fix failing checks', kind: 'mission', goal: 'Fix the failing checks', successCriteria: ['Every failing check passes', 'No test was skipped'],
      priority: 'high', schedule: { type: 'daily', at },
    });
    routineId = created.body?.routine?.id;
    check('POST routine → next run in about an hour', created.status === 200 && created.body?.nextRunLabel?.startsWith('Next: '), created.body);
    await sleep(600);
    check('nothing yet', sql('SELECT COUNT(*) AS n FROM missions WHERE routine_id = ?', routineId)[0].n === 0);
    const advanced = await api('POST', '/v1/test/clock', { advanceMs: 2 * HOUR });
    check('advance two hours', advanced.status === 200 && advanced.body?.offsetMs === 2 * HOUR, advanced.body);
    const made = await poll(() => sql('SELECT id, status, queued_at, priority FROM missions WHERE routine_id = ?', routineId)[0]);
    check('the scheduler tick created a queued DRAFT', made?.status === 'DRAFT' && made?.queued_at !== null && made?.priority === 'high', made);
    const criteria = await api('GET', `/v1/missions/${made?.id}/criteria`);
    check('with U1 and U2', eq((criteria.body ?? []).map((c) => c.key), ['U1', 'U2']), criteria.body);
    const mission = await api('GET', `/v1/missions/${made?.id}`);
    check('the mission carries its routine id', mission.body?.mission?.routineId === routineId, mission.body?.mission?.routineId);
    const list = await api('GET', `/v1/workspaces/${ws}/routines`);
    check('GET routines shows the last outcome', list.body?.[0]?.lastLabel?.startsWith('Created “Nightly: fix failing checks · '), list.body?.[0]?.lastLabel);
    await api('POST', '/v1/test/clock', { advanceMs: DAY });
    const skipped = await poll(async () => (await api('GET', `/v1/workspaces/${ws}/routines`)).body?.[0]?.lastLabel === 'Skipped: previous run still active');
    check('a day later with the draft still queued: skipped', skipped === true);
    const runNow = await api('POST', `/v1/routines/${routineId}/run-now`);
    check('Run now answers with the routine and obeys coalescing', runNow.status === 200 && runNow.body?.lastLabel === 'Skipped: previous run still active', runNow.body?.lastLabel);
    await api('POST', `/v1/missions/${made.id}/cancel`, {});
    const paused = await api('PATCH', `/v1/routines/${routineId}`, { enabled: false });
    check('PATCH enabled:false → Paused', paused.body?.nextRunLabel === 'Paused', paused.body);
    const resumed = await api('PATCH', `/v1/routines/${routineId}`, { enabled: true });
    check('PATCH enabled:true → a next run', resumed.body?.nextRunLabel?.startsWith('Next: '), resumed.body);
    check('DELETE an unknown routine is 404', (await api('DELETE', '/v1/routines/rtn_nope')).status === 404);
  }
  const offsetBefore = (await api('POST', '/v1/test/clock', { advanceMs: 0 })).body.offsetMs;
  await daemon.stop();

  // Tandemise is "off" for three days: restart with the clock three days on.
  await start({ clockOffsetMs: offsetBefore + 3 * DAY });
  {
    const created = await poll(() => sql("SELECT COUNT(*) AS n FROM missions WHERE routine_id = ? AND status = 'DRAFT'", routineId)[0].n === 1);
    check('after three days down: one catch-up mission', created === true && sql('SELECT COUNT(*) AS n FROM missions WHERE routine_id = ?', routineId)[0].n === 2);
    const runs = sql('SELECT outcome, skipped_count, detail FROM routine_runs WHERE routine_id = ? ORDER BY ran_at DESC, rowid DESC', routineId);
    check('the missed runs are noted once, with the count', runs.some((r) => r.outcome === 'missed' && r.skipped_count === 2 && r.detail.startsWith('Missed 2 runs while Tandemise was not running')), runs.slice(0, 3));
    await sleep(800);
    check('and nothing more fires on later ticks', sql('SELECT COUNT(*) AS n FROM missions WHERE routine_id = ?', routineId)[0].n === 2);
  }
} finally {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
