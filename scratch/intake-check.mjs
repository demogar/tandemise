// Intake (spec 2026-10-30-intake-design.md): anything that might be work,
// from any source, lands as one item in the project's primary tracker.
//
//   npm run build && node scratch/intake-check.mjs
//
// Sections grow with the plan's tasks. Task 1 pins the contract
// (`tandemise.intake/v1`, its limits and the config file schemas) and the
// pure rules the pipeline is built on.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const C = await import('@tandemise/api-contract');
const D = await import('@tandemise/domain');

// ------------------------------------------------------------------ contract
section('contract: tandemise.intake/v1');
{
  // The spec §1 example, with a 10-byte inline attachment.
  const example = () => ({
    schema: 'tandemise.intake/v1',
    source: { kind: 'sentry', instance: 'acme/web' },
    key: '4501234567',
    url: 'https://acme.sentry.io/issues/4501234567/',
    title: "TypeError: cannot read 'id' of undefined",
    description: 'Checkout breaks when the cart is empty.',
    reporter: { name: 'Sam Ortiz', handle: 'sam', url: 'https://github.com/sam' },
    occurredAt: '2026-10-30T09:12:00Z',
    attachments: [
      { name: 'trace.txt', mediaType: 'text/plain', url: 'https://acme.sentry.io/trace.txt' },
      { name: 'screen.png', mediaType: 'image/png', contentBase64: Buffer.alloc(10, 7).toString('base64') },
    ],
    impact: { level: 'error', events: 132, users: 41, firstSeen: '2026-10-29T08:00:00Z', lastSeen: '2026-10-30T09:12:00Z', release: 'web@2026.10.29' },
    labels: ['checkout'],
    reply: { address: 'sentry:acme/web:4501234567' },
    kindHint: 'bug',
  });
  const S = C.intakeSignalV1;
  check('the contract is exported', S !== undefined && C.INTAKE_SCHEMA_V1 === 'tandemise.intake/v1' && eq(C.ACCEPTED_INTAKE_SCHEMAS, ['tandemise.intake/v1']));
  if (S === undefined) {
    console.log(`\n${passed} passed, ${failures.length + 1} failed`);
    process.exit(1);
  }
  const ok = S.safeParse(example());
  check('the spec §1 example parses', ok.success, ok.error?.issues);
  check('its fingerprint is <kind>:<instance>:<key>', ok.success && D.fingerprintOf(ok.data) === 'sentry:acme/web:4501234567');
  check('only the five required fields parse alone', S.safeParse({ schema: 'tandemise.intake/v1', source: { kind: 'my-feed', instance: 'x' }, key: 'k', url: 'https://x.test/1', title: 'T' }).success);

  const text = (r) => (r.success ? '' : C.formatIntakeIssues(r.error));
  const pri = S.safeParse({ ...example(), priority: 'high' });
  check('an unknown field (priority) is refused and named', !pri.success && text(pri).includes('priority'), text(pri));
  check('a signal cannot choose the project', !S.safeParse({ ...example(), project: 'other' }).success);
  check('a v2-only field is refused inside v1', !S.safeParse({ ...example(), severityScore: 3 }).success);
  check('another schema is refused', !S.safeParse({ ...example(), schema: 'tandemise.intake/v2' }).success);
  check('a bad source kind is refused', !S.safeParse({ ...example(), source: { kind: 'Sentry!', instance: 'x' } }).success);

  const http = S.safeParse({ ...example(), url: 'http://acme.sentry.io/x' });
  check('http links are refused in plain words', !http.success && text(http).includes('Only https links are accepted.'), text(http));
  check('a reporter http link is refused too', !S.safeParse({ ...example(), reporter: { url: 'http://x.test' } }).success);
  check('an attachment http link is refused too', !S.safeParse({ ...example(), attachments: [{ name: 'a', mediaType: 'text/plain', url: 'http://x.test/a' }] }).success);

  const att = (bytes) => ({ name: 'a.bin', mediaType: 'application/octet-stream', contentBase64: Buffer.alloc(bytes, 1).toString('base64') });
  check('11 attachments are refused', !S.safeParse({ ...example(), attachments: Array.from({ length: 11 }, () => att(1)) }).success);
  check('10 attachments parse', S.safeParse({ ...example(), attachments: Array.from({ length: 10 }, () => att(1)) }).success);
  check('one inline attachment of 1 000 000 bytes parses', S.safeParse({ ...example(), attachments: [att(1_000_000)] }).success);
  const big = S.safeParse({ ...example(), attachments: [att(1_000_001)] });
  check('one inline attachment of 1 000 001 bytes is refused', !big.success, text(big));
  const many = S.safeParse({ ...example(), attachments: Array.from({ length: 6 }, () => att(900_000)) });
  check('six of 900 000 bytes (5.4 MB in all) are refused', !many.success, text(many));
  check('an attachment with both a url and inline content is refused', !S.safeParse({ ...example(), attachments: [{ ...att(1), url: 'https://x.test/a' }] }).success);
  check('an attachment with neither is refused', !S.safeParse({ ...example(), attachments: [{ name: 'a', mediaType: 'text/plain' }] }).success);
  check('inline content that is not base64 is refused', !S.safeParse({ ...example(), attachments: [{ name: 'a', mediaType: 'text/plain', contentBase64: 'not base64!' }] }).success);

  check('reporter.email is refused', !S.safeParse({ ...example(), reporter: { name: 'Sam', email: 'sam@x.test' } }).success);
  check('a title over 200 is refused', !S.safeParse({ ...example(), title: 'x'.repeat(201) }).success);
  check('a description over 20 000 is refused', !S.safeParse({ ...example(), description: 'x'.repeat(20_001) }).success);
  check('an unknown impact level is refused', !S.safeParse({ ...example(), impact: { level: 'critical' } }).success);
  check('an unknown kind hint is refused', !S.safeParse({ ...example(), kindHint: 'chore' }).success);

  // The push body: one signal, or a batch whose signals are checked one by one.
  const B = C.intakePushBody;
  check('a batch of 51 is refused', !B.safeParse({ signals: Array.from({ length: 51 }, example) }).success);
  check('a batch of 50 parses', B.safeParse({ signals: Array.from({ length: 50 }, example) }).success);
  check('a batch with one bad signal still parses as a batch', B.safeParse({ signals: [example(), { ...example(), priority: 'high' }] }).success);
  check('one signal parses as a push body', B.safeParse(example()).success);
  check('an empty batch is refused', !B.safeParse({ signals: [] }).success);

  const good = C.validateIntakeSignal(example());
  check('validateIntakeSignal accepts a good signal', good.ok && good.signal.key === '4501234567');
  const bad = C.validateIntakeSignal({ ...example(), priority: 'high', url: 'http://x.test' });
  check('validateIntakeSignal lists the issues in one readable line', !bad.ok && bad.reason.includes('priority') && bad.reason.includes('url: Only https links are accepted.') && bad.issues.length === 2, bad);
  check('…and keeps the fingerprint and title it could read', !bad.ok && bad.fingerprint === 'sentry:acme/web:4501234567' && bad.title === example().title, bad);
  const junk = C.validateIntakeSignal('nope');
  check('…and null for what it could not read', !junk.ok && junk.fingerprint === null && junk.title === null, junk);
  const v2 = C.validateIntakeSignal({ ...example(), schema: 'tandemise.intake/v2' });
  check('a schema this daemon does not accept is named', !v2.ok && v2.reason.includes("tandemise.intake/v2"), v2);
}

