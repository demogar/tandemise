// P12: model routing. Every run is given a model by one pure rule -
// retry escalation, then economy past a limit's warning level, then the step's
// model, the role's, the runtime profile's - and records which one and why. A
// review step can require that its run used a different runtime or model than
// the run it reviews (fact review.independent).
//
//   npm run build && node scratch/p12-models-check.mjs
//
// The rule first, as a table; then independence, the workflow file, and each
// runtime's argv; then a real daemon (startDaemon, in process) with the
// scripted agent, which records the argv it was started with.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

// ------------------------------------------------------------------ the rule
section('pure: resolveModel, one row per rule and per precedence pair');
{
  const base = { step: null, role: null, profileModel: null, attempt: 1, pressure: null, runtimeTakesModel: true };
  const role = { model: 'role-m', escalate: ['role-up1', 'role-up2'], economyModel: 'role-eco' };
  const step = { model: 'step-m', escalate: ['step-up1', 'step-up2'] };
  const mission85 = { percent: 85.7, scope: 'mission' };
  const month90 = { percent: 90, scope: 'month' };
  const rows = [
    // [label, context, model, reason, source]
    ['nothing set: runtime default', {}, null, 'runtime default', 'runtime'],
    ['profile model only', { profileModel: 'prof' }, 'prof', 'runtime profile default', 'profile'],
    ['role beats profile', { profileModel: 'prof', role }, 'role-m', 'role model', 'role'],
    ['step beats role and profile', { profileModel: 'prof', role, step }, 'step-m', 'step override', 'step'],
    ['step without a model falls to the role', { role, step: { escalate: ['x'] } }, 'role-m', 'role model', 'role'],
    ['attempt 2 takes the first rung of the step ladder', { role, step, attempt: 2 }, 'step-up1', 'retry escalation (attempt 2)', 'escalation'],
    ['attempt 3 takes the second rung', { role, step, attempt: 3 }, 'step-up2', 'retry escalation (attempt 3)', 'escalation'],
    ['past the end of the ladder stays on the last rung', { role, step, attempt: 7 }, 'step-up2', 'retry escalation (attempt 7)', 'escalation'],
    ['no step ladder: the role ladder', { role, step: { model: 'step-m' }, attempt: 2 }, 'role-up1', 'retry escalation (attempt 2)', 'escalation'],
    ['an empty step ladder is no ladder', { role, step: { model: 'step-m', escalate: [] }, attempt: 2 }, 'role-up1', 'retry escalation (attempt 2)', 'escalation'],
    ['no ladder anywhere: attempt 2 keeps the step model', { step: { model: 'step-m' }, attempt: 2 }, 'step-m', 'step override', 'step'],
    ['economy beats the step model past the warning level', { role, step, pressure: mission85 }, 'role-eco', 'economy: 85% of limit', 'economy'],
    ['economy on the month says monthly', { role, pressure: month90 }, 'role-eco', 'economy: 90% of monthly limit', 'economy'],
    ['escalation beats economy', { role, step, pressure: mission85, attempt: 2 }, 'step-up1', 'retry escalation (attempt 2)', 'escalation'],
    ['pressure without an economy model changes nothing', { role: { model: 'role-m', escalate: [], economyModel: null }, pressure: mission85 }, 'role-m', 'role model', 'role'],
    ['no pressure, no economy', { role }, 'role-m', 'role model', 'role'],
    ['a runtime that takes no model: runtime default, whatever was asked', { role, step, attempt: 2, pressure: mission85, profileModel: 'prof', runtimeTakesModel: false }, null, 'runtime default', 'runtime'],
    ['blank strings are not set', { role: { model: '  ', escalate: [' ', ''], economyModel: '' }, step: { model: '' }, profileModel: ' ', attempt: 2, pressure: mission85 }, null, 'runtime default', 'runtime'],
    ['names are trimmed', { step: { model: ' step-m ' } }, 'step-m', 'step override', 'step'],
  ];
  for (const [label, ctx, model, reason, source] of rows) {
    const got = D.resolveModel({ ...base, ...ctx });
    check(`${label}: ${model ?? 'none'} · ${reason}`, got.model === model && got.reason === reason && got.source === source, got);
  }
  check('percent rounds down (85.7 → 85)', D.resolveModel({ ...base, role, pressure: { percent: 99.99, scope: 'mission' } }).reason === 'economy: 99% of limit');
  check('the drawer label joins model and reason', D.modelLabel({ model: 'opus', modelReason: 'retry escalation (attempt 2)' }) === 'Model: opus · retry escalation (attempt 2)', D.modelLabel({ model: 'opus', modelReason: 'retry escalation (attempt 2)' }));
  check('no model reads "Model: runtime default"', D.modelLabel({ model: null, modelReason: 'runtime default' }) === 'Model: runtime default');
  check('a run from before P12 reads "Model: not recorded"', D.modelLabel({ model: null, modelReason: null }) === 'Model: not recorded');
  check('a model name with a space is refused', D.modelProblem('big model') !== null && D.modelProblem('claude-opus-4') === null && D.modelProblem('x'.repeat(101)) !== null);
}

