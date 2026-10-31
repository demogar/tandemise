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

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
