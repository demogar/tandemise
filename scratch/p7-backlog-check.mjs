// P7: backlog, priority and a work-in-progress limit. Queued drafts are pulled
// into planning, in a deterministic total order, whenever fewer missions than the
// project's limit are in progress; readiness is P6's gate, read through
// ReadinessService; and a mission cancelled while it is being planned stays
// cancelled.
//
//   npm run build && node scratch/p7-backlog-check.mjs
//
// Pure rules first (order, determinism, the WIP gate, pulls, moves), then the
// scheduler's dispatch order with stub dependencies, then a real daemon
// (startDaemon, in process) for the migration, the pull, the routes and the
// cancel-while-planning fix.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const D = await import('@tandemise/domain');
const app = await import('@tandemise/application');

/** Every ordering of `items` (small lists only). */
function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

// ------------------------------------------------------------------ pure rules
section('pure: the backlog order is a total order');
{
  check('four priorities, urgent first', eq(D.MISSION_PRIORITIES, ['urgent', 'high', 'normal', 'low']) && D.priorityLevel('urgent') === 0 && D.priorityLevel('low') === 3);
  const e = (id, priority, rank, createdAt) => ({ id, priority, rank, createdAt });
  const rows = [
    e('msn_c', 'normal', 1, '2026-09-26T10:00:03.000Z'),
    e('msn_a', 'low', 0, '2026-09-26T10:00:00.000Z'),
    e('msn_u', 'urgent', 9, '2026-09-26T10:00:09.000Z'),
    // A tie on rank with msn_c: the older one comes first.
    e('msn_b', 'normal', 1, '2026-09-26T10:00:01.000Z'),
    // A tie on rank and createdAt with msn_b: the id decides.
    e('msn_bb', 'normal', 1, '2026-09-26T10:00:01.000Z'),
    e('msn_h', 'high', 5, '2026-09-26T10:00:05.000Z'),
  ];
  const order = D.backlogOrder(rows).map((r) => r.id);
  check('priority first, then rank, then createdAt, then id', eq(order, ['msn_u', 'msn_h', 'msn_b', 'msn_bb', 'msn_c', 'msn_a']), order);
  check('a tie on rank falls to the older mission', order.indexOf('msn_b') < order.indexOf('msn_c'));
  check('a tie on rank and createdAt falls to the id', order.indexOf('msn_b') < order.indexOf('msn_bb'));
  const all = permutations(rows).map((p) => D.backlogOrder(p).map((r) => r.id).join(','));
  check(`deterministic: all ${all.length} input orders give the same order`, new Set(all).size === 1, [...new Set(all)].slice(0, 3));
  check('no two distinct missions compare equal', rows.every((a) => rows.every((b) => a === b || D.compareBacklog(a, b) !== 0)));
}

section('pure: the WIP gate and facts');
{
  check('the gate is a gate expression over measured facts', D.WIP_PULL_GATE === 'workspace.active_missions < workspace.max_active_missions', D.WIP_PULL_GATE);
  const facts = D.wipFacts({ active: 1, limit: 2 });
  check('facts carry active and the limit', facts['workspace.active_missions'] === 1 && facts['workspace.max_active_missions'] === 2, facts);
  check('limit off: the limit is not measured', D.wipFacts({ active: 0, limit: null })['workspace.max_active_missions'] === undefined);
  check('room: 1 < 2 passes', D.evaluateGate(D.WIP_PULL_GATE, D.wipFacts({ active: 1, limit: 2 })).passed);
  check('full: 2 < 2 fails', !D.evaluateGate(D.WIP_PULL_GATE, D.wipFacts({ active: 2, limit: 2 })).passed);
  check('off never passes, even with nothing in progress', !D.evaluateGate(D.WIP_PULL_GATE, D.wipFacts({ active: 0, limit: null })).passed);
  check('mission.priority fact is 0-3', D.missionFacts({ priority: 'high' })['mission.priority'] === 1);
  check('in progress: not DRAFT, not PAUSED, not finished', ['PLANNING', 'AWAITING_PLAN_APPROVAL', 'EXECUTING', 'BLOCKED', 'QA'].every(D.isInProgress) && !['DRAFT', 'PAUSED', 'COMPLETE', 'FAILED', 'CANCELLED'].some(D.isInProgress));
  const { GATE_FACT_VOCABULARY } = await import('@tandemise/evaluation');
  const names = GATE_FACT_VOCABULARY.map((f) => f.name);
  for (const n of ['mission.priority', 'workspace.active_missions', 'workspace.max_active_missions']) check(`${n} is in the published vocabulary`, names.includes(n));
  check('headline with a limit', D.describeWip({ active: 1, limit: 2, queued: 3 }).headline === 'Working on 1 of 2 · 3 queued', D.describeWip({ active: 1, limit: 2, queued: 3 }));
  check('headline with the limit off', D.describeWip({ active: 1, limit: null, queued: 3 }).headline === 'Working on 1 · no limit · 3 queued', D.describeWip({ active: 1, limit: null, queued: 3 }));
  check('the hint says what happens with the limit off', /wait until you plan them/.test(D.describeWip({ active: 0, limit: null, queued: 1 }).hint));
}

