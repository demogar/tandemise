// The planner and risk-based merge, phase 2: outcomes, the fold and model
// routing (docs/superpowers/specs/2026-10-30-planner-and-merge-design.md §6, §9.1).
//
//   npm run build && node scratch/routing-check.mjs
const D = await import('@tandemise/domain');
const app = await import('@tandemise/application');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const attempt = async (label, fn) => {
  try { await fn(); } catch (e) { failures.push(label); console.log(`  FAIL ${label} threw: ${e?.stack ?? e}`); }
};
const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const at = (n) => new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString();
const outcome = (n, kind, extra = {}) => ({
  op: 'outcome', id: `out_${String(n).padStart(4, '0')}`, at: at(n), by: extra.by ?? 'A', mission: extra.mission ?? `m${n}`,
  lane: extra.lane ?? 'quick', profile: { type: 'fix', size: 'xs', risk: 'low', areas: extra.areas ?? [], sensitivity: extra.sensitivity ?? 'none' }, kind,
  ...(kind === 'step_result' || extra.step ? { step: { class: 'implement', model: 'sonnet', attempt: 1, gatePassed: true, costUsd: null, wallTimeMs: null, taskKey: 'implement', ...(extra.step ?? {}) } } : {}),
});

await attempt('fold', async () => {
  section('fold');
  const rnd = mulberry32(51);
  const events = Array.from({ length: 40 }, (_, i) => outcome(i, i % 7 === 3 ? 'held' : 'step_result', {
    mission: `m${i % 9}`, areas: i % 2 === 0 ? ['desktop-ui'] : ['docs'],
    step: { model: ['haiku', 'sonnet'][i % 2], gatePassed: i % 5 !== 0, attempt: i % 4 === 0 ? 2 : 1, costUsd: i % 3 === 0 ? null : i / 100 },
  }));
  const first = JSON.stringify(D.foldOutcomes(events));
  let same = true;
  for (let k = 0; k < 100; k++) {
    const shuffled = [...events].sort(() => rnd() - 0.5);
    if (JSON.stringify(D.foldOutcomes(shuffled)) !== first) same = false;
  }
  check('the same events in any order fold the same', same);
  const split = events.map((e, i) => ({ ...e, by: i % 2 === 0 ? 'A' : 'B' }));
  check('two writers fold the same', JSON.stringify(D.foldOutcomes(split)) === first);
  const five = [1, 2, 3, 4, 5].map((n) => outcome(n, 'step_result', { mission: `x${n}`, step: { gatePassed: n !== 5, attempt: 1 } }));
  const held = outcome(9, 'held', { mission: 'x2', step: { taskKey: 'implement' } });
  const stats = D.foldOutcomes([...five, held]).buckets['implement|quick|none'].sonnet;
  check('n, first pass, success and holds', stats.n === 5 && stats.firstPass === 4 && stats.success === 3 && stats.holds === 1, stats);
  check('an unreported cost is null, never 0', stats.medianCostUsd === null && stats.medianWallTimeMs === null, stats);
  // A request-changes round reruns the same task: it is one task people stepped in on, not two.
  const rounds = [1, 2].flatMap((n) => [
    outcome(n * 10, 'step_result', { mission: `r${n}`, areas: ['desktop-ui'] }),
    outcome(n * 10 + 1, 'changes_requested', { mission: `r${n}`, areas: ['desktop-ui'], step: { taskKey: 'implement' } }),
    outcome(n * 10 + 2, 'step_result', { mission: `r${n}`, areas: ['desktop-ui'] }),
  ]);
  check('stepped in counts each task once, however many rounds it had', eq(D.foldOutcomes(rounds).steppedIn['implement|desktop-ui'], [true, true]), D.foldOutcomes(rounds).steppedIn);
});