section('pure: modelsIndependent');
{
  const run = (adapterId, model) => ({ adapterId, model });
  check('different runtimes are independent', D.modelsIndependent(run('claude-code', 'opus'), run('codex', 'opus')) === true);
  check('same runtime, different models', D.modelsIndependent(run('claude-code', 'opus'), run('claude-code', 'sonnet')) === true);
  check('same runtime, same model: not independent', D.modelsIndependent(run('claude-code', 'opus'), run('claude-code', 'opus')) === false);
  check('same runtime, one on its default: cannot be shown to differ', D.modelsIndependent(run('claude-code', null), run('claude-code', 'opus')) === false);
  check('different runtimes, both on defaults: independent', D.modelsIndependent(run('claude-code', null), run('codex', null)) === true);
}

section('workflow file: model, escalate, independentOf');
{
  const wf = {
    name: 'Models',
    steps: [
      { key: 'implement', role: 'development', objective: 'Build.', outputs: ['ChangeSet'], gate: 'artifact.ChangeSet.exists', model: 'step-m', escalate: ['up1', 'up2'] },
      { key: 'review', role: 'review', objective: 'Review.', dependsOn: ['implement'], outputs: ['ReviewReport'], gate: 'artifact.ReviewReport.exists', independentOf: 'implement' },
      { key: 'notes', role: 'product', objective: 'Notes.', dependsOn: ['review'], independentOf: 'implement' },
    ],
  };
  const parsed = D.parseWorkflowDefinition(wf);
  check('parses', parsed.ok, parsed.error);
  const plan = D.compileWorkflow(parsed.value, {});
  check('compiles', plan.ok, plan.error);
  const [impl, review, notes] = plan.value?.tasks ?? [];
  check('implement carries its model and ladder', eq(impl?.modelPolicy, { model: 'step-m', escalate: ['up1', 'up2'] }), impl?.modelPolicy);
  check('review carries independentOf', eq(review?.modelPolicy, { independentOf: 'implement' }), review?.modelPolicy);
  check('its gate gains review.independent', review?.completionGate === '(artifact.ReviewReport.exists) && review.independent', review?.completionGate);
  check('a step with no gate gets review.independent as its gate', notes?.completionGate === 'review.independent', notes?.completionGate);
  check('an upstream step two levels away is allowed', D.compileWorkflow(parsed.value, {}).ok);
  check('a step with no model settings has no policy', D.compileWorkflow(D.parseWorkflowDefinition({ name: 'x', steps: [{ key: 'a', role: 'product', objective: 'A.' }] }).value, {}).value.tasks[0].modelPolicy === null);
  const bad = (steps) => { const p = D.parseWorkflowDefinition({ name: 'Bad', steps }); return p.ok ? D.compileWorkflow(p.value, {}) : p; };
  const notUpstream = bad([{ key: 'a', role: 'product', objective: 'A.' }, { key: 'b', role: 'review', objective: 'B.', independentOf: 'a' }]);
  check('independentOf a step it does not depend on is refused', !notUpstream.ok && notUpstream.error.some((i) => /independentOf/.test(i.path) && /depend/.test(i.message)), notUpstream.error);
  const self = bad([{ key: 'a', role: 'product', objective: 'A.', independentOf: 'a' }]);
  check('independentOf itself is refused', !self.ok, self);
  check('a model with a space is refused', !bad([{ key: 'a', role: 'product', objective: 'A.', model: 'big model' }]).ok);
  check('a ladder of six is refused', !bad([{ key: 'a', role: 'product', objective: 'A.', escalate: ['1', '2', '3', '4', '5', '6'] }]).ok);
}