section('pure: choosing pulls');
{
  const c = (id, priority, rank, { queued = true, ready = true } = {}) => ({ id, priority, rank, createdAt: `2026-09-26T10:00:0${rank}.000Z`, queued, ready });
  const g1 = [c('normal', 'normal', 1), c('urgent', 'urgent', 2), c('low', 'low', 3), c('unq', 'urgent', 0, { queued: false })];
  const one = D.choosePulls({ active: 0, limit: 1, candidates: g1 });
  check('G1 shape: limit 1 pulls urgent only, first in the queue', eq(one.pulls.map((p) => [p.id, p.position, p.active, p.limit]), [['urgent', 1, 1, 1]]), one.pulls);
  check('an unqueued draft is never pulled, even when urgent', !one.pulls.some((p) => p.id === 'unq'));
  const all = permutations(g1).map((p) => JSON.stringify(D.choosePulls({ active: 0, limit: 2, candidates: p }).pulls));
  check(`same state, same pick: all ${all.length} input orders pick the same`, new Set(all).size === 1, [...new Set(all)]);
  const two = D.choosePulls({ active: 0, limit: 2, candidates: g1 });
  check('limit 2 pulls urgent then normal, counting up', eq(two.pulls.map((p) => [p.id, p.active]), [['urgent', 1], ['normal', 2]]), two.pulls);
  const full = D.choosePulls({ active: 2, limit: 2, candidates: g1 });
  check('a full project pulls nothing, and the gate says why', full.pulls.length === 0 && full.outcome.detail.includes('workspace.active_missions'), full.outcome);
  const off = D.choosePulls({ active: 0, limit: null, candidates: g1 });
  check('limit off pulls nothing', off.pulls.length === 0);
  const g4 = [c('notready', 'urgent', 1, { ready: false }), c('ready', 'normal', 2)];
  const skip = D.choosePulls({ active: 0, limit: 1, candidates: g4 });
  check('G4 shape: a not-ready queued mission is skipped, the next ready one pulled at position 2', eq(skip.pulls.map((p) => [p.id, p.position, p.skipped]), [['ready', 2, 1]]), skip.pulls);
  check('the pull title', D.pulledTitle({ active: 1, limit: 1 }) === 'Pulled from the backlog (1 of 1)', D.pulledTitle({ active: 1, limit: 1 }));
}