await attempt('words', async () => {
  section('words');
  check('a routed step reads "Implement · sonnet · passed 23 of 25 … · if it fails, opus"',
    D.stepLine({ key: 'implement', stepClass: 'implement', model: 'sonnet', reason: 'routed: sonnet passed 23 of 25 similar implement steps first time', escalate: ['opus'] })
      === 'Implement · sonnet · passed 23 of 25 similar implement steps first time · if it fails, opus');
  check('a step with no routed model keeps "role model"', D.stepLine({ key: 'implement', stepClass: 'implement', model: null, reason: 'role model', escalate: [] }) === 'Implement · role model');
  check('a default rung says why',
    D.stepLine({ key: 'implement', stepClass: 'implement', model: 'sonnet', reason: 'default: only 3 similar implement steps measured', escalate: [] })
      === 'Implement · sonnet · the starting model, since only 3 similar implement steps measured');
  check('the tiebreak line with its cost', D.tiebreakSentence({ reason: 'type_unknown', model: 'haiku', costUsd: 0.002, answer: { type: 'fix' }, error: null })
    === "Couldn't tell from the tracker whether this is a fix or a feature; asked haiku (0.2¢): fix.");
  check('a cost nobody reported is said so', D.tiebreakSentence({ reason: 'type_unknown', model: 'haiku', costUsd: null, answer: { type: 'fix' }, error: null })
    === "Couldn't tell from the tracker whether this is a fix or a feature; asked haiku (cost not reported): fix.");
});

await attempt('engine outcomes', async () => {
  section('engine outcomes');
  const keepAlive = setInterval(() => {}, 1000);
  const { world } = await import('./planner-harness.mjs');
  const w = await world();
  const m = await w.mission('fix: typo in the settings title');
  const implement = () => w.h.repo.tasks.listByMission(m.id).find((t) => t.key === 'implement');
  await w.h.until(() => implement().status === 'SUCCEEDED' && w.h.repo.outcomes.listByWorkspace(w.ws, '1970').length > 0, 60000);
  const rows = w.h.repo.outcomes.listByWorkspace(w.ws, '1970').filter((o) => o.mission === m.id);
  const run = w.h.repo.runs.listByTask(implement().id).at(-1);
  check('a settled implement step writes one step_result with the run\'s model', rows.filter((o) => o.kind === 'step_result' && o.step.taskKey === 'implement').length === 1 && rows[0].step.model === (run?.model ?? null) && rows[0].lane === 'quick', rows);
  check('task.outcome is recorded', w.h.repo.events.listByMission(m.id).some((e) => e.body.type === 'task.outcome'));
  const rounds = w.h.container.resolve(app.FEEDBACK_ROUNDS);
  rounds.beginRound({ task: implement(), feedbackIds: [], downstream: 'none', actorId: 'check' });
  check('a request-changes round writes changes_requested', w.h.repo.outcomes.listByWorkspace(w.ws, '1970').some((o) => o.mission === m.id && o.kind === 'changes_requested'));
  const recorder = w.h.container.resolve(app.OUTCOME_RECORDER);
  const trial = w.h.repo.missions.update(m.id, { evalTrialId: 'etr_x' });
  const before = w.h.repo.outcomes.listByWorkspace(w.ws, '1970').length;
  recorder.stepSettled(trial, implement());
  check('an eval trial writes none', w.h.repo.outcomes.listByWorkspace(w.ws, '1970').length === before);
  clearInterval(keepAlive);
});

