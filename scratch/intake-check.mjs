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

// ------------------------------------------------------------------ noise
// Task 6: the noise filter is a pure function of the aggregated signal and the
// source's rules (spec §4.1). Each row of the plan's table is pinned exactly.
section('noise: evaluateNoise and the daily cap');
{
  const now = '2026-10-30T12:00:00.000Z';
  const rules = { minLevel: 'error', minEvents: 20, minUsers: 3, window: '24h' };
  const sig = (impact, extra = {}) => ({ title: 'TypeError: x', occurrences: 1, impact: { level: 'error', events: 3, users: 2, lastSeen: now, ...impact }, ...extra });
  const held = (reason) => ({ verdict: 'held_back', reason });
  const pass = { verdict: 'pass' };
  const row = (label, got, want) => check(label, eq(got, want), got);
  row('3 events in a 24 h window under minEvents 20 is held back',
    D.evaluateNoise(sig({}), rules, now), held('3 events in 24 h; this source needs 20'));
  row('132 events and 41 people pass', D.evaluateNoise(sig({ events: 132, users: 41 }), rules, now), pass);
  row('132 events but 2 people is held back on users',
    D.evaluateNoise(sig({ events: 132, users: 2 }), rules, now), held('2 people affected; this source needs 3'));
  row('a warning under minLevel error is held back on the level first',
    D.evaluateNoise(sig({ level: 'warning' }), rules, now), held('Level warning; this source takes error and above'));
  row('last seen 3 days ago is outside a 24 h window',
    D.evaluateNoise(sig({ events: 132, users: 41, lastSeen: '2026-10-27T12:00:00.000Z' }), rules, now),
    held('Last seen 3 days ago; this source looks at the last 24 h'));
  row('an ignoreTitles substring holds back first',
    D.evaluateNoise(sig({ events: 132, users: 41 }, { title: 'ResizeObserver loop limit exceeded' }), { ...rules, ignoreTitles: ['ResizeObserver loop'] }, now),
    held("Ignored by this source's rule 'ResizeObserver loop'"));
  check('an ignoreTitles /regex/ holds back',
    D.evaluateNoise(sig({ events: 132, users: 41 }, { title: 'Network Error' }), { ignoreTitles: ['/^Network ?Error/'] }, now).verdict === 'held_back');
  row('no rules pass everything', D.evaluateNoise(sig({ events: 0, users: 0, level: 'info' }), undefined, now), pass);
  row('dailyCapReason(20)', D.dailyCapReason(20), 'This source already filed 20 tasks today; decide on this one.');
  // Beyond the table (Ruling 11): events fall back to occurrences; a rule the
  // signal has no data for does not hold it back.
  row('with no impact, minEvents counts occurrences',
    D.evaluateNoise({ title: 't', occurrences: 4, impact: null }, { minEvents: 5 }, now), held('4 events; this source needs 5'));
  row('…and passes once the occurrences reach it', D.evaluateNoise({ title: 't', occurrences: 5, impact: null }, { minEvents: 5 }, now), pass);
  row('a level, user count or last sighting the signal lacks does not hold it back',
    D.evaluateNoise({ title: 't', occurrences: 1, impact: null }, { minLevel: 'error', minUsers: 3, window: '1h' }, now), pass);
  row('a broken /regex/ rule matches nothing instead of throwing',
    D.evaluateNoise({ title: 'x(', occurrences: 1, impact: null }, { ignoreTitles: ['/x(/'] }, now), pass);
  row('a substring rule ignores case',
    D.evaluateNoise({ title: 'resizeobserver LOOP', occurrences: 1, impact: null }, { ignoreTitles: ['ResizeObserver loop'] }, now).verdict, 'held_back');
  row('one person reads in the singular',
    D.evaluateNoise({ title: 't', occurrences: 1, impact: { users: 1 } }, { minUsers: 3 }, now), held('1 person affected; this source needs 3'));
  row('an age under a day reads in hours',
    D.evaluateNoise({ title: 't', occurrences: 1, impact: { lastSeen: '2026-10-30T07:00:00.000Z' } }, { window: '1h' }, now), held('Last seen 5 hours ago; this source looks at the last 1 h'));
}