section('runtimes: the model reaches the argv');
{
  const claude = await import('@tandemise/runtime-claude');
  const codex = await import('@tandemise/runtime-codex');
  const generic = await import('@tandemise/runtime-generic');
  const profile = (adapterId, settings) => ({ id: 'rtp_x', workspaceId: null, adapterId, name: adapterId, executablePath: null, args: [], settings, capabilities: [], enabled: true, maxConcurrent: 1, createdAt: '', updatedAt: '' });
  const request = (p, model) => ({ runId: 'run_x', profile: p, prompt: 'Do it.', workingDirectory: tmpdir(), grants: [], allowedRoots: [], mcpConfigPath: null, maxWallTimeMs: 1000, signal: new AbortController().signal, log: null, ...(model === undefined ? {} : { model }) });
  const after = (args, flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const cp = profile('claude-code', { model: 'prof' });
  check('Claude: the request model wins over the profile setting', after(claude.buildInvocation(request(cp, 'opus'), null).args, '--model') === 'opus');
  check('Claude: a null request model passes no --model', !claude.buildInvocation(request(cp, null), null).args.includes('--model'));
  check('Claude: no request model keeps the profile setting (older callers)', after(claude.buildInvocation(request(cp), null).args, '--model') === 'prof');
  const codexSettings = codex.parseCodexSettings ? codex.parseCodexSettings({}) : null;
  if (codexSettings !== null) {
    check('Codex: -m <model> from the request', after(codex.buildInvocation(codexSettings, request(profile('codex', {}), 'gpt-x'), null).args, '-m') === 'gpt-x');
    check('Codex: null passes no -m', !codex.buildInvocation(codexSettings, request(profile('codex', {}), null), null).args.includes('-m'));
  } else check('Codex settings parser is exported', false);
  const gs = (s) => generic.parseGenericCliSettings({ command: 'agent', args: ['run'], ...s }).value;
  check('Generic: with a modelFlag the model goes before the appended prompt', eq(generic.buildArgv(gs({ modelFlag: '--model' }), request(profile('generic-cli', {}), 'm1')).args, ['run', '--model', 'm1', 'Do it.']), generic.buildArgv(gs({ modelFlag: '--model' }), request(profile('generic-cli', {}), 'm1')).args);
  check('Generic: without a modelFlag nothing is added', eq(generic.buildArgv(gs({}), request(profile('generic-cli', {}), 'm1')).args, ['run', 'Do it.']));
  check('Generic: a null model adds nothing', eq(generic.buildArgv(gs({ modelFlag: '--model' }), request(profile('generic-cli', {}), null)).args, ['run', 'Do it.']));
  const ga = new generic.GenericCliAdapter({});
  check('acceptsModel: generic only with a modelFlag', ga.acceptsModel(profile('generic-cli', { command: 'a', modelFlag: '--model' })) === true && ga.acceptsModel(profile('generic-cli', { command: 'a' })) === false);
  const ca = new claude.ClaudeCodeAdapter({});
  check('acceptsModel: Claude Code always', ca.acceptsModel(profile('claude-code', {})) === true);
  const fake = new generic.FakeRuntimeAdapter({});
  check('acceptsModel: the fake runtime never', (fake.acceptsModel?.(profile('fake', {})) ?? false) === false);
}

section('vocabulary');
{
  const { GATE_FACT_VOCABULARY } = await import('@tandemise/evaluation');
  check('review.independent is published', GATE_FACT_VOCABULARY.some((f) => f.name === 'review.independent' && f.type === 'boolean'));
}

// ---------------------------------------------------------------- the daemon
const root = mkdtempSync(join(tmpdir(), 'tdm12-'));
const home = join(root, 'h');
const repo = join(root, 'r');
const argsDir = join(root, 'args');
const gitConfig = join(root, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Models Tester\n\temail = models@example.com\n');
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.SCRIPTED_DELAY_MS = '0';
process.env.SCRIPTED_ARGS_DIR = argsDir;
process.env.SCRIPTED_STATE_DIR = join(root, 'state');
delete process.env.TANDEMISE_OWNER_NAME;
execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
writeFileSync(join(repo, 'README.md'), '# models check\n');
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'm', private: true, scripts: { test: 'node -e "process.exit(0)"' } }));
mkdirSync(join(repo, '.tandemise', 'workflows'), { recursive: true });
for (const f of ['p12-models.yaml', 'p12-escalate.yaml', 'p12-economy.yaml', 'p12-review.yaml']) copyFileSync(join(here, 'acceptance/p0/workflows', f), join(repo, '.tandemise/workflows', f));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const poll = async (fn, ms = 60_000) => {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(150)) { const v = await fn(); if (v) return v; }
  return undefined;
};
const sql = (q, ...p) => {
  const db = new globalThis.__sqlite.DatabaseSync(join(home, 'tandemise.db'), { readOnly: true });
  try { return db.prepare(q).all(...p); } finally { db.close(); }
};
/** Every argv the scripted agent recorded for a mission's goal marker, oldest first. */
const argvs = (marker) => (existsSync(argsDir) ? readdirSync(argsDir) : []).sort()
  .map((f) => JSON.parse(readFileSync(join(argsDir, f), 'utf8'))).filter((r) => r.goal.includes(marker));
