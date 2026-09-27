// P14: GitHub issues in and out. A repository opted in turns its open
// labelled issues into draft missions (queued when the issue says what "done"
// means, "Needs refinement" otherwise), follows upstream edits and closes, and
// reports back on each issue - once per kind, updated in place, idempotent
// across restarts - closing it only when asked and every criterion was verified.
//
//   npm run build && node scratch/p14-issues-check.mjs
//
// A fake `gh` (scratch/fake-gh.mjs) stands in for GitHub: it serves issues and
// comments from a JSON file and records every call. Pure rules first, then the
// engine (real SQLite, real services, the real GhIssueTracker over the fake gh,
// a clock the check moves by hand), then a real daemon with the fake gh first
// on its PATH.
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addComment, calls, commentsOf, installFakeGh, patchIssue, putIssue, readState, writeState } from './fake-gh.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const D = await import('@tandemise/domain');
const app = await import('@tandemise/application');
const A = await import('@tandemise/artifacts');
const G = await import('@tandemise/integration-github');

// ------------------------------------------------------------------ parsing
section('pure: "Done when" from an issue body');
{
  const p = D.parseIssueCriteria;
  check('a checklist under "## Done when"', eq(p('Intro text.\n\n## Done when\n- [ ] The page loads offline\n- [x] It greets the visitor\n* [ ] It works on a phone\n\n## Notes\n- [ ] not a criterion'),
    ['The page loads offline', 'It greets the visitor', 'It works on a phone']), p('## Done when\n- [ ] a'));
  check('bullets under "Acceptance criteria:" (plain line)', eq(p('Acceptance criteria:\n- Tests pass\n- Docs updated\n\nThanks!'), ['Tests pass', 'Docs updated', 'Thanks!'].slice(0, 2)), p('Acceptance criteria:\n- Tests pass\n- Docs updated\n\nThanks!'));
  check('a bold heading "**Done when**" with numbered items', eq(p('**Done when**\n1. One\n2) Two\n'), ['One', 'Two']));
  check('an inline "Done when: …" is one criterion', eq(p('Please fix it.\n\nDone when: the build is green'), ['the build is green']));
  check('checklist items win over plain list items in the same section', eq(p('### Acceptance Criteria\n- context line\n- [ ] Real one\n'), ['Real one']));
  check('paragraphs when there is no list', eq(p('## Done when\nThe export finishes\nin under a minute.\n\nNo data is lost.'), ['The export finishes in under a minute.', 'No data is lost.']));
  check('fenced code is ignored', eq(p('## Done when\n```\n- [ ] not me\n```\n- [ ] me'), ['me']));
  check('a checklist without the heading is not criteria', eq(p('Steps:\n- [ ] do a\n- [ ] do b'), []));
  check('no section, no criteria', eq(p('Just a request with no list.'), []));
  check('duplicates dropped; whitespace collapsed', eq(p('## Done when\n- [ ]  Same   thing\n- [ ] Same thing'), ['Same thing']));
  check('at most 20', p(`## Done when\n${Array.from({ length: 30 }, (_, i) => `- [ ] Item ${i}`).join('\n')}`).length === 20);
  check('CRLF bodies parse the same', eq(p('## Done when\r\n- [ ] a\r\n- [ ] b\r\n'), ['a', 'b']));
  check('a later heading ends the section', eq(p('## Done when\n- [ ] a\n## Out of scope\n- [ ] b'), ['a']));
}

section('pure: settings words, slugs, labels');
{
  check('slug from https remote', D.githubRepoFromRemote('https://github.com/acme/site.git') === 'acme/site');
  check('slug from ssh remote', D.githubRepoFromRemote('git@github.com:acme/site.git') === 'acme/site');
  check('enterprise host keeps its host', D.githubRepoFromRemote('https://github.acme.io/team/site') === 'github.acme.io/team/site');
  check('a non-GitHub remote gives none', D.githubRepoFromRemote('https://gitlab.com/acme/site.git') === null && D.githubRepoFromRemote(null) === null);
  check('repo problem words', D.githubRepoProblem('nope') !== null && D.githubRepoProblem('acme/site') === null);
  check('label problems', D.issueLabelProblem('a,b') !== null && D.issueLabelProblem('') !== null && D.issueLabelProblem('tandemise') === null);
  check('poll presets only', D.issuePollProblem(7) !== null && D.issuePollProblem(10) === null);
  const now = Date.parse('2026-09-28T10:00:00Z');
  check('"Last checked 2 min ago · 3 linked"', D.issueCheckLabel({ enabled: true, checking: false, lastCheckedMs: now - 150_000, nowMs: now, linked: 3 }) === 'Last checked 2 min ago · 3 linked');
  check('"Not checked yet · 0 linked" and "Off"', D.issueCheckLabel({ enabled: true, checking: false, lastCheckedMs: null, nowMs: now, linked: 0 }) === 'Not checked yet · 0 linked'
    && D.issueCheckLabel({ enabled: false, checking: false, lastCheckedMs: null, nowMs: now, linked: 2 }) === 'Off');
  const goal = D.issueGoal('acme/site', { number: 12, title: 'Offline mode', body: 'Please.', url: 'https://github.com/acme/site/issues/12', author: 'sam' });
  check('the goal attributes the request to its author', goal.startsWith('GitHub issue #12 in acme/site, opened by @sam: https://github.com/acme/site/issues/12') && goal.includes("The request as the issue's author wrote it:\n\nOffline mode\n\nPlease."), goal);
  check('a huge body is cut to the goal limit', D.issueGoal('a/b', { number: 1, title: 't', body: 'x'.repeat(20_000), url: 'u', author: null }).length <= 8000);
}

