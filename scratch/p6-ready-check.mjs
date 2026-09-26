// P6: ready before planning. A rough request is refined into accepted criteria
// and answered questions, and the daemon refuses to plan a DRAFT mission until
// the readiness gate passes - through the service, through planNow and through
// the HTTP API alike.
//
//   npm run build && node scratch/p6-ready-check.mjs
//
// Pure rules first, then a real daemon (startDaemon, in process) with a
// generic-cli runtime running the scripted acceptance agent: the refinement
// pass is the real one, only the model is replaced.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const A = await import('@tandemise/artifacts');
const app = await import('@tandemise/application');

// ------------------------------------------------------------------ pure rules
section('pure: the readiness gate');
{
  check('the gate is the roadmap expression', D.READY_TO_PLAN_GATE === 'ready.criteria >= 1 && ready.open_questions == 0 && ready.proposed_pending == 0', D.READY_TO_PLAN_GATE);
  const r = (criteria, openQuestions, proposedPending) => D.evaluateReadiness({ criteria, openQuestions, proposedPending });
  check('one accepted criterion and nothing pending is ready', r(1, 0, 0).ready && r(1, 0, 0).label === 'Plan');
  const f1 = r(0, 1, 3);
  check('F1 shape: not ready, the button says what to do', !f1.ready && f1.label === 'Answer 1 question and decide 3 criteria to plan', f1.label);
  check('the detail is the gate language\'s own explanation', f1.detail.includes('ready.open_questions is 1, needs 0') && f1.detail.includes('ready.proposed_pending is 3, needs 0') && f1.detail.includes('ready.criteria is 0, needs >= 1'), f1.detail);
  check('nothing at all asks for a criterion', r(0, 0, 0).label === 'Add at least one Done-when criterion to plan', r(0, 0, 0).label);
  check('plurals and singulars', r(2, 2, 1).label === 'Answer 2 questions and decide 1 criterion to plan', r(2, 2, 1).label);
  check('only a question left', r(3, 1, 0).label === 'Answer 1 question to plan', r(3, 1, 0).label);
  check('the refusal sentence', D.notReadyMessage(f1) === 'Not ready to plan: answer 1 question and decide 3 criteria first. (Not met: ready.criteria is 0, needs >= 1; ready.open_questions is 1, needs 0; ready.proposed_pending is 3, needs 0)', D.notReadyMessage(f1));
  const facts = D.readinessFacts({ criteria: 2, openQuestions: 0, proposedPending: 1 });
  check('facts carry the three counts', facts['ready.criteria'] === 2 && facts['ready.open_questions'] === 0 && facts['ready.proposed_pending'] === 1, facts);
  const { GATE_FACT_VOCABULARY } = await import('@tandemise/evaluation');
  const names = GATE_FACT_VOCABULARY.map((f) => f.name);
  for (const n of ['ready.criteria', 'ready.open_questions', 'ready.proposed_pending']) check(`${n} is in the published vocabulary`, names.includes(n));
  check('keys: P1 for a proposal, Q1 for a question', D.proposalKey(0) === 'P1' && D.questionKey(1) === 'Q2');
}