// ------------------------------------------------------------------ similarity
// Task 6: the default IntakeSimilarity is lexical (spec §5 step 4).
section('similarity: titleTokens and lexicalSimilarity');
{
  const title = "TypeError: cannot read 'id' of undefined";
  check('titleTokens drops stopwords, one-letter words and repeats', eq(D.titleTokens(title), ['typeerror', 'read', 'id', 'undefined']), D.titleTokens(title));
  const item = (t, description = '') => ({ ref: 'youtrack:GAR-1', key: 'GAR-1', url: 'https://yt.test/issue/GAR-1', title: t, description, state: 'Open', assignee: null, updatedAt: '2026-10-30T00:00:00Z', createdAt: '2026-10-30T00:00:00Z' });
  const sig = (t, url = 'https://acme.sentry.io/issues/1/') => ({ title: t, description: '', url });
  const s = D.lexicalSimilarity(sig(title), item(`${title} in checkout`));
  check('the same error plus " in checkout" scores 0.84, between ask and link', s === 0.84 && s >= D.DEFAULT_INTAKE_SIMILARITY.ask && s < D.DEFAULT_INTAKE_SIMILARITY.link, s);
  check('a title with itself scores 1', D.lexicalSimilarity(sig('Checkout button does nothing on Safari'), item('Checkout button does nothing on Safari')) === 1);
  check('unrelated titles score 0', D.lexicalSimilarity(sig('Export to CSV is slow'), item('Checkout button does nothing on Safari')) === 0);
  check("a candidate whose description holds the signal's URL scores 1",
    D.lexicalSimilarity(sig('Export to CSV is slow'), item('Something else', '## Sources\n- x · https://acme.sentry.io/issues/1/')) === 1);
  const diff = D.lexicalSimilarity(sig('TypeError: read id'), item('RangeError: read id'));
  check('different error types keep only the title words (0.8 × Jaccard)', diff === 0.4, diff);
  check('two titles with no words score 0, not NaN', D.lexicalSimilarity(sig('!!', ''), item('a')) === 0);
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
    // The pipeline runs after each push (Task 7); let it finish before the database closes.
    await container.resolve((await import('@tandemise/application')).INTAKE_SERVICE).settle?.();
    await container.dispose();
    rmSync(HOME, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ pipeline
// Task 7: after recording, a signal is filtered, deduped, then created in or
// linked to the primary tracker, once (spec §4, §5, §6.1). Against the fake
// YouTrack (and the fake gh for "the source is the tracker"), over the real
// application module, a hand-moved clock and a check-owned settings store and
// secret store, so a second container can open the same database as the
// same daemon after a crash (Review Focus 1).
const pipeline = await (async () => {
  const { execFile } = await import('node:child_process');
  const { mkdirSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { Container, compose, defineModule } = await import('@tandemise/kernel');
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
  const I = await import('@tandemise/integrations-core');
  const Y = await import('@tandemise/integration-youtrack');
  const G = await import('@tandemise/integration-github');
  const { startFakeYouTrack } = await import('./fake-youtrack.mjs');
  const fakeGh = await import('./fake-gh.mjs');

  let t = Date.parse('2026-10-30T10:00:00.000Z');
  const clock = { now: () => new Date(t).toISOString(), epochMs: () => t };
  const log = createLogger({ level: 'error', base: { component: 'intake-check' } });
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
  const ghRoot = mkdtempSync(join(tmpdir(), 'tdi-pipe-gh-'));
  const ghBin = fakeGh.installFakeGh(join(ghRoot, 'gh'));
  const exec = {
    run: (req) => new Promise((resolve) => {
      execFile(req.command, req.args ?? [], { cwd: req.cwd, env: { ...process.env, PATH: `${ghBin}:${process.env.PATH}`, ...(req.env ?? {}) }, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
        resolve({ exitCode: err ? (typeof err.code === 'number' ? err.code : 127) : 0, stdout, stderr, timedOut: false, durationMs: 0, command: [req.command, ...(req.args ?? [])].join(' ') });
      });
    }),
  };

  /**
   * One daemon: a container over `home`'s database. `settings` and `secrets`
   * are handed in, so a second container on the same home is the same daemon
   * restarted. `providers` are the tracker modules it composes.
   */
  async function open({ home, settings, secrets, providers }) {
    const paths = createPaths(home);
    mkdirSync(paths.root, { recursive: true });
    const container = new Container();
    compose(
      container,
      P.persistenceModule({ path: paths.db, logger: log, clock }),
      A.createArtifactsModule({ paths }),
      policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
      executionCoreModule, executionLocalModule, I.integrationsCoreModule, ...providers, app.createApplicationModule({ localPersonName: 'Demo' }),
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
    container.bind(app.SECRET_STORE, () => secrets, { source: 'check' });
    container.bind(app.SETTINGS_STORE, () => settings, { source: 'check' });
    container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home, schemaVersion: 1 }), { source: 'check' });
    container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });
    const services = app.createServices(container);
    return {
      container, services, intake: services.intake,
      repo: container.resolve(app.INTAKE_REPOSITORY),
      items: container.resolve(app.TRACKER_ITEM_REPOSITORY),
      config: container.resolve(app.INTAKE_CONFIG_SOURCE),
      resolver: container.resolve(app.TRACKER_RESOLVER),
      caller: { personId: services.identity.localPerson().id },
    };
  }

  const ytTracker = (url) => ({
    kind: 'youtrack', url, project: 'GAR', board: 'project: GAR #Unresolved', onComplete: 'in_review',
    states: { ready: ['Open'], in_progress: 'In Progress', in_review: 'In Review', done: ['Fixed', 'Done'], wont_do: ["Won't fix", 'Duplicate', 'Obsolete'] },
  });
  const SOURCES = [
    { id: 'sentry-web', kind: 'sentry', instance: 'acme/web', filter: { minLevel: 'error', minEvents: 20, minUsers: 3, window: '24h' }, create: { type: 'Bug' }, closeOnDone: false, closeWontDo: false },
    { id: 'slack-support', kind: 'slack', instance: 'acme.slack.com#support', closeOnDone: false, closeWontDo: false },
  ];
  const intakeConfig = (over = {}) => ({ sources: SOURCES, dailyCap: 20, similarity: { link: 0.85, ask: 0.55 }, ...over });
  /** A YouTrack project for `d`: the tracker over `fakeUrl`, both sources, and the token saved. */
  async function configureYouTrack(d, fakeUrl) {
    const ws = (await d.services.workspaces.create(d.caller, { name: 'Intake pipeline' })).workspace.id;
    d.config.write(ws, { tracker: ytTracker(fakeUrl), intake: intakeConfig() });
    await d.resolver.saveCredential(ws, 'perm:test');
    return ws;
  }
  const GAR1_TITLE = "TypeError: cannot read 'id' of undefined";
  const sentry = (over = {}) => ({
    schema: 'tandemise.intake/v1', source: { kind: 'sentry', instance: 'acme/web' }, key: '4501234567',
    url: 'https://acme.sentry.io/issues/4501234567/', title: GAR1_TITLE,
    description: 'Checkout breaks when the cart is empty. cc @ana', reporter: { name: 'Sam Ortiz' },
    impact: { level: 'error', events: 132, users: 41, lastSeen: clock.now() }, ...over,
  });
  const slack = (key, title, over = {}) => ({
    schema: 'tandemise.intake/v1', source: { kind: 'slack', instance: 'acme.slack.com#support' }, key,
    url: `https://acme.slack.com/archives/C1/${key}`, title, reporter: { handle: 'dana' }, ...over,
  });
  return {
    app, clock, open, configureYouTrack, intakeConfig, sentry, slack, GAR1_TITLE, memorySecrets, startFakeYouTrack,
    Y, G, I, defineModule, fakeGh, ghRoot, mkdtempSync, tmpdir,
    advance: (ms) => { t += ms; },
  };
})();