section('pure: mergeImpact and labels');
{
  const m = D.mergeImpact({ events: 3, users: 1, level: 'warning', lastSeen: 'A' }, { events: 300, users: 2, level: 'error', lastSeen: 'B' });
  check('mergeImpact takes the larger counts, the later lastSeen, the worse level', m.events === 300 && m.users === 2 && m.level === 'error' && m.lastSeen === 'B', m);
  const back = D.mergeImpact({ events: 300, level: 'fatal', firstSeen: '2026-10-01', lastSeen: '2026-10-30', release: 'r1' }, { events: 4, level: 'info', firstSeen: '2026-10-05', lastSeen: '2026-10-29' });
  check('…and never moves backwards', back.events === 300 && back.level === 'fatal' && back.firstSeen === '2026-10-01' && back.lastSeen === '2026-10-30' && back.release === 'r1', back);
  check('…and the newer release wins', D.mergeImpact({ release: 'r1' }, { release: 'r2' }).release === 'r2');
  check('…null on either side is the other', eq(D.mergeImpact(null, { events: 1 }), { events: 1 }) && eq(D.mergeImpact({ users: 2 }, null), { users: 2 }) && D.mergeImpact(null, null) === null);
  check('fingerprintOf', D.fingerprintOf({ source: { kind: 'custom', instance: 'feed' }, key: 'k1' }) === 'custom:feed:k1');
  check('signal statuses', D.SIGNAL_STATUSES.length === 10 && D.SIGNAL_STATUSES.includes('needs_decision') && D.SIGNAL_STATUSES.includes('closure_failed'));
  check('shipped source labels', ['github', 'sentry', 'posthog', 'slack', 'discord'].map(D.sourceLabel).join(',') === 'GitHub,Sentry,PostHog,Slack,Discord');
  check('a custom slug reads as itself', D.sourceLabel('my-feed') === 'my-feed');
}

