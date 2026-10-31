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

// @sections

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
process.exit(0);
