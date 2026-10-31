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
// Task 11: "sentry", "posthog" and "webhook listener", over
// scratch/fake-sentry.mjs and scratch/fake-posthog.mjs (never a real service).
// Task 12: "slack" and "discord", over scratch/fake-slack.mjs (Web API plus
// Socket Mode) and scratch/fake-discord.mjs (REST plus the gateway), both on
// `ws`; the runners themselves use Node 22's built-in WebSocket.
// Task 13: "closure", the loop closing at every source once a person sets the
// tracker item done in the fake YouTrack (ClosureService over the runners).
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calls, commentsOf, installFakeGh, putIssue, readState } from './fake-gh.mjs';
import { startFakeYouTrack } from './fake-youtrack.mjs';
import { sentrySignature, startFakeSentry } from './fake-sentry.mjs';
import { startFakePostHog } from './fake-posthog.mjs';
import { startFakeSlack } from './fake-slack.mjs';
import { startFakeDiscord } from './fake-discord.mjs';

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
// Task 11: absent until the package exists, so the check fails rather than crashes.
const R = await import('@tandemise/intake-runners').catch(() => null);
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

/** One daemon over a fresh home (or `home`, for a restart), with both tracker modules and the fake gh on PATH. */
async function open({ bindings, home: reopened } = {}) {
  const home = reopened ?? newHome();
  const paths = createPaths(home);
  mkdirSync(paths.root, { recursive: true });
  const container = new Container();
  compose(
    container,
    P.persistenceModule({ path: paths.db, logger: log, clock }),
    A.createArtifactsModule({ paths }),
    policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
    executionCoreModule, executionLocalModule, I.integrationsCoreModule, Y.youtrackIntegrationModule, G.githubIntegrationModule, ...(R === null ? [] : [R.intakeRunnersModule]),
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

  // Ruling 22: a source the brain configures is off on a machine until its
  // person switches it on there; a local one is on.
  section('sources from the brain: off on this machine until switched on');
  let dBrain = null;
  try {
    dBrain = await open();
    const ws = (await dBrain.services.workspaces.create(dBrain.caller, { name: 'Brain project' })).workspace.id;
    const source = { ...GITHUB_SOURCE, id: 'github-acme-brain', instance: 'acme/brain' };
    dBrain.config.write(ws, { tracker: ytTracker(fake.url), intake: { sources: [source], dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } } });
    await dBrain.resolver.saveCredential(ws, 'perm:test');
    // The same configuration, read as the brain's (as a project linked to a brain reads it).
    dBrain.config.originFor = () => 'brain';
    putIssue(GH, 'acme/brain', { number: 1, title: 'Configured by the team, run by whoever switches it on' });
    const before = listCalls('acme/brain');
    await dBrain.host.checkNow(dBrain.caller, ws);
    dBrain.host.tick();
    await dBrain.settle();
    check('a brain source is not polled before this machine switches it on', listCalls('acme/brain') === before, listCalls('acme/brain') - before);
    const view = dBrain.services.intake.config(ws);
    check('…and the config view says it is off here', view.enabled?.[source.id] === false, view.enabled);
    const on = await refusal(() => dBrain.services.intake.setSourceEnabled(dBrain.caller, ws, source.id, true));
    check('setSourceEnabled switches it on', on === null && dBrain.services.intake.config(ws).enabled?.[source.id] === true, on?.message ?? dBrain.services.intake.config(ws).enabled);
    await dBrain.host.checkNow(dBrain.caller, ws);
    await dBrain.settle();
    check('…then it is polled', listCalls('acme/brain') === before + 1, listCalls('acme/brain') - before);
    const unknown = await refusal(() => dBrain.services.intake.setSourceEnabled(dBrain.caller, ws, 'nope', true));
    check('switching an unknown source is NOT_FOUND', unknown?.code === 'NOT_FOUND', unknown?.message);
    dBrain.config.originFor = () => 'local';
    const local = { ...GITHUB_SOURCE, id: 'github-acme-local', instance: 'acme/local' };
    dBrain.config.write(ws, { intake: { sources: [source, local], dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } } });
    check('a local source is on by default', dBrain.services.intake.config(ws).enabled?.[local.id] === true, dBrain.services.intake.config(ws).enabled);
  } catch (e) {
    check('the brain source section ran', false, String(e?.stack ?? e));
  } finally {
    await dBrain?.dispose();
  }

  // Ruling 22: with the relay, one daemon runs a source at a time, under a
  // lease ('source', id) that lapses 2 minutes after its last renewal.
  section('source leases: two daemons, one team; the second is refused until the lease lapses');
  let leaseTeam = null;
  const leasePair = [];
  try {
    const { sharedTeam } = await import('./shared-coordination.mjs');
    leaseTeam = sharedTeam(clock);
    const source = { ...GITHUB_SOURCE, id: 'github-acme-team', instance: 'acme/team' };
    const host = async (name) => {
      const port = leaseTeam.join(name, `${name}'s laptop`);
      const d = await open({ bindings: (c) => c.bind(app.COORDINATION, () => port, { source: 'check' }) });
      leasePair.push(d);
      const ws = (await d.services.workspaces.create(d.caller, { name: `${name}'s copy` })).workspace.id;
      d.config.write(ws, { tracker: ytTracker(fake.url), intake: { sources: [source], dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } } });
      await d.resolver.saveCredential(ws, 'perm:test');
      d.container.resolve(app.SETTINGS_STORE).write({ coordination: { projectKeys: { [ws]: 'github.com/acme/brain' } } });
      return { d, ws };
    };
    const ana = await host('Ana');
    const bruno = await host('Bruno');
    putIssue(GH, 'acme/team', { number: 1, title: 'One daemon reads this source' });
    const base = listCalls('acme/team');
    await ana.d.host.checkNow(ana.d.caller, ana.ws);
    await ana.d.settle();
    check("Ana's daemon takes the source's lease and polls", listCalls('acme/team') === base + 1, listCalls('acme/team') - base);
    await bruno.d.host.checkNow(bruno.d.caller, bruno.ws);
    await bruno.d.settle();
    check("…Bruno's is refused while Ana's lease is live: no poll", listCalls('acme/team') === base + 1, listCalls('acme/team') - base);
    advance(60_000);
    await ana.d.host.checkNow(ana.d.caller, ana.ws);
    await ana.d.settle();
    check('…Ana renews it a minute later', listCalls('acme/team') === base + 2, listCalls('acme/team') - base);
    advance(90_000);
    await bruno.d.host.checkNow(bruno.d.caller, bruno.ws);
    await bruno.d.settle();
    check('…so 2.5 minutes after the first, Bruno is still refused', listCalls('acme/team') === base + 2, listCalls('acme/team') - base);
    advance(3 * 60_000);
    await bruno.d.host.checkNow(bruno.d.caller, bruno.ws);
    await bruno.d.settle();
    check('once the lease lapses (Ana stopped renewing), Bruno takes it and polls', listCalls('acme/team') === base + 3, listCalls('acme/team') - base);
    await ana.d.host.checkNow(ana.d.caller, ana.ws);
    await ana.d.settle();
    check('…and now Ana is the one refused', listCalls('acme/team') === base + 3, listCalls('acme/team') - base);
  } catch (e) {
    check('the source lease section ran', false, String(e?.stack ?? e));
  } finally {
    for (const d of leasePair) await d.dispose();
    leaseTeam?.close();
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
  // ------------------------------------------------------------------ Task 11: Sentry, PostHog and the webhook listener
  // A fresh fake YouTrack, so the items these sections file are GAR-1 and on.
  const yt2 = await startFakeYouTrack({ project: 'GAR', token: 'perm:test', login: 'tandemise-bot' });
  const sentry = await startFakeSentry({ token: 'sntrys_test', org: 'acme', project: 'web', repos: ['acme/web'] });
  const posthog = await startFakePostHog({ key: 'phx_test', project: '4242' });
  const yt2Creates = () => yt2.calls.filter((c) => c.method === 'POST' && c.path === '/api/issues').length;
  const SENTRY_SOURCE = {
    id: 'sentry-web', kind: 'sentry', instance: 'acme/web', api: sentry.url, every: '10m',
    filter: { minEvents: 20, window: '24h' }, closeOnDone: true, closeWontDo: false,
  };
  const POSTHOG_SOURCE = { id: 'posthog-app', kind: 'posthog', instance: '4242', api: posthog.url, every: '10m', closeOnDone: true, closeWontDo: false };
  const hoursAgo = (h) => new Date(t - h * 3_600_000).toISOString();
  const runnerCtx = (ws, source, secrets) => ({
    workspaceId: ws, source, clock, log, signal: new AbortController().signal,
    push: async () => { throw new Error('unused'); }, secrets: { get: async (name) => secrets[name] }, cursor: { get: () => null, set: () => {} },
  });
  let d4 = null;
  try {
    section('intake-runners: the package contributes its runners');
    check('@tandemise/intake-runners exports intakeRunnersModule', R?.intakeRunnersModule !== undefined);
    const probe = R === null ? null : compose(new Container(), R.intakeRunnersModule);
    const kinds = probe === null ? [] : probe.resolveAll(I.INTAKE_RUNNERS).map((r) => `${r.kind}:${r.mode}`).sort();
    check('…sentry and posthog polling, slack and discord on a socket (Task 12)', eq(kinds, ['discord:socket', 'posthog:poll', 'sentry:poll', 'slack:socket']), kinds);

    d4 = await open();
    const ws = (await d4.services.workspaces.create(d4.caller, { name: 'Errors' })).workspace.id;
    d4.config.write(ws, { tracker: ytTracker(yt2.url), intake: { sources: [SENTRY_SOURCE, POSTHOG_SOURCE], dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } } });
    await d4.resolver.saveCredential(ws, 'perm:test');
    const sentryRunner = d4.container.resolveAll(I.INTAKE_RUNNERS).find((r) => r.kind === 'sentry');
    const posthogRunner = d4.container.resolveAll(I.INTAKE_RUNNERS).find((r) => r.kind === 'posthog');

    section('sentry: poll');
    // A wrong token first: the source says so in the plan's words.
    await d4.services.intake.saveSourceSecret(d4.caller, ws, 'sentry-web', { name: 'token', value: 'sntrys_wrong' });
    sentry.putIssue({ id: '101', title: 'TypeError: cart is undefined', culprit: 'checkout/pay.ts in submit', metadata: { value: 'cart is undefined' }, level: 'error', count: '132', userCount: 41, firstSeen: hoursAgo(30), lastSeen: hoursAgo(1) });
    sentry.putIssue({ id: '102', title: 'Warning: slow image', culprit: 'gallery.ts', level: 'warning', count: '3', userCount: 2, firstSeen: hoursAgo(5), lastSeen: hoursAgo(1) });
    await d4.host.checkNow(d4.caller, ws);
    await d4.settle();
    check('a refused token reads "Sentry refused the token. Save a new one in Settings → Intake."',
      d4.repo.source(ws, 'sentry-web')?.lastError === 'Sentry refused the token. Save a new one in Settings → Intake.' && yt2Creates() === 0, d4.repo.source(ws, 'sentry-web'));
    const refsBefore = d4.repo.source(ws, 'sentry-web')?.secretRefs ?? {};
    await d4.services.intake.saveSourceSecret(d4.caller, ws, 'sentry-web', { name: 'token', value: 'sntrys_test' });
    const refsAfter = d4.repo.source(ws, 'sentry-web')?.secretRefs ?? {};
    const secretStore = d4.container.resolve(app.SECRET_STORE);
    check('saving the token again replaces its ref and removes the old secret',
      typeof refsAfter.token === 'string' && refsAfter.token !== refsBefore.token && !(await secretStore.list()).includes(refsBefore.token), { refsBefore, refsAfter });
    await d4.host.checkNow(d4.caller, ws);
    await d4.settle();
    const s101 = d4.repo.findSignal(ws, 'sentry:acme/web:101');
    const s102 = d4.repo.findSignal(ws, 'sentry:acme/web:102');
    const listCall = sentry.calls.find((c) => c.method === 'GET' && c.path === '/api/0/projects/acme/web/issues/' && c.authorization === 'Bearer sntrys_test');
    check('the poll asks for the unresolved issues of the last 24 h, with the token as a bearer',
      listCall?.query.get('query') === 'is:unresolved' && listCall?.query.get('statsPeriod') === '24h', listCall && { q: listCall.query.toString() });
    const created = yt2.issues.get('GAR-1');
    check('132 events, 41 users → GAR-1 created, with "132 events, 41 users" in its Sources',
      yt2Creates() === 1 && s101?.status === 'created' && d4.repo.linkFor(s101.id)?.itemRef === 'youtrack:GAR-1' && created?.description?.includes('132 events, 41 users'),
      { creates: yt2Creates(), s101: s101?.status, reason: s101?.reason, description: created?.description });
    check('…the signal maps the issue: key, permalink, title, culprit + value, impact',
      s101?.key === '101' && s101?.url === 'https://acme.sentry.io/issues/101/' && s101?.title === 'TypeError: cart is undefined'
      && s101?.description?.includes('checkout/pay.ts in submit') && s101?.description?.includes('cart is undefined')
      && eq(s101?.impact, { level: 'error', events: 132, users: 41, firstSeen: hoursAgo(30), lastSeen: hoursAgo(1) }), s101);
    check("3 events → held back: '3 events in 24 h; this source needs 20'",
      s102?.status === 'held_back' && s102?.reason === '3 events in 24 h; this source needs 20', { status: s102?.status, reason: s102?.reason });
    sentry.putIssue({ ...sentry.issues.get('102'), count: '300' });
    await d4.host.checkNow(d4.caller, ws);
    await d4.settle();
    const s102b = d4.repo.findSignal(ws, 'sentry:acme/web:102');
    check('a second poll with 300 events → created', s102b?.status === 'created' && yt2Creates() === 2, { status: s102b?.status, reason: s102b?.reason, creates: yt2Creates() });

    section('sentry: close');
    const secrets = { token: 'sntrys_test', clientSecret: 'whsec_sentry', apiKey: 'phx_test', webhookSecret: 'whsec_posthog' };
    const sentryClosure = (id, commit) => ({
      kind: 'done', signal: { fingerprint: `sentry:acme/web:${id}`, key: id, url: `https://acme.sentry.io/issues/${id}/`, instance: 'acme/web', title: 't', reply: null },
      item: { key: 'GAR-1', url: `${yt2.url}/issue/GAR-1` }, prUrl: 'https://github.com/acme/web/pull/7', commit,
    });
    const lastPut = (id) => sentry.calls.filter((c) => c.method === 'PUT' && c.path === `/api/0/issues/${id}/`).at(-1)?.body;
    const inCommit = await sentryRunner?.close(sentryClosure('101', { sha: 'abc123', repo: 'acme/web' }), runnerCtx(ws, SENTRY_SOURCE, secrets));
    check('with a commit in a repository Sentry lists → resolved inCommit abc123',
      inCommit?.ok === true && lastPut('101')?.status === 'resolved' && lastPut('101')?.statusDetails?.inCommit?.commit === 'abc123'
      && lastPut('101')?.statusDetails?.inCommit?.repository === 'acme/web' && sentry.issues.get('101').status === 'resolved', { inCommit, put: lastPut('101') });
    const unlisted = await sentryRunner?.close(sentryClosure('102', { sha: 'def456', repo: 'acme/other' }), runnerCtx(ws, SENTRY_SOURCE, secrets));
    check('with the repository not listed → inNextRelease', unlisted?.ok === true && eq(lastPut('102'), { status: 'resolved', statusDetails: { inNextRelease: true } }), { unlisted, put: lastPut('102') });
    sentry.putIssue({ id: '103', title: 'Third', count: '50' });
    const reposAsked = sentry.calls.filter((c) => c.path === '/api/0/organizations/acme/repos/').length;
    const noCommit = await sentryRunner?.close(sentryClosure('103', null), runnerCtx(ws, SENTRY_SOURCE, secrets));
    check('with commit null → inNextRelease, without asking for the repositories',
      noCommit?.ok === true && eq(lastPut('103'), { status: 'resolved', statusDetails: { inNextRelease: true } })
      && sentry.calls.filter((c) => c.path === '/api/0/organizations/acme/repos/').length === reposAsked, { noCommit, put: lastPut('103') });
    const gone = await sentryRunner?.close(sentryClosure('999', null), runnerCtx(ws, SENTRY_SOURCE, secrets));
    check('an issue Sentry no longer has fails without retry', gone?.ok === false && gone?.retryable === false, gone);

    section('sentry: webhook');
    const hook = { action: 'created', data: { issue: { id: '201', title: 'RangeError: too deep', culprit: 'tree.ts', level: 'fatal', count: '40', userCount: 9, firstSeen: hoursAgo(2), lastSeen: hoursAgo(1), web_url: 'https://acme.sentry.io/issues/201/', metadata: { value: 'Maximum call stack' } } } };
    const hookBody = new TextEncoder().encode(JSON.stringify(hook));
    const good = await sentryRunner?.fromWebhook({ headers: { 'sentry-hook-signature': sentrySignature(hookBody, 'whsec_sentry'), 'sentry-hook-resource': 'issue' }, body: hookBody }, runnerCtx(ws, SENTRY_SOURCE, secrets));
    check('a valid signature maps to one signal', good?.length === 1 && good[0].key === '201' && good[0].url === 'https://acme.sentry.io/issues/201/' && good[0].impact?.events === 40 && good[0].source.kind === 'sentry', good);
    const bad = await refusal(() => sentryRunner.fromWebhook({ headers: { 'sentry-hook-signature': sentrySignature(hookBody, 'not-the-secret') }, body: hookBody }, runnerCtx(ws, SENTRY_SOURCE, secrets)));
    check("a bad one throws \"The Sentry signature doesn't match.\"", bad?.message === "The Sentry signature doesn't match.", bad?.message);

    section('posthog');
    await d4.services.intake.saveSourceSecret(d4.caller, ws, 'posthog-app', { name: 'apiKey', value: 'phx_test' });
    const ph = posthog.putIssue({ name: 'TypeError: map is not a function', description: 'in Dashboard.tsx', occurrences: 88, users: 23, first_seen: hoursAgo(10), last_seen: hoursAgo(1) });
    await d4.host.checkNow(d4.caller, ws);
    await d4.settle();
    const sph = d4.repo.findSignal(ws, `posthog:4242:${ph.id}`);
    const phList = posthog.calls.find((c) => c.method === 'GET' && c.path === '/api/projects/4242/error_tracking/issues/');
    check('poll asks for active error-tracking issues with the key as a bearer', phList?.query.get('status') === 'active' && phList?.authorization === 'Bearer phx_test', phList && { q: phList.query.toString(), a: phList.authorization });
    check('poll → created', sph?.status === 'created' && yt2Creates() === 3, { status: sph?.status, reason: sph?.reason });
    check('…mapped: name, description, a link to the issue, impact',
      sph?.title === 'TypeError: map is not a function' && sph?.description === 'in Dashboard.tsx'
      && sph?.url === `${posthog.url.replace('http:', 'https:')}/project/4242/error_tracking/${ph.id}`
      && eq(sph?.impact, { level: 'error', events: 88, users: 23, firstSeen: hoursAgo(10), lastSeen: hoursAgo(1) }), sph);
    const phClosure = (key) => ({
      kind: 'done', signal: { fingerprint: `posthog:4242:${key}`, key, url: 'https://us.posthog.com/x', instance: '4242', title: 't', reply: null },
      item: { key: 'GAR-3', url: `${yt2.url}/issue/GAR-3` }, prUrl: null, commit: null,
    });
    const phDone = await posthogRunner?.close(phClosure(ph.id), runnerCtx(ws, POSTHOG_SOURCE, secrets));
    const patch = posthog.calls.filter((c) => c.method === 'PATCH').at(-1);
    check("close → PATCH { status: 'resolved' }", phDone?.ok === true && patch?.path === `/api/projects/4242/error_tracking/issues/${ph.id}/` && eq(patch?.body, { status: 'resolved' }) && posthog.issues.get(ph.id).status === 'resolved', { phDone, patch });
    const patches = posthog.calls.filter((c) => c.method === 'PATCH').length;
    const notIssue = await posthogRunner?.close(phClosure('insight-77'), runnerCtx(ws, POSTHOG_SOURCE, secrets));
    check('a signal that is not an error issue closes with nothing to write', notIssue?.ok === true && notIssue?.externalId === null && posthog.calls.filter((c) => c.method === 'PATCH').length === patches, notIssue);
    const phHook = new TextEncoder().encode(JSON.stringify({ issue: { id: '0b4e1f0a-1111-4222-8333-444455556666', name: 'Hooked', occurrences: 5, users: 1 } }));
    const phGood = await posthogRunner?.fromWebhook({ headers: { 'x-tandemise-secret': 'whsec_posthog' }, body: phHook }, runnerCtx(ws, POSTHOG_SOURCE, secrets));
    const phBad = await refusal(() => posthogRunner.fromWebhook({ headers: { 'x-tandemise-secret': 'nope' }, body: phHook }, runnerCtx(ws, POSTHOG_SOURCE, secrets)));
    check('a PostHog webhook with the secret maps to one signal; a wrong secret is refused',
      phGood?.length === 1 && phGood[0].key === '0b4e1f0a-1111-4222-8333-444455556666' && phBad?.message === "The PostHog secret doesn't match.", { phGood, bad: phBad?.message });

    section('webhook listener');
    const L = await import('../apps/daemon/dist/http/webhook-listener.js').catch(() => null);
    check('the daemon has startWebhookListener', typeof L?.startWebhookListener === 'function');
    await d4.services.intake.saveSourceSecret(d4.caller, ws, 'sentry-web', { name: 'clientSecret', value: 'whsec_sentry' });
    const listener = await L.startWebhookListener({ port: 0, mailbox: d4.mailbox, log });
    try {
      const base = `http://127.0.0.1:${listener.port}`;
      const delivered = { action: 'created', data: { issue: { id: '301', title: 'Webhook-borne error', culprit: 'hook.ts', level: 'error', count: '64', userCount: 12, firstSeen: hoursAgo(3), lastSeen: hoursAgo(1), web_url: 'https://acme.sentry.io/issues/301/' } } };
      const bytes = new TextEncoder().encode(JSON.stringify(delivered));
      const posted = await fetch(`${base}/hooks/sentry-web`, { method: 'POST', headers: { 'content-type': 'application/json', 'sentry-hook-signature': sentrySignature(bytes, 'whsec_sentry') }, body: bytes });
      check('POST /hooks/sentry-web → 202 {}', posted.status === 202 && (await posted.text()) === '{}', posted.status);
      const pulled = d4.mailbox.pull(10);
      check('…the mailbox holds 1 message, its body bytes intact',
        pulled.length === 1 && pulled[0].sourceId === 'sentry-web' && Buffer.from(pulled[0].body).equals(Buffer.from(bytes)) && pulled[0].headers['sentry-hook-signature'] === sentrySignature(bytes, 'whsec_sentry'),
        pulled.map((m) => ({ s: m.sourceId, n: m.body.length })));
      const health = await fetch(`${base}/v1/health`);
      check('GET /v1/health on the listener → 404 with no body', health.status === 404 && (await health.text()) === '', health.status);
      const getHook = await fetch(`${base}/hooks/sentry-web`);
      check('GET /hooks/sentry-web → 404', getHook.status === 404, getHook.status);
      const big = await fetch(`${base}/hooks/x`, { method: 'POST', body: new Uint8Array(2 * 1024 * 1024) }).catch((e) => ({ status: `error ${e?.cause?.code ?? e}` }));
      check('POST /hooks/x with 2 MiB → 413', big.status === 413, big.status);
      check('…and nothing was put for it', d4.mailbox.pull(10).length === 0);

      // The message pulled above is still claimed, as if the daemon died holding it (Ruling 17).
      advance(1_000);
      d4.host.tick();
      await d4.settle();
      const s301 = d4.repo.findSignal(ws, 'sentry:acme/web:301');
      check('IntakeRunnerHost.tick() releases the crashed claim and drains the message into a signal', s301 !== undefined && s301.impact?.events === 64, s301);
      check('…and acks it', d4.mailbox.pull(10).length === 0);
      const forged = new TextEncoder().encode(JSON.stringify({ data: { issue: { ...delivered.data.issue, id: '302' } } }));
      await fetch(`${base}/hooks/sentry-web`, { method: 'POST', headers: { 'sentry-hook-signature': 'deadbeef' }, body: forged });
      d4.host.tick();
      await d4.settle();
      check("a forged delivery files nothing, and the source says \"The Sentry signature doesn't match.\"",
        d4.repo.findSignal(ws, 'sentry:acme/web:302') === undefined && d4.repo.source(ws, 'sentry-web')?.lastError === "The Sentry signature doesn't match.", d4.repo.source(ws, 'sentry-web'));
    } finally {
      await listener.close();
    }
  } catch (e) {
    check('the sentry/posthog/listener sections ran', false, String(e?.stack ?? e));
  } finally {
    await d4?.dispose();
    await yt2.close();
    await sentry.close();
    await posthog.close();
  }

  // ------------------------------------------------------------------ Task 12: Slack and Discord
  // A fresh fake YouTrack again, so these sections file GAR-1 and on. The
  // sockets run on real timers (the runner's backoff is wall-clock); the
  // daemon's clock stays the check's.
  const until = async (cond, ms = 3_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return Boolean(await cond());
  };
  const yt3 = await startFakeYouTrack({ project: 'GAR', token: 'perm:test', login: 'tandemise-bot' });
  const slack = await startFakeSlack({ workspace: 'acme' });
  const discord = await startFakeDiscord({ token: 'bot-test', heartbeatMs: 100 });
  const sentry3 = await startFakeSentry({ token: 'sntrys_test', org: 'acme', project: 'web' });
  const yt3Creates = () => yt3.calls.filter((c) => c.method === 'POST' && c.path === '/api/issues').length;
  const DISCORD_CHANNEL = '900000000000000010';
  const SLACK_SOURCE = { id: 'slack-support', kind: 'slack', instance: 'acme.slack.com#support', api: slack.url, closeOnDone: true, closeWontDo: false };
  const SENTRY3_SOURCE = { id: 'sentry-web', kind: 'sentry', instance: 'acme/web', api: sentry3.url, every: '10m', closeOnDone: true, closeWontDo: false };
  const DISCORD_SOURCE = { id: 'discord-help', kind: 'discord', instance: `${discord.guildId}#${DISCORD_CHANNEL}`, api: discord.url, closeOnDone: true, closeWontDo: false };
  const chatSecrets = { appToken: 'xapp-test', botToken: 'xoxb-test' };
  const slackFp = (ts) => `slack:acme.slack.com#support:C0SUPPORT:${ts}`;
  const discordFp = (id) => `discord:${DISCORD_SOURCE.instance}:${DISCORD_CHANNEL}:${id}`;
  const slackCalls = (method) => slack.calls.filter((c) => c.path === `/${method}`);
  let d5 = null;
  try {
    section('slack: a reaction files the thread');
    d5 = await open();
    const ws = (await d5.services.workspaces.create(d5.caller, { name: 'Chat' })).workspace.id;
    d5.config.write(ws, { tracker: ytTracker(yt3.url), intake: { sources: [SLACK_SOURCE, SENTRY3_SOURCE, DISCORD_SOURCE], dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } } });
    await d5.resolver.saveCredential(ws, 'perm:test');
    for (const [name, value] of Object.entries(chatSecrets)) await d5.services.intake.saveSourceSecret(d5.caller, ws, 'slack-support', { name, value });
    await d5.services.intake.saveSourceSecret(d5.caller, ws, 'discord-help', { name: 'botToken', value: 'bot-test' });
    await d5.services.intake.saveSourceSecret(d5.caller, ws, 'sentry-web', { name: 'token', value: 'sntrys_test' });
    d5.host.tick();
    await d5.settle();
    check('the tick starts the slack runner: apps.connections.open with the app token, then one socket',
      await until(() => slack.open === 1) && slackCalls('apps.connections.open')[0]?.authorization === 'Bearer xapp-test', { open: slack.open, calls: slackCalls('apps.connections.open').length });

    const root = slack.postMessage({ channel: 'C0SUPPORT', user: 'U0SAM', text: 'Checkout button does nothing on Safari\nTried twice; the spinner never stops.' });
    const reply = slack.postMessage({ channel: 'C0SUPPORT', user: 'U0KIM', text: 'Same here on an iPad.', thread_ts: root.ts });
    // The reaction lands on a reply: the runner still files the whole thread, keyed by its root.
    const env1 = slack.emit({ type: 'reaction_added', user: 'U0KIM', reaction: 'tandemise', item_user: 'U0KIM', item: { type: 'message', channel: 'C0SUPPORT', ts: reply.ts }, event_ts: reply.ts });
    await until(() => d5.repo.findSignal(ws, slackFp(root.ts))?.status === 'created');
    await d5.settle();
    const s1 = d5.repo.findSignal(ws, slackFp(root.ts));
    check('reaction_added :tandemise: → GAR-1 created', yt3Creates() === 1 && s1?.status === 'created' && d5.repo.linkFor(s1.id)?.itemRef === 'youtrack:GAR-1',
      { creates: yt3Creates(), status: s1?.status, reason: s1?.reason });
    check('…the envelope was acked', slack.acks.includes(env1), { env1, acks: slack.acks });
    const eyes = slackCalls('reactions.add').find((c) => c.body?.name === 'eyes');
    check('…and the fake recorded reactions.add eyes on the thread, with the bot token',
      eyes?.body?.channel === 'C0SUPPORT' && eyes?.body?.timestamp === root.ts && eyes?.authorization === 'Bearer xoxb-test', eyes);
    check('…the signal: key <channel>:<thread_ts>, the permalink, the first line as title, the thread as description, the thread as reply address',
      s1?.key === `C0SUPPORT:${root.ts}` && s1?.url === slack.permalink('C0SUPPORT', root.ts) && s1?.title === 'Checkout button does nothing on Safari'
      && s1?.description === `**U0SAM:** Checkout button does nothing on Safari\nTried twice; the spinner never stops.\n**U0KIM:** Same here on an iPad.`
      && s1?.reply?.address === `C0SUPPORT:${root.ts}`, s1);
    check('…read through conversations.replies of the thread root', slackCalls('conversations.replies').some((c) => c.query.get('ts') === root.ts && c.query.get('channel') === 'C0SUPPORT'));

    section('slack: everything else is ignored');
    const signalsBefore = d5.repo.listSignals(ws).length;
    const chatter = slack.postMessage({ channel: 'C0SUPPORT', user: 'U0SAM', text: 'Lunch anyone?' });
    const ignored = [
      slack.emit({ type: 'message', channel: 'C0SUPPORT', user: 'U0SAM', text: chatter.text, ts: chatter.ts }),
      slack.emit({ type: 'reaction_added', user: 'U0SAM', reaction: 'thumbsup', item: { type: 'message', channel: 'C0SUPPORT', ts: chatter.ts } }),
    ];
    const elsewhere = slack.postMessage({ channel: 'C0RANDOM', user: 'U0SAM', text: 'Printer is jammed' });
    ignored.push(slack.emit({ type: 'reaction_added', user: 'U0SAM', reaction: 'tandemise', item: { type: 'message', channel: 'C0RANDOM', ts: elsewhere.ts } }));
    await until(() => ignored.every((e) => slack.acks.includes(e)));
    await new Promise((r) => setTimeout(r, 150));
    await d5.settle();
    check('an ordinary message, another emoji, and a reaction in another channel create nothing (each still acked)',
      yt3Creates() === 1 && d5.repo.listSignals(ws).length === signalsBefore && ignored.every((e) => slack.acks.includes(e)), { creates: yt3Creates(), signals: d5.repo.listSignals(ws).length });

    section('slack: the same title as an existing Sentry item is linked (I3, the engine half)');
    sentry3.putIssue({ id: '501', title: 'Login page spins forever', culprit: 'login.ts', level: 'error', count: '80', userCount: 12, firstSeen: hoursAgo(5), lastSeen: hoursAgo(1) });
    await d5.host.checkNow(d5.caller, ws);
    await d5.settle();
    check('the Sentry issue is GAR-2', yt3Creates() === 2 && d5.repo.linkFor(d5.repo.findSignal(ws, 'sentry:acme/web:501')?.id)?.itemRef === 'youtrack:GAR-2', yt3Creates());
    // Through a mention this time: the app is named in the thread's root.
    const root2 = slack.postMessage({ channel: 'C0SUPPORT', user: 'U0SAM', text: '<@U0BOT> Login page spins forever' });
    slack.emit({ type: 'app_mention', user: 'U0SAM', text: root2.text, ts: root2.ts, channel: 'C0SUPPORT', event_ts: root2.ts });
    await until(() => d5.repo.findSignal(ws, slackFp(root2.ts))?.status === 'linked');
    await d5.settle();
    const s2 = d5.repo.findSignal(ws, slackFp(root2.ts));
    const l2 = s2 && d5.repo.linkFor(s2.id);
    check('app_mention → linked to GAR-2 with similarity 1, no new item',
      s2?.status === 'linked' && l2?.itemRef === 'youtrack:GAR-2' && l2?.score === 1 && yt3Creates() === 2 && s2?.title === 'Login page spins forever', { status: s2?.status, reason: s2?.reason, link: l2, creates: yt3Creates() });
    const sources2 = (yt3.comments.get('GAR-2') ?? []).find((c) => c.text.startsWith('<!-- tandemise:sources -->'));
    check("…and GAR-2's sources comment lists the Slack permalink", sources2?.text.includes(slack.permalink('C0SUPPORT', root2.ts)), yt3.comments.get('GAR-2'));

    section('slack: closing twice, across a restart, replies once (Review Focus 5)');
    const slackRunner = d5.container.resolveAll(I.INTAKE_RUNNERS).find((r) => r.kind === 'slack');
    const slackClosure = (s, key, prUrl) => ({
      kind: 'done', signal: { fingerprint: s.fingerprint, key: s.key, url: s.url, instance: s.instance, title: s.title, reply: s.reply },
      item: { key, url: `${yt3.url}/issue/${key}` }, prUrl, commit: null,
    });
    const c1 = await slackRunner?.close(slackClosure(s1, 'GAR-1', 'https://github.com/acme/web/pull/7'), runnerCtx(ws, SLACK_SOURCE, chatSecrets));
    // A restart: a new runner instance, nothing in memory, the same Slack.
    const c2 = await new R.SlackRunner().close(slackClosure(s1, 'GAR-1', 'https://github.com/acme/web/pull/7'), runnerCtx(ws, SLACK_SOURCE, chatSecrets));
    const posts = slackCalls('chat.postMessage');
    check("exactly one chat.postMessage: 'Done: Checkout button does nothing on Safari · GAR-1 · https://github.com/acme/web/pull/7'",
      posts.length === 1 && posts[0].body?.text === 'Done: Checkout button does nothing on Safari · GAR-1 · https://github.com/acme/web/pull/7'
      && posts[0].body?.thread_ts === root.ts && posts[0].body?.channel === 'C0SUPPORT', posts.map((p) => p.body));
    check('…both closes succeed and name the same reply', c1?.ok === true && c2?.ok === true && c1.externalId !== null && c1.externalId === c2.externalId, { c1, c2 });
    check('…the bot user came from auth.test', slackCalls('auth.test').length >= 1);
    check('…and the reaction is swapped: eyes off, white_check_mark on',
      eq([...(slack.reactions.get(`C0SUPPORT:${root.ts}`) ?? [])], ['white_check_mark']), [...(slack.reactions.get(`C0SUPPORT:${root.ts}`) ?? [])]);
    const c3 = await slackRunner?.close(slackClosure(s2, 'GAR-2', null), runnerCtx(ws, SLACK_SOURCE, chatSecrets));
    check("without a pull request: 'Done: Login page spins forever · GAR-2'", c3?.ok === true && slackCalls('chat.postMessage').at(-1)?.body?.text === 'Done: Login page spins forever · GAR-2', slackCalls('chat.postMessage').at(-1)?.body);
    const wontDo = await slackRunner?.close({ ...slackClosure(s2, 'GAR-2', null), kind: 'not_planned' }, runnerCtx(ws, SLACK_SOURCE, chatSecrets));
    check('not_planned without closeWontDo writes nothing', wontDo?.ok === true && wontDo.externalId === null && slackCalls('chat.postMessage').length === 2, wontDo);
    const badToken = await slackRunner?.close(slackClosure(s1, 'GAR-1', null), runnerCtx(ws, SLACK_SOURCE, { botToken: 'xoxb-wrong' }));
    check('a refused bot token fails in the plan\'s words, without retry',
      badToken?.ok === false && badToken.retryable === false && badToken.error === 'Slack refused the token. Save a new one in Settings → Intake.', badToken);

    section('slack: the socket drops and comes back');
    const openedBefore = slack.opened;
    const dropAt = Date.now();
    slack.dropSockets();
    const back = await until(() => slack.opened > openedBefore && slack.open === 1, 2_500);
    const tookMs = Date.now() - dropAt;
    check('the runner reconnects within 2 s', back && tookMs < 2_000, { back, tookMs });
    const root3 = slack.postMessage({ channel: 'C0SUPPORT', user: 'U0SAM', text: 'Search ignores quoted phrases' });
    slack.emit({ type: 'reaction_added', user: 'U0SAM', reaction: 'tandemise', item: { type: 'message', channel: 'C0SUPPORT', ts: root3.ts } });
    await until(() => d5.repo.findSignal(ws, slackFp(root3.ts))?.status === 'created');
    await d5.settle();
    check('…and a later reaction still arrives', d5.repo.findSignal(ws, slackFp(root3.ts))?.status === 'created' && yt3Creates() === 3, { status: d5.repo.findSignal(ws, slackFp(root3.ts))?.status, creates: yt3Creates() });

    section('discord');
    await until(() => discord.sessions === 1);
    const identify = discord.frames.find((f) => f.op === 2);
    check('GET /gateway/bot with the bot token, then the gateway with v=10&encoding=json',
      discord.calls.some((c) => c.path === '/gateway/bot' && c.authorization === 'Bot bot-test') && identify?.query === 'v=10&encoding=json', { identify, calls: discord.calls.map((c) => c.path) });
    check('Identify carries intents 34304 and the token', identify?.d?.intents === 34304 && identify?.d?.token === 'bot-test', identify?.d && { intents: identify.d.intents });
    check('the heartbeat is sent', await until(() => discord.frames.some((f) => f.op === 1), 1_500));
    const dmsg = discord.postMessage({ channel_id: DISCORD_CHANNEL, content: 'Uploads over 10 MB fail\nThe bar stops at 99%.', author: { id: '900000000000000042', username: 'sam' } });
    discord.emit('MESSAGE_REACTION_ADD', { user_id: '900000000000000043', channel_id: DISCORD_CHANNEL, message_id: dmsg.id, guild_id: discord.guildId, emoji: { id: null, name: 'thumbsup' } });
    discord.emit('MESSAGE_REACTION_ADD', { user_id: '900000000000000043', channel_id: DISCORD_CHANNEL, message_id: dmsg.id, guild_id: discord.guildId, emoji: { id: '1', name: 'tandemise' } });
    await until(() => d5.repo.findSignal(ws, discordFp(dmsg.id))?.status === 'created');
    await d5.settle();
    const sd = d5.repo.findSignal(ws, discordFp(dmsg.id));
    const dItem = sd && d5.repo.linkFor(sd.id)?.itemRef;
    check('the :tandemise: reaction creates an item (another emoji does not)', sd?.status === 'created' && dItem === 'youtrack:GAR-4' && yt3Creates() === 4, { status: sd?.status, reason: sd?.reason, dItem, creates: yt3Creates() });
    check('…the signal: key <channel>:<message>, the message link, the first line as title, the message as reply address',
      sd?.key === `${DISCORD_CHANNEL}:${dmsg.id}` && sd?.url === `https://discord.com/channels/${discord.guildId}/${DISCORD_CHANNEL}/${dmsg.id}`
      && sd?.title === 'Uploads over 10 MB fail' && sd?.description?.includes('**sam:** Uploads over 10 MB fail') && sd?.reply?.address === `${DISCORD_CHANNEL}:${dmsg.id}`, sd);
    check('…and is acknowledged with 👀', discord.reactions.get(`${DISCORD_CHANNEL}:${dmsg.id}`)?.has('👀') === true);
    const plain = discord.postMessage({ channel_id: DISCORD_CHANNEL, content: 'Anyone around?' });
    discord.emit('MESSAGE_CREATE', { ...plain });
    const mention = discord.postMessage({ channel_id: DISCORD_CHANNEL, content: `<@${discord.bot.id}> Dark mode resets on reload`, mentions: [discord.bot] });
    discord.emit('MESSAGE_CREATE', { ...mention });
    await until(() => d5.repo.findSignal(ws, discordFp(mention.id))?.status === 'created');
    await d5.settle();
    check('a message mentioning the bot creates an item; one that does not, nothing',
      d5.repo.findSignal(ws, discordFp(mention.id))?.status === 'created' && d5.repo.findSignal(ws, discordFp(mention.id))?.title === 'Dark mode resets on reload'
      && d5.repo.findSignal(ws, discordFp(plain.id)) === undefined && yt3Creates() === 5, { creates: yt3Creates() });

    const discordRunner = d5.container.resolveAll(I.INTAKE_RUNNERS).find((r) => r.kind === 'discord');
    const discordClosure = { kind: 'done', signal: { fingerprint: sd.fingerprint, key: sd.key, url: sd.url, instance: sd.instance, title: sd.title, reply: sd.reply }, item: { key: 'GAR-4', url: `${yt3.url}/issue/GAR-4` }, prUrl: 'https://github.com/acme/web/pull/8', commit: null };
    const dc1 = await discordRunner?.close(discordClosure, runnerCtx(ws, DISCORD_SOURCE, { botToken: 'bot-test' }));
    const dc2 = await new R.DiscordRunner().close(discordClosure, runnerCtx(ws, DISCORD_SOURCE, { botToken: 'bot-test' }));
    const dposts = discord.calls.filter((c) => c.method === 'POST' && c.path === `/channels/${DISCORD_CHANNEL}/messages`);
    check('closing twice (a new runner the second time) yields one reply, with message_reference.message_id set',
      dposts.length === 1 && dposts[0].body?.message_reference?.message_id === dmsg.id
      && dposts[0].body?.content === 'Done: Uploads over 10 MB fail · GAR-4 · https://github.com/acme/web/pull/8', dposts.map((p) => p.body));
    check('…both closes succeed and name the same reply', dc1?.ok === true && dc2?.ok === true && dc1.externalId !== null && dc1.externalId === dc2.externalId, { dc1, dc2 });

    section('slack and discord: stopping closes the sockets');
    await d5.host.stopAll();
    check('stopAll closes both sockets', await until(() => slack.open === 0 && discord.sessions === 0), { slack: slack.open, discord: discord.sessions });
  } catch (e) {
    check('the slack/discord sections ran', false, String(e?.stack ?? e));
  } finally {
    await d5?.dispose();
    await yt3.close();
    await slack.close();
    await discord.close();
    await sentry3.close();
  }

  // ------------------------------------------------------------------ Task 13: closing the loop
  // A person sets the item done in the fake YouTrack; the board refresh writes
  // the closures and `closures.tick()` hands each to its source's runner.
  // Signals arrive through the pipeline directly (as a runner pushes them), so
  // no socket or poll runs here.
  const yt4 = await startFakeYouTrack({ project: 'GAR', token: 'perm:test', login: 'tandemise-bot' });
  const slack4 = await startFakeSlack({ workspace: 'acme' });
  const sentry4 = await startFakeSentry({ token: 'sntrys_test', org: 'acme', project: 'web', repos: ['acme/web'] });
  const C_SLACK = { id: 'slack-support', kind: 'slack', instance: 'acme.slack.com#support', api: slack4.url, closeOnDone: true, closeWontDo: false };
  const C_SENTRY = { id: 'sentry-web', kind: 'sentry', instance: 'acme/web', api: sentry4.url, every: '60m', closeOnDone: true, closeWontDo: false };
  const C_GITHUB = { id: 'github-acme-shop', kind: 'github', instance: 'acme/shop', every: '60m', closeOnDone: false, closeWontDo: false };
  const closureSources = (over = {}) => [C_SLACK, C_SENTRY, { ...C_GITHUB, ...over }];
  // One settings store and one secret store for both lives of the daemon, as the disk would keep them.
  const sharedSettings = app.createMemorySettingsStore();
  const sharedSecrets = memorySecrets();
  const shared = (c) => {
    c.rebind(app.SETTINGS_STORE, () => sharedSettings, { source: 'check' });
    c.rebind(app.SECRET_STORE, () => sharedSecrets, { source: 'check' });
  };
  let d6 = null;
  try {
    section('closure: a person sets GAR-1 Fixed; Sentry and Slack close (plan Task 13, 1)');
    d6 = await open({ bindings: shared });
    const home6 = d6.home;
    const ws = (await d6.services.workspaces.create(d6.caller, { name: 'Closing' })).workspace.id;
    d6.config.write(ws, { tracker: ytTracker(yt4.url), intake: { sources: closureSources(), dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } } });
    await d6.resolver.saveCredential(ws, 'perm:test');
    await d6.services.intake.saveSourceSecret(d6.caller, ws, 'sentry-web', { name: 'token', value: 'sntrys_test' });
    await d6.services.intake.saveSourceSecret(d6.caller, ws, 'slack-support', { name: 'botToken', value: 'xoxb-test' });
    const closures = d6.services.closures;
    check('services.closures is the ClosureService', typeof closures?.tick === 'function' && typeof closures?.detect === 'function');
    const push = async (d, sourceId, signal) => {
      await d.services.intake.ingest({ workspaceId: ws, sourceId, tokenId: null }, { schema: 'tandemise.intake/v1', ...signal }, { fromRunner: true });
      await d.settle();
    };
    const sentrySignal = (id, title) => ({ source: { kind: 'sentry', instance: 'acme/web' }, key: id, url: `https://acme.sentry.io/issues/${id}/`, title, impact: { level: 'error', events: 50 } });
    const slackSignal = (ts, title) => ({ source: { kind: 'slack', instance: 'acme.slack.com#support' }, key: `C0SUPPORT:${ts}`, url: slack4.permalink('C0SUPPORT', ts), title, reply: { address: `C0SUPPORT:${ts}` } });
    const ghSignal = (n, title) => ({ source: { kind: 'github', instance: 'acme/shop' }, key: String(n), url: `https://github.com/acme/shop/issues/${n}`, title });
    const closureOf = (d, sourceId, fp) => {
      const s = d.repo.findSignal(ws, fp);
      return s === undefined ? undefined : d.repo.closures.listForSource(ws, sourceId).find((c) => c.signalId === s.id);
    };
    const keyOf = (d, fp) => d.repo.linkFor(d.repo.findSignal(ws, fp)?.id)?.itemRef?.replace('youtrack:', '');
    const tickClosures = async (d) => { d.services.closures?.tick(); await d.services.closures?.settle(); };
    const refreshAndClose = async (d) => {
      await d.services.tracker.refreshBoard(ws);
      await tickClosures(d);
      await d.settle();
    };
    const threadReplies = (ts) => slack4.calls.filter((c) => c.path === '/chat.postMessage' && c.body?.thread_ts === ts);
    const sentryPuts = (id) => sentry4.calls.filter((c) => c.method === 'PUT' && c.path === `/api/0/issues/${id}/`);

    sentry4.putIssue({ id: '101', title: 'TypeError: cart is undefined', count: '50' });
    await push(d6, 'sentry-web', sentrySignal('101', 'TypeError: cart is undefined'));
    const root1 = slack4.postMessage({ channel: 'C0SUPPORT', user: 'U0SAM', text: 'TypeError: cart is undefined' });
    await push(d6, 'slack-support', slackSignal(root1.ts, 'TypeError: cart is undefined'));
    const sSentry = d6.repo.findSignal(ws, 'sentry:acme/web:101');
    const sSlack = d6.repo.findSignal(ws, `slack:acme.slack.com#support:C0SUPPORT:${root1.ts}`);
    check('the Sentry signal created GAR-1 and the Slack thread linked to it',
      d6.repo.linkFor(sSentry?.id)?.itemRef === 'youtrack:GAR-1' && d6.repo.linkFor(sSlack?.id)?.itemRef === 'youtrack:GAR-1',
      { sentry: sSentry?.status, slack: sSlack?.status, reason: sSlack?.reason });
    // A started mission in a repository whose remote is acme/web, with a commit and a pull request.
    await d6.services.tracker.refreshBoard(ws);
    const gar1 = d6.container.resolve(app.TRACKER_ITEM_REPOSITORY).byKey(ws, 'GAR-1');
    const checkout = join(home6, 'web');
    mkdirSync(checkout, { recursive: true });
    d6.container.resolve(app.REPO_REPOSITORY).create({ id: 'rep_web', workspaceId: ws, name: 'web', path: checkout, defaultBranch: 'main', remoteUrl: 'https://github.com/acme/web.git', checks: D.NO_CHECKS });
    const mission = await d6.services.missions.create(d6.caller, { workspaceId: ws, repositoryId: 'rep_web', title: 'Fix the cart', goal: 'Fix the cart on checkout' }, { trackerItemId: gar1.id });
    d6.container.resolve(app.ARTIFACT_REPOSITORY).create({
      id: 'art_close_1', workspaceId: ws, missionId: mission.id, taskId: null, createdByRunId: null, type: 'ChangeSet', title: 'The fix',
      contentRef: 'artifacts/close-1.md', mediaType: 'text/markdown', sha256: 'c'.repeat(64), byteSize: 1, schemaVersion: 1,
      sourceRefs: [{ kind: 'git.commit', value: 'abc123' }, { kind: 'github.pr', value: 'https://github.com/acme/web/pull/7' }],
      supersedes: null, summary: 'The fix', createdAt: clock.now(),
    });
    yt4.setState('GAR-1', 'Fixed');
    await d6.services.tracker.refreshBoard(ws);
    check('the refresh writes a pending closure per linked signal, and both signals read closure_pending',
      closureOf(d6, 'sentry-web', sSentry?.fingerprint)?.state === 'pending' && closureOf(d6, 'slack-support', sSlack?.fingerprint)?.state === 'pending'
      && d6.repo.getSignal(sSentry?.id)?.status === 'closure_pending' && d6.repo.getSignal(sSlack?.id)?.status === 'closure_pending',
      { sentry: closureOf(d6, 'sentry-web', sSentry?.fingerprint), slack: d6.repo.getSignal(sSlack?.id)?.status });
    await tickClosures(d6);
    const put101 = sentryPuts('101').at(-1)?.body;
    check('Sentry 101 resolved inCommit abc123 (the newest git.commit of the mission, the repo from its remote)',
      put101?.status === 'resolved' && put101?.statusDetails?.inCommit?.commit === 'abc123' && put101?.statusDetails?.inCommit?.repository === 'acme/web', put101);
    check("Slack got one reply: 'Done: TypeError: cart is undefined · GAR-1 · https://github.com/acme/web/pull/7'",
      threadReplies(root1.ts).length === 1 && threadReplies(root1.ts)[0].body?.text === 'Done: TypeError: cart is undefined · GAR-1 · https://github.com/acme/web/pull/7',
      threadReplies(root1.ts).map((c) => c.body));
    const cSentry = closureOf(d6, 'sentry-web', sSentry?.fingerprint);
    const cSlack = closureOf(d6, 'slack-support', sSlack?.fingerprint);
    check('both signals are closed; the closures carry the external id and closed_at',
      d6.repo.getSignal(sSentry?.id)?.status === 'closed' && d6.repo.getSignal(sSlack?.id)?.status === 'closed'
      && cSentry?.state === 'closed' && cSentry?.externalId === '101' && cSentry?.closedAt === clock.now()
      && cSlack?.state === 'closed' && typeof cSlack?.externalId === 'string',
      { cSentry, cSlack, statuses: [d6.repo.getSignal(sSentry?.id)?.status, d6.repo.getSignal(sSlack?.id)?.status] });
    await refreshAndClose(d6);
    check('a second refresh and tick write nothing more', threadReplies(root1.ts).length === 1 && sentryPuts('101').length === 1);

    section('closure: GitHub closes only with closeOnDone (plan Task 13, 2)');
    putIssue(GH, 'acme/shop', { number: 5, title: 'Coupon field rejects lowercase codes', author: 'sam' });
    putIssue(GH, 'acme/shop', { number: 6, title: 'Wishlist forgets sizes', author: 'kim' });
    const ghCloses = (n) => ghCalls((a) => a[0] === 'issue' && a[1] === 'close' && a.includes('acme/shop') && a.includes(String(n)));
    await push(d6, 'github-acme-shop', ghSignal(5, 'Coupon field rejects lowercase codes'));
    const key5 = keyOf(d6, 'github:acme/shop:5');
    yt4.setState(key5, 'Fixed');
    await refreshAndClose(d6);
    const comments5 = commentsOf(GH, 'acme/shop', 5);
    check('closeOnDone false: one comment ("Done; tracked as <key>."), no gh issue close',
      comments5.length === 1 && comments5[0].body.includes(`Done; tracked as ${key5}.`) && ghCloses(5) === 0
      && d6.repo.findSignal(ws, 'github:acme/shop:5')?.status === 'closed', { key5, comments5, closes: ghCloses(5) });
    d6.config.write(ws, { intake: { sources: closureSources({ closeOnDone: true }), dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } } });
    await push(d6, 'github-acme-shop', ghSignal(6, 'Wishlist forgets sizes'));
    const key6 = keyOf(d6, 'github:acme/shop:6');
    yt4.setState(key6, 'Done');
    await refreshAndClose(d6);
    const comments6 = commentsOf(GH, 'acme/shop', 6);
    check('closeOnDone true: the comment, then gh issue close', comments6.length === 1 && comments6[0].body.includes(`Done; tracked as ${key6}.`) && ghCloses(6) === 1
      && d6.repo.findSignal(ws, 'github:acme/shop:6')?.status === 'closed', { key6, comments6, closes: ghCloses(6) });

    section("closure: Won't fix without closeWontDo writes nothing (plan Task 13, 3)");
    sentry4.putIssue({ id: '102', title: 'Image upload stalls at 99%', count: '50' });
    await push(d6, 'sentry-web', sentrySignal('102', 'Image upload stalls at 99%'));
    const s102 = d6.repo.findSignal(ws, 'sentry:acme/web:102');
    yt4.setState(keyOf(d6, 'sentry:acme/web:102'), "Won't fix");
    await refreshAndClose(d6);
    check('no closure row, the signal keeps its status, Sentry is not asked',
      closureOf(d6, 'sentry-web', 'sentry:acme/web:102') === undefined && d6.repo.getSignal(s102?.id)?.status === 'created' && sentryPuts('102').length === 0,
      { closure: closureOf(d6, 'sentry-web', 'sentry:acme/web:102'), status: d6.repo.getSignal(s102?.id)?.status });

    section('closure: Sentry answers 500; backoff, then closure_failed, then retry (plan Task 13, 4)');
    sentry4.putIssue({ id: '103', title: 'Search ignores quoted phrases', count: '50' });
    await push(d6, 'sentry-web', sentrySignal('103', 'Search ignores quoted phrases'));
    const s103 = d6.repo.findSignal(ws, 'sentry:acme/web:103');
    yt4.setState(keyOf(d6, 'sentry:acme/web:103'), 'Fixed');
    sentry4.failPuts(500);
    const at0 = t;
    await refreshAndClose(d6);
    const c1 = closureOf(d6, 'sentry-web', 'sentry:acme/web:103');
    check('attempt 1 fails: still pending, next attempt at +60 s', c1?.state === 'pending' && c1?.attempts === 1 && c1?.nextAttemptAt === new Date(at0 + 60_000).toISOString(), c1);
    await tickClosures(d6);
    check('…and it is not tried again before then', closureOf(d6, 'sentry-web', 'sentry:acme/web:103')?.attempts === 1);
    advance(60_000);
    const at1 = t;
    await tickClosures(d6);
    const c2 = closureOf(d6, 'sentry-web', 'sentry:acme/web:103');
    check('attempt 2 fails: next attempt at +120 s', c2?.state === 'pending' && c2?.attempts === 2 && c2?.nextAttemptAt === new Date(at1 + 120_000).toISOString(), c2);
    for (let i = 3; i <= 8; i++) {
      advance(3_600_000);
      await tickClosures(d6);
    }
    const c8 = closureOf(d6, 'sentry-web', 'sentry:acme/web:103');
    const f103 = d6.repo.getSignal(s103?.id);
    check("after 8 attempts: failed in Sentry's words, and the signal is closure_failed \"Couldn't close at Sentry: …\"",
      c8?.state === 'failed' && c8?.attempts === 8 && c8?.lastError === 'Sentry answered 500 to PUT /api/0/issues/103/.'
      && f103?.status === 'closure_failed' && f103?.reason === "Couldn't close at Sentry: Sentry answered 500 to PUT /api/0/issues/103/.", { c8, status: f103?.status, reason: f103?.reason });
    advance(3_600_000);
    await tickClosures(d6);
    check('…and a failed closure is not tried again on its own', closureOf(d6, 'sentry-web', 'sentry:acme/web:103')?.attempts === 8 && sentryPuts('103').length === 8);
    const retried = await refusal(async () => { const v = await closures?.retry(d6.caller, c8?.id); if (v?.state !== 'pending') throw new Error(JSON.stringify(v)); });
    const r103 = closureOf(d6, 'sentry-web', 'sentry:acme/web:103');
    check('retry makes it pending again: attempts reset, the signal closure_pending',
      retried === null && r103?.state === 'pending' && r103?.attempts === 0 && r103?.lastError === null && d6.repo.getSignal(s103?.id)?.status === 'closure_pending', { retried: String(retried), r103 });
    sentry4.failPuts(null);
    await tickClosures(d6);
    check('…and with Sentry back, the next tick closes it', closureOf(d6, 'sentry-web', 'sentry:acme/web:103')?.state === 'closed' && d6.repo.getSignal(s103?.id)?.status === 'closed');
    const closedAgain = await refusal(() => closures?.retry(d6.caller, c8?.id));
    check('retrying a closed closure is refused', closedAgain?.code === 'PRECONDITION_FAILED', closedAgain?.message);

    section('closure: a restart between postMessage and storing the result, still one Slack reply (plan Task 13, 5)');
    const root2 = slack4.postMessage({ channel: 'C0SUPPORT', user: 'U0KIM', text: 'Dark mode flickers on login' });
    await push(d6, 'slack-support', slackSignal(root2.ts, 'Dark mode flickers on login'));
    const s2fp = `slack:acme.slack.com#support:C0SUPPORT:${root2.ts}`;
    yt4.setState(keyOf(d6, s2fp), 'Fixed');
    // The process dies once Slack has the reply and before the closure is stored as closed.
    const update = d6.repo.closures.update;
    d6.repo.closures.update = (id, patch) => { if (patch.state === 'closed') throw new Error('the process died here'); return update(id, patch); };
    await refreshAndClose(d6);
    check('Slack has the reply; the closure is still pending', threadReplies(root2.ts).length === 1 && closureOf(d6, 'slack-support', s2fp)?.state === 'pending',
      { replies: threadReplies(root2.ts).length, closure: closureOf(d6, 'slack-support', s2fp) });
    await d6.dispose();
    d6 = await open({ home: home6, bindings: shared });
    await tickClosures(d6);
    const after = closureOf(d6, 'slack-support', s2fp);
    check('after the restart the tick finds its own reply: still one reply, the closure closed with it as the external id',
      threadReplies(root2.ts).length === 1 && after?.state === 'closed' && typeof after?.externalId === 'string' && d6.repo.findSignal(ws, s2fp)?.status === 'closed',
      { replies: threadReplies(root2.ts).length, after });
  } catch (e) {
    check('the closure sections ran', false, String(e?.stack ?? e));
  } finally {
    await d6?.dispose();
    await yt4.close();
    await slack4.close();
    await sentry4.close();
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
