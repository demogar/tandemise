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

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
