// P8: hard limits on spend and time. A mission, and a project per calendar
// month, has a ceiling on agent minutes, tokens or reported dollars; the daemon
// warns at the warning level and at 100% stops the work and asks whether to
// raise the limit. Measured from usage_records only; "not reported" is never 0.
//
//   npm run build && node scratch/p8-limits-check.mjs
//
// Pure rules first (levels, facts, the month window from an injected clock,
// the words), then the scheduler's admission rule with stub dependencies (a
// run is never dispatched in an over-limit mission, even when the scheduler is
// called directly), then a real daemon (startDaemon, in process) with the
// scripted agent reporting 5 agent minutes a run.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

// ------------------------------------------------------------------ pure rules
section('pure: levels, admission and facts');
{
  const minutes = (m) => ({ agentMs: m * 60_000, tokens: null, costUsd: null, runs: 1 });
  const limit = { metric: 'agent_minutes', amount: 12, warnPercent: 80 };
  check('10 of 12 minutes is soft (83%)', D.evaluateLimit(limit, minutes(10)).level === 'soft', D.evaluateLimit(limit, minutes(10)));
  check('9 of 12 minutes is ok (75%)', D.evaluateLimit(limit, minutes(9)).level === 'ok');
  check('12 of 12 minutes is hard (100%)', D.evaluateLimit(limit, minutes(12)).level === 'hard');
  check('15 of 12 minutes is hard', D.evaluateLimit(limit, minutes(15)).level === 'hard');
  const usd = D.evaluateLimit({ metric: 'usd', amount: 5, warnPercent: 80 }, minutes(100));
  check('a USD limit with no reported cost is unmeasured, not 0', usd.level === 'unmeasured' && usd.observed === null && usd.percent === null, usd);
  check('reported cost is measured', D.evaluateLimit({ metric: 'usd', amount: 5, warnPercent: 80 }, { agentMs: 0, tokens: null, costUsd: 6, runs: 3 }).level === 'hard');
  check('tokens not reported are unmeasured', D.evaluateLimit({ metric: 'tokens', amount: 1000, warnPercent: 80 }, minutes(1)).level === 'unmeasured');
  check('admits: nothing at 100% passes', D.admits(D.evaluateLimits([limit], minutes(11.9))) && !D.admits(D.evaluateLimits([limit], minutes(12))));
  check('admits: an unmeasured limit never stops work', D.admits([usd]));
  check('worst level ignores unmeasured', D.worstLevel([usd, D.evaluateLimit(limit, minutes(10))]) === 'soft');
  const facts = D.limitFacts({ mission: { totals: minutes(15), statuses: D.evaluateLimits([limit], minutes(15)) }, month: [] });
  check('facts: mission.agent_minutes and mission.limit_percent', facts['mission.agent_minutes'] === 15 && facts['mission.limit_percent'] === 125, facts);
  check('facts: tokens and spend not reported are not measured (absent, never 0)', !('mission.tokens' in facts) && !('mission.spend_usd' in facts), facts);
  check('facts: no monthly limit, no workspace.month_limit_percent', !('workspace.month_limit_percent' in facts));
  check('facts: without a limit, mission.limit_percent is absent', !('mission.limit_percent' in D.limitFacts({ mission: { totals: minutes(15), statuses: [] } })));
  check('a gate over the facts', D.evaluateGate('mission.limit_percent < 100', facts).passed === false);
  const { GATE_FACT_VOCABULARY } = await import('@tandemise/evaluation');
  const names = GATE_FACT_VOCABULARY.map((f) => f.name);
  for (const n of ['mission.agent_minutes', 'mission.tokens', 'mission.spend_usd', 'mission.limit_percent', 'workspace.month_limit_percent']) check(`${n} is in the published vocabulary`, names.includes(n));
}