const modelArg = (argv) => { const i = argv.indexOf('--model'); return i < 0 ? null : argv[i + 1]; };

try {
  section('migration 017');
  {
    const system = await api('GET', '/v1/system');
    check('schema version is at least 17', system.body?.schemaVersion >= 17, system.body?.schemaVersion);
    const cols = (t) => sql(`SELECT name FROM pragma_table_info('${t}')`).map((c) => c.name);
    check('runs.model and runs.model_reason', ['model', 'model_reason'].every((c) => cols('runs').includes(c)));
    check('role_templates.models', cols('role_templates').includes('models'));
    check('mission_tasks.model_policy', cols('mission_tasks').includes('model_policy'));
  }

  const wsRes = await api('POST', '/v1/workspaces', { name: 'Models', repositoryPath: repo });
  const ws = wsRes.body?.workspace?.id;
  await api('PATCH', `/v1/workspaces/${ws}`, { autonomy: { ...wsRes.body.workspace.autonomy, planApproval: 'auto' } });
  const runtime = await api('POST', '/v1/runtimes', {
    adapterId: 'generic-cli', name: 'Scripted agent', workspaceId: null,
    settings: { command: process.execPath, args: [resolve(here, 'acceptance/p0/scripted-agent.mjs')], promptVia: 'stdin', outputFormat: 'ndjson', modelFlag: '--model', model: 'profile-model', capabilities: ['reasoning', 'tool_calling', 'shell', 'git', 'filesystem', 'mcp'] },
    maxConcurrent: 4, enabled: true,
  });
  check('a scripted runtime with a model flag and a default model', runtime.status === 200, runtime.body);

  const roles = async () => (await api('GET', `/v1/roles?workspaceId=${ws}`)).body;
  const setRole = async (id, models) => {
    const role = (await roles()).find((r) => r.id === id);
    const { createdAt, updatedAt, builtIn, workspaceId, ...rest } = role;
    return api('PUT', `/v1/roles/${id}`, { ...rest, workspaceId: ws, ...(models === undefined ? {} : { models }) });
  };
  const create = async (goal, preset, extra = {}) => {
    const body = (await api('POST', '/v1/missions', { workspaceId: ws, goal, workflowPreset: preset, successCriteria: ['The steps finish'], planNow: true, ...extra })).body;
    const id = body?.mission?.id;
    if (id !== undefined) {
      await poll(() => /Ready to start/.test(sql('SELECT status_reason AS r FROM missions WHERE id = ?', id)[0]?.r ?? '') || sql('SELECT status FROM missions WHERE id = ?', id)[0]?.status !== 'PLANNING', 20_000);
      await api('POST', `/v1/missions/${id}/start`);
    }
    return id;
  };
  const status = (id) => sql('SELECT status FROM missions WHERE id = ?', id)[0]?.status;
  const runsOf = (id) => sql('SELECT r.attempt, r.status, r.model, r.model_reason AS reason, t.key FROM runs r JOIN mission_tasks t ON t.id = r.task_id WHERE r.mission_id = ? ORDER BY r.started_at, r.rowid', id);

  section('role models round-trip; omitting them keeps them');
  {
    const put = await setRole('product', { model: 'role-product', escalate: [], economyModel: 'eco-product' });
    check('PUT /v1/roles/product with models', put.status === 200 && eq(put.body?.models, { model: 'role-product', escalate: [], economyModel: 'eco-product' }), put.body);
    const again = await setRole('product');
    check('a PUT without models keeps them', eq(again.body?.models, { model: 'role-product', escalate: [], economyModel: 'eco-product' }), again.body?.models);
    const bad = await setRole('product', { model: 'two words', escalate: [], economyModel: null });
    check('a model with a space is refused (400)', bad.status === 400, bad.status);
  }

  section('M1: step override, role model, profile default; each run records why');
  {
    const id = await create('Models M1', 'p12-models');
    await poll(() => ['COMPLETE', 'BLOCKED', 'FAILED'].includes(status(id)));
    check('the mission completes', status(id) === 'COMPLETE', { status: status(id), runs: runsOf(id) });
    const r = runsOf(id);
    check('implement: step-model · step override', r.find((x) => x.key === 'implement')?.model === 'step-model' && r.find((x) => x.key === 'implement')?.reason === 'step override', r);
    check('review: profile-model · runtime profile default', r.find((x) => x.key === 'review')?.model === 'profile-model' && r.find((x) => x.key === 'review')?.reason === 'runtime profile default', r);
    const a = argvs('Models M1');
    check('the agent was started with --model step-model, then --model profile-model', eq(a.map((x) => modelArg(x.argv)), ['step-model', 'profile-model']), a.map((x) => x.argv));
    const tasks = (await api('GET', `/v1/missions/${id}/tasks`)).body;
    const impl = (tasks.tasks ?? tasks).find((t) => t.key === 'implement');
    check('the task view carries the run model', impl?.latestRun?.model === 'step-model' && impl?.latestRun?.modelReason === 'step override', impl?.latestRun);
    check('and the step policy', eq(impl?.modelPolicy, { model: 'step-model', escalate: ['strong-model'] }), impl?.modelPolicy);
    const detail = (await api('GET', `/v1/missions/${id}`)).body;
    const by = detail.metrics?.byModel ?? [];
    check('metrics: usage by model lists both', eq(by.map((b) => [b.model, b.runs]).sort(), [['profile-model', 1], ['step-model', 1]]), by);
  }

  section('M2: a retry escalates on attempt 2');
  {
    const id = await create('Models M2 SCRIPTED_FAIL_TIMES=1', 'p12-escalate');
    await poll(() => ['COMPLETE', 'BLOCKED', 'FAILED'].includes(status(id)));
    check('the mission completes', status(id) === 'COMPLETE', { status: status(id), runs: runsOf(id) });
    const r = runsOf(id);
    check('attempt 1 on the step model, attempt 2 on the first rung', eq(r.map((x) => [x.attempt, x.model, x.reason]), [[1, 'step-model', 'step override'], [2, 'strong-model', 'retry escalation (attempt 2)']]), r);
    const a = argvs('Models M2');
    check('the recorded argv of run 2 has --model strong-model', eq(a.map((x) => modelArg(x.argv)), ['step-model', 'strong-model']), a.map((x) => x.argv));
  }

  section('M3: economy past the warning level');
  {
    const id = await create('Models M3 SCRIPTED_USAGE_MIN=6', 'p12-economy', { limits: [{ metric: 'agent_minutes', amount: 20, warnPercent: 25 }] });
    await poll(() => ['COMPLETE', 'BLOCKED', 'FAILED', 'PAUSED'].includes(status(id)));
    check('the mission completes', status(id) === 'COMPLETE', { status: status(id), runs: runsOf(id) });
    const r = runsOf(id);
    check('step 1 under the warning level: role model', r[0]?.model === 'role-product' && r[0]?.reason === 'role model', r);
    check('step 2 past it (6 of 20 = 30%): economy model', r[1]?.model === 'eco-product' && r[1]?.reason === 'economy: 30% of limit', r);
  }

  section('M4: review.independent fails on the same model and passes once it differs');
  {
    await setRole('review', { model: 'shared-model', escalate: [], economyModel: null });
    const id = await create('Models M4', 'p12-review');
    await poll(() => ['COMPLETE', 'BLOCKED', 'FAILED'].includes(status(id)));
    const tasks = async () => { const t = (await api('GET', `/v1/missions/${id}/tasks`)).body; return t.tasks ?? t; };
    const review = (await tasks()).find((t) => t.key === 'review');
    check('the review blocks on its gate', review?.status === 'BLOCKED' && status(id) === 'BLOCKED', { task: review?.status, reason: review?.statusReason, mission: status(id) });
    const fact = review?.gate?.facts?.['review.independent'] ?? review?.gate?.measured?.['review.independent'];
    check('its gate measured review.independent = false', review?.gate?.passed === false && JSON.stringify(review?.gate).includes('review.independent'), review?.gate);
    void fact;
    await setRole('review', { model: 'review-model', escalate: [], economyModel: null });
    const retry = await api('POST', `/v1/tasks/${review.id}/retry`, {});
    check('retry accepted', retry.status === 200, retry.body);
    await poll(() => status(id) === 'COMPLETE');
    check('after the reviewer role changes model, it passes and the mission completes', status(id) === 'COMPLETE', { status: status(id), runs: runsOf(id) });
    const r = runsOf(id).filter((x) => x.key === 'review');
    check('the review runs: shared-model then review-model', eq(r.map((x) => x.model), ['shared-model', 'review-model']), r);
  }

  section('a runtime that takes no model records "runtime default"');
  {
    await api('PATCH', `/v1/runtimes/${runtime.body.profile?.id ?? runtime.body.id}`, { settings: { command: process.execPath, args: [resolve(here, 'acceptance/p0/scripted-agent.mjs')], promptVia: 'stdin', outputFormat: 'ndjson', model: 'profile-model', capabilities: ['reasoning', 'tool_calling', 'shell', 'git', 'filesystem', 'mcp'] } });
    const id = await create('Models no flag', 'p12-escalate');
    await poll(() => ['COMPLETE', 'BLOCKED', 'FAILED'].includes(status(id)));
    const r = runsOf(id);
    check('model null, reason runtime default', r.length === 1 && r[0].model === null && r[0].reason === 'runtime default', r);
    const a = argvs('Models no flag');
    check('and no --model on the argv', a.length === 1 && !a[0].argv.includes('--model'), a.map((x) => x.argv));
  }

  section('the application never names a model');
  {
    const src = readFileSync(join(here, '../packages/domain/dist/entities/models.js'), 'utf8') + readFileSync(join(here, '../packages/application/dist/engine/task-executor.js'), 'utf8');
    check('no vendor model names in the rule or the executor', !/\b(opus|sonnet|haiku|gpt-\d)/i.test(src));
  }
} catch (e) {
  failures.push(`threw: ${e?.stack ?? e}`);
  console.log(e);
} finally {
  await daemon.stop();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
console.log('ALL P12 MODELS CHECKS PASSED');
process.exit(0);