section('contract: config files (tracker.yaml, intake.yaml)');
{
  const trackerYaml = `
tracker:
  kind: youtrack
  url: https://acme.youtrack.cloud
  project: GAR
  board: "project: GAR #Unresolved sort by: updated desc"
  states:
    ready: [Open, Submitted]
    in_progress: In Progress
    in_review: In Review
    done: [Fixed, Done]
    wont_do: [Won't fix, Duplicate, Obsolete]
  onComplete: in_review
`;
  const t = C.trackerFileV1.safeParse(parseYaml(trackerYaml));
  check('trackerFileV1 parses the spec §6.2 YAML', t.success && t.data.tracker.onComplete === 'in_review' && eq(t.data.tracker.states.done, ['Fixed', 'Done']), t.error?.issues);
  const noReview = parseYaml(trackerYaml);
  delete noReview.tracker.states.in_review;
  check('onComplete in_review without an in_review state is refused', !C.trackerFileV1.safeParse(noReview).success);
  noReview.tracker.onComplete = 'done';
  check('…and parses once onComplete is done', C.trackerFileV1.safeParse(noReview).success);
  const noReady = parseYaml(trackerYaml);
  noReady.tracker.states.ready = [];
  check('an empty ready list is refused', !C.trackerFileV1.safeParse(noReady).success);
  const plainHttp = parseYaml(trackerYaml);
  plainHttp.tracker.url = 'http://acme.youtrack.cloud';
  check('a plain-http tracker url is refused', !C.trackerFileV1.safeParse(plainHttp).success);
  plainHttp.tracker.url = 'http://127.0.0.1:4100';
  check('…but loopback http (fakes, self-hosted on this machine) is allowed', C.trackerFileV1.safeParse(plainHttp).success);
  check('a github-issues tracker parses', C.trackerFileV1.safeParse({ tracker: { kind: 'github-issues', repo: 'acme/web', board: 'is:open', states: { ready: ['open'], in_progress: 'in progress', done: ['closed'], wont_do: [] }, onComplete: 'done' } }).success);

  const intakeYaml = `
sources:
  - id: sentry-web
    kind: sentry
    instance: acme/web
    every: 10m
    filter:
      minLevel: error
      minEvents: 20
      minUsers: 3
      window: 24h
      ignoreTitles: ["ResizeObserver loop", "/^Network ?Error/"]
    create: { type: Bug, fields: { Subsystem: Web } }
  - id: slack-support
    kind: slack
    instance: acme.slack.com#support
    trigger: { emoji: tandemise }
    create: { type: Task }
dailyCap: 20
`;
  const i = C.intakeFileV1.safeParse(parseYaml(intakeYaml));
  check('intakeFileV1 parses the spec §4.1 YAML', i.success && i.data.dailyCap === 20 && i.data.sources.length === 2, i.error?.issues);
  check('…and defaults similarity to { link: 0.85, ask: 0.55 }', i.success && eq(i.data.similarity, { link: 0.85, ask: 0.55 }), i.data?.similarity);
  check('…and closeOnDone / closeWontDo to false', i.success && i.data.sources[0].closeOnDone === false && i.data.sources[0].closeWontDo === false);
  check('dailyCap defaults to 20', C.intakeFileV1.safeParse({ sources: [] }).data?.dailyCap === 20);
  const src = (extra) => ({ sources: [{ id: 'feed', kind: 'custom', instance: 'x', ...extra }] });
  check('a bad source id is refused', !C.intakeFileV1.safeParse({ sources: [{ id: 'Feed!', kind: 'custom', instance: 'x' }] }).success);
  check('two sources with one id are refused', !C.intakeFileV1.safeParse({ sources: [src({}).sources[0], src({}).sources[0]] }).success);
  check('an unknown cadence is refused', !C.intakeFileV1.safeParse(src({ every: '7m' })).success);
  check('an https api override parses', C.intakeFileV1.safeParse(src({ api: 'https://sentry.acme.internal' })).success);
  check('a loopback http api override parses', C.intakeFileV1.safeParse(src({ api: 'http://localhost:4200' })).success);
  check('a remote http api override is refused', !C.intakeFileV1.safeParse(src({ api: 'http://sentry.acme.internal' })).success);
}

