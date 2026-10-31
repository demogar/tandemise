// Intake's runners (spec 2026-10-30-intake-design.md §2, §10): the shipped
// runners, the host that drives them from the scheduler tick, and P14 moving
// onto the intake pipeline. Every source is a fake; never a real service.
//
//   npm run build && node scratch/intake-runners-check.mjs
//
// Sections grow with the plan's tasks. Task 10: "github runner", over the
// fake `gh` (scratch/fake-gh.mjs, first on PATH) with the fake YouTrack
// (scratch/fake-youtrack.mjs) as the project's tracker, plus P14's migration
// onto GitHub Issues as the tracker and the webhook mailbox's unknown source.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calls, commentsOf, installFakeGh, putIssue, readState } from './fake-gh.mjs';
import { startFakeYouTrack } from './fake-youtrack.mjs';

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const D = await import('@tandemise/domain');
const app = await import('@tandemise/application');
const I = await import('@tandemise/integrations-core');
const Y = await import('@tandemise/integration-youtrack');
const G = await import('@tandemise/integration-github');
const P = await import('@tandemise/persistence');
const A = await import('@tandemise/artifacts');
const { Container, compose } = await import('@tandemise/kernel');
const { createLogger, createPaths } = await import('@tandemise/shared');
const { policyModule } = await import('@tandemise/policy');
const { contextModule } = await import('@tandemise/context');
const { createEvaluationModule } = await import('@tandemise/evaluation');
const { runtimesCoreModule } = await import('@tandemise/runtimes-core');
const { genericRuntimeModule } = await import('@tandemise/runtime-generic');
const { executionCoreModule, CLOCK: EXEC_CLOCK, LOGGER: EXEC_LOGGER, PATHS: EXEC_PATHS } = await import('@tandemise/execution-core');
const { executionLocalModule } = await import('@tandemise/execution-local');

let t = Date.parse('2026-10-30T10:00:00.000Z');
const clock = { now: () => new Date(t).toISOString(), epochMs: () => t };
const advance = (ms) => { t += ms; };
const log = createLogger({ level: 'error', base: { component: 'intake-runners-check' } });
const memorySecrets = () => {
  const values = new Map();
  let n = 0;
  return {
    backend: 'memory',
    store: async (name, value) => { const ref = `memory:${name}:${++n}`; values.set(ref, value); return ref; },
    resolve: async (ref) => values.get(ref),
    remove: async (ref) => { values.delete(ref); },
    list: async () => [...values.keys()],
  };
};

const homes = [];
const newHome = () => { const h = mkdtempSync(join(tmpdir(), 'tdi-run-')); homes.push(h); return h; };
const GH = join(newHome(), 'gh');
const ghBin = installFakeGh(GH);
const exec = {
  run: (req) => new Promise((resolve) => {
    execFile(req.command, req.args ?? [], { cwd: req.cwd, env: { ...process.env, PATH: `${ghBin}:${process.env.PATH}`, ...(req.env ?? {}) }, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      resolve({ exitCode: err ? (typeof err.code === 'number' ? err.code : 127) : 0, stdout, stderr, timedOut: false, durationMs: 0, command: [req.command, ...(req.args ?? [])].join(' ') });
    });
  }),
};
const ghCalls = (pred) => calls(GH).filter((c) => pred(c.args)).length;
const listCalls = (repo) => ghCalls((a) => a[0] === 'issue' && a[1] === 'list' && a.includes(repo) && a.includes('--label'));
const createCalls = () => ghCalls((a) => a[0] === 'issue' && a[1] === 'create');