section('pure: comments');
{
  const body = D.queuedCommentBody([{ key: 'U1', statement: 'Works | fast `now` @alice' }]);
  check('queued: marker first, count, table', body.startsWith('<!-- tandemise:queued -->\nQueued in Tandemise — 1 criterion.') && body.includes('| U1 |'), body);
  check('escaped: pipes, backticks; mentions broken', body.includes('Works \\| fast \\`now\\` @​alice') && !/@alice/.test(body), body);
  const done = D.completedCommentBody({ rows: [{ key: 'U1', statement: 'a', result: 'PASS' }, { key: 'U2', statement: 'b', result: 'FAIL' }], links: [{ label: 'Pull request', url: 'https://github.com/a/b/pull/3' }], close: 'left_open' });
  check('completed: counts, words, links, left open', done.includes('Done in Tandemise — 1 of 2 criteria verified.') && done.includes('| U2 | b | Failed |') && done.includes('- Pull request: https://github.com/a/b/pull/3') && done.includes('Left open: 1 criterion was not verified.'), done);
  check('hasIssueMarker', D.hasIssueMarker(done, 'completed') && !D.hasIssueMarker(done, 'queued'));
  const base = { settings: { postComments: true, closeOnComplete: true }, link: { state: 'open', stallOpen: false, closedByUsAt: null }, criteria: [{ key: 'U1', statement: 'a' }], links: [], stalled: null, posted: {} };
  const pass = [{ key: 'U1', statement: 'a', result: 'PASS' }];
  const q = D.decideWriteBack({ ...base, mission: { status: 'DRAFT', queued: true }, trace: [] });
  check('a queued draft wants the queued comment', q.comments.length === 1 && q.comments[0].kind === 'queued' && !q.close);
  check('the same body already posted: nothing', D.decideWriteBack({ ...base, mission: { status: 'DRAFT', queued: true }, trace: [], posted: { queued: q.comments[0].body } }).comments.length === 0);
  check('an unqueued draft: nothing', D.decideWriteBack({ ...base, mission: { status: 'DRAFT', queued: false }, trace: [] }).comments.length === 0);
  const c = D.decideWriteBack({ ...base, mission: { status: 'COMPLETE', queued: false }, trace: pass });
  check('complete + all verified + close on: comment and close', c.close && c.comments.some((x) => x.kind === 'completed' && x.body.includes('Closing this issue')));
  check('complete + one failed: never close', !D.decideWriteBack({ ...base, mission: { status: 'COMPLETE', queued: false }, trace: [...pass, { key: 'U2', statement: 'b', result: 'FAIL' }] }).close);
  check('complete + no criteria: never close', !D.decideWriteBack({ ...base, mission: { status: 'COMPLETE', queued: false }, trace: [] }).close);
  check('close off: never close', !D.decideWriteBack({ ...base, settings: { postComments: true, closeOnComplete: false }, mission: { status: 'COMPLETE', queued: false }, trace: pass }).close);
  check('already closed by us: not again', !D.decideWriteBack({ ...base, link: { ...base.link, closedByUsAt: 'x' }, mission: { status: 'COMPLETE', queued: false }, trace: pass }).close);
  check('closed upstream: not closed again', !D.decideWriteBack({ ...base, link: { ...base.link, state: 'closed' }, mission: { status: 'COMPLETE', queued: false }, trace: pass }).close);
  check('comments off: no comments, close still decided', D.decideWriteBack({ ...base, settings: { postComments: false, closeOnComplete: true }, mission: { status: 'COMPLETE', queued: false }, trace: pass }).comments.length === 0
    && D.decideWriteBack({ ...base, settings: { postComments: false, closeOnComplete: true }, mission: { status: 'COMPLETE', queued: false }, trace: pass }).close);
  const stalled = { reason: '“release” was left blocked.', action: 'Retry release' };
  const s1 = D.decideWriteBack({ ...base, mission: { status: 'BLOCKED', queued: false }, trace: [], stalled });
  check('a new stall: one blocked comment, stall flag set', s1.comments.length === 1 && s1.comments[0].kind === 'blocked' && s1.stallOpen, s1);
  check('the same stall again: nothing', D.decideWriteBack({ ...base, link: { ...base.link, stallOpen: true }, mission: { status: 'BLOCKED', queued: false }, trace: [], stalled }).comments.length === 0);
  check('no longer stalled: flag clears', D.decideWriteBack({ ...base, link: { ...base.link, stallOpen: true }, mission: { status: 'RUNNING', queued: false }, trace: [], stalled: null }).stallOpen === false);
}

