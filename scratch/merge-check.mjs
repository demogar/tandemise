// The planner and risk-based merge, the ship step and the merge decision
// (docs/superpowers/specs/2026-10-30-planner-and-merge-design.md §8): a real
// git repository with a bare `origin`, the fake `gh` (scratch/fake-gh.mjs)
// first on PATH recording every call. No real GitHub is ever touched.
//
//   npm run build && node scratch/merge-check.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const D = await import('@tandemise/domain');
const app = await import('@tandemise/application');
const GH = await import('@tandemise/integration-github');
const fake = await import('./fake-gh.mjs');
const { engineHarness, memoryFactory } = await import('./planner-harness.mjs');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 700)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const attempt = async (label, fn) => {
  try { await fn(); } catch (e) { failures.push(label); console.log(`  FAIL ${label} threw: ${e?.stack ?? e}`); }
};
const keepAlive = setInterval(() => {}, 1000);

const { realExecutor, world, git, REPO } = await import('./planner-harness.mjs');


await attempt('ship opens', async () => {
  section('ship opens');
  const prTitles = [
    ['fix', 'fix: typo in the settings title', 'fix: typo in the settings title'],
    ['fix', 'Typo in settings title', 'fix: typo in settings title'],
    ['feature', 'feat: add export', 'feat: add export'],
    ['deps', 'Bump lodash', 'build: bump lodash'],
  ];
  for (const [type, title, want] of prTitles) check(`pr title for ${type} "${title}"`, D.prTitle({ type }, title) === want, D.prTitle({ type }, title));

  const w = await world();
  const m = await w.mission('fix: typo in the settings title');
  const ship = () => w.h.repo.tasks.listByMission(m.id).find((t) => t.key === 'ship');
  await w.h.until(() => ['SUCCEEDED', 'BLOCKED', 'FAILED', 'SKIPPED', 'AWAITING_APPROVAL'].includes(ship()?.status), 60000);
  const creates = fake.calls(w.ghDir).filter((c) => c.args[0] === 'pr' && c.args[1] === 'create');
  const implement = w.h.repo.tasks.listByMission(m.id).find((t) => t.key === 'implement');
  check('implement succeeded', implement.status === 'SUCCEEDED', [implement.status, implement.statusReason]);
  check('one pr create, titled from the profile, not a draft', creates.length === 1 && creates[0].args.includes('fix: typo in the settings title') && !creates[0].args.includes('--draft'), creates.map((c) => c.args));
  const head = creates[0]?.args[creates[0].args.indexOf('--head') + 1];
  check('the head is the task branch, pushed to origin', typeof head === 'string' && git(w.origin, 'branch', '--list', head).includes(head), [head, git(w.origin, 'branch', '--list')]);
  check('with no CI on the repository, the ship step asks', ship().status === 'AWAITING_APPROVAL', [ship().status, ship().statusReason]);
  check('the ship task kept its executor', ship().executor === 'ship');
  const pr = fake.pullRequests(w.ghDir, REPO)[0];
  check('the body carries no agent text', pr !== undefined && !pr.body.includes('ZZ-AGENT-SAYS') && pr.body.includes('Done when'), pr?.body);
  check('pr.opened is recorded', w.h.repo.events.listByMission(m.id).some((e) => e.body.type === 'ship.pr_opened' && e.body.number === pr.number));
  // Ship again: the pull request is found by its head, not opened twice.
  const flow = new GH.GhPullRequestFlow(realExecutor(join(w.ghDir, 'bin')));
  const again = await flow.open({ cwd: w.checkout, repo: REPO, head, base: 'main', title: 'x', body: 'y' });
  check('opening again finds the same pull request', again.created === false && again.number === pr.number && fake.calls(w.ghDir).filter((c) => c.args[1] === 'create').length === 1);
});