section('contract: the JSON Schema for runner authors');
{
  let js = null;
  try { js = JSON.parse(readFileSync(join(repo, 'docs/intake/signal.v1.schema.json'), 'utf8')); } catch (e) { check('docs/intake/signal.v1.schema.json is valid JSON', false, String(e)); }
  if (js) {
    check('docs/intake/signal.v1.schema.json is valid JSON', true);
    check('its properties are the zod shape', eq(Object.keys(js.properties).sort(), Object.keys(C.intakeSignalV1.shape).sort()), Object.keys(js.properties));
    check('it rejects unknown fields', js.additionalProperties === false);
    check('its required fields are the five', eq(js.required, ['schema', 'source', 'key', 'url', 'title']), js.required);
    // Nested objects mirror the zod shapes too, so a runner in another language learns the same rules.
    const shapeOf = (z) => {
      let t = z;
      while (t && !t.shape) t = t._def?.innerType ?? t._def?.schema ?? t._def?.type;
      return t?.shape;
    };
    const resolve = (node) => (node?.$ref ? js.$defs[node.$ref.replace('#/$defs/', '')] : node);
    for (const name of ['source', 'reporter', 'impact', 'reply']) {
      const node = resolve(js.properties[name]);
      check(`${name} mirrors the zod shape and is closed`, node?.additionalProperties === false && eq(Object.keys(node.properties).sort(), Object.keys(shapeOf(C.intakeSignalV1.shape[name])).sort()), node && Object.keys(node.properties ?? {}));
    }
    const attItem = resolve(resolve(js.properties.attachments).items);
    const zAtt = shapeOf(C.intakeSignalV1.shape.attachments);
    check('attachments mirror the zod shape and are closed', attItem?.additionalProperties === false && resolve(js.properties.attachments).maxItems === 10 && eq(Object.keys(attItem.properties).sort(), Object.keys(zAtt ?? {}).sort()), attItem && Object.keys(attItem.properties));
    check('the enums match', eq(resolve(js.properties.impact).properties.level.enum, [...D.IMPACT_LEVELS]) && eq(js.properties.kindHint.enum, [...D.KIND_HINTS]));
    check('the source kind pattern matches', resolve(js.properties.source).properties.kind.pattern === C.INTAKE_SOURCE_KIND_PATTERN.source);
    check('the https rule is in the schema', String(resolve(js.properties.url).pattern ?? '').startsWith('^https://'));
    check('the limits are in the schema', js.properties.title.maxLength === 200 && js.properties.key.maxLength === 200 && js.properties.description.maxLength === 20000);
  }
}

