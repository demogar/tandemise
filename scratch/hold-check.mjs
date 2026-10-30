// Hold and interact: the domain half
// (docs/superpowers/specs/2026-10-30-hold-and-interact-design.md).
//
//   npm run build && node scratch/hold-check.mjs
const D = await import('@tandemise/domain');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);

section('pure: the HELD status');
{
  check('HELD is a task status', D.TASK_STATUSES.includes('HELD'));
  check('HELD is active', D.ACTIVE_TASK_STATUSES.includes('HELD'));
  check('HELD is parked, so it does not count against the concurrency ceiling', D.isTaskParked('HELD'));
  check('HELD is not finished', !D.isTaskFinished('HELD'));
  check('interactive_resume is a runtime capability', D.RUNTIME_CAPABILITIES.includes('interactive_resume'));
  check('holdable statuses', JSON.stringify(D.HOLDABLE_TASK_STATUSES) === JSON.stringify(['READY', 'RUNNING', 'AWAITING_INPUT', 'AWAITING_APPROVAL']));
  check('the hold events are in the semantic timeline',
    D.isSemanticEvent({ type: 'task.held' }) && D.isSemanticEvent({ type: 'task.hold_ended' }));
}

section('pure: holdRefusal');
{
  const task = (extra = {}) => ({ title: 'Build the page', executor: 'agent', status: 'RUNNING', ...extra });
  const input = (extra = {}, t = {}) => ({
    task: task(t), mission: {}, trial: false, liveRun: true, outputUnderReview: true,
    runtimeHasInteractive: true, openHold: null, holderName: null, ...extra,
  });
  const r = (extra, t) => D.holdRefusal(input(extra, t));
  check('a done step', r({}, { status: 'SUCCEEDED' }) === 'This step is done; request changes instead.', r({}, { status: 'SUCCEEDED' }));
  check('a person\'s step', r({}, { executor: 'human' }) === "'Build the page' is a person's step; there is no agent to hold.", r({}, { executor: 'human' }));
  check('an eval trial', r({ trial: true }) === "Eval trials can't be held.");
  check('running but the stream ended', r({ liveRun: false }) === "It's checking its work. You can hold it once that's done.");
  check('a runtime with no interactive mode', r({ runtimeHasInteractive: false }) === 'Only Claude Code steps can be held for now.');
  const at = new Date(2026, 9, 30, 9, 5, 0).toISOString();
  const hold = { id: 'hld_x', startedAt: at, endedAt: null };
  check('already held, by name and time', r({ openHold: hold, holderName: 'Ana' }, { status: 'HELD' }) === 'Held by Ana since 09:05.', r({ openHold: hold, holderName: 'Ana' }, { status: 'HELD' }));
  check('a start approval comes first', r({ outputUnderReview: false }, { status: 'AWAITING_APPROVAL' }) === 'Approve the start first, then you can hold it.');
  for (const status of D.HOLDABLE_TASK_STATUSES) check(`${status} is holdable`, r({}, { status }) === null, r({}, { status }));
  check('output under review is holdable', r({ outputUnderReview: true }, { status: 'AWAITING_APPROVAL' }) === null);
  check('a pending step is refused with some reason', typeof r({}, { status: 'PENDING' }) === 'string');
}

section('pure: nowLine and describeHoldEnd');
{
  const tool = (name, input) => ({ type: 'tool.started', tool: name, inputSummary: JSON.stringify(input) });
  check('nothing yet', D.nowLine(null) === 'Starting…');
  check('an edit', D.nowLine(tool('Edit', { file_path: 'src/app/page.tsx', old_string: 'a' })) === 'Editing src/app/page.tsx');
  check('a command', D.nowLine(tool('Bash', { command: 'npm test' })) === 'Running npm test');
  check('a read', D.nowLine(tool('Read', { file_path: 'a/b.ts' })) === 'Reading a/b.ts');
  check('a tandemise tool never shows its raw name', D.nowLine(tool('mcp__tandemise__x', {})) === 'Using a Tandemise tool');
  const long = 'x'.repeat(200);
  const m = D.nowLine({ type: 'message', text: long });
  check('long text is cut to 80', m.length === 80 && m.endsWith('…') && m === `${'x'.repeat(79)}…`, m.length);
  check('short text is kept', D.nowLine({ type: 'message', text: 'Looking' }) === 'Looking');
  const hold = (extra) => ({ ending: 'continued', diffStat: null, ...extra });
  check('describeHoldEnd names the outcome', /continu/i.test(D.describeHoldEnd(hold({}))) && /releas/i.test(D.describeHoldEnd(hold({ ending: 'released' }))));
}