await attempt('decision table, hard rules, no self-report', async () => {
  section('decision table');
  const policy = D.parseMergePolicy(app.SHIPPED_MERGE);
  check('the shipped policy parses', !('error' in policy), policy);
  const on = { ...policy, autoMerge: 'on' };
  const base = {
    changedPaths: ['apps/web/src/pages/settings.tsx'], deletedPaths: [], files: 1, linesAdded: 10, linesRemoved: 2, binaryFiles: 0, repos: 1,
    areas: [], testsTouched: 1, dependenciesChanged: false, lockfileOnly: false, coverageChangedLines: null,
    ci: { state: 'PASS', requiredPresent: true }, reviewRequired: false, checksTests: 'PASS',
    review: { blocking: 0, major: 0, independent: true }, criteria: { unverified: 0, implicit: true },
    process: { lane: 'quick', lightenedByPerson: false, stepsSkipped: 0, holds: 0, changesRequested: 0, escalations: 0, gateRetries: 0, personCommits: 0, revertOfAuto: false },
    history: { areaReverts90d: null, areaRecentRevert: null },
  };
  const v = (patch) => ({ ...base, ...patch, ci: { ...base.ci, ...(patch.ci ?? {}) }, review: { ...base.review, ...(patch.review ?? {}) }, process: { ...base.process, ...(patch.process ?? {}) }, history: { ...base.history, ...(patch.history ?? {}) } });
  const baseDecision = D.decideMerge(base, on);
  check('the base set merges at score 0', baseDecision.verdict === 'merge' && baseDecision.score === 0, baseDecision);
  const rows = [
    ['a migration', v({ changedPaths: ['db/migrations/0042_add_index.sql'] }), 'ask', 'Touches db/migrations/0042_add_index.sql — never merged on its own in this project.'],
    ['a workflow file', v({ changedPaths: ['.github/workflows/ci.yml'] }), 'ask', null],
    ['an env file', v({ changedPaths: ['.env.local'] }), 'ask', null],
    ['the auth area', v({ areas: [{ name: 'auth', sensitivity: 'critical', paths: ['src/auth/session.ts'] }], changedPaths: ['src/auth/session.ts'] }), 'ask', 'Touches src/auth/session.ts — never merged on its own in this project.'],
    ['a deletion in a sensitive area', v({ deletedPaths: ['package.json'], areas: [{ name: 'dependencies', sensitivity: 'sensitive', paths: ['package.json'] }] }), 'ask', null],
    ['the careful lane', v({ process: { lane: 'careful' } }), 'ask', null],
    ['a person committed', v({ process: { personCommits: 1 } }), 'ask', null],
    ['CI failed', v({ ci: { state: 'FAIL' } }), 'ask', 'CI is not green on this commit.'],
    ['tests failed', v({ checksTests: 'FAIL' }), 'ask', null],
    ['blocking findings', v({ review: { blocking: 2 } }), 'ask', null],
    ['450 lines', v({ linesAdded: 400, linesRemoved: 50 }), 'ask', 'Risk score 4 of 2 allowed: over 400 lines changed, over 100 lines changed.'],
    ['120 lines', v({ linesAdded: 100, linesRemoved: 20 }), 'merge', null],
    ['16 files', v({ files: 16 }), 'merge', null],
    ['two repositories', v({ repos: 2 }), 'merge', null],
    ['a recent revert in the area', v({ history: { areaRecentRevert: true } }), 'ask', null],
  ];
  for (const [label, facts, verdict, reason] of rows) {
    const d = D.decideMerge(facts, on);
    check(`${label} → ${verdict}`, d.verdict === verdict && (reason === null || d.reasons.includes(reason)), { verdict: d.verdict, score: d.score, reasons: d.reasons });
  }
  const scores = { '120 lines': 1, '16 files': 2, 'two repositories': 2, 'a recent revert in the area': 3 };
  for (const [label, score] of Object.entries(scores)) {
    const facts = rows.find((r) => r[0] === label)[1];
    check(`${label} scores ${score}`, D.decideMerge(facts, on).score === score, D.decideMerge(facts, on).score);
  }
  const coverage = baseDecision.factors.find((f) => f.rule.startsWith('coverage.changed_lines'));
  check('unmeasured coverage adds nothing and is listed', coverage?.points === 0 && coverage.unmeasured.includes('coverage.changed_lines'), coverage);

  section('hard rules');
  const off = D.decideMerge(base, policy);
  check('auto-merge off always asks, and says what would have happened', off.verdict === 'ask' && off.reasons[0] === D.AUTO_MERGE_OFF && off.wouldMerge === true, off);
  const noCi = D.decideMerge(v({ ci: { state: 'NONE' } }), { ...on, requires: [] });
  check('no CI asks even when the policy omits the CI rule', noCi.verdict === 'ask' && noCi.reasons.includes(D.NO_CI), noCi.reasons);
  check('a required review asks', D.decideMerge(v({ reviewRequired: true }), on).reasons.includes(D.REVIEW_REQUIRED));
  check('a malformed policy asks', D.decideMerge(base, { error: 'bad indent' }).reasons[0] === D.malformedPolicy('bad indent'));
  check('an unmeasured review requirement asks', D.decideMerge(v({ reviewRequired: null }), on).verdict === 'ask');
  check('a policy with a rule that does not lint is an error, never partial', 'error' in D.parseMergePolicy({ ...app.SHIPPED_MERGE, requires: ['item.prefix == "x"'] }));

  section('no self-report');
  const keys = Object.keys(D.MERGE_FACT_ORIGINS).sort();
  check('every fact has a measured origin', keys.every((k) => ['git', 'github', 'daemon', 'ledger'].includes(D.MERGE_FACT_ORIGINS[k])) && eq(keys, Object.keys(base).sort()), keys);
});