section('pipeline: filter, dedupe, then create or link (Task 7)');
const fake = await pipeline.startFakeYouTrack({ project: 'GAR', token: 'perm:test', login: 'tandemise-bot' });
const { rmSync } = await import('node:fs');
const homes = [];
const newHome = () => { const h = pipeline.mkdtempSync(join(pipeline.tmpdir(), 'tdi-pipe-')); homes.push(h); return h; };
const creates = () => fake.calls.filter((c) => c.method === 'POST' && c.path === '/api/issues').length;
const withUrl = (url) => [...fake.issues.values()].filter((i) => i.description.includes(url)).length;
let PA = null;
try {
  const { app, sentry, slack } = pipeline;
  PA = await pipeline.open({ home: newHome(), settings: app.createMemorySettingsStore(), secrets: pipeline.memorySecrets(), providers: [pipeline.Y.youtrackIntegrationModule] });
  const ws = await pipeline.configureYouTrack(PA, fake.url);
  const push = async (signal, sourceId = 'sentry-web') => {
    const r = await PA.intake.ingest({ workspaceId: ws, sourceId, tokenId: null }, signal);
    await PA.intake.settle();
    return { ...PA.repo.getSignal(r.signalId), link: PA.repo.linkFor(r.signalId) };
  };

  // 1. Over the bar: a new item, with the Sources section and the type.
  const s1 = await push(sentry());
  const gar1 = fake.issues.get('GAR-1');
  check('1. a signal over the bar is created as GAR-1', s1.status === 'created' && s1.link?.status === 'done' && s1.link?.itemRef === 'youtrack:GAR-1' && s1.link?.linkedBy === 'created', { status: s1.status, reason: s1.reason, link: s1.link });
  check('…its description has the Sources line', gar1?.description.includes('## Sources\n- Sentry · acme/web · 132 events, 41 users · https://acme.sentry.io/issues/4501234567/'), gar1?.description);
  check('…and who recorded it', gar1?.description.includes('Recorded by Tandemise from Sentry, reported by Sam Ortiz.'), gar1?.description);
  check('…the type comes from the source (command Type Bug)', fake.commands.some((c) => c.query === 'Type Bug' && c.issues[0].idReadable === 'GAR-1'), fake.commands);
  check('…copied text never pings anyone (@mentions broken)', gar1?.description.includes('cc @​ana') && !gar1?.description.includes('cc @ana'), gar1?.description);
  check('…and the item is in the board cache', PA.items.byRef(ws, 'youtrack:GAR-1')?.key === 'GAR-1');

  // 2. The same fingerprint again: the local index answers.
  const s2 = await push(sentry());
  check('2. the same fingerprint again is linked, with no new item', s2.status === 'linked' && creates() === 1, { status: s2.status, creates: creates() });

  // 3. Under the bar, then over it on its own.
  const nan = (events) => sentry({ key: '777', url: 'https://acme.sentry.io/issues/777/', title: 'Checkout total shows NaN', impact: { level: 'error', events, users: 5, lastSeen: pipeline.clock.now() } });
  const s3 = await push(nan(3));
  check("3. 3 events is held back: '3 events in 24 h; this source needs 20'", s3.status === 'held_back' && s3.reason === '3 events in 24 h; this source needs 20' && creates() === 1, { status: s3.status, reason: s3.reason });
  const s3b = await push(nan(300));
  check('…and the same fingerprint at 300 events is created as GAR-2', s3b.status === 'created' && s3b.link?.itemRef === 'youtrack:GAR-2' && creates() === 2, { status: s3b.status, reason: s3b.reason, link: s3b.link });

  // 4. Another daemon, its own database, the same tracker: the exact URL answers.
  const PB = await pipeline.open({ home: newHome(), settings: app.createMemorySettingsStore(), secrets: pipeline.memorySecrets(), providers: [pipeline.Y.youtrackIntegrationModule] });
  try {
    const wsB = await pipeline.configureYouTrack(PB, fake.url);
    const r = await PB.intake.ingest({ workspaceId: wsB, sourceId: 'sentry-web', tokenId: null }, sentry());
    await PB.intake.settle();
    const sb = PB.repo.getSignal(r.signalId);
    const lb = PB.repo.linkFor(r.signalId);
    check("4. another daemon's same signal is linked by its exact URL, no new item", sb.status === 'linked' && lb?.linkedBy === 'url' && lb?.itemRef === 'youtrack:GAR-1' && creates() === 2, { status: sb.status, reason: sb.reason, link: lb });
    const sourcesComment = (fake.comments.get('GAR-1') ?? []).find((c) => c.text.startsWith('<!-- tandemise:sources -->'));
    check('…and the URL is in its sources comment', sourcesComment?.text.includes('https://acme.sentry.io/issues/4501234567/'), fake.comments.get('GAR-1'));
  } finally {
    await PB.intake.settle();
    await PB.container.dispose();
  }

  // 5. The source is the tracker: a GitHub issue of the tracker repo is that item.
  const PG = await pipeline.open({ home: newHome(), settings: app.createMemorySettingsStore(), secrets: pipeline.memorySecrets(), providers: [pipeline.G.githubIntegrationModule] });
  try {
    const wsG = (await PG.services.workspaces.create(PG.caller, { name: 'GitHub intake' })).workspace.id;
    PG.config.write(wsG, {
      tracker: { kind: 'github-issues', repo: 'acme/web', board: 'is:open', onComplete: 'done', states: { ready: ['open'], in_progress: 'status: in progress', done: ['closed'], wont_do: [] } },
      intake: { sources: [{ id: 'gh-web', kind: 'github', instance: 'acme/web', closeOnDone: false, closeWontDo: false }], dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } },
    });
    const r = await PG.intake.ingest({ workspaceId: wsG, sourceId: 'gh-web', tokenId: null }, {
      schema: 'tandemise.intake/v1', source: { kind: 'github', instance: 'acme/web' }, key: '9', url: 'https://github.com/acme/web/issues/9', title: 'Checkout button does nothing on Safari',
    });
    await PG.intake.settle();
    const sg = PG.repo.getSignal(r.signalId);
    const lg = PG.repo.linkFor(r.signalId);
    const ghCalls = pipeline.fakeGh.calls(join(pipeline.ghRoot, 'gh'));
    check('5. a GitHub issue of the tracker repo is linked as itself (source_is_item), nothing created', sg.status === 'linked' && lg?.linkedBy === 'source_is_item' && lg?.itemRef === 'github:acme/web#9' && !ghCalls.some((c) => c.args[0] === 'issue' && c.args[1] === 'create'), { status: sg.status, reason: sg.reason, link: lg, ghCalls });
  } finally {
    await PG.intake.settle();
    await PG.container.dispose();
  }

  // 6. Similarity: the same title from another source links; a close one asks.
  const s6 = await push(slack('p1', pipeline.GAR1_TITLE), 'slack-support');
  check('6. the same title from Slack is linked by similarity, score 1', s6.status === 'linked' && s6.link?.linkedBy === 'similarity' && s6.link?.score === 1 && s6.link?.itemRef === 'youtrack:GAR-1' && creates() === 2, { status: s6.status, reason: s6.reason, link: s6.link });
  const s6b = await push(slack('p2', `${pipeline.GAR1_TITLE} in checkout`), 'slack-support');
  check("…a close title needs a decision: 'Is this the same as GAR-1?'", s6b.status === 'needs_decision' && s6b.reason === 'Is this the same as GAR-1?' && s6b.candidateRef === 'youtrack:GAR-1' && s6b.score >= 0.55 && s6b.score < 0.85 && creates() === 2, { status: s6b.status, reason: s6b.reason, candidateRef: s6b.candidateRef, score: s6b.score });
  const inbox = PA.services.projections.inbox(ws).intakeDecisions ?? [];
  check('…and the Inbox asks it, naming the candidate', inbox.length === 1 && inbox[0].signalId === s6b.id && inbox[0].question === 'Is this the same as GAR-1?' && inbox[0].candidate?.key === 'GAR-1' && inbox[0].sourceLabel === 'Slack', inbox);
  const decided = await PA.intake.decide(PA.caller, s6b.id, 'same');
  const s6c = PA.repo.getSignal(s6b.id);
  check("…'same' links it (person), and the Inbox is empty", decided.status === 'linked' && s6c.status === 'linked' && PA.repo.linkFor(s6b.id)?.linkedBy === 'person' && PA.repo.linkFor(s6b.id)?.itemRef === 'youtrack:GAR-1' && (PA.services.projections.inbox(ws).intakeDecisions ?? []).length === 0, { decided, link: PA.repo.linkFor(s6b.id) });

  // 7. Nothing like it: a new item.
  const s7 = await push(slack('p3', 'Export to CSV is slow'), 'slack-support');
  check('7. an unrelated title is created', s7.status === 'created' && s7.link?.itemRef === 'youtrack:GAR-3' && creates() === 3, { status: s7.status, reason: s7.reason, link: s7.link });
  check('…a reporter with no name reads as their handle', fake.issues.get('GAR-3')?.description.includes('Recorded by Tandemise from Slack, reported by dana.'), fake.issues.get('GAR-3')?.description);

  // 8. The daily cap: sentry-web filed GAR-1 and GAR-2 today.
  PA.config.write(ws, { intake: pipeline.intakeConfig({ dailyCap: 2 }) });
  const capped = (key, title) => sentry({ key, url: `https://acme.sentry.io/issues/${key}/`, title });
  const s8 = await push(capped('cap1', 'Login button misaligned on Firefox'));
  check("8. past the daily cap: 'This source already filed 2 tasks today; decide on this one.'", s8.status === 'needs_decision' && s8.reason === 'This source already filed 2 tasks today; decide on this one.' && s8.candidateRef === null && creates() === 3, { status: s8.status, reason: s8.reason, candidateRef: s8.candidateRef });
  const capCard = (PA.services.projections.inbox(ws).intakeDecisions ?? []).find((d) => d.signalId === s8.id);
  check('…the Inbox card has no candidate', capCard !== undefined && capCard.candidate === null && capCard.question === s8.reason, capCard);
  const s8b = await PA.intake.decide(PA.caller, s8.id, 'new');
  check("…'new' creates it, past the cap", s8b.status === 'created' && PA.repo.linkFor(s8.id)?.itemRef === 'youtrack:GAR-4' && creates() === 4, { s8b, link: PA.repo.linkFor(s8.id) });

  // 9. Not work.
  const s9 = await push(capped('cap2', 'Avatar upload spins forever'));
  const s9b = await PA.intake.decide(PA.caller, s9.id, 'not_work');
  check("9. 'not work' dismisses it: 'You marked this as not work.'", s9.status === 'needs_decision' && s9b.status === 'dismissed' && s9b.reason === 'You marked this as not work.' && PA.repo.linkFor(s9.id) === undefined && creates() === 4, { s9: s9.status, s9b });
  let again = null;
  try { await PA.intake.decide(PA.caller, s9.id, 'new'); } catch (e) { again = e; }
  check("…and deciding again is refused: 'This signal was already decided.'", again?.message === 'This signal was already decided.', again?.message);

  // 10. The tracker is down: the signal waits, and a later tick files it.
  PA.config.write(ws, { intake: pipeline.intakeConfig() });
  await fake.stop();
  const s10 = await push(slack('down1', 'Search results ignore the date filter'), 'slack-support');
  check("10. with YouTrack down the signal stays received: Couldn't reach YouTrack: …", s10.status === 'received' && s10.reason?.startsWith("Couldn't reach YouTrack:") && s10.reason?.endsWith('Tandemise will try again.'), { status: s10.status, reason: s10.reason });
  await fake.restart();
  pipeline.advance(10_000);
  PA.intake.tick();
  await PA.intake.settle();
  check('…a tick within the minute does not try again', PA.repo.getSignal(s10.id).status === 'received' && creates() === 4, PA.repo.getSignal(s10.id).status);
  pipeline.advance(61_000);
  PA.intake.tick();
  await PA.intake.settle();
  const s10b = PA.repo.getSignal(s10.id);
  check('…a tick past the minute files it once YouTrack is back', s10b.status === 'created' && s10b.reason === null && creates() === 5, { status: s10b.status, reason: s10b.reason });

  // A repeat whose events grew tenfold updates the same sources comment, never a new one.
  await push(sentry({ impact: { level: 'error', events: 1500, users: 41, lastSeen: pipeline.clock.now() } }));
  const sourcesComments = (fake.comments.get('GAR-1') ?? []).filter((c) => c.text.startsWith('<!-- tandemise:sources -->'));
  check('a linked signal whose events grew tenfold updates the one sources comment', sourcesComments.length === 1 && sourcesComments[0].text.includes('1500 events'), fake.comments.get('GAR-1'));
  const writes = fake.calls.length;
  await push(sentry({ impact: { level: 'error', events: 1600, users: 41, lastSeen: pipeline.clock.now() } }));
  check('…and a small change writes nothing', fake.calls.slice(writes).every((c) => c.method === 'GET'), fake.calls.slice(writes).map((c) => `${c.method} ${c.path}`));
} catch (e) {
  check('the pipeline section ran', false, String(e?.stack ?? e));
} finally {
  await PA?.intake?.settle?.();
  await PA?.container.dispose();
}