section('persistence: migration 022 and the hold repository');
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Container, compose } = await import('@tandemise/kernel');
  const P = await import('@tandemise/persistence');
  const container = new Container();
  const dir = mkdtempSync(join(tmpdir(), 'tandemise-hold-'));
  compose(container, P.persistenceModule({ path: join(dir, 'h.db') }));
  const db = container.resolve(P.DATABASE);
  db.handle.exec(`
    INSERT INTO workspaces (id,name,autonomy,concurrency,routing,default_autonomy_level,knowledge,created_at,updated_at)
      VALUES ('ws1','W','balanced','{}','{}','balanced','{}','2026-01-01','2026-01-01');
    INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,created_at,updated_at)
      VALUES ('m1','ws1','T','G','[]','[]','EXECUTING','balanced','p','2026-01-01','2026-01-01');
    INSERT INTO mission_tasks (id,mission_id,key,title,objective,role_id,required_capabilities,input_artifacts,expected_outputs,execution_policy,approval_policy,retry_policy,status,created_at,updated_at)
      VALUES ('t1','m1','k1','T1','O','design','[]','[]','[]','{}','{}','{}','RUNNING','2026-01-01','2026-01-01');
  `);
  let held = null;
  try { db.handle.prepare("UPDATE mission_tasks SET status = 'HELD' WHERE id = 't1'").run(); } catch (e) { held = String(e.message); }
  check('a task row can be written with status HELD', held === null, held);
  const sql = db.handle.prepare("SELECT sql FROM sqlite_master WHERE name = 'mission_tasks'").get().sql;
  check("sqlite_master for mission_tasks contains 'HELD'", sql.includes("'HELD'"));

  const repo = container.resolve(P.TASK_HOLD_REPOSITORY);
  const hold = (id, extra = {}) => ({
    id, taskId: 't1', missionId: 'm1', heldBy: 'mem1', fromStatus: 'RUNNING', runtimeProfileId: 'rp1',
    sessionBefore: 's-1', sessionAfter: null, ptyPid: null, startedAt: '2026-01-02T00:00:00.000Z',
    endedAt: null, endedBy: null, ending: null, consumedAt: null, diffStat: null, dir: '/h/hld1', ...extra,
  });
  repo.create(hold('hld1'));
  check('openFor finds the open hold', repo.openFor('t1')?.id === 'hld1');
  let second = null;
  try { repo.create(hold('hld2')); } catch (e) { second = String(e.message); }
  check('a second open hold for the same task throws', second !== null && /UNIQUE/i.test(second), second);
  check('no pending continuation while open', repo.pendingContinuation('t1') === undefined);

  const stat = { files: 2, insertions: 5, deletions: 1 };
  repo.update('hld1', { endedAt: '2026-01-02T01:00:00.000Z', endedBy: 'mem1', ending: 'continued', sessionAfter: 's-2', diffStat: stat });
  check('openFor is empty once ended', repo.openFor('t1') === undefined);
  const pending = repo.pendingContinuation('t1');
  check('pendingContinuation returns the ended continued hold', pending?.id === 'hld1' && pending.sessionAfter === 's-2'
    && JSON.stringify(pending.diffStat) === JSON.stringify(stat), pending);
  repo.update('hld1', { consumedAt: '2026-01-02T02:00:00.000Z' });
  check('pendingContinuation returns nothing once consumedAt is set', repo.pendingContinuation('t1') === undefined);
  repo.create(hold('hld3', { startedAt: '2026-01-03T00:00:00.000Z' }));
  check('a new hold may open after the first ended', repo.openFor('t1')?.id === 'hld3');
  repo.update('hld3', { endedAt: '2026-01-03T01:00:00.000Z', ending: 'released' });
  check('a released hold is never a pending continuation', repo.pendingContinuation('t1') === undefined);
  check('listByMission lists in start order', repo.listByMission('m1').map((h) => h.id).join() === 'hld1,hld3');
  check('get round-trips', repo.get('hld1')?.consumedAt === '2026-01-02T02:00:00.000Z');
  db.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