section('pure: the month comes from the injected clock, in local time');
{
  const lastMs = new Date(2026, 8, 30, 23, 59, 59, 999).getTime();
  const sep = D.monthWindow(lastMs);
  const oct = D.monthWindow(lastMs + 1);
  check('the last millisecond of September is September', sep.month === '2026-09' && sep.start === new Date(2026, 8, 1).toISOString() && sep.end === new Date(2026, 9, 1).toISOString(), sep);
  check('one millisecond later is October', oct.month === '2026-10' && oct.start === sep.end, oct);
  check('December rolls into the next year', D.monthWindow(new Date(2026, 11, 15).getTime()).end === new Date(2027, 0, 1).toISOString());
  check('a month label reads back to the same window', eq(D.monthWindowOf('2026-09'), sep));
  check('a bad label is null', D.monthWindowOf('2026-13') === null && D.monthWindowOf('Sept') === null);
  const source = readFileSync(join(here, '../packages/application/dist/services/limit-service.js'), 'utf8');
  check('the limit service never reads Date.now()', !/Date\.now\(/.test(source));
  check('the domain month window never reads Date.now()', !/Date\.now\(/.test(readFileSync(join(here, '../packages/domain/dist/entities/limits.js'), 'utf8')));
}

section('pure: the words say the numbers');
{
  const status = D.evaluateLimit({ metric: 'agent_minutes', amount: 12, warnPercent: 80 }, { agentMs: 15 * 60_000, tokens: null, costUsd: null, runs: 3 });
  check('"Limit reached: 15 of 12 agent minutes"', D.reachedReason(status, 'mission') === 'Limit reached: 15 of 12 agent minutes', D.reachedReason(status, 'mission'));
  check('bar "15 / 12 agent min"', D.barLabel(status) === '15 / 12 agent min', D.barLabel(status));
  const soft = D.evaluateLimit({ metric: 'agent_minutes', amount: 12, warnPercent: 80 }, { agentMs: 10 * 60_000, tokens: null, costUsd: null, runs: 2 });
  check('warning note "10 of 12 agent minutes used (83%)"', D.warningNote(soft, 'mission').startsWith('Limit warning: 10 of 12 agent minutes used (83%).'), D.warningNote(soft, 'mission'));
  check('USD bar says not reported', D.barLabel(D.evaluateLimit({ metric: 'usd', amount: 5, warnPercent: 80 }, D.NO_USAGE)) === 'not reported / $5.00');
  check('tokens are grouped', D.formatAmount('tokens', 12000) === '12,000 tokens');
  check('a raise is suggested above what was used', D.suggestedRaise(status) > 15, D.suggestedRaise(status));
  check('normalize: one per metric, warn default 80', eq(D.normalizeLimits([{ metric: 'tokens', amount: 5 }, { metric: 'agent_minutes', amount: 3, warnPercent: 150 }, { metric: 'tokens', amount: 9 }]), [{ metric: 'agent_minutes', amount: 3, warnPercent: 99 }, { metric: 'tokens', amount: 9, warnPercent: 80 }]));
  check('withAmount replaces the metric\'s amount only', eq(D.withAmount([{ metric: 'agent_minutes', amount: 12, warnPercent: 70 }], 'agent_minutes', 30), [{ metric: 'agent_minutes', amount: 30, warnPercent: 70 }]));
}

section('pure: the backlog spend rule');
{
  check('under the warning level everything may be pulled', D.MISSION_PRIORITIES.every((p) => D.pullAllowedAtSpend(p, 'ok')));
  check('over the warning level only urgent and high', eq(D.MISSION_PRIORITIES.map((p) => D.pullAllowedAtSpend(p, 'soft')), [true, true, false, false]));
  check('at the limit nothing', D.MISSION_PRIORITIES.every((p) => !D.pullAllowedAtSpend(p, 'hard')));
  const month = D.evaluateLimit({ metric: 'agent_minutes', amount: 60, warnPercent: 80 }, { agentMs: 51 * 60_000, tokens: null, costUsd: null, runs: 1 });
  check('held label names the level and the numbers', D.heldLabel(month).startsWith('Held: this project is over 80% of its monthly limit (51 of 60 agent minutes)'), D.heldLabel(month));
}

// ------------------------------------------------------------ admission, stubbed
section('scheduler: a run is never dispatched in an over-limit mission, called directly');
{
  const now = '2026-09-26T10:00:00.000Z';
  const mission = (id) => ({ id, workspaceId: 'ws_1', status: 'EXECUTING', priority: 'normal', rank: 1, createdAt: now, queuedAt: null, title: id, statusReason: null });
  const missions = [mission('msn_over'), mission('msn_fine')];
  const task = (missionId) => ({ id: `tsk_${missionId}`, key: 'build', missionId, status: 'READY', statusReason: null, orderHint: 0, executor: 'agent', staffing: {}, dependsOn: [], roleId: 'development', expectedOutputs: [] });
  const tasks = new Map(missions.map((m) => [m.id, [task(m.id)]]));
  const started = [];
  const asked = [];
  const noop = () => undefined;
  const scheduler = new app.SchedulerService({
    workspaces: { get: () => ({ id: 'ws_1', concurrency: { maxTotalWorkers: 4, perRuntime: {} } }) },
    missions: { list: () => missions, get: (id) => missions.find((m) => m.id === id) },
    tasks: { listByMission: (id) => tasks.get(id) ?? [], get: (id) => [...tasks.values()].flat().find((t) => t.id === id), update: noop },
    approvals: {}, repositories: {}, waiter: {}, remediation: {}, integration: {}, members: {},
    executor: { execute: (taskId) => { started.push(taskId); return new Promise(() => undefined); } },
    recorder: { record: noop, invalidate: noop, note: noop },
    staffing: { isStale: () => false, snapshot: () => ({}) },
    reviews: { sweepEscalations: noop },
    rounds: { releaseStranded: noop },
    limits: { admit: (id) => { asked.push(id); return id === 'msn_over' ? 'Limit reached: 15 of 12 agent minutes' : null; } },
    clock: { now: () => now, epochMs: () => Date.parse(now) },
    log: { info: noop, warn: noop, error: noop, debug: noop, child() { return this; } },
  });
  await scheduler.tick();
  await scheduler.tick();
  check('the over-limit mission\'s task never starts', !started.includes('tsk_msn_over'), started);
  check('the other mission\'s task starts', started.includes('tsk_msn_fine'), started);
  check('the rule was asked for both missions', asked.includes('msn_over') && asked.includes('msn_fine'), asked);
}

// ---------------------------------------------------------------- the daemon
const root = mkdtempSync(join(tmpdir(), 'tdl-'));
const home = join(root, 'h');
const repo = join(root, 'r');
const gitConfig = join(root, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Limits Tester\n\temail = limits@example.com\n');
const savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, TANDEMISE_OWNER_NAME: process.env.TANDEMISE_OWNER_NAME, SCRIPTED_DELAY_MS: process.env.SCRIPTED_DELAY_MS };
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.SCRIPTED_DELAY_MS = '0';
delete process.env.TANDEMISE_OWNER_NAME;
execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
writeFileSync(join(repo, 'README.md'), '# limits check\n');
mkdirSync(join(repo, '.tandemise', 'workflows'), { recursive: true });
copyFileSync(join(here, 'acceptance/p0/workflows/p8-steps.yaml'), join(repo, '.tandemise/workflows/p8-steps.yaml'));
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
const poll = async (fn, ms = 60_000) => {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(150)) { const v = await fn(); if (v) return v; }
  return undefined;
};
const sql = (q, ...p) => {
  const db = new globalThis.__sqlite.DatabaseSync(join(home, 'tandemise.db'), { readOnly: true });
  try { return db.prepare(q).all(...p); } finally { db.close(); }
};

try {
  section('migration 014');
  {
    const system = await api('GET', '/v1/system');
    check('schema version is at least 14', system.body?.schemaVersion >= 14, system.body?.schemaVersion);
    const cols = (t) => sql(`SELECT name, dflt_value, "notnull" AS nn FROM pragma_table_info('${t}')`);
    check('missions.limits exists and is nullable', cols('missions').some((c) => c.name === 'limits' && c.nn === 0));
    const ws = cols('workspaces');
    check('workspaces.default_mission_limits and monthly_limits default to []', ['default_mission_limits', 'monthly_limits'].every((n) => ws.find((c) => c.name === n)?.dflt_value === "'[]'"), ws.slice(-4));
    const inc = cols('limit_incidents').map((c) => c.name);
    check('limit_incidents has the roadmap columns', ['id', 'workspace_id', 'mission_id', 'metric', 'window_start', 'window_end', 'amount_limit', 'amount_observed', 'threshold', 'status', 'approval_id', 'created_at'].every((n) => inc.includes(n)), inc);
    const table = sql("SELECT sql FROM sqlite_master WHERE name = 'limit_incidents'")[0]?.sql ?? '';
    check('threshold and status are CHECKed', table.includes("threshold IN ('soft','hard')") && table.includes("status IN ('open','resolved','dismissed')"), table);
    const index = sql("SELECT sql FROM sqlite_master WHERE name = 'ux_limit_incidents_scope'")[0]?.sql ?? '';
    check('one incident per scope/metric/window/threshold/limit, NULL mission included', /UNIQUE/i.test(index) && index.includes("COALESCE(mission_id, '')"), index);
  }

  const wsRes = await api('POST', '/v1/workspaces', { name: 'Limits', repositoryPath: repo });
  const ws = wsRes.body?.workspace?.id;
  check('workspace created with no limits', wsRes.status === 200 && eq(wsRes.body?.workspace?.defaultMissionLimits, []) && eq(wsRes.body?.workspace?.monthlyLimits, []), wsRes.body?.workspace);
  const autonomy = { ...wsRes.body.workspace.autonomy, planApproval: 'auto' };
  await api('PATCH', `/v1/workspaces/${ws}`, { autonomy });
  const runtime = await api('POST', '/v1/runtimes', {
    adapterId: 'generic-cli', name: 'Scripted agent', workspaceId: null,
    settings: { command: process.execPath, args: [resolve(here, 'acceptance/p0/scripted-agent.mjs')], promptVia: 'stdin', outputFormat: 'ndjson', capabilities: ['reasoning', 'tool_calling', 'shell', 'git', 'filesystem', 'mcp'] },
    maxConcurrent: 4, enabled: true,
  });
  check('a scripted runtime that reports usage as NDJSON', runtime.status === 200, runtime.body);

  // Planned from the workflow file and accepted automatically; then started, as the Start button does.
  const create = async (goal, extra = {}) => {
    const body = (await api('POST', '/v1/missions', { workspaceId: ws, goal, workflowPreset: 'p8-steps', successCriteria: ['The five steps finish'], planNow: true, ...extra })).body;
    const id = body?.mission?.id;
    if (id !== undefined) {
      await poll(() => /Ready to start/.test(sql('SELECT status_reason AS r FROM missions WHERE id = ?', id)[0]?.r ?? '') || sql('SELECT status FROM missions WHERE id = ?', id)[0]?.status !== 'PLANNING', 20_000);
      await api('POST', `/v1/missions/${id}/start`);
    }
    return body;
  };
  const mission = (id) => sql('SELECT status, status_reason AS reason, limits FROM missions WHERE id = ?', id)[0];
  const runs = (id) => sql("SELECT id, status, started_at FROM runs WHERE mission_id = ? ORDER BY started_at", id);
  const notes = async (id) => { const e = await api('GET', `/v1/missions/${id}/events?limit=1000`); return (e.body.events ?? e.body).filter((r) => r.body.type === 'note').map((r) => r.body.text); };
  const incidents = (id) => sql('SELECT * FROM limit_incidents WHERE mission_id IS ? ORDER BY created_at', id);
  const detail = async (id) => (await api('GET', `/v1/missions/${id}`)).body;

  section('H1: a 12-minute limit warns after run 2 and stops after run 3');
  let a;
  {
    const created = await create('Hello page SCRIPTED_USAGE_MIN=5', { limits: [{ metric: 'agent_minutes', amount: 12 }] });
    a = created?.mission?.id;
    check('created with its own limit (warn defaults to 80)', eq(created?.mission?.limits, [{ metric: 'agent_minutes', amount: 12, warnPercent: 80 }]), created?.mission ?? created);
    const paused = await poll(() => mission(a)?.status === 'PAUSED' && mission(a));
    check('paused', paused?.status === 'PAUSED', mission(a));
    check('status reason "Limit reached: 15 of 12 agent minutes"', paused?.reason === 'Limit reached: 15 of 12 agent minutes', paused?.reason);
    check('exactly three runs', runs(a).length === 3, runs(a));
    const all = await notes(a);
    check('the 80% note after run 2', all.some((t) => t.startsWith('Limit warning: 10 of 12 agent minutes used (83%)')), all);
    const inc = incidents(a);
    check('one soft and one hard incident', eq(inc.map((i) => [i.threshold, i.status, i.amount_limit, i.amount_observed]), [['soft', 'open', 12, 10], ['hard', 'open', 12, 15]]), inc);
    const card = sql('SELECT * FROM approvals WHERE id = ?', inc[1]?.approval_id)[0];
    check('the hard incident has a PENDING intervention card', card?.status === 'PENDING' && card.kind === 'intervention', card);
    check('its options: Raise limit and resume / Keep paused', eq(JSON.parse(card?.options ?? '[]').map((o) => o.label), ['Raise limit and resume', 'Keep paused']), card?.options);
    check('its title states the numbers', card?.title.includes('15 of 12 agent minutes'), card?.title);
    const d = await detail(a);
    check('the mission view carries the limit bar', d.limits?.limits?.[0]?.bar === '15 / 12 agent min' && d.limits.limits[0].level === 'hard' && d.limits.pendingApprovalId === card?.id, d.limits);
    check('agent minutes come from usage records', d.limits?.usage?.agentMinutes === 15, d.limits?.usage);
    await sleep(1500);
    check('nothing more runs while it is paused', runs(a).length === 3);
    const home = (await api('GET', `/v1/home?workspaceId=${ws}`)).body;
    check('Home carries a hard alert for it', home.limitAlerts?.some((x) => x.missionId === a && x.level === 'hard' && x.text.startsWith('Limit reached: 15 of 12 agent minutes')), home.limitAlerts);
    const resume = await api('POST', `/v1/missions/${a}/resume`);
    check('Resume is refused at the limit (412), saying why', code(resume) === '412 PRECONDITION_FAILED' && /Limit reached: 15 of 12 agent minutes/.test(resume.body?.error?.message), resume.body);

    section('H3: raise to 30 and resume, exactly once');
    const low = await api('POST', `/v1/approvals/${card.id}/decide`, { optionId: 'raise_limit', raiseTo: 15 });
    check('a raise that would stop again at once is refused (400)', low.status === 400 && /Raise it above 15 agent minutes/.test(low.body?.error?.message), low.body);
    const none = await api('POST', `/v1/approvals/${card.id}/decide`, { optionId: 'raise_limit' });
    check('a raise without a number is refused (400)', none.status === 400, none.body);
    check('the card is still open after refusals', sql('SELECT status FROM approvals WHERE id = ?', card.id)[0].status === 'PENDING');
    const [one, two] = await Promise.all([
      api('POST', `/v1/approvals/${card.id}/decide`, { optionId: 'raise_limit', raiseTo: 30 }),
      api('POST', `/v1/approvals/${card.id}/decide`, { optionId: 'raise_limit', raiseTo: 30 }),
    ]);
    check('deciding twice: one succeeds, one is a conflict', eq([one.status, two.status].sort(), [200, 409]), [code(one), code(two)]);
    await sleep(300);
    const resumedEvents = (await api('GET', `/v1/missions/${a}/events?limit=1000`)).body;
    const resumes = (resumedEvents.events ?? resumedEvents).filter((r) => r.body.type === 'mission.status' && r.body.from === 'PAUSED' && r.body.to === 'EXECUTING');
    check('resumed exactly once', resumes.length === 1 && resumes[0].body.reason === 'Limit raised to 30 agent minutes; resumed.', resumes.map((r) => r.body));
    check('the mission now carries a 30-minute limit', eq(JSON.parse(mission(a).limits), [{ metric: 'agent_minutes', amount: 30, warnPercent: 80 }]), mission(a).limits);
    check('the hard incident is resolved', incidents(a).find((i) => i.threshold === 'hard' && i.amount_limit === 12)?.status === 'resolved');
    const service = app.LimitService;
    check('the service is exported for harnesses', typeof service === 'function');
    const done = await poll(() => mission(a)?.status === 'COMPLETE');
    check('it finishes under the new limit', done === true, mission(a));
    check('five runs in all, 25 minutes', runs(a).length === 5 && (await detail(a)).limits.usage.agentMinutes === 25, runs(a).length);
    check('the new limit warns afresh at 25 of 30', (await notes(a)).some((t) => t.startsWith('Limit warning: 25 of 30 agent minutes used (83%)')), await notes(a));
  }

  section('H2: keep paused');
  let b;
  {
    b = (await create('Keep me paused SCRIPTED_USAGE_MIN=5', { limits: [{ metric: 'agent_minutes', amount: 12 }] }))?.mission?.id;
    await poll(() => mission(b)?.status === 'PAUSED');
    const hard = incidents(b).find((i) => i.threshold === 'hard');
    const kept = await api('POST', `/v1/approvals/${hard.approval_id}/decide`, { optionId: 'keep_paused' });
    check('Keep paused is accepted', kept.status === 200 && kept.body?.approval?.status === 'REJECTED', code(kept));
    check('the incident is resolved', incidents(b).find((i) => i.threshold === 'hard').status === 'resolved');
    check('the mission stays paused and says how to go on', mission(b).status === 'PAUSED' && mission(b).reason === 'Kept paused at its limit: 15 of 12 agent minutes. Raise the limit to resume.', mission(b));
    await sleep(1500);
    check('no more runs', runs(b).length === 3, runs(b).length);
  }

  section('admission: a lowered limit stops a working mission before its next run');
  {
    const raised = await api('PATCH', `/v1/missions/${b}`, { limits: [{ metric: 'agent_minutes', amount: 100 }] });
    check('PATCH limits answers with the mission', raised.status === 200 && raised.body?.limits?.limits?.[0]?.amount === 100, code(raised));
    await poll(() => mission(b)?.status !== 'PAUSED', 5000);
    check('raising the limit of a mission kept paused resumes it', ['EXECUTING', 'COMPLETE'].includes(mission(b).status), mission(b));
    // Hold it in place: lower the limit below what was used while it works.
    const before = runs(b).length;
    const lowered = await api('PATCH', `/v1/missions/${b}`, { limits: [{ metric: 'agent_minutes', amount: 12 }] });
    const at = new Date().toISOString();
    check('lowering the limit below what was used pauses it at once', lowered.status === 200 && ['PAUSED', 'COMPLETE'].includes(mission(b).status), mission(b));
    await sleep(2000);
    // A run already being set up when the limit was lowered is stopped, never run to an end.
    const started = runs(b).filter((r) => r.started_at > at && r.status !== 'CANCELLED').length;
    if (mission(b).status !== 'COMPLETE') {
      check('the scheduler stops it at admission: paused', mission(b).status === 'PAUSED', mission(b));
      check('no run went ahead after the limit was lowered', started === 0, { before, after: runs(b), started });
      check('its card is open again', incidents(b).some((i) => i.threshold === 'hard' && i.status === 'open'), incidents(b));
    } else {
      check('(it finished before the limit was lowered; nothing to stop)', true);
    }
  }

  section('H5: a USD limit on a runtime that reports no cost');
  {
    const c = (await create('Cost unknown SCRIPTED_USAGE_MIN=1', { limits: [{ metric: 'usd', amount: 5 }] }))?.mission?.id;
    await poll(() => mission(c)?.status === 'COMPLETE');
    check('it runs to the end: an unmeasured limit never stops work', mission(c).status === 'COMPLETE', mission(c));
    check('no incident', incidents(c).length === 0, incidents(c));
    const n = (await notes(c)).filter((t) => t.startsWith('USD limit cannot be measured for this runtime'));
    check('the note is said once', n.length === 1, n);
    const d = await detail(c);
    check('the bar reads "not reported / $5.00"', d.limits.limits[0].bar === 'not reported / $5.00' && d.limits.limits[0].level === 'unmeasured', d.limits.limits[0]);
    check('cost stays null, tokens are measured', d.limits.usage.costUsd === null && d.limits.usage.tokens === 7500, d.limits.usage);
    check('the metrics say cost is not reported', d.metrics.costUsd === null);
  }

  section('a USD limit on reported cost stops like any other');
  {
    const c = (await create('Cost known SCRIPTED_USAGE_MIN=1 SCRIPTED_COST_USD=2', { limits: [{ metric: 'usd', amount: 5 }] }))?.mission?.id;
    await poll(() => mission(c)?.status === 'PAUSED');
    check('paused at "$6.00 of $5.00"', mission(c).reason === 'Limit reached: $6.00 of $5.00', mission(c));
    await api('POST', `/v1/missions/${c}/cancel`, { reason: 'check: done' });
  }

  section('H4: over 80% of the monthly limit only urgent and high are pulled');
  let normal; let high;
  {
    const usage = (await api('GET', `/v1/workspaces/${ws}/usage`)).body;
    const used = usage.usage.agentMinutes;
    check('the usage view sums the month', used > 40 && usage.month === D.monthWindow(Date.now()).month && usage.missions.length >= 4, usage);
    const amount = Math.ceil(used / 0.85);
    const set = await api('PATCH', `/v1/workspaces/${ws}`, { monthlyLimits: [{ metric: 'agent_minutes', amount }] });
    check('PATCH monthlyLimits', set.status === 200 && set.body?.workspace?.monthlyLimits?.[0]?.amount === amount, code(set));
    const month = (await api('GET', `/v1/workspaces/${ws}/usage`)).body.limits[0];
    check('the month reads soft', month.level === 'soft', month);
    const home = (await api('GET', `/v1/home?workspaceId=${ws}`)).body;
    check('Home carries the project warning', home.limitAlerts?.some((x) => x.scope === 'project' && x.level === 'soft' && x.text.startsWith('Monthly limit warning')), home.limitAlerts);
    normal = (await api('POST', '/v1/missions', { workspaceId: ws, goal: 'Normal work', workflowPreset: 'p8-steps', successCriteria: ['Done'], queued: true })).body?.mission?.id;
    high = (await api('POST', '/v1/missions', { workspaceId: ws, goal: 'High work', workflowPreset: 'p8-steps', successCriteria: ['Done'], queued: true, priority: 'high' })).body?.mission?.id;
    let view = (await api('GET', `/v1/workspaces/${ws}/backlog`)).body;
    check('the normal mission is held, with the reason', /^Held: this project is over 80% of its monthly limit/.test(view.items.find((i) => i.summary.mission.id === normal)?.held ?? ''), view.items.map((i) => i.held));
    check('the high mission is not held', view.items.find((i) => i.summary.mission.id === high)?.held === null);
    await api('PATCH', `/v1/workspaces/${ws}`, { maxActiveMissions: 1 });
    await poll(() => mission(high)?.status !== 'DRAFT', 10_000);
    await sleep(800);
    check('the high mission is pulled', mission(high).status !== 'DRAFT', mission(high));
    await poll(() => /Ready to start/.test(mission(high)?.reason ?? '') || mission(high)?.status !== 'PLANNING', 20_000);
    await api('POST', `/v1/missions/${high}/start`);
    await poll(() => ['COMPLETE', 'PAUSED'].includes(mission(high)?.status), 30_000);
    await sleep(1500);
    check('the normal mission stays queued with a free slot', mission(normal).status === 'DRAFT', mission(normal));
    view = (await api('GET', `/v1/workspaces/${ws}/backlog`)).body;
    check('it still says why', /^Held:/.test(view.items.find((i) => i.summary.mission.id === normal)?.held ?? ''));
  }

  section('the project\'s monthly limit stops every working mission');
  {
    await api('PATCH', `/v1/workspaces/${ws}`, { maxActiveMissions: null });
    const d = (await create('Month stop SCRIPTED_USAGE_MIN=5'))?.mission?.id;
    const used = (await api('GET', `/v1/workspaces/${ws}/usage`)).body.usage.agentMinutes;
    await api('PATCH', `/v1/workspaces/${ws}`, { monthlyLimits: [{ metric: 'agent_minutes', amount: Math.floor(used + 4) }] });
    await poll(() => mission(d)?.status === 'PAUSED', 30_000);
    check('paused with the monthly reason', mission(d)?.status === 'PAUSED' && /^Monthly limit reached: this project used/.test(mission(d).reason), mission(d));
    const inc = incidents(null).filter((i) => i.threshold === 'hard');
    check('one project incident, no mission', inc.length === 1 && inc[0].mission_id === null && JSON.parse(inc[0].paused_missions).includes(d), inc);
    const card = sql('SELECT * FROM approvals WHERE id = ?', inc[0].approval_id)[0];
    check('its card has no mission and asks to raise the monthly limit', card?.mission_id === null && card.title.startsWith('This project reached its monthly limit'), card);
    const inbox = (await api('GET', `/v1/inbox?workspaceId=${ws}`)).body;
    check('the card is in the Inbox', inbox.approvals.some((x) => x.approval.id === card.id));
    const raised = await api('POST', `/v1/approvals/${card.id}/decide`, { optionId: 'raise_limit', raiseTo: Math.ceil(used + 100) });
    check('raising the monthly limit is accepted', raised.status === 200, code(raised));
    await poll(() => mission(d)?.status !== 'PAUSED', 5000);
    check('the paused mission resumes', mission(d).status !== 'PAUSED', mission(d));
    const ws2 = (await api('GET', `/v1/workspaces/${ws}`)).body.workspace;
    check('the project now carries the raised limit', ws2.monthlyLimits[0].amount === Math.ceil(used + 100), ws2.monthlyLimits);
    await poll(() => mission(d)?.status === 'COMPLETE', 30_000);
    await api('PATCH', `/v1/workspaces/${ws}`, { monthlyLimits: [] });
  }

  section('refusals');
  {
    const bad = await api('PATCH', `/v1/workspaces/${ws}`, { monthlyLimits: [{ metric: 'agent_minutes', amount: 0 }] });
    check('a limit of 0 is 400', bad.status === 400, code(bad));
    const dup = await api('PATCH', `/v1/workspaces/${ws}`, { monthlyLimits: [{ metric: 'tokens', amount: 1 }, { metric: 'tokens', amount: 2 }] });
    check('two limits on one metric is 400', dup.status === 400, code(dup));
    const month = await api('GET', `/v1/workspaces/${ws}/usage?month=Sept`);
    check('a bad month is 400', month.status === 400, code(month));
    const finished = await api('PATCH', `/v1/missions/${a}`, { limits: [{ metric: 'agent_minutes', amount: 40 }] });
    check('a finished mission\'s limits cannot change (412)', code(finished) === '412 PRECONDITION_FAILED', finished.body);
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
console.log('ALL P8 LIMITS CHECKS PASSED');