await attempt('ship decides, audit, person merge, closed, crash', async () => {
  section('ship decides');
  const fake = await import('./fake-gh.mjs');
  const w = await world({ factory: { merge: { ...app.SHIPPED_MERGE, reviewers: ['sam'] } } });
  const pending = [{ name: 'unit', status: 'in_progress' }, { name: 'lint', status: 'queued' }];
  const prOf = () => fake.pullRequests(w.ghDir, REPO).at(-1);
  // CI is pending on every head this world pushes until the check says otherwise.
  const watch = setInterval(() => { const pr = prOf(); if (pr !== undefined && !(fake.readState(w.ghDir).repos[REPO].checks ?? {})[pr.headRefOid]) fake.setChecks(w.ghDir, REPO, pr.headRefOid, pending); }, 20);
  const m = await w.mission('fix: typo in the settings title');
  const ship = () => w.h.repo.tasks.listByMission(m.id).find((t) => t.key === 'ship');
  await w.h.until(() => ship()?.status === 'AWAITING_EXTERNAL' && ship().statusReason.startsWith('Waiting for CI'), 60000);
  check('after the PR opens it waits for CI', ship().statusReason === 'Waiting for CI (0 of 2 checks done)', ship().statusReason);
  const sha1 = prOf().headRefOid;
  fake.setChecks(w.ghDir, REPO, sha1, [{ name: 'unit', conclusion: 'success' }, { name: 'lint', conclusion: 'success' }]);
  await w.h.until(() => ship().status === 'AWAITING_APPROVAL', 30000);
  const rows = w.h.repo.mergeDecisions.listByMission(m.id);
  check('green CI → one decision, ask, auto-merge off, would have merged', rows.length === 1 && rows[0].verdict === 'ask' && rows[0].reasons.includes(D.AUTO_MERGE_OFF) && rows[0].wouldMerge === true, rows.map((r) => [r.verdict, r.reasons, r.score]));
  const cards = w.h.repo.approvals.list({ missionId: m.id, statuses: ['PENDING'] });
  check('one Review and merge card', cards.length === 1 && cards[0].kind === 'release' && cards[0].title === 'Review and merge fix: typo in the settings title', cards.map((c) => c.title));
  check('the reviewers in the policy were asked', fake.calls(w.ghDir).some((c) => c.args[1] === 'edit' && c.args.includes('--add-reviewer') && c.args.includes('sam')));

  section('audit');
  const facts = rows[0].facts;
  check('the row keeps every measured fact', Object.keys(D.MERGE_FACT_ORIGINS).every((k) => k in facts), Object.keys(facts));
  check('no agent text reached the facts', !JSON.stringify(facts).includes('ZZ-AGENT-SAYS'));
  const comments = () => fake.readState(w.ghDir).repos[REPO].comments[String(prOf().number)] ?? [];
  check('one PR comment that asks and names the commit', comments().length === 1 && comments()[0].body.includes('Tandemise asks for a review') && comments()[0].body.includes(sha1.slice(0, 7)), comments());
  // A new head: the decision is void and a second is made, editing the same comment.
  const sha2 = 'e'.repeat(40);
  fake.putPullRequest(w.ghDir, REPO, { ...prOf(), headRefOid: sha2 });
  fake.setChecks(w.ghDir, REPO, sha2, [{ name: 'unit', conclusion: 'success' }]);
  await w.h.until(() => w.h.repo.mergeDecisions.listByMission(m.id).length === 2, 30000);
  const two = w.h.repo.mergeDecisions.listByMission(m.id);
  check('a moved head voids the decision and decides again on the new sha', two[0].voidedAt !== null && two[1].headSha === sha2, two.map((r) => [r.headSha.slice(0, 7), r.voidedAt]));
  check('the same comment is edited, not a second one', comments().length === 1 && fake.calls(w.ghDir).some((c) => c.args.includes('PATCH')));
  check('the feed says it is checking again', w.h.repo.events.listByMission(m.id).some((e) => e.body.type === 'note' && e.body.text === 'The pull request changed after it was checked; checking again.'));

  section('person merge');
  fake.putPullRequest(w.ghDir, REPO, { ...prOf(), state: 'MERGED', mergedBy: { login: 'sam' }, mergeCommit: { oid: 'a'.repeat(40) } });
  await w.h.until(() => w.h.repo.missions.get(m.id).status === 'COMPLETE', 30000);
  check('a merge in GitHub finishes the step and the mission', ship().status === 'SUCCEEDED' && w.h.repo.missions.get(m.id).status === 'COMPLETE', [ship().status, ship().statusReason]);
  check('it is a merged_by_person outcome', w.h.repo.outcomes.listByWorkspace(w.ws, '1970').some((o) => o.mission === m.id && o.kind === 'merged_by_person'));
  check('no pr merge was ever called', !fake.calls(w.ghDir).some((c) => c.args[0] === 'pr' && c.args[1] === 'merge'));

  section('closed');
  const m2 = await w.mission('fix: typo in the footer');
  const ship2 = () => w.h.repo.tasks.listByMission(m2.id).find((t) => t.key === 'ship');
  await w.h.until(() => ship2()?.status === 'AWAITING_EXTERNAL', 60000);
  fake.setChecks(w.ghDir, REPO, prOf().headRefOid, [{ name: 'unit', conclusion: 'success' }]);
  await w.h.until(() => ship2().status === 'AWAITING_APPROVAL', 30000);
  fake.putPullRequest(w.ghDir, REPO, { ...prOf(), state: 'CLOSED' });
  await w.h.until(() => ship2().status === 'BLOCKED', 30000);
  check('a closed PR blocks with the exact sentence', ship2().statusReason === 'The pull request was closed without merging.', ship2().statusReason);

  section('ci fails');
  const m3 = await w.mission('fix: typo in the header');
  const task3 = (k) => w.h.repo.tasks.listByMission(m3.id).find((t) => t.key === k);
  await w.h.until(() => task3('ship')?.status === 'AWAITING_EXTERNAL', 60000);
  fake.setChecks(w.ghDir, REPO, prOf().headRefOid, [{ name: 'unit', conclusion: 'failure', logTail: 'expected 1 to be 2' }]);
  await w.h.until(() => (task3('implement').round ?? 1) >= 2, 30000);
  const fb = w.h.container.resolve(app.FEEDBACK_REPOSITORY).listByTask(task3('implement').id);
  check('a failing check starts round 2 on implement with the log', (task3('implement').round ?? 1) === 2 && fb.some((f) => f.text.startsWith('CI failed: unit') && f.text.includes('expected 1 to be 2')), fb.map((f) => f.text));
  clearInterval(watch);

  section('crash between decide and merge');
  const w2 = await world();
  const m4 = await w2.mission('fix: typo in the sidebar');
  const ship4 = () => w2.h.repo.tasks.listByMission(m4.id).find((t) => t.key === 'ship');
  await w2.h.until(() => ship4()?.status === 'AWAITING_APPROVAL', 60000);
  const before = w2.h.repo.mergeDecisions.listByMission(m4.id).length;
  // A restart: a new engine over the same database and home adopts the waiting ship step.
  const { engineHarness } = await import('./planner-harness.mjs');
  const GH = await import('@tandemise/integration-github');
  const { realExecutor } = await import('./planner-harness.mjs');
  const exec = realExecutor(`${w2.ghDir}/bin`);
  const again = await engineHarness(w2.h.paths.root, { factory: w2.files, commandExecutor: exec, pullRequests: new GH.GhPullRequestFlow(exec) });
  for (let i = 0; i < 8; i++) { await again.scheduler.tick(); await again.sleep(100); }
  check('restarted, it decides nothing twice and merges nothing', again.repo.mergeDecisions.listByMission(m4.id).length === before && !fake.calls(w2.ghDir).some((c) => c.args[1] === 'merge'), again.repo.mergeDecisions.listByMission(m4.id).length);
  check('the ship step is still waiting for a review', again.repo.tasks.listByMission(m4.id).find((t) => t.key === 'ship').status === 'AWAITING_APPROVAL');
});