section('contracts: the Refinement artifact');
{
  check('Refinement and StatusReport are artifact types', D.isArtifactType('Refinement') && D.isArtifactType('StatusReport'));
  const doc = (criteria, questions) => ['---', 'type: Refinement', 'title: Hello refined', 'handoff:', '  headline: Three criteria and one question', 'proposedCriteria:',
    ...criteria.flatMap((c, i) => [`  - key: P${i + 1}`, `    statement: ${c}`]),
    ...(questions.length ? ['questions:', ...questions.flatMap((q, i) => [`  - key: Q${i + 1}`, `    text: ${q}`, '    why: It changes which pages are built', '    options: [Only the home page, Every page]'])] : []),
    '---', '', '## What I understood', '', 'A hello page.'].join('\n');
  const ok = A.parseArtifact('Refinement', doc(['Visiting / shows Hello', 'The page loads offline', 'The name comes from the profile'], ['Which pages greet the visitor?']));
  check('a Refinement with criteria and a question parses', ok.ok && ok.value.frontMatter.proposedCriteria.length === 3 && ok.value.frontMatter.questions[0].options.length === 2 && ok.value.frontMatter.questions[0].why.length > 0, ok.ok ? ok.value.frontMatter : ok.error);
  const nine = A.parseArtifact('Refinement', doc(Array.from({ length: 9 }, (_, i) => `Criterion ${i}`), []));
  check('nine proposed criteria are refused (at most 8)', !nine.ok && JSON.stringify(nine.error).includes('at most 8'), nine.ok ? null : nine.error);
  const six = A.parseArtifact('Refinement', doc(['One'], Array.from({ length: 6 }, (_, i) => `Question ${i}?`)));
  check('six questions are refused (at most 5)', !six.ok && JSON.stringify(six.error).includes('at most 5'), six.ok ? null : six.error);
  const template = A.renderArtifactTemplate('Refinement');
  check('the template shows proposedCriteria and questions', template.includes('proposedCriteria:') && template.includes('questions:') && template.includes('options:'));
  check('the template carries the product-owner guidance', /changes? the plan/i.test(template) && /observable/i.test(template) && /do not ask/i.test(template), template.slice(0, 400));
  const status = A.parseArtifact('StatusReport', ['---', 'type: StatusReport', 'title: Week 39', 'handoff:', '  headline: Two missions moving', '---', '', '# Status'].join('\n'));
  check('a StatusReport parses (P10 fills it in)', status.ok, status.ok ? null : status.error);
}

section('prompt: the planner reads accepted criteria and answers');
{
  const mission = { id: 'msn_x', title: 'Hello', goal: 'A hello page', constraints: [], successCriteria: [], autonomy: 'balanced', workflowPreset: 'feature-delivery' };
  const prompt = app.buildPlannerPrompt({
    mission, repository: null, roles: [], preset: app.findPreset('feature-delivery'), availableCapabilities: ['reasoning'], repositoryContext: null,
    criteria: [{ key: 'U1', statement: 'Visiting / shows Hello, Ana' }, { key: 'U2', statement: 'The page works offline' }],
    answers: [{ key: 'Q1', text: 'Which pages greet the visitor?', answer: 'Only the home page' }],
  });
  check('the accepted ledger replaces the plain criteria', prompt.includes('- U1: Visiting / shows Hello, Ana') && prompt.includes('- U2: The page works offline'), prompt.slice(0, 1500));
  check('the answers are there, with their questions', prompt.includes('Decided during refinement') && prompt.includes('Which pages greet the visitor?') && prompt.includes('Only the home page'));
  check('Refinement and StatusReport are not offered as task outputs', !/\bRefinement\b/.test(prompt.split('# Artifact types')[1]?.split('#')[0] ?? '') && !prompt.includes('StatusReport'));
}

// ---------------------------------------------------------------- the daemon
const root = mkdtempSync(join(tmpdir(), 'tdr-'));
const home = join(root, 'h');
const repo = join(root, 'r');
const promptDir = join(root, 'p');
mkdirSync(promptDir, { recursive: true });
const gitConfig = join(root, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Ready Tester\n\temail = ready@example.com\n');
const savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, TANDEMISE_OWNER_NAME: process.env.TANDEMISE_OWNER_NAME, SCRIPTED_PROMPT_DIR: process.env.SCRIPTED_PROMPT_DIR, SCRIPTED_DELAY_MS: process.env.SCRIPTED_DELAY_MS };
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.SCRIPTED_PROMPT_DIR = promptDir;
process.env.SCRIPTED_DELAY_MS = '0';
delete process.env.TANDEMISE_OWNER_NAME;
execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
writeFileSync(join(repo, 'README.md'), '# ready check\n');
execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore' });

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
  for (const until = Date.now() + ms; Date.now() < until; await sleep(200)) { const v = await fn(); if (v) return v; }
  return undefined;
};
const sql = (q, ...p) => {
  // A second connection, read-only, as the acceptance harness reads proof.
  const { DatabaseSync } = globalThis.__sqlite;
  const db = new DatabaseSync(join(home, 'tandemise.db'), { readOnly: true });
  try { return db.prepare(q).all(...p); } finally { db.close(); }
};
globalThis.__sqlite = await import('node:sqlite');

