// Intake's primary trackers (spec 2026-10-30-intake-design.md §6): the
// `PrimaryTracker` port's pure helpers and its adapters, each driven against
// an in-process fake. Never a real tracker.
//
//   npm run build && node scratch/intake-tracker-check.mjs
//
// Sections grow with the plan's tasks. Task 4 pins the pure helpers and the
// YouTrack adapter against `scratch/fake-youtrack.mjs`.
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
const finish = () => {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
};

const D = await import('@tandemise/domain');
const I = await import('@tandemise/integrations-core');
const K = await import('@tandemise/kernel');

const STATES = ['Open', 'Submitted', 'In Progress', 'In Review', 'Fixed', 'Done', "Won't fix", 'Duplicate', 'Obsolete'];

// ------------------------------------------------------------------ pure
section('pure: refs, markers and the Sources section');
{
  check('trackerRef is <tracker>:<key>', D.trackerRef?.('youtrack', 'GAR-12') === 'youtrack:GAR-12' && D.trackerRef?.('github', 'acme/web#42') === 'github:acme/web#42');
  check('markerLine is an HTML comment', D.markerLine?.('tandemise:sources') === '<!-- tandemise:sources -->' && D.markerLine?.('tandemise:activity') === '<!-- tandemise:activity -->');
  const parsed = D.parseSourcesSection?.('x\n\n## Sources\n- Sentry · acme/web · https://s.test/1\n- Slack thread · https://slack.test/a');
  check('parseSourcesSection lists the URLs', eq(parsed, ['https://s.test/1', 'https://slack.test/a']), parsed);
  check('a description with no Sources section lists none', eq(D.parseSourcesSection?.('just text\n- https://x.test/1'), []));
  const section1 = D.sourcesSection?.(['Sentry · acme/web · 132 events, 41 users · https://s.test/1']);
  check('sourcesSection renders the heading and one line per source', section1 === '## Sources\n- Sentry · acme/web · 132 events, 41 users · https://s.test/1', section1);
  check('sourcesSection round-trips through parseSourcesSection', eq(D.parseSourcesSection?.(`D\n\n${section1}\n\nRecorded by Tandemise.`), ['https://s.test/1']));

  const one = D.sourcesCommentWith?.(null, { url: 'https://s.test/1', title: 'Sentry · acme/web', context: '132 events\nreported by @sam' });
  const two = D.sourcesCommentWith?.(one, { url: 'https://slack.test/a', title: 'Slack thread', context: '' });
  const again = D.sourcesCommentWith?.(two, { url: 'https://s.test/1', title: 'Sentry · acme/web', context: '1320 events' });
  check('the sources comment lists each URL once, in the order first seen', eq(D.parseSourcesSection?.(again), ['https://s.test/1', 'https://slack.test/a']), again);
  check('a repeated URL has its line replaced, not appended', typeof again === 'string' && again.includes('1320 events') && !again.includes('132 events\n') && again.split('https://s.test/1').length === 2, again);
  check('copied context is escaped: @mentions are broken', typeof one === 'string' && !one.includes('@sam') && one.includes('@​sam'), one);
  check('sourcesCommentBody renders entries as the Sources section', typeof D.sourcesCommentBody === 'function' && eq(D.parseSourcesSection?.(D.sourcesCommentBody([{ url: 'https://a.test/1', title: 'A', context: '' }])), ['https://a.test/1']));
}