await attempt('backtest and switch', async () => {
  section('backtest');
  const policy = D.parseMergePolicy(app.SHIPPED_MERGE);
  const facts = (lines) => ({
    changedPaths: ['src/a.ts'], deletedPaths: [], files: 1, linesAdded: lines, linesRemoved: 0, binaryFiles: 0, repos: 1, areas: [], testsTouched: 1,
    dependenciesChanged: false, lockfileOnly: false, coverageChangedLines: null, ci: { state: 'PASS', requiredPresent: true }, reviewRequired: false,
    checksTests: 'PASS', review: { blocking: 0, major: 0, independent: true }, criteria: { unverified: 0, implicit: false },
    process: { lane: 'quick', lightenedByPerson: false, stepsSkipped: 0, holds: 0, changesRequested: 0, escalations: 0, gateRetries: 0, personCommits: 0, revertOfAuto: false },
    history: { areaReverts90d: 0, areaRecentRevert: false },
  });
  // Scores 0, 1, 2 (merge under the current policy), and 3, 4, 5 (asks).
  const withScore = (s) => {
    const f = facts(s === 1 || s >= 4 ? 150 : 10);
    if (s >= 2) f.process.lightenedByPerson = true;
    if (s >= 3) f.process.escalations = 2;
    // 4 adds the lines again, on top of 3
    if (s >= 5) f.criteria.unverified = 1;
    return f;
  };
  const row = (i, s) => ({ id: `mrg_${i}`, workspaceId: 'ws', missionId: `m${i}`, repo: 'acme/web', prNumber: i, headSha: 'a'.repeat(40), policyRef: 'shipped', verdict: 'ask', score: s, allowed: 2, wouldMerge: s <= 2, factors: [], reasons: [], facts: withScore(s), decidedAt: `2026-10-0${i + 1}T00:00:00.000Z`, voidedAt: null, commentId: null, mergedAt: null, mergedBy: null, mergeSha: null });
  const rows = [0, 1, 2, 3, 4, 5].map((s, i) => row(i, s));
  check('the fixture scores 0..5', eq(rows.map((r) => D.decideMerge(r.facts, { ...policy, autoMerge: 'on' }).score), [0, 1, 2, 3, 4, 5]), rows.map((r) => D.decideMerge(r.facts, { ...policy, autoMerge: 'on' }).score));
  const reverted = [{ op: 'outcome', id: 'out_r', at: '2026-10-20T00:00:00.000Z', by: 'A', mission: 'm3', lane: 'quick', profile: { type: 'fix', size: 's', risk: 'low', areas: [] }, kind: 'reverted' }];
  const result = D.backtest(rows, policy, { ...policy, autoMergeAtMost: 4 }, reverted);
  check('a looser candidate merges two more', result.mergedCurrent === 3 && result.mergedCandidate === 5 && result.changed.length === 2, result);
  check('…and says one of those was later reverted', result.changedThenReverted === 1 && result.changed.find((c) => c.decisionId === 'mrg_3')?.revertedOrBroke === true, result.changed);

  section('switch');
  const w = await world();
  const service = w.h.services.mergePolicy;
  const before = await service.get(w.ws);
  check('the policy starts off, built in', before.policy.autoMerge === 'off' && before.origin === 'shipped', before);
  await service.update(w.ws, { ...app.SHIPPED_MERGE, autoMerge: 'on' }, w.caller);
  check('turning it on writes the repository\'s merge.yaml', w.files.written.merge?.raw.autoMerge === 'on', w.files.written.merge);
  const decisions = w.h.container.resolve(app.DECISION_REPOSITORY).listByWorkspace(w.ws);
  check('…and records a Decision', decisions.length === 1 && decisions[0].title === 'Auto-merge low-risk pull requests in Ship' && decisions[0].status === 'accepted', decisions.map((d) => d.title));
  let refused = null;
  try { await service.update(w.ws, { ...app.SHIPPED_MERGE, autoMerge: 'on' }, { ...w.caller, runtime: true }); } catch (e) { refused = e.message; }
  check('a runtime may not change it', refused === 'Only a person can change the merge policy.', refused);
  // A ship step waiting on a person: stop re-decides it as ask.
  const m = await w.mission('fix: typo in the settings title');
  const ship = () => w.h.repo.tasks.listByMission(m.id).find((t) => t.key === 'ship');
  await w.h.until(() => ship()?.status === 'AWAITING_APPROVAL' || ship()?.status === 'AWAITING_EXTERNAL', 60000);
  const n = w.h.repo.mergeDecisions.listByMission(m.id).length;
  await service.stop(w.ws, w.caller);
  check('stop writes autoMerge off', w.files.written.merge?.raw.autoMerge === 'off');
  await w.h.until(() => w.h.repo.mergeDecisions.listByMission(m.id).length > n, 30000);
  const last = w.h.repo.mergeDecisions.listByMission(m.id).at(-1);
  check('…and a waiting ship step is decided again, as ask, auto-merge off', last.verdict === 'ask' && last.reasons[0] === D.AUTO_MERGE_OFF, last.reasons);
});