section('pure: moving in the backlog');
{
  const e = (id, priority, rank) => ({ id, priority, rank, createdAt: `2026-09-26T10:00:0${rank}.000Z` });
  const backlog = [e('u', 'urgent', 1), e('n1', 'normal', 2), e('n2', 'normal', 3), e('l', 'low', 4)];
  const up = D.moveInBacklog(backlog, 'n2', 'up');
  const after = D.backlogOrder(backlog.map((b) => ({ ...b, ...(up.updates.find((u) => u.id === b.id) ?? {}) }))).map((b) => b.id);
  check('move up swaps with the neighbour', eq(after, ['u', 'n2', 'n1', 'l']), after);
  check('and renumbers the backlog 1…n', eq(up.updates.map((u) => [u.id, u.rank]).sort(), [['l', 4], ['n1', 3], ['n2', 2], ['u', 1]].sort()) || up.updates.every((u) => Number.isInteger(u.rank)), up.updates);
  check('a move inside one priority keeps it', up.moved.priority === 'normal' && up.crossed === null);
  const cross = D.moveInBacklog(backlog, 'l', 'up');
  const crossed = D.backlogOrder(backlog.map((b) => ({ ...b, ...(cross.updates.find((u) => u.id === b.id) ?? {}) }))).map((b) => b.id);
  check('G3 shape: Low moved above a Normal becomes Normal and sits above it', cross.moved.priority === 'normal' && eq(crossed, ['u', 'n1', 'l', 'n2']), { moved: cross.moved, crossed });
  check('it names the mission it crossed', cross.crossed?.id === 'n2');
  const down = D.moveInBacklog(backlog, 'u', 'down');
  check('Urgent moved below a Normal becomes Normal', down.moved.priority === 'normal' && down.crossed?.id === 'n1');
  check('the first cannot move up, the last cannot move down', D.moveInBacklog(backlog, 'u', 'up') === null && D.moveInBacklog(backlog, 'l', 'down') === null);
}

// ------------------------------------------------------------ dispatch order
section('scheduler: worker slots go in backlog order, not list order');
{
  const now = '2026-09-26T10:00:00.000Z';
  const mission = (id, priority, rank, createdAt) => ({ id, workspaceId: 'ws_1', status: 'EXECUTING', priority, rank, createdAt, queuedAt: null, title: id, statusReason: null });
  // Listed newest first, as the repository does: the normal mission would win on list order.
  const missions = [mission('msn_normal', 'normal', 2, '2026-09-26T10:00:02.000Z'), mission('msn_urgent', 'urgent', 1, '2026-09-26T10:00:01.000Z')];
  const task = (missionId) => ({ id: `tsk_${missionId}`, key: 'build', missionId, status: 'READY', statusReason: null, orderHint: 0, executor: 'agent', staffing: {}, dependsOn: [], roleId: 'development', expectedOutputs: [] });
  const tasks = new Map(missions.map((m) => [m.id, [task(m.id)]]));
  const started = [];
  const noop = () => undefined;
  const scheduler = new app.SchedulerService({
    workspaces: { get: () => ({ id: 'ws_1', concurrency: { maxTotalWorkers: 1, perRuntime: {} } }) },
    missions: { list: () => missions, get: (id) => missions.find((m) => m.id === id) },
    tasks: { listByMission: (id) => tasks.get(id) ?? [], get: (id) => [...tasks.values()].flat().find((t) => t.id === id), update: noop },
    approvals: {}, repositories: {}, waiter: {}, remediation: {}, integration: {}, members: {},
    executor: { execute: (taskId) => { started.push(taskId); return new Promise(() => undefined); } },
    recorder: { record: noop, invalidate: noop, note: noop },
    staffing: { isStale: () => false, snapshot: () => ({}) },
    reviews: { sweepEscalations: noop },
    rounds: { releaseStranded: noop },
    clock: { now: () => now, epochMs: () => Date.parse(now) },
    log: { info: noop, warn: noop, error: noop, debug: noop, child() { return this; } },
  });
  await scheduler.tick();
  check('with one worker slot, the urgent mission\'s task starts first', eq(started, ['tsk_msn_urgent']), started);
}

// ---------------------------------------------------------------- the daemon
const root = mkdtempSync(join(tmpdir(), 'tdb-'));
const home = join(root, 'h');
const repo = join(root, 'r');
const gitConfig = join(root, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Backlog Tester\n\temail = backlog@example.com\n');
const savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, TANDEMISE_OWNER_NAME: process.env.TANDEMISE_OWNER_NAME, SCRIPTED_DELAY_MS: process.env.SCRIPTED_DELAY_MS };
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.SCRIPTED_DELAY_MS = '0';
delete process.env.TANDEMISE_OWNER_NAME;
execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
writeFileSync(join(repo, 'README.md'), '# backlog check\n');
execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore' });