// ------------------------------------------------------------ the engine
async function engineHarness(HOME, clock, bin) {
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
  const log = createLogger({ level: 'error', base: { component: 'p14-check' } });
  const container = new Container();
  compose(
    container,
    persistenceTokens.persistenceModule({ path: paths.db, logger: log, clock }),
    A.createArtifactsModule({ paths }),
    policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
    executionCoreModule, executionLocalModule, integrationsCoreModule, app.createApplicationModule({ localPersonName: 'Demo' }),
  );
  // A real process runner with the fake gh first on PATH: the tracker under test is the real one.
  const exec = {
    run: (req) => new Promise((resolve) => {
      execFile(req.command, req.args ?? [], { cwd: req.cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...(req.env ?? {}) }, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
        resolve({ exitCode: err ? (typeof err.code === 'number' ? err.code : 127) : 0, stdout, stderr, timedOut: false, durationMs: 0, command: [req.command, ...(req.args ?? [])].join(' ') });
      });
    }),
  };
  container.bind(EXEC_CLOCK, () => clock, { source: 'check' });
  container.bind(EXEC_LOGGER, () => log, { source: 'check' });
  container.bind(EXEC_PATHS, () => paths, { source: 'check' });
  container.bind(INT_CLOCK, () => clock, { source: 'check' });
  container.bind(INT_LOGGER, () => log, { source: 'check' });
  container.bind(COMMAND_EXECUTOR, () => exec, { source: 'check' });
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
  container.rebind(app.ISSUE_TRACKER, () => new G.GhIssueTracker(exec), { source: 'check' });
  const services = app.createServices(container);
  const repo = {
    workspaces: container.resolve(app.WORKSPACE_REPOSITORY),
    repositories: container.resolve(app.REPO_REPOSITORY),
    missions: container.resolve(app.MISSION_REPOSITORY),
    criteria: container.resolve(app.MISSION_CRITERIA_REPOSITORY),
    events: container.resolve(app.EVENT_REPOSITORY),
    issues: container.resolve(app.ISSUE_REPOSITORY),
    tasks: container.resolve(app.TASK_REPOSITORY),
    evaluations: container.resolve(app.EVALUATION_REPOSITORY),
  };
  const db = container.resolve(persistenceTokens.DATABASE);
  return { container, services, repo, db };
}