/** One daemon over a fresh home, with both tracker modules and the fake gh on PATH. */
async function open({ bindings } = {}) {
  const home = newHome();
  const paths = createPaths(home);
  mkdirSync(paths.root, { recursive: true });
  const container = new Container();
  compose(
    container,
    P.persistenceModule({ path: paths.db, logger: log, clock }),
    A.createArtifactsModule({ paths }),
    policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
    executionCoreModule, executionLocalModule, I.integrationsCoreModule, Y.youtrackIntegrationModule, G.githubIntegrationModule,
    app.createApplicationModule({ localPersonName: 'Demo' }),
  );
  container.bind(EXEC_CLOCK, () => clock, { source: 'check' });
  container.bind(EXEC_LOGGER, () => log, { source: 'check' });
  container.bind(EXEC_PATHS, () => paths, { source: 'check' });
  container.bind(I.CLOCK, () => clock, { source: 'check' });
  container.bind(I.LOGGER, () => log, { source: 'check' });
  container.bind(I.COMMAND_EXECUTOR, () => exec, { source: 'check' });
  container.bind(I.BACKGROUND_PROCESS_LAUNCHER, () => ({ launch: async () => { throw new Error('unused'); } }), { source: 'check' });
  const isToken = (v) => typeof v === 'object' && v !== null && typeof v.description === 'string';
  for (const name of Object.keys(app)) {
    const appToken = app[name]; const provider = P[name];
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
  container.bind(app.SECRET_STORE, () => memorySecrets(), { source: 'check' });
  container.bind(app.SETTINGS_STORE, () => app.createMemorySettingsStore(), { source: 'check' });
  container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home, schemaVersion: 1 }), { source: 'check' });
  container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });
  container.rebind(app.ISSUE_TRACKER, () => new G.GhIssueTracker(exec), { source: 'check' });
  bindings?.(container);
  const services = app.createServices(container);
  const d = {
    home, container, services,
    host: container.resolve(app.INTAKE_RUNNER_HOST),
    repo: container.resolve(app.INTAKE_REPOSITORY),
    config: container.resolve(app.INTAKE_CONFIG_SOURCE),
    resolver: container.resolve(app.TRACKER_RESOLVER),
    mailbox: container.resolve(app.WEBHOOK_MAILBOX),
    caller: { personId: services.identity.localPerson().id },
    /** Waits for the host, the pipeline, the board and P14 to finish what they started. */
    settle: async () => {
      for (let i = 0; i < 3; i++) {
        await d.host.settle();
        await services.intake.settle();
        await services.tracker.settle();
        await services.issues.settle();
      }
    },
    dispose: async () => { await d.settle(); await d.host.stopAll(); await container.dispose(); },
  };
  return d;
}

const ytTracker = (url) => ({
  kind: 'youtrack', url, project: 'GAR', board: 'project: GAR #Unresolved', onComplete: 'in_review',
  states: { ready: ['Open'], in_progress: 'In Progress', in_review: 'In Review', done: ['Fixed', 'Done'], wont_do: ["Won't fix", 'Duplicate', 'Obsolete'] },
});
const GITHUB_SOURCE = { id: 'github-acme-web', kind: 'github', instance: 'acme/web', every: '10m', closeOnDone: true, closeWontDo: false };
const WHATSAPP_SOURCE = { id: 'whatsapp-sales', kind: 'whatsapp', instance: 'sales', closeOnDone: false, closeWontDo: false };

const fake = await startFakeYouTrack({ project: 'GAR', token: 'perm:test', login: 'tandemise-bot' });
const ytCreates = () => fake.calls.filter((c) => c.method === 'POST' && c.path === '/api/issues').length;