try {
  section('migration 012');
  {
    const system = await api('GET', '/v1/system');
    check('schema version is at least 12', system.body?.schemaVersion >= 12, system.body?.schemaVersion);
    const table = sql("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'")[0]?.sql ?? '';
    check('the artifacts CHECK names Refinement and StatusReport', table.includes("'Refinement'") && table.includes("'StatusReport'"), table.slice(0, 600));
    const cols = sql("SELECT name FROM pragma_table_info('mission_criteria')").map((r) => r.name);
    check('mission_criteria gains status, refinement_artifact_id, decided_by, decided_at', ['status', 'refinement_artifact_id', 'decided_by', 'decided_at'].every((c) => cols.includes(c)), cols);
    const q = sql("SELECT name FROM pragma_table_info('mission_questions')").map((r) => r.name);
    check('mission_questions exists', ['id', 'mission_id', 'key', 'text', 'why', 'options', 'answer', 'answered_by', 'status', 'refinement_artifact_id', 'created_at', 'answered_at'].every((c) => q.includes(c)), q);
  }

  const wsRes = await api('POST', '/v1/workspaces', { name: 'Ready', repositoryPath: repo });
  const ws = wsRes.body?.workspace?.id;
  const me = (await api('GET', '/v1/me')).body?.memberships?.[0]?.memberId;
  const runtime = await api('POST', '/v1/runtimes', {
    adapterId: 'generic-cli', name: 'Scripted agent', workspaceId: null,
    settings: { command: process.execPath, args: [resolve(here, 'acceptance/p0/scripted-agent.mjs')], promptVia: 'stdin', outputFormat: 'text', capabilities: ['reasoning', 'tool_calling', 'shell', 'git', 'filesystem', 'mcp'] },
    maxConcurrent: 4, enabled: true,
  });
  check('a scripted runtime is registered', runtime.status === 200, runtime.body);
  // Plans approved automatically so a planned mission does not wait on a card.
  const autonomy = (await api('GET', `/v1/workspaces/${ws}`)).body?.workspace?.autonomy;
  await api('PATCH', `/v1/workspaces/${ws}`, { autonomy: { ...autonomy, planApproval: 'auto' } });

  const create = (body) => api('POST', '/v1/missions', { workspaceId: ws, ...body });
  const refinement = async (id) => (await api('GET', `/v1/missions/${id}/refinement`)).body;
  const refineAndWait = async (id) => {
    const started = await api('POST', `/v1/missions/${id}/refine`);
    const done = await poll(async () => { const v = await refinement(id); return v?.state !== 'running' ? v : undefined; }, 90_000);
    return { started, done };
  };

  section('the gate: a request with a Done-when line is ready by construction');
  {
    const withLine = await create({ goal: 'Add a hello page', successCriteria: ['Visiting / shows Hello'] });
    const view = await refinement(withLine.body.mission.id);
    check('ready, and the button reads Plan', view?.readiness?.ready === true && view.readiness.label === 'Plan', view?.readiness);
    const planned = await api('POST', `/v1/missions/${withLine.body.mission.id}/plan`);
    check('POST /plan is accepted', planned.status === 200 && planned.body?.mission?.status === 'PLANNING', code(planned));
  }

  section('the gate: a goal-only request cannot be planned by any path');
  let goalOnly;
  {
    const before = (await api('GET', `/v1/missions?workspaceId=${ws}`)).body.length;
    const refused = await create({ goal: 'A friendlier hello page', planNow: true });
    check('planNow without a Done-when line is 412 PRECONDITION_FAILED', code(refused) === '412 PRECONDITION_FAILED', refused.body);
    check('it says why, in the gate\'s words', /Not ready to plan/.test(refused.body?.error?.message ?? '') && (refused.body?.error?.message ?? '').includes('ready.criteria is 0, needs >= 1'), refused.body?.error?.message);
    check('and nothing was written', (await api('GET', `/v1/missions?workspaceId=${ws}`)).body.length === before);

    const created = await create({ goal: 'A friendlier hello page' });
    goalOnly = created.body.mission.id;
    check('without planNow the mission is created in DRAFT', created.status === 200 && created.body.mission.status === 'DRAFT', created.body?.mission?.status);
    const view = await refinement(goalOnly);
    check('its readiness asks for a criterion', view.readiness.ready === false && view.readiness.label === 'Add at least one Done-when criterion to plan', view.readiness);
    const bypass = await api('POST', `/v1/missions/${goalOnly}/plan`);
    check('API bypass: POST /v1/missions/:id/plan is 412 PRECONDITION_FAILED', code(bypass) === '412 PRECONDITION_FAILED', bypass.body);
    check('with the explainFailure text', (bypass.body?.error?.message ?? '').includes('Not met: ready.criteria is 0, needs >= 1'), bypass.body?.error?.message);
    const start = await api('POST', `/v1/missions/${goalOnly}/start`);
    check('start is refused too (no plan)', start.status >= 400, code(start));
    check('SQL: still DRAFT', sql('SELECT status FROM missions WHERE id = ?', goalOnly)[0]?.status === 'DRAFT');
  }

  section('refinement: a real pass through the scripted agent');
  let proposals;
  let question;
  {
    const { started, done } = await refineAndWait(goalOnly);
    check('POST /refine starts a pass and answers at once', started.status === 200 && ['running', 'idle'].includes(started.body?.state), started.body);
    check('the pass finished without failing', done?.state === 'idle' && done.failure === null, done);
    proposals = (done?.criteria ?? []).filter((c) => c.status === 'proposed');
    const questions = (done?.questions ?? []).filter((q) => q.status === 'open');
    question = questions[0];
    check('three proposed criteria, numbered P1-P3 by the daemon', eq(proposals.map((c) => c.key), ['P1', 'P2', 'P3']), done?.criteria);
    check('one open question Q1 with options and a why', questions.length === 1 && question.key === 'Q1' && question.options.length >= 2 && question.why.length > 0, questions);
    check('F1: the button reads "Answer 1 question and decide 3 criteria to plan"', done?.readiness?.label === 'Answer 1 question and decide 3 criteria to plan', done?.readiness);
    check('the Refinement artifact is stored', typeof done?.artifactId === 'string' && sql('SELECT type FROM artifacts WHERE id = ?', done.artifactId)[0]?.type === 'Refinement', done?.artifactId);
    check('proposals are not on the ledger: the Done-when checklist is still empty', (await api('GET', `/v1/missions/${goalOnly}/criteria`)).body.length === 0);
    const inbox = (await api('GET', `/v1/inbox?workspaceId=${ws}`)).body;
    const row = inbox.refinements?.find((r) => r.missionId === goalOnly);
    check('F6: the inbox has "4 to decide" for this mission, addressed to its creator', row?.toDecide === 4 && eq(row.forIds, [me]), inbox.refinements);
    const bypass = await api('POST', `/v1/missions/${goalOnly}/plan`);
    check('F2: POST /plan still refused, naming both open counts', code(bypass) === '412 PRECONDITION_FAILED' && bypass.body.error.message.includes('ready.open_questions is 1, needs 0') && bypass.body.error.message.includes('ready.proposed_pending is 3, needs 0'), bypass.body?.error?.message);
    const twice = await api('POST', `/v1/missions/${goalOnly}/refine`);
    check('a refine while one is running is refused; after, it may run again', twice.status === 200 || code(twice) === '409 CONFLICT', code(twice));
    await poll(async () => (await refinement(goalOnly))?.state !== 'running' || undefined, 90_000);
  }

  section('verdicts, answers and hand-added criteria');
  {
    // The second refine above replaced the first; read the live proposals again.
    let view = await refinement(goalOnly);
    proposals = view.criteria.filter((c) => c.status === 'proposed');
    question = view.questions.find((q) => q.status === 'open');
    const [p1, p2, p3] = proposals;
    const a1 = await api('POST', `/v1/criteria/${p1.id}/verdict`, { verdict: 'accept' });
    check('accepting a proposal gives it U1', a1.status === 200 && a1.body.criteria.find((c) => c.id === p1.id)?.key === 'U1' && a1.body.criteria.find((c) => c.id === p1.id)?.status === 'accepted', a1.body?.criteria ?? a1.body);
    const a2 = await api('POST', `/v1/criteria/${p2.id}/verdict`, { verdict: 'accept', statement: 'The greeting uses the name on the profile' });
    const edited = a2.body?.criteria?.find((c) => c.id === p2.id);
    check('accept with changes keeps the person\'s words and gets U2', edited?.key === 'U2' && edited.statement === 'The greeting uses the name on the profile', edited);
    const r3 = await api('POST', `/v1/criteria/${p3.id}/verdict`, { verdict: 'reject' });
    check('rejecting retires it', r3.body?.criteria?.find((c) => c.id === p3.id)?.status === 'rejected');
    const again = await api('POST', `/v1/criteria/${p1.id}/verdict`, { verdict: 'reject' });
    check('a decided criterion cannot be decided again (409)', code(again) === '409 CONFLICT', again.body);
    const ledger = (await api('GET', `/v1/missions/${goalOnly}/criteria`)).body;
    check('the ledger holds exactly the accepted ones, U1 and U2', eq(ledger.map((c) => [c.key, c.source]), [['U1', 'user'], ['U2', 'user']]), ledger);
    view = await refinement(goalOnly);
    check('only the question is left', view.readiness.label === 'Answer 1 question to plan', view.readiness);
    const empty = await api('POST', `/v1/questions/${question.id}/answer`, { text: '   ' });
    check('an empty answer is 400', empty.status === 400, code(empty));
    const answered = await api('POST', `/v1/questions/${question.id}/answer`, { text: question.options[0] });
    check('answering with an option records it', answered.body?.questions?.find((q) => q.id === question.id)?.answer === question.options[0] && answered.body.questions.find((q) => q.id === question.id).status === 'answered', answered.body?.questions);
    check('the mission is ready', answered.body?.readiness?.ready === true && answered.body.readiness.label === 'Plan', answered.body?.readiness);
    const inbox = (await api('GET', `/v1/inbox?workspaceId=${ws}`)).body;
    check('F6: the inbox row is gone once nothing is left to decide', !(inbox.refinements ?? []).some((r) => r.missionId === goalOnly), inbox.refinements);
    const added = await api('POST', `/v1/missions/${goalOnly}/criteria`, { statement: 'The page reads well on a phone' });
    check('a hand-added criterion is accepted at once as U3', added.body?.criteria?.find((c) => c.key === 'U3')?.origin === 'added', added.body?.criteria);

    const promptsBefore = readdirSync(promptDir).length;
    const plan = await api('POST', `/v1/missions/${goalOnly}/plan`);
    check('F3: now POST /plan is accepted', plan.status === 200 && plan.body?.mission?.status === 'PLANNING', code(plan));
    const plannerPrompt = await poll(async () => readdirSync(promptDir).slice(promptsBefore).map((f) => readFileSync(join(promptDir, f), 'utf8')).find((p) => p.includes('You are the Planner')), 30_000);
    check('F3: the planner was told the answer and the accepted criteria', plannerPrompt?.includes(question.options[0]) && plannerPrompt.includes(question.text) && plannerPrompt.includes('The greeting uses the name on the profile') && plannerPrompt.includes(p1.statement), plannerPrompt?.slice(0, 2500));
    check('F3: and not the rejected one', plannerPrompt !== undefined && !plannerPrompt.includes(p3.statement), p3.statement);
    await poll(async () => (await api('GET', `/v1/missions/${goalOnly}`)).body?.mission?.status !== 'PLANNING' || undefined, 60_000);
    const late = await api('POST', `/v1/missions/${goalOnly}/criteria`, { statement: 'Too late' });
    check('once planned, criteria cannot be added (412)', code(late) === '412 PRECONDITION_FAILED', late.body);
    const lateRefine = await api('POST', `/v1/missions/${goalOnly}/refine`);
    check('once planned, it cannot be refined (412)', code(lateRefine) === '412 PRECONDITION_FAILED', lateRefine.body);
  }

  section('refine again: what is still pending goes stale');
  {
    const id = (await create({ goal: 'A calmer settings page' })).body.mission.id;
    let { done } = await refineAndWait(id);
    const [first] = done.criteria.filter((c) => c.status === 'proposed');
    await api('POST', `/v1/criteria/${first.id}/verdict`, { verdict: 'accept' });
    ({ done } = await refineAndWait(id));
    const byStatus = (s) => done.criteria.filter((c) => c.status === s).map((c) => c.key);
    check('F4: the two undecided proposals are stale', eq(byStatus('stale'), ['P2', 'P3']), done.criteria.map((c) => [c.key, c.status]));
    check('the accepted one stays U1', eq(byStatus('accepted'), ['U1']));
    check('the new pass is numbered on: P4-P6', eq(byStatus('proposed'), ['P4', 'P5', 'P6']), byStatus('proposed'));
    check('the old question is stale and a new one Q2 is open', eq(done.questions.map((q) => [q.key, q.status]), [['Q1', 'stale'], ['Q2', 'open']]), done.questions);
    const stale = done.questions.find((q) => q.key === 'Q1');
    const answerStale = await api('POST', `/v1/questions/${stale.id}/answer`, { text: 'late' });
    check('a stale question cannot be answered (409)', code(answerStale) === '409 CONFLICT', answerStale.body);
  }

  section('autonomy: accepts criteria, never answers');
  {
    const id = (await create({ goal: 'An autonomous hello page', autonomy: 'autonomous' })).body.mission.id;
    const { done } = await refineAndWait(id);
    const accepted = done.criteria.filter((c) => c.status === 'accepted');
    check('F5: every proposal accepted automatically', accepted.length === 3 && accepted.every((c) => c.decidedBy === 'autonomy') && eq(accepted.map((c) => c.key), ['U1', 'U2', 'U3']), done.criteria);
    check('F5: the question is still open and blocks planning', done.questions.filter((q) => q.status === 'open').length === 1 && done.readiness.label === 'Answer 1 question to plan', done.readiness);
    const plan = await api('POST', `/v1/missions/${id}/plan`);
    check('F5: POST /plan refused on the open question alone', code(plan) === '412 PRECONDITION_FAILED' && plan.body.error.message.includes('ready.open_questions is 1, needs 0'), plan.body?.error?.message);
  }

  section('refinement with no runtime fails plainly and leaves the mission usable');
  {
    const profiles = (await api('GET', '/v1/runtimes')).body;
    for (const p of profiles) await api('PATCH', `/v1/runtimes/${p.profile?.id ?? p.id}`, { enabled: false });
    const id = (await create({ goal: 'A hello page nobody can refine' })).body.mission.id;
    const { done } = await refineAndWait(id);
    check('the pass fails with a reason a person can act on', done?.state === 'failed' && /runtime/i.test(done.failure ?? ''), done);
    const added = await api('POST', `/v1/missions/${id}/criteria`, { statement: 'Visiting / shows Hello' });
    check('a criterion added by hand makes it ready anyway', added.body?.readiness?.ready === true, added.body?.readiness);
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
console.log('ALL P6 READY CHECKS PASSED');
