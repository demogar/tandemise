// P3a: outside contributions, part 1 - the pure types, schemas, events and the
// liveness split that every later P3 task builds on. A contribution (a file
// or a link) is one shape wherever it arrives; a workspace handoff link may
// carry a path instead of a url; a skipped plan stage must name a real
// upload; and a parked agent task waits on a person, not the scheduler.
//
//   npm run build && node scratch/p3-contributions-check.mjs
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '@tandemise/persistence';

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 700)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const D = await import('@tandemise/domain');
const A = await import('@tandemise/artifacts');

section('pure: contributions, links, plans, liveness');

check('decodedSize of 4 base64 chars is 3', D.decodedSize('YWJj') === 3);
check('decodedSize honours padding', D.decodedSize('YQ==') === 1);
check('the cap is 24 MB', D.CONTRIBUTION_MAX_BYTES === 25165824);

const ok = A.handoffSchema.safeParse({ headline: 'h', points: [], links: [{ label: 'Repo', kind: 'workspace', path: 'docs/spec.md' }] });
check('a workspace link may carry a path and no url', ok.success, ok.error?.issues);
const bad = A.handoffSchema.safeParse({ headline: 'h', points: [], links: [{ label: 'PR', kind: 'pr', url: 'https://x/1', path: 'a' }] });
check('a pr link with a path is refused', !bad.success && bad.error.issues.some((i) => /only a workspace link may carry a path/.test(i.message)), bad.success ? bad.data : bad.error.issues);
const file = A.handoffSchema.safeParse({ headline: 'h', points: [], links: [{ label: 'X', kind: 'doc', url: 'file:///etc/passwd' }] });
check('a non-workspace link stays http(s) only', !file.success);
const noUrlNoPath = A.handoffSchema.safeParse({ headline: 'h', points: [], links: [{ label: 'X', kind: 'other' }] });
check('a non-workspace link without a url is refused', !noUrlNoPath.success && noUrlNoPath.error.issues.some((i) => /link url must be a full URL/.test(i.message)), noUrlNoPath.success ? noUrlNoPath.data : noUrlNoPath.error.issues);
const bareWorkspace = A.handoffSchema.safeParse({ headline: 'h', points: [], links: [{ label: 'X', kind: 'workspace' }] });
check('a workspace link with neither url nor path says so', !bareWorkspace.success && bareWorkspace.error.issues.some((i) => /a workspace link needs a url or a path/.test(i.message)), bareWorkspace.success ? bareWorkspace.data : bareWorkspace.error.issues);

// A minimal planned task: the shape validateMissionPlan already accepts
// (copied from the `task` fixture in scratch/p15-setup-check.mjs), parameterised
// by key, output type and dependencies since this check needs several shapes.
const minimalTask = (key, outputType, dependsOn) => ({
  key, title: key, objective: 'o', roleId: key, dependsOn, requiredCapabilities: [], inputArtifacts: [],
  expectedOutputs: [outputType], executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
  approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'block' },
  completionGate: null,
});
const ctx = (extra = {}) => ({ knownRoleIds: new Set(['design']), satisfiableCapabilities: new Set(), ...extra });

const pre = [{ id: 'art_up', type: 'ProductSpec' }];
const plan = {
  summary: 's',
  tasks: [/* a design task depending on nothing */ minimalTask('design', 'DesignBrief', [])],
  skipped: [{ stage: 'product', outputType: 'ProductSpec', artifactId: 'art_up', reason: 'upload' }],
};
const good = D.validateMissionPlan(plan, ctx({ preexistingArtifacts: pre }));
check('a skipped stage naming a real upload validates', good.ok, good.ok ? good.value : good.error);
const badSkip = D.validateMissionPlan({ ...plan, skipped: [{ ...plan.skipped[0], artifactId: 'art_nope' }] }, ctx({ preexistingArtifacts: pre }));
check('a skipped stage naming an unknown artifact is an error', !badSkip.ok && badSkip.error.some((e) => /not an upload of type ProductSpec/.test(e.message)), badSkip.ok ? badSkip.value : badSkip.error);