// ------------------------------------------------------------------ crash safety
// Review Focus 1: a crash between the pending link and the tracker call. The
// restarted daemon searches by exact URL before creating, so exactly one item
// exists whether the crash came before or after `create` returned.
section('crash safety: a pending create is finished once after a restart');
try {
  const { app } = pipeline;
  class Crash extends Error {}
  /** A YouTrack factory whose `create` dies before, or right after, the call reaches YouTrack. */
  const crashing = (when) => pipeline.defineModule('crashing-youtrack', (container) => {
    container.contribute(pipeline.I.PRIMARY_TRACKER_FACTORIES, () => ({
      kind: 'youtrack',
      create(config, credential) {
        const real = pipeline.Y.youtrackTrackerFactory.create(config, credential);
        return new Proxy(real, {
          get(target, prop) {
            if (prop === 'create') {
              return async (draft) => {
                if (when === 'before') throw new Crash('the daemon died before create');
                await target.create(draft);
                throw new Crash('the daemon died after create');
              };
            }
            const v = Reflect.get(target, prop, target);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      },
    }), { source: 'check' });
  });
  for (const when of ['before', 'after']) {
    const home = newHome();
    const settings = app.createMemorySettingsStore();
    const secrets = pipeline.memorySecrets();
    const url = `https://acme.sentry.io/issues/crash-${when}/`;
    const first = await pipeline.open({ home, settings, secrets, providers: [crashing(when)] });
    let signalId;
    try {
      const ws = await pipeline.configureYouTrack(first, fake.url);
      const r = await first.intake.ingest({ workspaceId: ws, sourceId: 'sentry-web', tokenId: null }, pipeline.sentry({ key: `crash-${when}`, url, title: when === 'before' ? 'Payment webhook times out' : 'Invoice PDF renders blank' }));
      await first.intake.settle();
      signalId = r.signalId;
      const link = first.repo.linkFor(signalId);
      check(`${when} create: the crash leaves a pending link with no item yet`, link?.status === 'pending' && link?.itemRef === null && link?.linkedBy === 'created', link);
      check(`${when} create: YouTrack holds ${when === 'before' ? 'no' : 'one'} item with the URL`, withUrl(url) === (when === 'before' ? 0 : 1), withUrl(url));
    } finally {
      await first.container.dispose();
    }
    const createsBefore = creates();
    const callsBefore = fake.calls.length;
    const second = await pipeline.open({ home, settings, secrets, providers: [pipeline.Y.youtrackIntegrationModule] });
    try {
      second.intake.tick();
      await second.intake.settle();
      const s = second.repo.getSignal(signalId);
      const link = second.repo.linkFor(signalId);
      check(`${when} create: after the restart exactly one item carries the URL, and the signal is created`, withUrl(url) === 1 && s.status === 'created' && s.reason === null && link?.status === 'done' && link?.itemRef?.startsWith('youtrack:GAR-'), { items: withUrl(url), status: s.status, reason: s.reason, link });
      check(`${when} create: the restart ${when === 'before' ? 'created it once' : 'adopted it by URL, creating nothing'}`, creates() - createsBefore === (when === 'before' ? 1 : 0) && link?.linkedBy === 'created', { created: creates() - createsBefore, link });
      const after = fake.calls.slice(callsBefore);
      const search = after.findIndex((c) => c.method === 'GET' && c.path === '/api/issues' && (c.query.get('query') ?? '').includes(`"${url}"`));
      const create = after.findIndex((c) => c.method === 'POST' && c.path === '/api/issues');
      check(`${when} create: the restart searched by exact URL before any create`, search >= 0 && (create < 0 || search < create), { search, create });
      check(`${when} create: the board cache holds the item`, second.items.byRef(s.workspaceId, link?.itemRef ?? '') !== undefined);
      second.intake.tick();
      await second.intake.settle();
      check(`${when} create: a second tick changes nothing`, withUrl(url) === 1 && second.repo.pendingLinks().length === 0 && creates() - createsBefore === (when === 'before' ? 1 : 0));
    } finally {
      await second.intake.settle();
      await second.container.dispose();
    }
  }
} catch (e) {
  check('the crash safety section ran', false, String(e?.stack ?? e));
} finally {
  await fake.close();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  rmSync(pipeline.ghRoot, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