// ------------------------------------------------------------------ store
// Task 2: migration 022 (Ruling 1) and the intake repositories, on a fresh
// database with a clock the check moves by hand.
section('store: migration and repositories');
{
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { Container, compose } = await import('@tandemise/kernel');
  const { ids } = await import('@tandemise/shared');
  const P = await import('@tandemise/persistence');
  const app = await import('@tandemise/application');
  let t = Date.parse('2026-10-30T10:00:00.000Z');
  const clock = { now: () => new Date(t).toISOString(), epochMs: () => t };
  const tick = (ms) => { t += ms; };
  const dir = mkdtempSync(join(tmpdir(), 'tandemise-intake-store-'));
  const container = new Container();
  try {
    compose(container, P.persistenceModule({ path: join(dir, 'tandemise.db'), clock }));
    const db = container.resolve(P.DATABASE);

    // 1. The schema is at the last migration in the list (022 on this base, Ruling 1).
    const last = P.MIGRATIONS[P.MIGRATIONS.length - 1];
    const max = db.handle.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
    check('schema_migrations reaches the last migration, which is intake', max === last.version && last.name === 'intake' && max === P.SCHEMA_VERSION, { max, last: last?.name });
    const tables = new Set(db.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const want = ['intake_sources', 'intake_tokens', 'intake_signals', 'intake_attachments', 'tracker_items', 'intake_links', 'intake_closures', 'tracker_comments', 'intake_webhook_inbox'];
    check('the nine intake tables exist', want.every((n) => tables.has(n)), want.filter((n) => !tables.has(n)));

    // The three application tokens carry the persistence tokens' export names,
    // so the daemon's aliasPorts loop binds them (apps/daemon/src/bootstrap.ts).
    const names = ['INTAKE_REPOSITORY', 'TRACKER_ITEM_REPOSITORY', 'WEBHOOK_MAILBOX'];
    check('application and persistence export the three tokens by the same name', names.every((n) => app[n]?.description && P[n]?.description && app[n] !== P[n]));
    if (!names.every((n) => P[n] && app[n])) throw new Error('intake tokens missing');
    for (const n of names) container.bind(app[n], (r) => r.resolve(P[n]), { source: `alias:${n}` });
    const intake = container.resolve(app.INTAKE_REPOSITORY);
    const items = container.resolve(app.TRACKER_ITEM_REPOSITORY);
    const mailbox = container.resolve(app.WEBHOOK_MAILBOX);
    const workspaces = container.resolve(P.WORKSPACE_REPOSITORY);
    const missions = container.resolve(P.MISSION_REPOSITORY);

    const ws = ids.workspace();
    workspaces.create({
      id: ws, name: 'Intake', defaultRepositoryId: null,
      autonomy: { planApproval: 'ask', localCodeChanges: 'auto', externalWrites: 'policy', productionRelease: 'ask', financialActions: 'deny' },
      concurrency: { maxTotalWorkers: 1, perRuntime: {} }, routing: {}, defaultAutonomyLevel: 'balanced',
      knowledge: { productVision: null, architecturePrinciples: null, codingStandards: null, designSystem: null, glossary: null },
    });

    // 2. One fingerprint, one row: occurrences count, impact merges, latest text wins.
    const sig = (over = {}) => ({
      schema: 'tandemise.intake/v1', source: { kind: 'sentry', instance: 'acme/web' }, key: '4501',
      url: 'https://acme.sentry.io/issues/4501/', title: 'TypeError in checkout',
      impact: { events: 3, users: 1, level: 'warning', lastSeen: '2026-10-30T09:00:00Z' }, ...over,
    });
    const a = intake.upsertSignal(ws, 'sentry-web', sig(), clock.now());
    tick(60_000);
    const b = intake.upsertSignal(ws, 'sentry-web', sig({ title: 'TypeError in checkout (cart)', impact: { events: 300, users: 2, level: 'error', lastSeen: '2026-10-30T10:00:00Z' } }), clock.now());
    const rows = db.handle.prepare('SELECT COUNT(*) AS n FROM intake_signals WHERE workspace_id = ?').get(ws).n;
    check('a second push of one fingerprint updates the same row', rows === 1 && a.signal.id === b.signal.id, { rows });
    check('firstTime is true, then false', a.firstTime === true && b.firstTime === false);
    check('occurrences count the pushes', b.signal.occurrences === 2, b.signal.occurrences);
    check('impact is merged (3 -> 300 events, error)', b.signal.impact?.events === 300 && b.signal.impact?.users === 2 && b.signal.impact?.level === 'error', b.signal.impact);
    check('the latest title wins and first/last seen are kept', b.signal.title === 'TypeError in checkout (cart)' && b.signal.firstSeenAt < b.signal.lastSeenAt && b.signal.status === 'received', b.signal);
    check('findSignal finds it by fingerprint', intake.findSignal(ws, 'sentry:acme/web:4501')?.id === a.signal.id);

    // A rejected push is recorded, and never undoes a signal already in the pipeline (Ruling 6).
    const rej = intake.recordRejected(ws, 'custom', 'my-feed:x:1', 'Broken', "Unknown field 'priority'.");
    check('a rejected signal is recorded with its reason', rej.status === 'rejected' && rej.reason === "Unknown field 'priority'." && rej.title === 'Broken', rej);
    const kept = intake.recordRejected(ws, 'sentry-web', 'sentry:acme/web:4501', 'x', 'bad');
    check('a bad repeat of a good signal leaves it alone', kept.status === 'received' && kept.title === 'TypeError in checkout (cart)', kept);
    const revived = intake.upsertSignal(ws, 'custom', sig({ source: { kind: 'my-feed', instance: 'x' }, key: '1' }), clock.now());
    check('a valid push after a rejected one enters the pipeline as new', revived.firstTime && revived.signal.id === rej.id && revived.signal.status === 'received' && revived.signal.reason === null, revived);
    check('listSignals filters by status', intake.listSignals(ws, { statuses: ['received'] }).length === 2 && intake.listSignals(ws, { statuses: ['rejected'] }).length === 0);
    const held = intake.setStatus(a.signal.id, 'needs_decision', 'Is this the same as GAR-12?', { candidateRef: 'youtrack:GAR-12', score: 0.7 });
    check('setStatus keeps the reason, candidate and score', held.status === 'needs_decision' && held.candidateRef === 'youtrack:GAR-12' && held.score === 0.7, held);
    intake.addAttachment(a.signal.id, { name: 'trace.txt', mediaType: 'text/plain', url: 'https://acme.sentry.io/t.txt', blobSha256: null });
    check('attachments round-trip', intake.attachments(a.signal.id).length === 1 && intake.attachments(a.signal.id)[0].url === 'https://acme.sentry.io/t.txt');
    let badAttachment = null;
    try { intake.addAttachment(a.signal.id, { name: 'x', mediaType: 'text/plain', url: null, blobSha256: null }); } catch (e) { badAttachment = e; }
    check('an attachment with neither a blob nor a url is refused', badAttachment !== null);

    // 3. One link per signal.
    const link = intake.createPendingLink(ws, a.signal.id, null, 'created');
    let second = null;
    try { intake.createPendingLink(ws, a.signal.id, 'youtrack:GAR-1', 'url'); } catch (e) { second = e; }
    check('a second link for the same signal throws', second !== null && link.status === 'pending');
    check('the pending link is listed for restart', intake.pendingLinks().some((l) => l.id === link.id));
    const done = intake.completeLink(link.id, 'youtrack:GAR-1');
    check('completeLink sets the ref and marks it done', done.status === 'done' && done.itemRef === 'youtrack:GAR-1' && intake.linkFor(a.signal.id)?.status === 'done' && !intake.pendingLinks().some((l) => l.id === link.id));
    intake.createPendingLink(ws, revived.signal.id, 'youtrack:GAR-2', 'similarity', 0.9);
    check("repointLinks moves a duplicate's links", intake.repointLinks(ws, 'youtrack:GAR-2', 'youtrack:GAR-1') === 1 && intake.linksForItem(ws, 'youtrack:GAR-1').length === 2);

    // 4. The daily cap counts only links that created an item, since the day started.
    check('createdToday counts only linked_by=created since the day start',
      intake.createdToday(ws, 'sentry-web', '2026-10-30T00:00:00.000Z') === 1
      && intake.createdToday(ws, 'custom', '2026-10-30T00:00:00.000Z') === 0
      && intake.createdToday(ws, 'sentry-web', '2026-10-31T00:00:00.000Z') === 0);

    // 5. A closure per (signal, kind).
    const c1 = intake.closures.ensure(a.signal.id, 'done');
    const c2 = intake.closures.ensure(a.signal.id, 'done');
    check('closures.ensure twice returns the same closure', c1.id === c2.id && c1.state === 'pending');
    check('a pending closure is due', intake.closures.due(clock.now()).some((c) => c.id === c1.id));
    const closed = intake.closures.update(c1.id, { state: 'closed', attempts: 1, closedAt: clock.now(), externalId: 'reply-1' });
    check('a closed closure is no longer due', closed.state === 'closed' && !intake.closures.due(clock.now()).some((c) => c.id === c1.id) && intake.closures.listForSource(ws, 'sentry-web').length === 1);

    // Tokens are stored by hash only.
    const tok = intake.tokens.create(ws, 'custom', 'a'.repeat(64), 'Demo');
    check('a token is found by its hash', intake.tokens.byHash('a'.repeat(64))?.id === tok.id && tok.revokedAt === null);
    intake.tokens.revoke(tok.id);
    check('a revoked token says so', intake.tokens.byHash('a'.repeat(64))?.revokedAt !== null && intake.tokens.list(ws).length === 1);

    // Sources keep their state per project.
    intake.saveSource(ws, 'sentry-web', { kind: 'sentry', enabled: true, enabledBy: 'Demo', cursor: { since: 'x' } });
    check('a source round-trips and is listed as enabled', intake.source(ws, 'sentry-web')?.cursor?.since === 'x' && intake.listEnabledSources().length === 1 && intake.listSources(ws).length === 1);

    // 6. The board cache, and a mission that points at it.
    const tracked = items.upsert(ws, { ref: 'youtrack:GAR-1', key: 'GAR-1', url: 'https://yt.test/issue/GAR-1', title: 'T', description: 'D', state: 'Open', assignee: null, updatedAt: '2026-10-30T10:00:00Z', createdAt: '2026-10-30T09:00:00Z', type: 'Bug' });
    const again = items.upsert(ws, { ...tracked, state: 'In Progress' });
    check('an item upserts by ref, keeping its id', again.id === tracked.id && again.state === 'In Progress' && items.byKey(ws, 'GAR-1')?.id === tracked.id && items.list(ws).length === 1);
    items.setWrittenState(tracked.id, 'In Progress');
    check('the written state is kept across a refresh', items.upsert(ws, { ...tracked, state: 'In Progress' }).writtenState === 'In Progress');
    items.saveComment(ws, 'youtrack:GAR-1', 'tandemise:activity', 'c-1', 'v1');
    items.saveComment(ws, 'youtrack:GAR-1', 'tandemise:activity', 'c-1', 'v2');
    check('one comment per (item, marker)', items.comment(ws, 'youtrack:GAR-1', 'tandemise:activity')?.body === 'v2');
    const mission = missions.create({ id: ids.mission(), workspaceId: ws, repositoryId: null, title: 'From GAR-1', goal: 'g', trackerItemId: tracked.id });
    check('a mission is written with its tracker item', missions.get(mission.id)?.trackerItemId === tracked.id);
    items.removeMissing(ws, []);
    check("removing the tracker item clears the mission's pointer", items.get(tracked.id) === undefined && missions.get(mission.id)?.trackerItemId === null, missions.get(mission.id)?.trackerItemId);

    // 7. The webhook mailbox: claim, release, ack.
    const id = mailbox.put({ sourceId: 'github', headers: { 'x-github-event': 'issues' }, body: new TextEncoder().encode('{"a":1}') });
    const first = mailbox.pull(10);
    check('put then pull(10) returns the message', first.length === 1 && first[0].id === id && new TextDecoder().decode(first[0].body) === '{"a":1}' && first[0].headers['x-github-event'] === 'issues', first);
    check('a second pull returns nothing (claimed)', mailbox.pull(10).length === 0);
    mailbox.release(id);
    check('after release it is pulled again', mailbox.pull(10).length === 1);
    mailbox.ack(id);
    mailbox.release(id);
    check('after ack it is gone for good', mailbox.pull(10).length === 0);
  } catch (e) {
    check('the store section ran', false, String(e?.stack ?? e));
  } finally {
    await container.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ ingest
// Task 3: IntakeService validates and records what custom runners push, over
// the real application module, the local config source and a hand-moved clock.
// The HTTP route, the token check at the listener and the CLI are pinned by
// scratch/intake-daemon-check.mjs.
section('ingest: validate and record, in process');
{
  const { mkdirSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { Container, compose } = await import('@tandemise/kernel');
  const { createLogger, createPaths } = await import('@tandemise/shared');
  const P = await import('@tandemise/persistence');
  const A = await import('@tandemise/artifacts');
  const app = await import('@tandemise/application');
  const { policyModule } = await import('@tandemise/policy');
  const { contextModule } = await import('@tandemise/context');
  const { createEvaluationModule } = await import('@tandemise/evaluation');
  const { runtimesCoreModule } = await import('@tandemise/runtimes-core');
  const { genericRuntimeModule } = await import('@tandemise/runtime-generic');
  const { executionCoreModule, CLOCK: EXEC_CLOCK, LOGGER: EXEC_LOGGER, PATHS: EXEC_PATHS } = await import('@tandemise/execution-core');
  const { executionLocalModule } = await import('@tandemise/execution-local');
  const { integrationsCoreModule, CLOCK: INT_CLOCK, LOGGER: INT_LOGGER, COMMAND_EXECUTOR, BACKGROUND_PROCESS_LAUNCHER } = await import('@tandemise/integrations-core');
  let t = Date.parse('2026-10-30T10:00:00.000Z');
  const clock = { now: () => new Date(t).toISOString(), epochMs: () => t };
  const HOME = mkdtempSync(join(tmpdir(), 'tandemise-intake-ingest-'));
  const paths = createPaths(HOME);
  mkdirSync(paths.root, { recursive: true });
  const log = createLogger({ level: 'error', base: { component: 'intake-check' } });
  const container = new Container();
  try {
    compose(
      container,
      P.persistenceModule({ path: paths.db, logger: log, clock }),
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
    container.bind(app.SECRET_STORE, () => ({ backend: 'memory', store: async () => 'x', resolve: async () => undefined, remove: async () => {}, list: async () => [] }), { source: 'check' });
    container.bind(app.SETTINGS_STORE, () => app.createMemorySettingsStore(), { source: 'check' });
    container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home: HOME, schemaVersion: 1 }), { source: 'check' });
    container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });
    const services = app.createServices(container);
    check('the application exposes the intake service', services.intake !== undefined && app.INTAKE_SERVICE !== undefined && app.INTAKE_CONFIG_SOURCE !== undefined && app.INTAKE_BLOBS !== undefined);
    if (services.intake === undefined) throw new Error('no intake service');
    const intake = services.intake;
    const caller = { personId: services.identity.localPerson().id };
    const ws = (await services.workspaces.create(caller, { name: 'Intake' })).workspace.id;
    const scope = { workspaceId: ws, sourceId: 'custom-feed', tokenId: null };
    const signal = (over = {}) => ({
      schema: 'tandemise.intake/v1', source: { kind: 'custom', instance: 'custom-feed' }, key: 'k1',
      url: 'https://feed.test/k1', title: 'Checkout is slow', ...over,
    });
    const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

    // Nothing configured: there is no tracker to land in.
    const none = await refusal(() => intake.ingest(scope, signal()));
    check("a push with no tracker is refused: Set this project's tracker first.", none?.code === 'CONFLICT' && none?.message === "Set this project's tracker first.", { code: none?.code, message: none?.message });

    const config = container.resolve(app.INTAKE_CONFIG_SOURCE);
    check('the local config source reads an empty project', config.origin === 'local' && config.read(ws).tracker === null && config.read(ws).dailyCap === 20);
    config.write(ws, {
      tracker: {
        kind: 'youtrack', url: 'https://yt.test', project: 'GAR', board: 'project: GAR #Unresolved',
        states: { ready: ['Open'], in_progress: 'In Progress', done: ['Done'], wont_do: ["Won't fix"] }, onComplete: 'done',
      },
      intake: { sources: [{ id: 'custom-feed', kind: 'custom', instance: 'custom-feed', closeOnDone: false, closeWontDo: false }], dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } },
    });
    const read = config.read(ws);
    check('the local config source round-trips the tracker and sources', read.tracker?.kind === 'youtrack' && read.sources.length === 1 && read.sources[0].id === 'custom-feed', read);
    let badWrite = null;
    try { config.write(ws, { tracker: { kind: 'youtrack', board: 'x', states: { ready: ['Open'], in_progress: 'P', done: ['Done'], wont_do: [] }, onComplete: 'done' } }); } catch (e) { badWrite = e; }
    check('the local config source refuses a youtrack tracker with no url or project', badWrite?.code === 'VALIDATION' && config.read(ws).tracker?.project === 'GAR', badWrite?.message);

    const unknown = await refusal(() => intake.ingest({ ...scope, sourceId: 'nope' }, signal()));
    check("an unknown source is refused: This project has no intake source 'nope'.", unknown?.code === 'NOT_FOUND' && unknown?.message === "This project has no intake source 'nope'.", { code: unknown?.code, message: unknown?.message });

    const first = await intake.ingest(scope, signal());
    t += 1000;
    const second = await intake.ingest(scope, signal({ title: 'Checkout is slow again' }));
    check('a valid signal is received, with no reason', first.status === 'received' && first.reason === null && first.fingerprint === 'custom:custom-feed:k1', first);
    const listed = intake.list(ws, {});
    check('the same fingerprint twice is one signal with occurrences 2', second.signalId === first.signalId && listed.length === 1 && listed[0].occurrences === 2 && listed[0].status === 'received' && listed[0].title === 'Checkout is slow again', listed);

    const bad = await intake.ingest(scope, signal({ key: 'k2', priority: 'high' }));
    const rejected = intake.list(ws, { statuses: ['rejected'] });
    check("an invalid signal is answered and listed as rejected, naming 'priority'", bad.status === 'rejected' && bad.reason?.includes('priority') && rejected.length === 1 && rejected[0].reason?.includes('priority') && rejected[0].fingerprint === 'custom:custom-feed:k2', { bad, rejected });
    const unreadable = await intake.ingest(scope, { schema: 'tandemise.intake/v1', title: 42 });
    check('an unreadable signal gets an invalid:<source>:<hash> fingerprint and a placeholder title', /^invalid:custom-feed:[0-9a-f]{16}$/.test(unreadable.fingerprint ?? '') && intake.list(ws, { statuses: ['rejected'] }).some((s) => s.title === '(unreadable signal)'), unreadable);

    // Inline attachments are stored by sha256; links are only recorded.
    const withFiles = await intake.ingest(scope, signal({ key: 'k3', attachments: [
      { name: 'note.txt', mediaType: 'text/plain', contentBase64: Buffer.from('hello').toString('base64') },
      { name: 'trace.txt', mediaType: 'text/plain', url: 'https://feed.test/trace.txt' },
    ] }));
    await intake.ingest(scope, signal({ key: 'k3', attachments: [{ name: 'note.txt', mediaType: 'text/plain', contentBase64: Buffer.from('hello').toString('base64') }] }));
    const repo = container.resolve(app.INTAKE_REPOSITORY);
    const atts = repo.attachments(withFiles.signalId);
    const blobs = container.resolve(app.INTAKE_BLOBS);
    const inline = atts.find((a) => a.name === 'note.txt');
    check('an inline attachment is stored as a blob, a url attachment as a link, and a repeat adds none',
      atts.length === 2 && inline?.blobSha256?.length === 64 && new TextDecoder().decode(await blobs.get(inline.blobSha256)) === 'hello'
      && atts.find((a) => a.name === 'trace.txt')?.url === 'https://feed.test/trace.txt', atts);

    // Tokens: minted once, stored hashed, scoped to one source, rate-limited per signal.
    const minted = intake.mintToken(caller, ws, 'custom-feed');
    check('a minted token starts tdi_ and resolves to its source', /^tdi_[A-Za-z0-9_-]{32}$/.test(minted.token) && intake.resolveToken(minted.token)?.sourceId === 'custom-feed' && intake.resolveToken(minted.token)?.tokenId === minted.id, minted);
    check('only its sha256 is stored', repo.tokens.list(ws).every((r) => r.tokenHash !== minted.token && r.tokenHash.length === 64));
    check('an unknown token resolves to nothing', intake.resolveToken('tdi_' + 'x'.repeat(32)) === null && intake.resolveToken('nonsense') === null);
    const tokenScope = intake.resolveToken(minted.token);
    const foreign = await refusal(() => intake.ingest(tokenScope, signal({ source: { kind: 'custom', instance: 'other-feed' } })));
    check("a token's push naming another source is refused: This token can only push to 'custom-feed'.", foreign?.code === 'PERMISSION_DENIED' && foreign?.message === "This token can only push to 'custom-feed'.", foreign?.message);
    let limited = null;
    for (let i = 0; i < 61; i++) {
      try { await intake.ingest(tokenScope, signal({ key: `r${i}` })); } catch (e) { limited = { i, e }; break; }
    }
    check('the 61st signal in a minute is refused: Too many signals from this source: at most 60 a minute.',
      limited?.i === 60 && limited.e.code === 'RATE_LIMITED' && limited.e.message === 'Too many signals from this source: at most 60 a minute.', limited && { i: limited.i, code: limited.e.code, message: limited.e.message });
    t += 60_000;
    const after = await refusal(() => intake.ingest(tokenScope, signal({ key: 'r-after' })));
    check('after the minute has passed, a push passes again', after === null, after?.message);
    const revoked = intake.mintToken(caller, ws, 'custom-feed');
    intake.revokeToken(caller, revoked.id);
    check('a revoked token resolves to nothing', intake.resolveToken(revoked.token) === null);
  } catch (e) {
    check('the ingest section ran', false, String(e?.stack ?? e));
  } finally {
    await container.dispose();
    rmSync(HOME, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