// ------------------------------------------------------------------ youtrack
section('youtrack: the adapter against the fake');
let Y;
try {
  Y = await import('@tandemise/integration-youtrack');
} catch (e) {
  check('@tandemise/integration-youtrack loads', false, String(e?.message ?? e));
  finish();
}
const fake = await startFakeYouTrack({ project: 'GAR', states: STATES, types: ['Bug', 'Task'], token: 'perm:test', login: 'tandemise-bot' });
try {
  const yt = new Y.YouTrackTracker({ url: fake.url, project: 'GAR', token: 'perm:test' });
  check('kind and capabilities', yt.kind === 'youtrack' && eq(yt.capabilities, { editComments: true, attachments: true, duplicateLinks: true }), yt.capabilities);

  const described = await yt.describe();
  check('describe() returns the nine states and the types', eq(described.states, STATES) && eq(described.types, ['Bug', 'Task']), described);
  check('describe() lists every field name', ['State', 'Type', 'Assignee'].every((f) => described.fields.includes(f)), described.fields);

  const mapping = (states, onComplete = 'in_review') => ({
    kind: 'youtrack', url: fake.url, project: 'GAR', board: 'project: GAR #Unresolved', onComplete,
    states: { ready: ['Open'], in_progress: 'In Progress', in_review: 'In Review', done: ['Fixed', 'Done'], wont_do: ["Won't fix", 'Duplicate', 'Obsolete'], ...states },
  });
  const bad = D.stateMappingProblem(mapping({ in_progress: 'In Review!' }), described);
  check("a mapping naming a missing state: YouTrack has no state 'In Review!' in GAR. Its states are: …",
    bad === "YouTrack has no state 'In Review!' in GAR. Its states are: Open, Submitted, In Progress, In Review, Fixed, Done, Won't fix, Duplicate, Obsolete.", bad);
  const noReview = mapping({});
  const { in_review: _dropped, ...withoutReview } = noReview.states;
  const missing = D.stateMappingProblem({ ...noReview, states: withoutReview }, described);
  check('in_review absent with onComplete in_review: Without an in-review state, a finished mission can only mark the task done.',
    missing === 'Without an in-review state, a finished mission can only mark the task done.', missing);
  check('in_review absent with onComplete done is fine', D.stateMappingProblem({ ...noReview, states: withoutReview, onComplete: 'done' }, described) === null);
  check('a valid mapping has no problem', D.stateMappingProblem(mapping({}), described) === null);

  const created = await yt.create({ title: 'T', description: 'D\n\n## Sources\n- Sentry · acme/web · https://s.test/1', type: 'Bug' });
  check("create() returns key 'GAR-1' and ref youtrack:GAR-1", created.key === 'GAR-1' && created.ref === 'youtrack:GAR-1' && created.title === 'T', created);
  check('create() reads the item back: type Bug, state Open, a url on the tracker', created.type === 'Bug' && created.state === 'Open' && created.url === `${fake.url}/issue/GAR-1`, created);
  check('the fake recorded one command, Type Bug', eq(fake.commands.map((c) => c.query), ['Type Bug']) && fake.commands[0].issues[0].idReadable === 'GAR-1', fake.commands);
  check('every request carried the token and asked for JSON', fake.calls.length > 0 && fake.calls.every((c) => c.authorization === 'Bearer perm:test' && c.accept === 'application/json'));

  const found = await yt.search({ url: 'https://s.test/1', limit: 5 });
  check('search({ url }) finds GAR-1', eq(found.map((i) => i.key), ['GAR-1']), found.map((i) => i.key));
  const searchCall = fake.calls.findLast((c) => c.path === '/api/issues' && c.method === 'GET');
  check('search({ url }) is a quoted query scoped to the project', searchCall?.query.get('query') === 'project: GAR "https://s.test/1"' && searchCall?.query.get('$top') === '5', searchCall?.query.get('query'));
  check('search({ url }) of an unknown URL finds nothing', (await yt.search({ url: 'https://s.test/2', limit: 5 })).length === 0);

  const second = await yt.create({ title: "TypeError: cannot read 'id' of undefined", description: 'x', fields: { Subsystem: 'Web' } });
  check('fields are set by one command', fake.commands.at(-1)?.query === 'Subsystem Web', fake.commands.at(-1));
  await yt.search({ text: "TypeError: cannot read 'id' of undefined in checkout", unresolvedOnly: true, limit: 20 });
  const textCall = fake.calls.findLast((c) => c.path === '/api/issues' && c.method === 'GET');
  check('search({ text }) asks for the unresolved items with the title words', textCall?.query.get('query') === 'project: GAR #Unresolved typeerror read id undefined checkout' && textCall?.query.get('$top') === '20', textCall?.query.get('query'));
  const byText = await yt.search({ text: "TypeError: cannot read 'id' of undefined", unresolvedOnly: true, limit: 20 });
  check('search({ text }) finds the item whose title has those words', eq(byText.map((i) => i.key), [second.key]), byText.map((i) => i.key));
  const longTitle = 'one two three four five six seven eight nine ten';
  await yt.search({ text: longTitle, limit: 20 });
  check('search({ text }) sends at most 8 words, and no #Unresolved unless asked',
    fake.calls.findLast((c) => c.path === '/api/issues' && c.method === 'GET')?.query.get('query') === 'project: GAR one two three four five six seven eight');

  const ref = created.ref;
  const c1 = await yt.comment(ref, { marker: 'tandemise:activity', body: 'v1' });
  const c2 = await yt.comment(ref, { marker: 'tandemise:activity', body: 'v2' });
  const onGar1 = fake.comments.get('GAR-1') ?? [];
  check('comment() twice leaves exactly one comment on GAR-1', onGar1.length === 1, onGar1);
  check('its text starts with the marker and ends with v2', onGar1[0]?.text.startsWith('<!-- tandemise:activity -->') && onGar1[0]?.text.endsWith('v2'), onGar1[0]?.text);
  check('the second call edited the first comment', c1.commentId === c2.commentId && c1.commentId === onGar1[0]?.id, { c1, c2 });
  const c3 = await yt.comment(ref, { marker: 'tandemise:activity', body: 'v3', knownId: c1.commentId });
  check('a known id is edited in place', c3.commentId === c1.commentId && (fake.comments.get('GAR-1') ?? []).length === 1 && fake.comments.get('GAR-1')[0].text.endsWith('v3'));
  const c4 = await yt.comment(ref, { marker: 'tandemise:activity', body: 'v4', knownId: '999-999' });
  check('a known id that is gone falls back to the comment found by marker', c4.commentId === c1.commentId && fake.comments.get('GAR-1')[0].text.endsWith('v4'), c4);

  fake.putComment(second.key, { author: 'someone-else', text: '<!-- tandemise:activity -->\n\nI copied the marker.' });
  const c5 = await yt.comment(second.ref, { marker: 'tandemise:activity', body: 'ours' });
  const onSecond = fake.comments.get(second.key) ?? [];
  check("another user's comment with the marker is not adopted: a new comment is posted",
    onSecond.length === 2 && onSecond[0].text.endsWith('I copied the marker.') && onSecond[1].id === c5.commentId && onSecond[1].author === 'tandemise-bot', onSecond);

  await yt.link(ref, { url: 'https://slack.test/a', title: 'Slack thread', context: 'Ana: checkout is broken' });
  await yt.link(ref, { url: 'https://slack.test/a', title: 'Slack thread', context: 'Ana: checkout is broken again' });
  const sourcesComments = (fake.comments.get('GAR-1') ?? []).filter((c) => c.text.startsWith('<!-- tandemise:sources -->'));
  check('link() twice with the same URL keeps one sources comment', sourcesComments.length === 1, fake.comments.get('GAR-1'));
  check('…with one line for that URL, carrying the latest context', sourcesComments[0]?.text.split('https://slack.test/a').length === 2 && sourcesComments[0]?.text.includes('broken again'), sourcesComments[0]?.text);
  await yt.link(ref, { url: 'https://s.test/9', title: 'Sentry · acme/web', context: '' });
  const afterThird = (fake.comments.get('GAR-1') ?? []).filter((c) => c.text.startsWith('<!-- tandemise:sources -->'));
  check('a new URL is added to the same comment', afterThird.length === 1 && eq(D.parseSourcesSection(afterThird[0].text), ['https://slack.test/a', 'https://s.test/9']), afterThird[0]?.text);
  check('search({ url }) finds an item by a URL in its sources comment', eq((await yt.search({ url: 'https://slack.test/a', limit: 5 })).map((i) => i.key), ['GAR-1']));

  await yt.transition(ref, 'In Progress');
  check('transition() sends the command State In Progress', fake.commands.at(-1)?.query === 'State In Progress' && fake.commands.at(-1)?.issues[0].idReadable === 'GAR-1', fake.commands.at(-1));
  const got = await yt.get(ref);
  check("get() then shows state 'In Progress'", got.state === 'In Progress' && got.key === 'GAR-1', got);

  await yt.markDuplicate(second.ref, ref);
  check('markDuplicate(GAR-2, GAR-1) sends the command duplicates GAR-1 to GAR-2', fake.commands.at(-1)?.query === 'duplicates GAR-1' && fake.commands.at(-1)?.issues[0].idReadable === 'GAR-2', fake.commands.at(-1));
  await yt.assign(ref, 'ana');
  check('assign() sends the command Assignee <login>', fake.commands.at(-1)?.query === 'Assignee ana' && (await yt.get(ref)).assignee === 'ana');
  check('viewer() is the signed-in login', (await yt.viewer()) === 'tandemise-bot');

  // GAR-2 is a duplicate now, so resolved; GAR-1 is fixed by a person; GAR-3 is new.
  fake.setState('GAR-1', 'Fixed');
  fake.putIssue({ summary: 'Fresh' });
  const board = await yt.board({ query: 'project: GAR #Unresolved', limit: 50 });
  check('board() runs the given query: resolved items are not on it', eq(board.map((i) => i.key), ['GAR-3']), board.map((i) => i.key));
  const all = await yt.board({ query: 'project: GAR', limit: 50 });
  check('board() maps every item', eq(all.map((i) => i.key).sort(), ['GAR-1', 'GAR-2', 'GAR-3']) && all.every((i) => i.ref.startsWith('youtrack:') && typeof i.updatedAt === 'string' && typeof i.createdAt === 'string'));
  const since = await yt.board({ query: 'project: GAR', updatedSince: all.find((i) => i.key === 'GAR-3').updatedAt, limit: 50 });
  check('board({ updatedSince }) keeps only the items updated since', eq(since.map((i) => i.key), ['GAR-3']), since.map((i) => i.key));
  check('refFromUrl() knows its own items and nothing else',
    yt.refFromUrl(`${fake.url}/issue/GAR-12/checkout-breaks`) === 'youtrack:GAR-12' && yt.refFromUrl(`${fake.url}/issue/OTHER-1`) === null && yt.refFromUrl('https://s.test/1') === null);

  const notThere = await refusal(() => yt.get(D.trackerRef('youtrack', 'GAR-404')));
  check('get() of a missing item is NOT_FOUND', notThere?.code === 'NOT_FOUND', notThere?.message);

  const wrong = new Y.YouTrackTracker({ url: fake.url, project: 'GAR', token: 'perm:wrong' });
  const refused = await refusal(() => wrong.search({ url: 'https://s.test/1', limit: 5 }));
  check("a wrong token: INTEGRATION_FAILED, YouTrack refused the token. Make a new permanent token and save it in the project's tracker settings.",
    refused?.code === 'INTEGRATION_FAILED' && refused?.message === "YouTrack refused the token. Make a new permanent token and save it in the project's tracker settings.", { code: refused?.code, message: refused?.message });

  const withFile = await yt.create({ title: 'With a file', description: 'x', attachments: [{ name: 'trace.txt', mediaType: 'text/plain', content: new TextEncoder().encode('stack') }] });
  check('an attachment with content is uploaded to the item', eq((fake.attachments.get(withFile.key) ?? []).map((a) => a.name), ['trace.txt']), fake.attachments.get(withFile.key));

  // The composition seam: the module contributes a factory for `kind: youtrack`.
  check('integrations-core exports PRIMARY_TRACKER_FACTORIES', I.PRIMARY_TRACKER_FACTORIES !== undefined && K.isMultiToken(I.PRIMARY_TRACKER_FACTORIES));
  const container = K.compose(new K.Container(), Y.youtrackIntegrationModule);
  const factories = container.resolveAll(I.PRIMARY_TRACKER_FACTORIES);
  const factory = factories.find((f) => f.kind === 'youtrack');
  check('the youtrack module contributes a youtrack factory', factory !== undefined, factories.map((f) => f.kind));
  const built = factory?.create(mapping({}), 'perm:test');
  check('the factory builds a working tracker from the config and the credential', built !== undefined && (await built.viewer()) === 'tandemise-bot');
  const noToken = await refusal(() => factory.create(mapping({}), undefined));
  check('the factory refuses without a credential', noToken?.code === 'PRECONDITION_FAILED', noToken?.message);

  fake.delayNext('/api/users/me', 300);
  const slow = new Y.YouTrackTracker({ url: fake.url, project: 'GAR', token: 'perm:test', timeoutMs: 50 });
  const timedOut = await refusal(() => slow.viewer());
  check('a request past its timeout fails as INTEGRATION_FAILED, retryable', timedOut?.code === 'INTEGRATION_FAILED' && timedOut?.retryable === true, { code: timedOut?.code, message: timedOut?.message });
} catch (e) {
  check('the youtrack section ran', false, String(e?.stack ?? e));
} finally {
  await fake.close();
}

finish();