await attempt('rung choice, bounds, escalation', async () => {
  section('rung choice');
  const config = D.parseRoutingConfig({ target: 0.8, minSamples: 8, probeEvery: 10, classes: { implement: { ladder: ['haiku', 'sonnet', 'opus'], default: 'sonnet' } } }).config;
  const stats = (rows) => ({ buckets: { 'implement|quick|none': rows } });
  const s = (success, n) => ({ n, firstPass: success, success, holds: 0, changesRequested: 0, reverts: 0, medianCostUsd: null, medianWallTimeMs: null });
  const choose = (rows, extra = {}) => D.chooseRung({ cls: 'implement', bucket: 'implement|quick|none', risk: 'medium', config, stats: stats(rows), taskOrdinal: 1, ...extra });
  check('under minSamples → the default', choose({ sonnet: s(7, 7) }).model === 'sonnet' && choose({ sonnet: s(7, 7) }).reason.startsWith('default:'));
  check('Wilson LB of 24/25 clears 0.8', D.wilsonLowerBound(24, 25) > 0.8 && D.wilsonLowerBound(24, 25) < 0.81, D.wilsonLowerBound(24, 25));
  const cheap = choose({ haiku: s(24, 25), sonnet: s(25, 25) });
  check('the cheapest rung that clears the target', cheap.model === 'haiku' && eq(cheap.escalate, ['sonnet', 'opus']) && cheap.reason === 'routed: haiku passed 24 of 25 similar implement steps first time', cheap);
  check('a rung below the target is passed over', choose({ haiku: s(18, 25), sonnet: s(25, 25) }).model === 'sonnet');
  const probe = choose({ haiku: s(18, 25), sonnet: s(25, 25) }, { risk: 'low', taskOrdinal: 10 });
  check('a low-risk tenth task probes one rung cheaper', probe.model === 'haiku' && probe.probe === true, probe);
  check('never on high risk', choose({ haiku: s(18, 25), sonnet: s(25, 25) }, { risk: 'high', taskOrdinal: 10 }).probe === false);
  check('no ladder → null (the role\'s model)', D.chooseRung({ cls: 'review', bucket: 'x', risk: 'low', config, stats: stats({}), taskOrdinal: 1 }) === null);

  section('bounds');
  const rnd = mulberry32(10);
  let off = 0;
  for (let i = 0; i < 500; i++) {
    const rows = {};
    for (const m of ['haiku', 'sonnet', 'opus', 'gpt-x']) { const n = Math.floor(rnd() * 40); rows[m] = s(Math.floor(rnd() * (n + 1)), n); }
    const c = D.chooseRung({ cls: 'implement', bucket: 'implement|quick|none', risk: rnd() < 0.5 ? 'low' : 'high', config, stats: stats(rows), taskOrdinal: Math.floor(rnd() * 30) });
    if (!['haiku', 'sonnet', 'opus'].includes(c.model) || c.escalate.some((e) => !['haiku', 'sonnet', 'opus'].includes(e))) off++;
  }
  check('500 random tables never route off the ladder', off === 0, off);

  section('escalation');
  const r2 = D.resolveModel({ step: { model: cheap.model, escalate: cheap.escalate, reason: cheap.reason }, role: null, profileModel: null, attempt: 2, pressure: null, runtimeTakesModel: true });
  check('attempt 2 takes the next rung', r2.model === 'sonnet' && r2.source === 'escalation', r2);
  const eco = D.resolveModel({ step: { model: 'haiku', reason: 'routed: x' }, role: { model: null, escalate: [], economyModel: 'mini' }, profileModel: null, attempt: 1, pressure: { percent: 85, scope: 'mission' }, runtimeTakesModel: true });
  check('economy mode still wins under limit pressure', eco.source === 'economy', eco);
  check('a request-changes round moves a routed model up', eq(app.moveUpAfterChanges({ model: 'haiku', escalate: ['sonnet', 'opus'], reason: 'routed: haiku passed' }), { model: 'sonnet', escalate: ['opus'], reason: 'moved up after changes were requested' }));
  check('a model the person pinned stays', eq(app.moveUpAfterChanges({ model: 'opus' }), { model: 'opus' }));
  check('with nothing above, it stays', eq(app.moveUpAfterChanges({ model: 'opus', escalate: [], reason: 'routed: x' }), { model: 'opus', escalate: [], reason: 'routed: x' }));
});

await attempt('holds count', async () => {
  section('holds count');
  const appended = [];
  let listener = null;
  const task = { id: 'tsk_h', missionId: 'msn_h', key: 'implement', executor: 'agent', stepClass: 'implement', roleId: 'development', attempts: 1, modelPolicy: null };
  const recorder = new app.OutcomeRecorder({
    outcomes: { append: (o) => appended.push(o), listByWorkspace: () => [] },
    missions: { get: () => ({ id: 'msn_h', workspaceId: 'ws_h' }) },
    planDecisions: { latest: () => ({ lane: 'quick', profile: { type: 'fix', size: 'xs', risk: 'low', areas: [] } }) },
    recorder: { record: () => {} }, clock: { now: () => new Date().toISOString() }, log: { warn: () => {} },
    bus: { subscribe: (fn) => { listener = fn; return () => { listener = null; }; } },
    tasks: { get: () => task },
  });
  await recorder.start();
  listener({ taskId: 'tsk_h', missionId: 'msn_h', body: { type: 'task.hold_ended', ending: 'continued' } });
  check('a hold that ends (task.hold_ended) is recorded as a held outcome on that step', appended.length === 1 && appended[0].kind === 'held' && appended[0].step.taskKey === 'implement', appended);
  await recorder.stop();
});

// @sections

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
process.exit(0);