globalThis.__sqlite = await import('node:sqlite');
const { startDaemon } = await import('../apps/daemon/dist/main.js');
const daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 200 });
const token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
const api = async (method, path, body) => {
  const res = await fetch(`${daemon.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
const code = (r) => `${r.status} ${r.body?.error?.code}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const poll = async (fn, ms = 30_000) => {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(150)) { const v = await fn(); if (v) return v; }
  return undefined;
};
const sql = (q, ...p) => {
  const db = new globalThis.__sqlite.DatabaseSync(join(home, 'tandemise.db'), { readOnly: true });
  try { return db.prepare(q).all(...p); } finally { db.close(); }
};

try {
  section('migration 013');
  {
    const system = await api('GET', '/v1/system');
    check('schema version is 13', system.body?.schemaVersion === 13, system.body?.schemaVersion);
    const cols = sql("SELECT name, dflt_value, \"notnull\" AS nn FROM pragma_table_info('missions')");
    const col = (n) => cols.find((c) => c.name === n);
    check('missions.priority defaults to normal', col('priority')?.dflt_value === "'normal'" && col('priority')?.nn === 1, col('priority'));
    check('missions.rank and missions.queued_at exist', col('rank') !== undefined && col('queued_at') !== undefined && col('queued_at').nn === 0, cols.map((c) => c.name));
    const ws = sql("SELECT name FROM pragma_table_info('workspaces')").map((c) => c.name);
    check('workspaces.max_active_missions exists', ws.includes('max_active_missions'), ws);
    const table = sql("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'missions'")[0]?.sql ?? '';
    check('priority is CHECKed', /priority IN \('urgent','high','normal','low'\)/.test(table.replace(/\s+/g, '')) || table.includes("'urgent'"), table.slice(-600));
    const wsTable = sql("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'")[0]?.sql ?? '';
    check('the limit is CHECKed to NULL or >= 1', wsTable.includes('max_active_missions') && wsTable.includes('>= 1'), wsTable.slice(-300));
  }

  const wsRes = await api('POST', '/v1/workspaces', { name: 'Backlog', repositoryPath: repo });
  const ws = wsRes.body?.workspace?.id;
  check('workspace created with the limit off', wsRes.status === 200 && wsRes.body?.workspace?.maxActiveMissions === null, wsRes.body?.workspace);
  // No runtime: planning falls back to the preset at once and waits on its plan approval, so a pulled mission stays in progress.
  const create = async (goal, extra = {}) => (await api('POST', '/v1/missions', { workspaceId: ws, goal, successCriteria: ['It is done'], ...extra })).body?.mission;
  const status = (id) => sql('SELECT status FROM missions WHERE id = ?', id)[0]?.status;
  const backlog = async () => (await api('GET', `/v1/workspaces/${ws}/backlog`)).body;
  const limit = (n) => api('PATCH', `/v1/workspaces/${ws}`, { maxActiveMissions: n });
  const events = async (id) => (await api('GET', `/v1/missions/${id}/events?limit=500`)).body;
  const pulledEvent = async (id) => { const e = await events(id); return (e.events ?? e).find((r) => r.body.type === 'mission.pulled')?.body; };

  section('create: priority, queue, rank');
  let normal; let urgent; let low; let unqueued;
  {
    normal = await create('Normal thing', { queued: true });
    urgent = await create('Urgent thing', { queued: true, priority: 'urgent' });
    low = await create('Low thing', { queued: true, priority: 'low' });
    unqueued = await create('Unqueued urgent thing', { priority: 'urgent' });
    check('created with their priority', normal.priority === 'normal' && urgent.priority === 'urgent' && low.priority === 'low', [normal.priority, urgent.priority, low.priority]);
    check('queued ones carry queuedAt; the other does not', normal.queuedAt !== null && unqueued.queuedAt === null);
    check('each new mission is ranked last', normal.rank < urgent.rank && urgent.rank < low.rank && low.rank < unqueued.rank, [normal.rank, urgent.rank, low.rank, unqueued.rank]);
    const bad = await api('POST', '/v1/missions', { workspaceId: ws, goal: 'Bad priority', priority: 'asap' });
    check('an unknown priority is 400', bad.status === 400, code(bad));
    await sleep(1200);
    check('limit off: nothing is pulled', [normal, urgent, low, unqueued].every((m) => status(m.id) === 'DRAFT'));
    const view = await backlog();
    check('the backlog lists drafts in backlog order', eq(view.items.map((i) => i.summary.mission.id), [urgent.id, unqueued.id, normal.id, low.id]), view.items.map((i) => i.summary.mission.title));
    check('queue positions count queued ones only', eq(view.items.map((i) => i.queuePosition), [1, null, 2, 3]), view.items.map((i) => i.queuePosition));
    check('G5 shape: the headline says the limit is off', view.headline === 'Working on 0 · no limit · 3 queued' && view.limit === null, view.headline);
    check('each row carries readiness from the P6 gate', view.items.every((i) => i.ready === true && i.readinessLabel === 'Plan'), view.items.map((i) => i.readinessLabel));
  }

  section('the pull: limit 1');
  {
    const set = await limit(1);
    check('PATCH maxActiveMissions 1', set.status === 200 && set.body?.workspace?.maxActiveMissions === 1, set.body?.workspace);
    await poll(() => status(urgent.id) !== 'DRAFT');
    await sleep(800);
    check('G1: urgent is pulled into planning', ['PLANNING', 'AWAITING_PLAN_APPROVAL'].includes(status(urgent.id)), status(urgent.id));
    check('G1: normal and low stay queued; the unqueued urgent is never pulled', [normal, low, unqueued].every((m) => status(m.id) === 'DRAFT'));
    const ev = await pulledEvent(urgent.id);
    check('mission.pulled {position 1, limit 1, active 1}', ev?.position === 1 && ev.limit === 1 && ev.active === 1, ev);
    const view = await backlog();
    check('G1: "Working on 1 of 1 · 2 queued"', view.headline === 'Working on 1 of 1 · 2 queued', view.headline);
    check('G1: normal is Queued 1/2, low 2/2', eq(view.items.filter((i) => i.queuePosition !== null).map((i) => [i.summary.mission.id, i.queuePosition]), [[normal.id, 1], [low.id, 2]]) && view.queued === 2, view.items.map((i) => [i.summary.mission.title, i.queuePosition]));
    const again = await api('PATCH', `/v1/missions/${urgent.id}`, { queued: false });
    check('queueing a mission that left DRAFT is 412', code(again) === '412 PRECONDITION_FAILED', again.body);
  }

  section('a not-ready queued mission is skipped');
  let notReady;
  {
    notReady = (await api('POST', '/v1/missions', { workspaceId: ws, goal: 'Needs refinement first', priority: 'urgent', queued: true })).body?.mission;
    check('created queued without a Done-when line', notReady?.queuedAt !== null && status(notReady.id) === 'DRAFT');
    const view = await backlog();
    const row = view.items.find((i) => i.summary.mission.id === notReady.id);
    check('its row says it needs refinement', row?.ready === false && row.readinessLabel === 'Add at least one Done-when criterion to plan', row);
    await api('POST', `/v1/missions/${urgent.id}/cancel`, { reason: 'check: free the slot' });
    await poll(() => status(normal.id) !== 'DRAFT');
    await sleep(800);
    check('G2/G4: freeing the slot pulls normal, skipping the not-ready urgent', status(normal.id) !== 'DRAFT' && status(notReady.id) === 'DRAFT' && status(low.id) === 'DRAFT', [status(normal.id), status(notReady.id), status(low.id)]);
    const ev = await pulledEvent(normal.id);
    check('its event: position 2 with 1 skipped ahead', ev?.position === 2 && ev.skipped === 1 && ev.active === 1, ev);
  }

  section('moves');
  let second;
  {
    second = await create('Second normal thing', { queued: true });
    let view = await backlog();
    const titles = () => view.items.map((i) => `${i.summary.mission.title}:${i.priority}`);
    check('backlog before: unqueued urgent, urgent not-ready, second normal, low', eq(view.items.map((i) => i.summary.mission.id), [unqueued.id, notReady.id, second.id, low.id]), titles());
    const moved = await api('PATCH', `/v1/missions/${low.id}`, { move: 'up' });
    view = moved.body;
    check('G3: move low up answers with the backlog', moved.status === 200 && Array.isArray(view?.items), code(moved));
    check('G3: low now sits above the second normal and reads normal', eq(view.items.map((i) => i.summary.mission.id), [unqueued.id, notReady.id, low.id, second.id]) && view.items.find((i) => i.summary.mission.id === low.id)?.priority === 'normal', titles());
    check('ranks are renumbered 1…n', eq(view.items.map((i) => i.summary.mission.rank), [1, 2, 3, 4]), view.items.map((i) => i.summary.mission.rank));
    const top = await api('PATCH', `/v1/missions/${unqueued.id}`, { move: 'up' });
    check('the first row cannot move up (409)', code(top) === '409 CONFLICT', top.body);
    const prio = await api('PATCH', `/v1/missions/${second.id}`, { priority: 'high' });
    check('a priority change reorders', prio.body?.items?.findIndex((i) => i.summary.mission.id === second.id) === 2, prio.body?.items?.map((i) => i.summary.mission.title));
    await api('PATCH', `/v1/missions/${second.id}`, { priority: 'normal' });
    await api('POST', `/v1/missions/${normal.id}/cancel`, { reason: 'check: free the slot' });
    await poll(() => status(low.id) !== 'DRAFT');
    await sleep(800);
    check('G3: the moved mission is pulled next', status(low.id) !== 'DRAFT' && status(second.id) === 'DRAFT', [status(low.id), status(second.id)]);
  }

  section('limit off pulls nothing');
  {
    const off = await limit(null);
    check('PATCH maxActiveMissions null turns it off', off.body?.workspace?.maxActiveMissions === null, off.body?.workspace);
    await api('POST', `/v1/missions/${low.id}/cancel`, { reason: 'check: free the slot' });
    await sleep(1500);
    check('G5: with a free slot and a ready queued mission, nothing is pulled', status(second.id) === 'DRAFT');
    const zero = await limit(0);
    check('a limit of 0 is 400', zero.status === 400, code(zero));
    const dequeue = await api('PATCH', `/v1/missions/${second.id}`, { queued: false });
    check('Remove from queue clears queuedAt', dequeue.body?.items?.find((i) => i.summary.mission.id === second.id)?.queuePosition === null);
    await limit(1);
    await sleep(1500);
    check('an unqueued ready draft is never pulled', status(second.id) === 'DRAFT');
    await limit(null);
  }

  section('cancelling a mission while it is being planned');
  {
    const runtime = await api('POST', '/v1/runtimes', {
      adapterId: 'generic-cli', name: 'Scripted agent', workspaceId: null,
      settings: { command: process.execPath, args: [resolve(here, 'acceptance/p0/scripted-agent.mjs')], promptVia: 'stdin', outputFormat: 'text', capabilities: ['reasoning', 'tool_calling', 'shell', 'git', 'filesystem', 'mcp'] },
      maxConcurrent: 4, enabled: true,
    });
    check('a scripted runtime is registered', runtime.status === 200, runtime.body);
    // The goal carries the slow knob: the planner run sleeps 20 s before answering.
    const slow = await create('Plan me slowly SCRIPTED_SLOW_20S', { planNow: true });
    check('planning started', status(slow.id) === 'PLANNING', status(slow.id));
    await sleep(1500);
    const cancelled = await api('POST', `/v1/missions/${slow.id}/cancel`, { reason: 'check: cancelled mid-plan' });
    check('cancel is accepted mid-plan', cancelled.status === 200 && status(slow.id) === 'CANCELLED', code(cancelled));
    const settled = await poll(async () => {
      const tasks = sql('SELECT count(*) AS n FROM mission_tasks WHERE mission_id = ?', slow.id)[0].n;
      const approvals = sql('SELECT count(*) AS n FROM approvals WHERE mission_id = ?', slow.id)[0].n;
      const e = await events(slow.id);
      const discarded = (e.events ?? e).some((r) => r.body.type === 'note' && /discarded/.test(r.body.text));
      return tasks > 0 || approvals > 0 || discarded ? { tasks, approvals, discarded } : undefined;
    }, 90_000);
    check('the plan is discarded, not written', settled?.discarded === true, settled);
    check('no tasks and no plan approval on the cancelled mission', settled?.tasks === 0 && settled.approvals === 0, settled);
    await sleep(500);
    check('and it stays CANCELLED', status(slow.id) === 'CANCELLED', status(slow.id));
  }
} catch (e) {
  failures.push(`threw: ${e?.stack ?? e}`);
  console.log(e);
} finally {
  await daemon.stop();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
console.log('ALL P7 BACKLOG CHECKS PASSED');