// taskLiveness is the real per-task classifier (liveness.ts); AWAITING_EXTERNAL
// now splits on executor (T8 wait vs T8b parked agent). `moves` is true, as it
// is for any task in a working mission's row.
const wctx = { byKey: new Map(), carded: new Set(), moves: true };
check('T8: a waiting wait-step is moving', D.taskLiveness({ status: 'AWAITING_EXTERNAL', executor: 'wait' }, wctx).standing === 'moving');
check('T8b: a parked agent task waits on a person', D.taskLiveness({ status: 'AWAITING_EXTERNAL', executor: 'agent' }, wctx).standing === 'waiting');

check('the new events are in the semantic list', ['task.parked_external', 'task.handed_back', 'mission.intake_completed'].every((t) => D.SEMANTIC_EVENT_TYPES.has(t)));

check('P3a adds no migration: SCHEMA_VERSION is still 19', SCHEMA_VERSION === 19, SCHEMA_VERSION);

// ------------------------------------------------------ the gh PR resolver
// The real GhPullRequestSnapshots over a scripted executor: which URLs reach
// gh at all, what a not-found exit becomes, and how a huge diff is cut.
section('github: pull request snapshots');
{
  const G = await import('@tandemise/integration-github');
  const ran = [];
  const scripted = (reply) => ({ run: async (req) => { ran.push(req); return { stdout: '', stderr: '', timedOut: false, durationMs: 0, command: ['gh', ...req.args].join(' '), exitCode: 0, ...reply(req) }; } });
  const view = { number: 7, title: 'Add greeting', body: 'Greets people.', headRefName: 'feat/greet', headRefOid: 'abc123', url: 'https://github.com/acme/app/pull/7' };
  const ok = new G.GhPullRequestSnapshots(scripted((req) => (req.args[1] === 'view' ? { stdout: JSON.stringify(view) } : { stdout: 'diff --git a/x b/x\n+hi\n' })));
  check('a non-PR URL never reaches gh', (await ok.read('https://www.figma.com/file/x', '/tmp')) === null && ran.length === 0, ran);
  const snap = await ok.read('https://github.com/acme/app/pull/7', '/tmp');
  check('a PR URL reads view and diff in the given cwd', eq(ran.map((r) => r.args.slice(0, 2)), [['pr', 'view'], ['pr', 'diff']]) && ran.every((r) => r.cwd === '/tmp'), ran);
  check('the snapshot carries repo, number, head and diff', snap?.repo === 'acme/app' && snap.number === 7 && snap.headRefOid === 'abc123' && snap.headRefName === 'feat/greet' && snap.diff.includes('+hi'), snap);
  const missing = new G.GhPullRequestSnapshots(scripted(() => ({ exitCode: 1, stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 7. (repository.pullRequest)' })));
  check('gh\'s real missing-PR text is null, not an error', (await missing.read('https://github.com/acme/app/pull/7', '/tmp')) === null);
  const denied = new G.GhPullRequestSnapshots(scripted(() => ({ exitCode: 1, stderr: 'HTTP 403: Resource not accessible by integration' })));
  check('a no-access exit is null, not an error', (await denied.read('https://github.com/acme/app/pull/7', '/tmp')) === null);
  const huge = new G.GhPullRequestSnapshots(scripted((req) => (req.args[1] === 'view' ? { stdout: JSON.stringify(view) } : { stdout: `${'+'.repeat(99)}\n`.repeat(30_000) })));
  const cut = await huge.read('https://github.com/acme/app/pull/7', '/tmp');
  check('a diff over 2 MB is cut and says so', cut !== null && Buffer.byteLength(cut.diff) <= 2 * 1024 * 1024 + 64 && cut.diff.endsWith('… diff truncated at 2 MB'), cut?.diff.slice(-80));
}

// ------------------------------------------------------ pinning, in process
// Real SQLite, real artifact store and real services, composed as
// scratch/p14-issues-check.mjs composes them, so the PR resolver can be
// rebound to a stub before anything resolves it.
async function engineHarness(HOME, prStub) {
  const app = await import('@tandemise/application');
  const { Container, compose } = await import('@tandemise/kernel');
  const { createLogger, createPaths, systemClock } = await import('@tandemise/shared');
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
  const clock = systemClock;
  const log = createLogger({ level: 'error', base: { component: 'p3-check' } });
  const container = new Container();
  compose(
    container,
    persistenceTokens.persistenceModule({ path: paths.db, logger: log, clock }),
    A.createArtifactsModule({ paths }),
    policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
    executionCoreModule, executionLocalModule, integrationsCoreModule, app.createApplicationModule({ localPersonName: 'Demo' }),
  );
  container.bind(EXEC_CLOCK, () => clock, { source: 'check' });
  container.bind(EXEC_LOGGER, () => log, { source: 'check' });
  container.bind(EXEC_PATHS, () => paths, { source: 'check' });
  container.bind(INT_CLOCK, () => clock, { source: 'check' });
  container.bind(INT_LOGGER, () => log, { source: 'check' });
  container.bind(COMMAND_EXECUTOR, () => ({ run: async () => { throw new Error('unused'); } }), { source: 'check' });
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
  container.rebind(app.PULL_REQUEST_SNAPSHOTS, () => prStub, { source: 'check' });
  const services = app.createServices(container);
  return { app, container, services, paths, artifacts: container.resolve(app.ARTIFACT_REPOSITORY), repositories: container.resolve(app.REPO_REPOSITORY) };
}

section('daemon: pinning');
{
  const HOME = mkdtempSync(join(tmpdir(), 'tdm-p3-'));
  const checkout = join(HOME, 'checkout');
  mkdirSync(join(checkout, 'docs'), { recursive: true });
  writeFileSync(join(checkout, 'docs/a.md'), '# a\n');
  // A link that sits inside the repository but resolves to somewhere else.
  symlinkSync('/tmp', join(checkout, 'escape'));
  const PR = 'https://github.com/acme/app/pull/7';
  const cwds = [];
  // Swappable, so later checks can put the real resolver or a failing
  // repository behind the same bound port.
  let reader = null;
  const stub = {
    read: async (url, cwd) => {
      cwds.push(cwd);
      if (reader !== null) return reader(url, cwd);
      return url === PR
        ? { url: PR, number: 7, repo: 'acme/app', headRefName: 'feat/greet', headRefOid: 'deadbeef', title: 'Add greeting', body: 'Greets people.', diff: 'diff --git a/x b/x\n+hi\n' }
        : null;
    },
  };
  const h = await engineHarness(HOME, stub);
  try {
    const caller = { personId: h.services.identity.localPerson().id };
    const ws = (await h.services.workspaces.create(caller, { name: 'Contributions' })).workspace.id;
    h.repositories.create({ id: 'rep_p3', workspaceId: ws, name: 'app', path: checkout, defaultBranch: 'main', remoteUrl: null, checks: D.NO_CHECKS });
    const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Ship the greeting', title: 'Greeting' });
    const C = h.container.resolve(h.app.CONTRIBUTION_SERVICE);
    const me = h.container.resolve(h.app.MEMBER_REPOSITORY).findPersonMember(ws, caller.personId);
    const evidence = () => h.artifacts.listByMission(mission.id, 'Evidence');
    const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
    const b64 = (text) => Buffer.from(text).toString('base64');

    const file = { kind: 'file', filename: 'brief.md', mediaType: 'text/markdown', dataBase64: b64('# The brief\n') };
    const one = await C.pin({ missionId: mission.id, caller, contribution: file });
    const two = await C.pin({ missionId: mission.id, caller, contribution: file });
    check('a file pins as Evidence', one.evidence.type === 'Evidence' && one.filename === 'brief.md' && one.mediaType === 'text/markdown' && one.resolved === null, one);
    check('two pins of the same bytes are two manifests over one blob', one.evidence.id !== two.evidence.id && one.evidence.contentRef === two.evidence.contentRef && one.evidence.contentRef.startsWith('sha256:'), [one.evidence.contentRef, two.evidence.contentRef]);
    check('the file ref names the stored blob and the filename', one.evidence.sourceRefs.some((r) => r.kind === 'file' && r.value === one.evidence.contentRef && r.label === 'brief.md'), one.evidence.sourceRefs);
    check('the pin is on record, authored and recorded by you', h.artifacts.get(one.evidence.id)?.authorId === me?.id && h.artifacts.get(one.evidence.id)?.recordedBy === me?.id, h.artifacts.get(one.evidence.id));
    const long = await C.pin({ missionId: mission.id, caller, contribution: { ...file, filename: `${'x'.repeat(70)}.md` } });
    check('a long filename is cut to 60 characters with an ellipsis', long.evidence.title.length === 60 && long.evidence.title.endsWith('…'), long.evidence.title);

    const pr = await C.pin({ missionId: mission.id, caller, contribution: { kind: 'link', url: PR } });
    const ref = (kind) => pr.evidence.sourceRefs.find((r) => r.kind === kind)?.value;
    check('a PR link is read in the workspace repository', cwds.includes(checkout), cwds);
    check('the PR Evidence carries url, github.pr, git.commit and git.branch', ref('url') === PR && ref('github.pr') === 'acme/app#7' && ref('git.commit') === 'deadbeef' && ref('git.branch') === 'feat/greet', pr.evidence.sourceRefs);
    const prBody = (await h.container.resolve(h.app.ARTIFACT_STORE).read(pr.evidence.id)).body;
    check('the PR Evidence is its title, body and diff', prBody.startsWith('# Add greeting\n\nGreets people.\n\n## Diff\n\n```diff\n') && prBody.includes('+hi'), prBody);
    check('the resolved snapshot comes back', pr.resolved?.headRefOid === 'deadbeef' && pr.mediaType === 'text/markdown', pr.resolved);

    const FIGMA = 'https://www.figma.com/file/x';
    const bare = await refusal(() => C.pin({ missionId: mission.id, caller, contribution: { kind: 'link', url: FIGMA } }));
    check('a link nothing can read, without an export, is refused', bare?.code === 'unreadable_link' && bare.message === 'Nothing here can read that link. Attach an export of it.', bare && { code: bare.code, message: bare.message });
    const exported = await C.pin({ missionId: mission.id, caller, contribution: { kind: 'link', url: FIGMA, export: { filename: 'frame.png', mediaType: 'image/png', dataBase64: b64('PNGBYTES') } } });
    const exportBody = await h.container.resolve(h.app.ARTIFACT_STORE).readBinary(exported.evidence.id);
    check('with an export it pins the export bytes', Buffer.from(exportBody).toString() === 'PNGBYTES' && exported.mediaType === 'image/png' && exported.resolved === null, Buffer.from(exportBody).toString());
    check('the export carries the url and the file', exported.evidence.sourceRefs.some((r) => r.kind === 'url' && r.value === FIGMA) && exported.evidence.sourceRefs.some((r) => r.kind === 'file' && r.value === exported.evidence.contentRef), exported.evidence.sourceRefs);

    // The real resolver over gh's own words for a PR that does not exist.
    const G = await import('@tandemise/integration-github');
    const gone = new G.GhPullRequestSnapshots({ run: async (req) => ({ exitCode: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 404. (repository.pullRequest)', timedOut: false, durationMs: 0, command: ['gh', ...req.args].join(' ') }) });
    reader = (url, cwd) => gone.read(url, cwd);
    const missingPr = await refusal(() => C.pin({ missionId: mission.id, caller, contribution: { kind: 'link', url: 'https://github.com/acme/app/pull/404' } }));
    check('a missing PR with no export is unreadable, in the person\'s words', missingPr?.code === 'unreadable_link' && missingPr.message === 'Nothing here can read that link. Attach an export of it.', missingPr && { code: missingPr.code, message: missingPr.message });

    // Two repositories: the first one's gh fails outright, the second reads the PR.
    const second = join(HOME, 'second');
    mkdirSync(second, { recursive: true });
    h.repositories.create({ id: 'rep_p3_b', workspaceId: ws, name: 'app-b', path: second, defaultBranch: 'main', remoteUrl: null, checks: D.NO_CHECKS });
    const tried = [];
    reader = async (url, cwd) => {
      tried.push(cwd);
      if (cwd === checkout) throw new Error('gh exited 1: something broke in this checkout');
      return { url, number: 7, repo: 'acme/app', headRefName: 'feat/greet', headRefOid: 'cafe', title: 'Add greeting', body: '', diff: '+hi\n' };
    };
    const viaSecond = await C.pin({ missionId: mission.id, caller, contribution: { kind: 'link', url: PR } });
    check('a failing first repository still resolves through the second', viaSecond.resolved?.headRefOid === 'cafe' && eq(tried, [checkout, second]), { tried, resolved: viaSecond.resolved });
    reader = async () => { throw new Error('gh exited 1: signed out'); };
    const allFail = await refusal(() => C.pin({ missionId: mission.id, caller, contribution: { kind: 'link', url: PR } }));
    check('when every repository fails and there is no export, the failure is said', /signed out/.test(allFail?.message ?? ''), allFail?.message);
    const allFailExport = await C.pin({ missionId: mission.id, caller, contribution: { kind: 'link', url: PR, export: { filename: 'pr.txt', mediaType: 'text/plain', dataBase64: b64('exported') } } });
    check('when every repository fails an export is still pinned', allFailExport.resolved === null && allFailExport.filename === 'pr.txt', allFailExport);
    reader = null;

    const before = evidence().length;
    const big = await refusal(() => C.pin({ missionId: mission.id, caller, contribution: { kind: 'file', filename: 'big.bin', mediaType: 'application/octet-stream', dataBase64: Buffer.alloc(D.CONTRIBUTION_MAX_BYTES + 1).toString('base64') } }));
    check('24 MB + 1 byte is too large', big?.code === 'too_large' && big.message === 'That file is larger than 24 MB.', big && { code: big.code, message: big.message });
    const empty = await refusal(() => C.pin({ missionId: mission.id, caller, contribution: { kind: 'file', filename: 'nothing.txt', mediaType: 'text/plain', dataBase64: '' } }));
    check('an empty file is refused', empty?.code === 'empty', empty && { code: empty.code, message: empty.message });
    check('a refused pin writes no artifact', evidence().length === before, [before, evidence().length]);

    const inside = await C.resolveWorkspacePath(ws, 'docs/a.md');
    check('a path inside the repository resolves to it', inside.endsWith('/checkout/docs/a.md'), inside);
    const up = await refusal(() => C.resolveWorkspacePath(ws, '../x'));
    check('a path with .. is refused', up?.code === 'outside_workspace', up && { code: up.code, message: up.message });
    const roundTrip = await refusal(() => C.resolveWorkspacePath(ws, 'docs/../docs/a.md'));
    check('a .. is refused even when it would land inside', roundTrip?.code === 'outside_workspace', roundTrip && { code: roundTrip.code, message: roundTrip.message });
    const link = await refusal(() => C.resolveWorkspacePath(ws, 'escape'));
    check('a symlink out of the repository is refused', link?.code === 'outside_workspace', link && { code: link.code, message: link.message });
    const artifactPath = await C.resolveWorkspacePath(ws, `blobs/${one.evidence.sha256.slice(0, 2)}/${one.evidence.sha256}`);
    check('a path inside the artifact root resolves', artifactPath.endsWith(one.evidence.sha256), artifactPath);
  } finally {
    h.container.resolve((await import('@tandemise/persistence')).DATABASE).close?.();
    rmSync(HOME, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
console.log('ALL P3 CONTRIBUTIONS CHECKS PASSED');
process.exit(0);