try {
  section('github runner: the port and the registration');
  {
    check('integrations-core exports the INTAKE_RUNNERS multiToken', I.INTAKE_RUNNERS !== undefined);
    const probe = compose(new Container(), G.githubIntegrationModule);
    probe.bind(I.COMMAND_EXECUTOR, () => exec, { source: 'check' });
    const runners = I.INTAKE_RUNNERS === undefined ? [] : probe.resolveAll(I.INTAKE_RUNNERS);
    const gh = runners.find((r) => r.kind === 'github');
    check('integration-github contributes a github runner that polls', gh !== undefined && gh.mode === 'poll' && typeof gh.start === 'function' && typeof gh.close === 'function', runners.map((r) => [r.kind, r.mode]));
  }

  section('github runner: labelled issues land in the tracker once');
  let d1 = null;
  try {
    d1 = await open();
    const ws = (await d1.services.workspaces.create(d1.caller, { name: 'Runners' })).workspace.id;
    d1.config.write(ws, { tracker: ytTracker(fake.url), intake: { sources: [GITHUB_SOURCE, WHATSAPP_SOURCE], dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } } });
    await d1.resolver.saveCredential(ws, 'perm:test');
    putIssue(GH, 'acme/web', { number: 1, title: 'Checkout button does nothing', body: 'Clicking Pay is silent.', labels: ['tandemise', 'bug'], author: 'sam' });
    putIssue(GH, 'acme/web', { number: 2, title: 'Add a dark theme to settings', body: 'Night owls want it.', labels: ['tandemise'], author: 'kim' });
    putIssue(GH, 'acme/web', { number: 3, title: 'Not for Tandemise', labels: ['question'] });

    const board = await d1.host.checkNow(d1.caller, ws);
    await d1.settle();
    const s1 = d1.repo.findSignal(ws, 'github:acme/web:1');
    const s2 = d1.repo.findSignal(ws, 'github:acme/web:2');
    const refs = [s1, s2].map((s) => s && d1.repo.linkFor(s.id)?.itemRef).sort();
    check('1. checkNow creates GAR-1 and GAR-2 from the two labelled issues', ytCreates() === 2 && eq(refs, ['youtrack:GAR-1', 'youtrack:GAR-2']) && s1?.status === 'created' && s2?.status === 'created',
      { creates: ytCreates(), refs, s1: s1?.status, s2: s2?.status, reason: s1?.reason });
    check('…the unlabelled issue is not read', d1.repo.findSignal(ws, 'github:acme/web:3') === undefined);
    check('…the signal carries the issue: key, URL, reporter and the bug hint',
      s1?.key === '1' && s1?.url === 'https://github.com/acme/web/issues/1' && s1?.reporter?.handle === 'sam' && s1?.reporter?.url === 'https://github.com/sam'
      && s1?.kindHint === 'bug' && s2?.kindHint === null, s1);
    check('…checkNow answers the board, with both items ready', board?.groups?.ready?.length === 2, board);
    check("…and the source's last check is recorded", d1.repo.source(ws, 'github-acme-web')?.lastCheckedAt === clock.now() && d1.repo.source(ws, 'github-acme-web')?.lastError === null, d1.repo.source(ws, 'github-acme-web'));

    await d1.host.checkNow(d1.caller, ws);
    await d1.settle();
    check('…a second checkNow files nothing (the create count stays 2)', ytCreates() === 2, ytCreates());

    const before = listCalls('acme/web');
    d1.host.tick();
    await d1.settle();
    check('the tick does not poll before the source is due', listCalls('acme/web') === before, listCalls('acme/web') - before);
    advance(10 * 60_000);
    d1.host.tick();
    await d1.settle();
    check('…and polls once it is 10 minutes old', listCalls('acme/web') === before + 1, listCalls('acme/web') - before);

    // Close: a comment, then a close only with closeOnDone.
    const runner = d1.container.resolveAll(I.INTAKE_RUNNERS).find((r) => r.kind === 'github');
    const ctx = (source) => ({
      workspaceId: ws, source, clock, log, signal: new AbortController().signal,
      push: async () => { throw new Error('unused'); }, secrets: { get: async () => undefined }, cursor: { get: () => null, set: () => {} },
    });
    const closure = (kind, number, prUrl) => ({
      kind, signal: { fingerprint: `github:acme/web:${number}`, key: String(number), url: `https://github.com/acme/web/issues/${number}`, instance: 'acme/web', title: 't', reply: null },
      item: { key: 'GAR-1', url: `${fake.url}/issue/GAR-1` }, prUrl, commit: null,
    });
    const done = await runner.close(closure('done', 1, 'https://github.com/acme/web/pull/9'), ctx(GITHUB_SOURCE));
    const c1 = commentsOf(GH, 'acme/web', 1);
    check('close(done) comments "Fixed in <pr>; tracked as GAR-1." and returns its id',
      done.ok && c1.length === 1 && c1[0].body.endsWith('Fixed in https://github.com/acme/web/pull/9; tracked as GAR-1.') && done.externalId === String(c1[0].id), { done, c1 });
    check('…and closes the issue, since the source closes on done', readState(GH).repos['acme/web'].issues.find((i) => i.number === 1).state === 'CLOSED');
    const again = await runner.close(closure('done', 1, 'https://github.com/acme/web/pull/9'), ctx(GITHUB_SOURCE));
    check('…a second close edits the same comment instead of posting another', again.ok && commentsOf(GH, 'acme/web', 1).length === 1 && again.externalId === done.externalId, commentsOf(GH, 'acme/web', 1));
    const leftOpen = await runner.close(closure('done', 2, null), ctx({ ...GITHUB_SOURCE, closeOnDone: false }));
    const c2 = commentsOf(GH, 'acme/web', 2);
    check('without closeOnDone: "Done; tracked as GAR-1." and the issue stays open',
      leftOpen.ok && c2.length === 1 && c2[0].body.endsWith('Done; tracked as GAR-1.') && readState(GH).repos['acme/web'].issues.find((i) => i.number === 2).state === 'OPEN', c2);
    const notPlanned = await runner.close(closure('not_planned', 2, null), ctx({ ...GITHUB_SOURCE, closeOnDone: false }));
    check('not_planned without closeWontDo writes nothing', notPlanned.ok && notPlanned.externalId === null && commentsOf(GH, 'acme/web', 2).length === 1, notPlanned);

    // 5. The mailbox: a delivery for a source no runner reads is acked, with the error on the source.
    d1.mailbox.put({ sourceId: 'whatsapp-sales', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode('{"hello":1}') });
    d1.mailbox.put({ sourceId: 'nobody-knows', headers: {}, body: new TextEncoder().encode('{}') });
    d1.host.tick();
    await d1.settle();
    check('5. a webhook for a source with no runner is acked', d1.mailbox.pull(10).length === 0);
    check('…and the source error reads "No runner for this source."', d1.repo.source(ws, 'whatsapp-sales')?.lastError === 'No runner for this source.', d1.repo.source(ws, 'whatsapp-sales'));
  } catch (e) {
    check('the github runner section ran', false, String(e?.stack ?? e));
  } finally {
    await d1?.dispose();
  }

  section('github runner: the host asks for the source claim first');
  let d2 = null;
  try {
    d2 = await open({
      bindings: (c) => c.rebind(app.INTAKE_CLAIMS, () => ({ source: async () => false, item: async () => ({ ok: true }), releaseItem: async () => {} }), { source: 'check' }),
    });
    const ws = (await d2.services.workspaces.create(d2.caller, { name: 'Claimed elsewhere' })).workspace.id;
    d2.config.write(ws, { tracker: ytTracker(fake.url), intake: { sources: [{ ...GITHUB_SOURCE, id: 'github-acme-claimed', instance: 'acme/claimed' }], dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } } });
    await d2.resolver.saveCredential(ws, 'perm:test');
    putIssue(GH, 'acme/claimed', { number: 1, title: 'Someone else runs this source' });
    const before = listCalls('acme/claimed');
    await d2.host.checkNow(d2.caller, ws);
    d2.host.tick();
    await d2.settle();
    check('2. with the source claim refused, checkNow and the tick make no gh issue list call', listCalls('acme/claimed') === before, listCalls('acme/claimed') - before);
  } catch (e) {
    check('the claim section ran', false, String(e?.stack ?? e));
  } finally {
    await d2?.dispose();
  }

  section('github runner: P14 moves onto GitHub Issues as the tracker');
  let d3 = null;
  try {
    d3 = await open();
    const ws = (await d3.services.workspaces.create(d3.caller, { name: 'P14 project' })).workspace.id;
    const checkout = join(d3.home, 'checkout');
    mkdirSync(checkout, { recursive: true });
    const repositories = d3.container.resolve(app.REPO_REPOSITORY);
    const issueRepo = d3.container.resolve(app.ISSUE_REPOSITORY);
    const repository = repositories.create({ id: 'rep_api', workspaceId: ws, name: 'api', path: checkout, defaultBranch: 'main', remoteUrl: null, checks: D.NO_CHECKS });
    putIssue(GH, 'acme/api', { number: 1, title: 'Rate limit the login endpoint', author: 'sam', body: '## Done when\n- [ ] Ten tries a minute at most' });
    putIssue(GH, 'acme/api', { number: 2, title: 'Document the token API', author: 'kim' });
    d3.services.issues.configure(d3.caller, repository.id, { enabled: true, githubRepo: 'acme/api', closeOnComplete: true, pollMinutes: 15 });
    await d3.services.issues.check(repository.id);
    check('the P14 harness has two issue_links rows', issueRepo.listLinks({ repositoryId: repository.id }).length === 2);
    const offered = d3.services.issues.repositoryView(repository.id);
    check('4. offerTracker is true while P14 is on and the project has no tracker; the card is deprecated', offered.offerTracker === true && offered.deprecated === true, offered);

    const adopted = await d3.services.issues.adoptAsTracker(d3.caller, repository.id);
    const sig = (n) => d3.repo.findSignal(ws, `github:acme/api:${n}`);
    const link = (n) => sig(n) && d3.repo.linkFor(sig(n).id);
    check('3. adoptAsTracker makes intake_signals hold github:acme/api:1 and :2, both linked', sig(1)?.status === 'linked' && sig(2)?.status === 'linked', [sig(1)?.status, sig(2)?.status]);
    check('…each with a done source_is_item link to github:acme/api#<n>',
      link(1)?.status === 'done' && link(1)?.linkedBy === 'source_is_item' && link(1)?.itemRef === 'github:acme/api#1' && link(2)?.itemRef === 'github:acme/api#2', [link(1), link(2)]);
    const cfg = d3.config.read(ws);
    check('…the tracker is the repository\'s GitHub Issues, as the plan maps it',
      cfg.tracker?.kind === 'github-issues' && cfg.tracker?.repo === 'acme/api' && cfg.tracker?.board === 'is:open label:tandemise' && cfg.tracker?.onComplete === 'in_review'
      && eq(cfg.tracker?.states, { ready: ['open'], in_progress: 'status: in progress', in_review: 'status: in review', done: ['closed'], wont_do: [] }), cfg.tracker);
    const src = cfg.sources.find((s) => s.id === 'github-acme-api');
    check('…with a github source for it: instance, interval, label and close setting carried over',
      cfg.sources.length === 1 && src?.kind === 'github' && src?.instance === 'acme/api' && src?.every === '15m' && src?.closeOnDone === true && src?.trigger?.label === 'tandemise', cfg.sources);
    const settings = issueRepo.settings(repository.id);
    check('…P14 is switched off with no error', settings?.enabled === false && settings?.lastError === null, settings);
    check('4. offerTracker is false after adopting', adopted.offerTracker === false && d3.services.issues.repositoryView(repository.id).offerTracker === false, adopted);

    const creates = createCalls();
    const polled = listCalls('acme/api');
    await d3.host.checkNow(d3.caller, ws);
    await d3.settle();
    check('…a following checkNow reads the issues through the runner and runs no gh issue create',
      listCalls('acme/api') > polled && createCalls() === creates && sig(1)?.status === 'linked' && sig(2)?.status === 'linked' && sig(1)?.occurrences === 2,
      { polled: listCalls('acme/api') - polled, creates: createCalls() - creates, s1: sig(1)?.status, reason: sig(1)?.reason, occurrences: sig(1)?.occurrences });
    const lists = listCalls('acme/api');
    advance(60 * 60_000);
    d3.services.issues.tick();
    await d3.services.issues.settle();
    check("…and P14's own tick no longer lists that repository's issues", listCalls('acme/api') === lists, listCalls('acme/api') - lists);

    const signalCount = d3.repo.listSignals(ws).length;
    await d3.services.issues.adoptAsTracker(d3.caller, repository.id);
    check('adoptAsTracker twice adds no rows', d3.repo.listSignals(ws).length === signalCount && signalCount === 2 && d3.config.read(ws).sources.length === 1, { signals: d3.repo.listSignals(ws).length });

    const other = await refusal(() => d3.services.issues.adoptAsTracker(d3.caller, 'rep_missing'));
    check('adopting an unknown repository is NOT_FOUND', other?.code === 'NOT_FOUND', other?.message);
  } catch (e) {
    check('the P14 migration section ran', false, String(e?.stack ?? e));
  } finally {
    await d3?.dispose();
  }
} finally {
  await fake.close();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
