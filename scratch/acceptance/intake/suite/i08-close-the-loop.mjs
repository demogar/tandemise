// I8 — A person sets the item to Fixed in YouTrack. Sentry is resolved `inCommit` (the mission's commit, in
// acme/web, which Sentry links), the Slack thread gets exactly one reply, and the Intake tab shows both Closed.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { checkSourcesNow, intakeStatus, openBoard, readScenarioState, sentry, slack, yt } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('I8', 'The item is done: the loop closes at Sentry and in Slack');
const { sentryKey, slackRoot, slackFingerprint } = readScenarioState();

await yt.edit(sentryKey, { state: 'Fixed' });
await openBoard(c);
await checkSourcesNow(c);
const resolve = await until(async () => (await sentry.state()).calls.find((x) => x.method === 'PUT' && x.path === '/api/0/issues/501/'), { label: 'Sentry resolved', timeoutMs: 60_000 });
ev.check('proof (fake Sentry): issue 501 resolved inCommit, in acme/web', resolve.body?.status === 'resolved' && resolve.body?.statusDetails?.inCommit?.repository === 'acme/web' && /^[0-9a-f]{40}$/.test(resolve.body.statusDetails.inCommit.commit ?? ''), resolve.body);
const replies = async () => (await slack.state()).messages.filter((m) => m.thread_ts === slackRoot && m.user === 'U0BOT');
const reply = await until(async () => { const list = await replies(); return list.length > 0 && list; }, { label: 'the Slack reply', timeoutMs: 60_000 });
ev.check(`proof (fake Slack): one thread reply naming ${sentryKey}`, reply.length === 1 && reply[0].text.includes(sentryKey), reply.map((m) => m.text));

const sentryFingerprint = (await c.api.get(`/v1/workspaces/${c.env.workspaceId}/intake/signals`)).find((s) => s.sourceId === 'sentry-web' && s.key === '501')?.fingerprint;
await openBoard(c, 'intake');
const s = await intakeStatus(c, sentryFingerprint, (x) => x === 'Closed', 'Sentry Closed');
const k = await intakeStatus(c, slackFingerprint, (x) => x === 'Closed', 'Slack Closed');
ev.check('Intake: the Sentry signal reads "Closed"', s.status === 'Closed', s);
ev.check('Intake: the Slack signal reads "Closed"', k.status === 'Closed', k);
await page.screenshot(ev.shot('intake-closed'));

await sleep(8000);
const puts = (await sentry.state()).calls.filter((x) => x.method === 'PUT' && x.path === '/api/0/issues/501/');
ev.check('nothing is written twice on later passes', puts.length === 1 && (await replies()).length === 1, { puts: puts.length, replies: (await replies()).length });
c.close(); ev.save();