await attempt('reviewed commit', async () => {
  section('reviewed commit');
  const fake = await import('./fake-gh.mjs');
  const w = await world({ factory: { merge: { ...app.SHIPPED_MERGE, autoMerge: 'on' } } });
  fake.setRepo(w.ghDir, REPO, { defaultChecks: [{ name: 'unit', conclusion: 'success' }] });
  const m = await w.mission('fix: typo in the settings title');
  const ship = () => w.h.repo.tasks.listByMission(m.id).find((t) => t.key === 'ship');
  await w.h.until(() => w.h.repo.missions.get(m.id).status === 'COMPLETE' || ship()?.status === 'BLOCKED', 60000);
  const merges = () => fake.calls(w.ghDir).filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
  const decision = w.h.repo.mergeDecisions.listByMission(m.id).at(-1);
  const call = merges()[0]?.args ?? [];
  check('it merged the decided head, squash', decision?.verdict === 'merge' && call.includes('--squash') && call[call.indexOf('--match-head-commit') + 1] === decision.headSha, { call, decision: decision && [decision.verdict, decision.reasons] });
  check('…with the trailers', (call[call.indexOf('--body') + 1] ?? '').includes(`Tandemise-Merge: auto; score ${decision?.score}/2`) && (call[call.indexOf('--body') + 1] ?? '').includes('Tandemise-Mission:'), call);
  check('the audit row has the merge commit, the step and the mission are done', decision?.mergeSha !== null && decision?.mergedBy === 'tandemise' && ship().status === 'SUCCEEDED' && w.h.repo.missions.get(m.id).status === 'COMPLETE', [decision?.mergeSha, ship().status, ship().statusReason]);
  check('the PR comment says it merged on its own', (fake.readState(w.ghDir).repos[REPO].comments[String(fake.pullRequests(w.ghDir, REPO).at(-1).number)] ?? []).some((c) => c.body.startsWith('Tandemise merged this on its own: risk score')));
  check('a merged outcome is recorded', w.h.repo.outcomes.listByWorkspace(w.ws, '1970').some((o) => o.mission === m.id && o.kind === 'merged'));

  // A push between the decision and the merge: GitHub refuses, the decision is void, a new one merges the new head.
  const moved = 'd'.repeat(40);
  fake.setRepo(w.ghDir, REPO, { moveHeadOnMerge: moved });
  const m2 = await w.mission('fix: typo in the footer');
  await w.h.until(() => w.h.repo.mergeDecisions.listByMission(m2.id).length === 2 && w.h.repo.tasks.listByMission(m2.id).find((t) => t.key === 'ship')?.status === 'AWAITING_APPROVAL', 60000);
  const rows = w.h.repo.mergeDecisions.listByMission(m2.id);
  check('the first decision was voided, the second is on the new sha', rows.length === 2 && rows[0].voidedAt !== null && rows[1].headSha === moved, rows.map((r) => [r.headSha.slice(0, 7), r.voidedAt, r.mergeSha]));
  // The new head is a commit Tandemise didn't push: someone else's, so it asks.
  check('…and asks, because someone else committed to it', rows[1].verdict === 'ask' && rows[1].reasons.includes('A person committed to this pull request, so they should look at the result.'), rows[1].reasons);
  const m2calls = merges().slice(1);
  check('only the refused merge call was made, on the decided sha', m2calls.length === 1 && m2calls[0].args[m2calls[0].args.indexOf('--match-head-commit') + 1] === rows[0].headSha, m2calls.map((c) => c.args.join(' ')));

  fake.setRepo(w.ghDir, REPO, { autoMergeAllowed: true });
  const m3 = await w.mission('fix: typo in the header');
  await w.h.until(() => w.h.repo.missions.get(m3.id).status === 'COMPLETE', 60000);
  check('with auto-merge allowed on the repository, the merge is queued with --auto', merges().at(-1).args.includes('--auto'), merges().at(-1).args);
  check('every pr merge call carried --match-head-commit', merges().length >= 3 && merges().every((c) => c.args.includes('--match-head-commit')), merges().length);
});

// @sections

clearInterval(keepAlive);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
process.exit(0);