section('engine: checks, drafts, edits, closes and idempotent write-back over a fake gh');
{
  const keepAlive = setInterval(() => {}, 1000);
  const HOME = mkdtempSync(join(tmpdir(), 'tdi-'));
  const GH = join(HOME, 'gh');
  const bin = installFakeGh(GH);
  const checkout = join(HOME, 'checkout');
  mkdirSync(checkout, { recursive: true });
  const clock = { ms: Date.parse('2026-09-28T09:00:00Z'), now() { return new Date(this.ms).toISOString(); }, epochMs() { return this.ms; } };
  const REPO = 'example/demo';
  let h = await engineHarness(HOME, clock, bin);
  try {
    const caller = { personId: h.services.identity.localPerson().id };
    const ws = (await h.services.workspaces.create(caller, { name: 'Issues' })).workspace.id;
    const repository = h.repo.repositories.create({ id: 'rep_issues', workspaceId: ws, name: 'demo', path: checkout, defaultBranch: 'main', remoteUrl: null, checks: D.NO_CHECKS });
    const I = () => h.services.issues;
    const missionsFrom = () => h.repo.missions.list({ workspaceId: ws }).filter((m) => m.issueLinkId);
    const missionOf = (n) => { const link = h.repo.issues.findLink(repository.id, n); return link && h.repo.missions.list({ workspaceId: ws }).find((m) => m.issueLinkId === link.id); };
    const notes = (m) => h.repo.events.listByMission(m.id).map((e) => e.body?.text ?? '').join(' | ');
    const writes = () => calls(GH).filter((c) => c.args[0] === 'api' && (c.args.includes('POST') || c.args.includes('PATCH')) || (c.args[0] === 'issue' && c.args[1] === 'close'));
    const refusal = (fn) => { try { fn(); return null; } catch (e) { return e; } };

    // --- settings
    check('a label with a comma is refused', refusal(() => I().configure(caller, repository.id, { label: 'a,b' }))?.code === 'VALIDATION');
    check('a repository that is not owner/name is refused', refusal(() => I().configure(caller, repository.id, { githubRepo: 'nope' }))?.code === 'VALIDATION');
    check('an interval off the presets is refused', refusal(() => I().configure(caller, repository.id, { pollMinutes: 7 }))?.code === 'VALIDATION');
    check('on without a GitHub repository (no remote) is refused', /owner\/name/.test(refusal(() => I().configure(caller, repository.id, { enabled: true }))?.message ?? ''));
    const off = I().overview(ws).repositories[0];
    check('before: off, defaults shown', off.statusLabel === 'Off' && off.settings.label === 'tandemise' && off.settings.pollMinutes === 10 && off.settings.postComments && !off.settings.closeOnComplete, off);
    const on = I().configure(caller, repository.id, { enabled: true, githubRepo: REPO });
    check('switched on: "Not checked yet · 0 linked"', on.statusLabel === 'Not checked yet · 0 linked' && on.settings.enabled, on);

    // --- first check
    putIssue(GH, REPO, { number: 11, title: 'Offline mode for the hello page', author: 'sam',
      body: 'The page should work on a train.\n\n## Done when\n- [ ] The page loads with no network\n- [ ] It says hello to the visitor\n- [x] It works on a phone\n' });
    putIssue(GH, REPO, { number: 12, title: 'Make the footer nicer', author: 'kim', body: 'It looks dated. Ideas welcome.' });
    putIssue(GH, REPO, { number: 5, title: 'Not for tandemise', labels: ['bug'], body: '## Done when\n- [ ] x' });
    await I().check(repository.id);
    const m11 = missionOf(11);
    const m12 = missionOf(12);
    check('two drafts, one per labelled issue (the unlabelled one is not read)', missionsFrom().length === 2 && m11 && m12 && !h.repo.issues.findLink(repository.id, 5), missionsFrom().map((m) => m.title));
    check('#11: a DRAFT, queued, with the issue title', m11?.status === 'DRAFT' && m11?.queuedAt !== null && m11?.title === 'Offline mode for the hello page', m11);
    const ledger = h.repo.criteria.listActive(m11.id);
    check('#11: U1…U3 from the checklist, recorded as from the issue', eq(ledger.map((c) => `${c.key} ${c.statement}`), ['U1 The page loads with no network', 'U2 It says hello to the visitor', 'U3 It works on a phone']) && ledger.every((c) => c.decidedBy === D.ISSUE_CRITERIA_AUTHOR), ledger);
    check('#11: ready by construction (P6)', h.container.resolve(app.READINESS_SERVICE).evaluate(m11.id).ready);
    check('#11: the goal is the issue, attributed', m11.goal.startsWith('GitHub issue #11 in example/demo, opened by @sam: https://github.com/example/demo/issues/11'), m11.goal);
    check('#11: repository and link', m11.repositoryId === repository.id && m11.issueLinkId === h.repo.issues.findLink(repository.id, 11).id);
    check('#12: a DRAFT, not queued, not ready (needs refinement)', m12?.status === 'DRAFT' && m12?.queuedAt === null && !h.container.resolve(app.READINESS_SERVICE).evaluate(m12.id).ready);
    check('timeline: "Created from GitHub issue #11 by @sam"', notes(m11).includes('Created from GitHub issue #11 by @sam: https://github.com/example/demo/issues/11. Its Done-when list gave 3 criteria, so it is queued.'), notes(m11));
    const c11 = commentsOf(GH, REPO, 11);
    check('the queued comment is on #11, once', c11.length === 1 && c11[0].body.startsWith('<!-- tandemise:queued -->\nQueued in Tandemise — 3 criteria.'), c11);
    check('no comment on #12 (not queued)', commentsOf(GH, REPO, 12).length === 0);
    const view = I().overview(ws);
    check('overview: "Last checked just now · 2 linked" and two links', view.repositories[0].statusLabel === 'Last checked just now · 2 linked' && view.links.length === 2 && view.links.every((l) => l.missionId !== null), view);
    check('linkForMission', I().linkForMission(m11.id)?.number === 11 && I().linkForMission(m11.id)?.url === 'https://github.com/example/demo/issues/11');

    // --- dedupe
    const writesBefore = writes().length;
    await I().check(repository.id);
    await I().check(repository.id);
    check('two more checks: no new mission, no new comment', missionsFrom().length === 2 && writes().length === writesBefore && commentsOf(GH, REPO, 11).length === 1, writes().length - writesBefore);

    // --- the tick honours the interval
    const lists = () => calls(GH).filter((c) => c.args[0] === 'issue' && c.args[1] === 'list').length;
    const before = lists();
    clock.ms += 5 * 60_000;
    I().tick(); await I().settle();
    check('tick after 5 minutes (interval 10): no check', lists() === before);
    clock.ms += 5 * 60_000;
    I().tick(); await I().settle();
    check('tick after 10 minutes: one check', lists() === before + 1);

    // --- edited before planning
    patchIssue(GH, REPO, 11, { title: 'Offline mode (hello page)', body: 'The page should work on a train.\n\n## Done when\n- [ ] The page loads with no network\n- [ ] It says hello to the visitor\n- [ ] It works on a phone\n- [ ] It shows the last visit time\n' });
    const postsBefore = calls(GH).filter((c) => c.args.includes('POST')).length;
    await I().check(repository.id);
    const e11 = h.repo.missions.get(m11.id);
    check('edited before planning: title follows the issue', e11.title === 'Offline mode (hello page)', e11.title);
    const live = h.repo.criteria.listActive(m11.id).map((c) => c.statement);
    check('…and the Done-when lines (4 now, old ones superseded)', live.length === 4 && live[3] === 'It shows the last visit time' && h.repo.criteria.listAll(m11.id).filter((c) => c.supersededAt).length === 3, live);
    check('…with a note', notes(e11).includes('Issue #11 was edited upstream; the goal and Done-when lines were updated.'));
    check('the queued comment was updated in place, not posted again', commentsOf(GH, REPO, 11).length === 1 && commentsOf(GH, REPO, 11)[0].body.includes('Queued in Tandemise — 4 criteria.') && calls(GH).filter((c) => c.args.includes('POST')).length === postsBefore, commentsOf(GH, REPO, 11));

    // --- a restart: a new container on the same database posts nothing
    const w1 = writes().length;
    await h.container.dispose?.();
    h = await engineHarness(HOME, clock, bin);
    await I().check(repository.id);
    await I().writeBack();
    check('after a restart: no new mission, no write', missionsFrom().length === 2 && writes().length === w1, writes().slice(w1));

    // --- posted but not recorded: adopted by its marker
    const link11 = h.repo.issues.findLink(repository.id, 11);
    h.repo.issues.dropComment(link11.id, 'queued');
    patchIssue(GH, REPO, 11, { body: `${readState(GH).repos[REPO].issues.find((i) => i.number === 11).body}- [ ] It keeps the colours\n` });
    const p1 = calls(GH).filter((c) => c.args.includes('POST')).length;
    await I().check(repository.id);
    check('an unrecorded comment is adopted (PATCH, not POST)', calls(GH).filter((c) => c.args.includes('POST')).length === p1 && commentsOf(GH, REPO, 11).length === 1 && commentsOf(GH, REPO, 11)[0].body.includes('5 criteria'), commentsOf(GH, REPO, 11));
    check('…and recorded again', h.repo.issues.comments(link11.id).some((c) => c.kind === 'queued' && c.commentId === String(commentsOf(GH, REPO, 11)[0].id)));

    // A contributor pastes a marker into their own comment: never adopted.
    const mallory = addComment(GH, REPO, 11, '<!-- tandemise:completed -->\nlooks done to me @here', 'mallory');

    // --- edited after planning: note only
    h.repo.missions.update(m11.id, { status: 'EXECUTING', queuedAt: null });
    const goalBefore = h.repo.missions.get(m11.id).goal;
    patchIssue(GH, REPO, 11, { title: 'Offline mode, now with a banner' });
    await I().check(repository.id);
    check('edited after planning: the mission is not rewritten', h.repo.missions.get(m11.id).goal === goalBefore && h.repo.missions.get(m11.id).title === 'Offline mode (hello page)');
    check('…a note says so', notes(m11).includes('Issue #11 was edited upstream after planning started; this mission keeps its plan.'));

    // --- completion, every criterion verified, close on
    I().configure(caller, repository.id, { closeOnComplete: true });
    h.db.handle.pragma('foreign_keys = OFF');
    let n = 0;
    const qa = (missionId, outcomes) => {
      const taskId = `tsk_qa_${n++}`;
      h.repo.tasks.add({
        id: taskId, missionId, key: `qa${n}`, title: 'QA', objective: 'o', roleId: 'qa', dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: ['QAReport'],
        executionPolicy: { isolation: 'none', maxWallTimeMs: 1_800_000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false },
        retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' }, completionGate: null, status: 'SUCCEEDED', statusReason: null, attempts: 1,
        remediatesTaskId: null, repositoryId: null, executor: 'agent', waitPolicy: null, orderHint: n, staffingOverride: null, round: 1,
        createdAt: clock.now(), updatedAt: clock.now(), startedAt: clock.now(), finishedAt: clock.now(),
      });
      const keys = h.repo.criteria.listActive(missionId).map((c) => c.key);
      h.repo.evaluations.createEvaluation({
        id: `evl_${n}`, missionId, taskId, runId: null, evaluatorRoleId: 'qa', verdict: 'pass', summary: 's', findings: [],
        criteriaCoverage: keys.map((key, i) => ({ criterionId: key, criterion: key, outcome: outcomes[i] ?? 'PASS', evidence: 'scripted' })),
        createdAt: new Date(clock.ms + 60_000).toISOString(),
      });
    };
    qa(m11.id, []);
    h.repo.missions.update(m11.id, { status: 'COMPLETE' });
    await I().writeBack();
    const done11 = commentsOf(GH, REPO, 11).find((c) => c.user.login === 'tandemise-owner' && c.body.includes('tandemise:completed'));
    check('complete: the criteria table is posted', done11?.body.includes('Done in Tandemise — 5 of 5 criteria verified.') && /\| U\d+ \| The page loads with no network \| Verified \|/.test(done11.body) && done11.body.includes('Closing this issue: every criterion was verified.'), done11?.body);
    check('the contributor\'s marker comment was left alone', commentsOf(GH, REPO, 11).find((c) => c.id === mallory.id)?.body === mallory.body);
    check('the issue was closed once', calls(GH).filter((c) => c.args[0] === 'issue' && c.args[1] === 'close' && c.args[2] === '11').length === 1 && readState(GH).repos[REPO].issues.find((i) => i.number === 11).state === 'CLOSED');
    check('…recorded, with a note', h.repo.issues.findLink(repository.id, 11).closedByUsAt !== null && notes(m11).includes('Closed GitHub issue #11: every criterion was verified.'));
    const w2 = writes().length;
    await I().writeBack();
    await I().check(repository.id);
    await h.container.dispose?.();
    h = await engineHarness(HOME, clock, bin);
    await I().check(repository.id);
    await I().writeBack();
    check('again, and after a restart: nothing more is written', writes().length === w2, writes().slice(w2));
    check('a closed issue we closed ourselves leaves the finished mission without a note', !notes(m11).includes('was closed upstream'));

    // --- completion with a failed criterion: comment, never close
    putIssue(GH, REPO, { number: 13, title: 'Dark theme', body: '## Acceptance criteria\n- [ ] Colours follow the system\n- [ ] Contrast passes' });
    await I().check(repository.id);
    const m13 = missionOf(13);
    h.repo.missions.update(m13.id, { status: 'COMPLETE', queuedAt: null });
    qa(m13.id, ['PASS', 'FAIL']);
    await I().writeBack();
    const done13 = commentsOf(GH, REPO, 13).find((c) => c.body.includes('tandemise:completed'));
    check('a failed criterion: the table says Failed and "Left open"', done13?.body.includes('| U2 | Contrast passes | Failed |') && done13.body.includes('Left open: 1 criterion was not verified.'), done13?.body);
    check('…and the issue is never closed', !calls(GH).some((c) => c.args[0] === 'issue' && c.args[1] === 'close' && c.args[2] === '13') && readState(GH).repos[REPO].issues.find((i) => i.number === 13).state === 'OPEN');

    // --- close off: comment only
    I().configure(caller, repository.id, { closeOnComplete: false });
    putIssue(GH, REPO, { number: 14, title: 'Faster start', body: 'Done when: it starts in under a second' });
    await I().check(repository.id);
    const m14 = missionOf(14);
    h.repo.missions.update(m14.id, { status: 'COMPLETE', queuedAt: null });
    qa(m14.id, ['PASS']);
    await I().writeBack();
    check('close off: all verified, commented, not closed', commentsOf(GH, REPO, 14).some((c) => c.body.includes('1 of 1 criterion verified')) && !calls(GH).some((c) => c.args[1] === 'close' && c.args[2] === '14'));

    // --- a stall: one comment per stall
    putIssue(GH, REPO, { number: 15, title: 'Release notes', body: '## Done when\n- [ ] Notes list every change' });
    await I().check(repository.id);
    const m15 = missionOf(15);
    h.repo.missions.update(m15.id, { status: 'BLOCKED', queuedAt: null, statusReason: "'release' was left blocked by a human." });
    const blockedTask = h.repo.tasks.add({
      id: 'tsk_rel_15', missionId: m15.id, key: 'release', title: 'Release', objective: 'o', roleId: 'release', dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: ['ReleaseCandidate'],
      executionPolicy: { isolation: 'none', maxWallTimeMs: 1_800_000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false },
      retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' }, completionGate: null, status: 'BLOCKED', statusReason: 'A human declined to retry this task.', attempts: 2,
      remediatesTaskId: null, repositoryId: null, executor: 'agent', waitPolicy: null, orderHint: 1, staffingOverride: null, round: 1,
      createdAt: clock.now(), updatedAt: clock.now(), startedAt: clock.now(), finishedAt: null,
    });
    const verdict = h.services.liveness.classify(m15.id);
    check('(P9 classifies the seeded mission as stalled)', verdict.kind === 'stalled', verdict);
    await I().writeBack();
    const blocked = () => commentsOf(GH, REPO, 15).filter((c) => c.body.includes('tandemise:blocked'));
    check('stalled: one "stuck" comment naming the next step', blocked().length === 1 && blocked()[0].body.includes('Tandemise is stuck on this:') && blocked()[0].body.includes('Next step in Tandemise:'), blocked());
    const w3 = writes().length;
    await I().writeBack();
    check('still the same stall: nothing more', writes().length === w3 && h.repo.issues.findLink(repository.id, 15).stallOpen);
    h.repo.missions.update(m15.id, { status: 'EXECUTING', statusReason: null });
    h.repo.tasks.update?.(blockedTask.id, { status: 'RUNNING', statusReason: null });
    if (!h.repo.tasks.update) h.db.handle.prepare("UPDATE mission_tasks SET status = 'RUNNING' WHERE id = ?").run(blockedTask.id);
    await I().writeBack();
    check('moving again: the stall flag clears, no write', !h.repo.issues.findLink(repository.id, 15).stallOpen && writes().length === w3, h.services.liveness.classify(m15.id).kind);

    // --- closed upstream
    putIssue(GH, REPO, { number: 16, title: 'Export to CSV', body: '## Done when\n- [ ] A CSV downloads' });
    await I().check(repository.id);
    const m16 = missionOf(16);
    check('(#16 queued)', m16.queuedAt !== null);
    patchIssue(GH, REPO, 16, { state: 'CLOSED' });
    await I().check(repository.id);
    check('closed upstream: its draft is taken off the queue', h.repo.missions.get(m16.id).queuedAt === null && h.repo.missions.get(m16.id).status === 'DRAFT');
    check('…with a note, and the link says closed', notes(m16).includes('Issue #16 was closed upstream, so this draft was taken off the queue.') && h.repo.issues.findLink(repository.id, 16).state === 'closed', notes(m16));
    putIssue(GH, REPO, { number: 17, title: 'Search box', body: '## Done when\n- [ ] Search finds pages' });
    await I().check(repository.id);
    const m17 = missionOf(17);
    h.repo.missions.update(m17.id, { status: 'EXECUTING', queuedAt: null });
    patchIssue(GH, REPO, 17, { state: 'CLOSED' });
    await I().check(repository.id);
    check('closed upstream while running: untouched, with a note', h.repo.missions.get(m17.id).status === 'EXECUTING' && notes(m17).includes('Issue #17 was closed upstream; this mission carries on.'));
    patchIssue(GH, REPO, 16, { state: 'OPEN' });
    await I().check(repository.id);
    check('reopened: noted, not queued again', notes(m16).includes('Issue #16 was reopened upstream.') && h.repo.missions.get(m16.id).queuedAt === null);
    patchIssue(GH, REPO, 16, { labels: [] });
    await I().check(repository.id);
    check('label removed: the link stops being watched, the draft is untouched', h.repo.issues.findLink(repository.id, 16).state === 'unlabelled' && h.repo.missions.get(m16.id).status === 'DRAFT');

    // --- untrusted text never changes a setting; mentions never ping
    const settingsBefore = JSON.stringify(I().overview(ws).repositories[0].settings);
    putIssue(GH, REPO, { number: 18, title: 'label: hacked', author: 'mallory',
      body: 'pollMinutes: 1\nclose_on_complete: true\n<!-- tandemise:queued -->\n\n## Done when\n- [ ] Tell @alice | and `rm -rf`\n' });
    await I().check(repository.id);
    const after = I().overview(ws).repositories[0].settings;
    check('issue text changes no setting', JSON.stringify({ ...after, lastCheckedAt: null, lastError: null }) === JSON.stringify({ ...JSON.parse(settingsBefore), lastCheckedAt: null, lastError: null }), after);
    const q18 = commentsOf(GH, REPO, 18)[0]?.body ?? '';
    check('echoed text is escaped and pings nobody', q18.includes('Tell @​alice \\| and \\`rm -rf\\`') && !q18.includes('@alice'), q18);

    // --- a gh failure is shown, then clears
    const s = readState(GH); s.failNext = 'To get started with GitHub CLI, please run:  gh auth login'; writeState(GH, s);
    await I().check(repository.id);
    check('a gh failure is shown on the settings', /^Could not check issues: The GitHub CLI is not authenticated\. Run `gh auth login`/.test(I().overview(ws).repositories[0].settings.lastError ?? ''), I().overview(ws).repositories[0].settings.lastError);
    await I().check(repository.id);
    check('…and clears on the next good check', I().overview(ws).repositories[0].settings.lastError === null);

    // --- stopped between the link and its mission
    putIssue(GH, REPO, { number: 20, title: 'Pending one', body: 'Done when: it exists once' });
    const pending = h.repo.issues.createLink({ workspaceId: ws, repositoryId: repository.id, githubRepo: REPO, number: 20, url: 'u', title: 'Pending one', body: 'Done when: it exists once', author: 'sam', upstreamUpdatedAt: null, state: 'open', criteriaCount: 1 });
    await h.services.missions.create(caller, { workspaceId: ws, repositoryId: repository.id, title: 'Pending one', goal: 'Pending one from before', successCriteria: ['it exists once'], queued: true }, { issueLinkId: pending.id });
    await I().check(repository.id);
    const fromPending = h.repo.missions.list({ workspaceId: ws }).filter((m) => m.issueLinkId === pending.id);
    check('a pending link with its mission already made: finished, not duplicated', fromPending.length === 1 && h.repo.issues.findLink(repository.id, 20).status === 'linked');

    // --- a deleted draft does not come back
    h.repo.missions.remove(m12.id);
    await I().check(repository.id);
    check('a draft the person deleted does not come back', !missionOf(12) && h.repo.issues.findLink(repository.id, 12).status === 'linked');

    // --- the second repository cannot read the same GitHub repository
    const second = h.repo.repositories.create({ id: 'rep_issues2', workspaceId: ws, name: 'demo-copy', path: checkout, defaultBranch: 'main', remoteUrl: 'https://github.com/example/demo.git', checks: D.NO_CHECKS });
    check('suggested repository from the remote', I().overview(ws).repositories.find((r) => r.repositoryId === second.id)?.suggestedRepo === 'example/demo');
    check('two repositories reading one GitHub repository: 409', refusal(() => I().configure(caller, second.id, { enabled: true }))?.code === 'CONFLICT');

    // --- sources
    const src = readFileSync(join(here, '../packages/application/dist/services/issue-service.js'), 'utf8');
    check('the issue service reads no wall clock', !/Date\.now\(/.test(src));
    check('the issue service never plans or starts work', !/planNow|planning\.|\.begin\(|scheduler/i.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
  } finally {
    clearInterval(keepAlive);
    await h.container.dispose?.();
    rmSync(HOME, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the daemon
section('daemon: migration 019, routes, gh on the daemon\'s PATH');
{
  const root = mkdtempSync(join(tmpdir(), 'tdi-d-'));
  const home = join(root, 'h');
  const repoDir = join(root, 'r');
  const GH = join(root, 'gh');
  const bin = installFakeGh(GH);
  const gitConfig = join(root, 'gitconfig');
  writeFileSync(gitConfig, '[user]\n\tname = Issue Tester\n\temail = issues@example.com\n');
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  delete process.env.TANDEMISE_OWNER_NAME;
  delete process.env.TANDEMISE_CLOCK_OFFSET_MS;
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  execFileSync('git', ['init', '-q', '-b', 'main', repoDir], { stdio: 'ignore' });
  writeFileSync(join(repoDir, 'README.md'), '# issues check\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/demo.git'], { cwd: repoDir, stdio: 'ignore' });
  globalThis.__sqlite = await import('node:sqlite');
  const { startDaemon } = await import('../apps/daemon/dist/main.js');
  let daemon;
  try {
    daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 200 });
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
    const sql = (q, ...p) => {
      const db = new globalThis.__sqlite.DatabaseSync(join(home, 'tandemise.db'), { readOnly: true });
      try { return db.prepare(q).all(...p); } finally { db.close(); }
    };
    const cols = (t) => sql(`SELECT name FROM pragma_table_info('${t}')`).map((c) => c.name);
    check('schema version is at least 19', (await api('GET', '/v1/system')).body?.schemaVersion >= 19);
    check('issue_sync, issue_links, issue_comments and missions.issue_link_id exist',
      cols('issue_sync').includes('poll_minutes') && cols('issue_links').includes('issue_number') && cols('issue_comments').includes('comment_id') && cols('missions').includes('issue_link_id'));
    check('links are unique per repository and number', (sql("SELECT sql FROM sqlite_master WHERE name = 'issue_links'")[0]?.sql ?? '').includes('UNIQUE (repository_id, issue_number)'));
    const ws = (await api('POST', '/v1/workspaces', { name: 'Issues', repositoryPath: repoDir })).body?.workspace?.id;
    const overview = await api('GET', `/v1/workspaces/${ws}/issues`);
    const repositoryId = overview.body?.repositories?.[0]?.repositoryId;
    check('GET issues: off, with the remote suggested', overview.status === 200 && overview.body.repositories[0].statusLabel === 'Off' && overview.body.repositories[0].suggestedRepo === 'example/demo', overview.body);
    check('Check now while off is 412', (await api('POST', `/v1/repositories/${repositoryId}/issues/check`)).status === 412);
    check('PATCH with a bad label is 400', (await api('PATCH', `/v1/repositories/${repositoryId}/issues`, { label: 'a,b' })).status === 400);
    check('PATCH with an unknown field is 400', (await api('PATCH', `/v1/repositories/${repositoryId}/issues`, { hacked: true })).status === 400);
    putIssue(GH, 'example/demo', { number: 3, title: 'Hello from an issue', body: '## Done when\n- [ ] It says hello' });
    const on = await api('PATCH', `/v1/repositories/${repositoryId}/issues`, { enabled: true });
    check('PATCH enabled: the remote becomes the GitHub repository', on.status === 200 && on.body.settings.githubRepo === 'example/demo' && on.body.settings.enabled, on.body);
    const checked = await api('POST', `/v1/repositories/${repositoryId}/issues/check`);
    check('Check now answers with the status line', checked.status === 200 && checked.body.statusLabel === 'Last checked just now · 1 linked', checked.body);
    const m = sql('SELECT id, status, queued_at, issue_link_id FROM missions WHERE issue_link_id IS NOT NULL');
    check('the daemon ran gh from its PATH and made a queued draft', m.length === 1 && m[0].status === 'DRAFT' && m[0].queued_at !== null, m);
    const links = (await api('GET', `/v1/workspaces/${ws}/issues`)).body.links;
    check('GET issues lists the link with its mission', links.length === 1 && links[0].number === 3 && links[0].missionId === m[0]?.id, links);
    check('the mission carries issueLinkId', (await api('GET', `/v1/missions/${m[0]?.id}`)).body?.mission?.issueLinkId === links[0]?.id);
    const listed = calls(GH).filter((c) => c.args[1] === 'list').length;
    await new Promise((r) => setTimeout(r, 800));
    check('the scheduler tick does not check again within the interval', calls(GH).filter((c) => c.args[1] === 'list').length === listed && sql('SELECT COUNT(*) AS n FROM missions WHERE issue_link_id IS NOT NULL')[0].n === 1);
  } finally {
    await daemon?.stop();
    process.env.PATH = PATH;
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
