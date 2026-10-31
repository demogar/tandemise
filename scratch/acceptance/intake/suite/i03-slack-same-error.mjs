// I3 — The same error, reported in Slack's #support with a :tandemise: reaction. No new row; the row's chips
// include Slack; the Intake tab says "Linked to <key>"; the fake YouTrack still has one create.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { boardGroups, boardRow, intakeStatus, openBoard, readScenarioState, slack, writeScenarioState, yt } from '../common.mjs';

const c = await context();
const { page, until } = c;
const ev = new Evidence('I3', 'The same error from Slack links to the item instead of filing another');
const { sentryKey } = readScenarioState();

await until(async () => (await slack.state()).opened > 0, { label: 'the Slack runner connected', timeoutMs: 60_000 });
const root = await slack.post({ channel: 'C0SUPPORT', user: 'U0KIM', text: 'TypeError: basket is null' });
await slack.post({ channel: 'C0SUPPORT', user: 'U0SAM', text: 'Same here, on an empty basket', thread_ts: root.ts });
await openBoard(c);
const rows = async () => Object.values(await boardGroups(c)).flatMap((g) => g.rows);
const before = (await rows()).length;
await until(async () => (await slack.emit({ type: 'reaction_added', user: 'U0KIM', reaction: 'tandemise', item: { type: 'message', channel: 'C0SUPPORT', ts: root.ts }, event_ts: root.ts })).delivered !== null, { label: 'the reaction delivered', timeoutMs: 30_000 });
const signal = await until(async () => (await c.api.get(`/v1/workspaces/${c.env.workspaceId}/intake/signals`)).find((s) => s.sourceId === 'slack-support' && s.status === 'linked'), { label: 'the Slack signal linked', timeoutMs: 30_000 });

const row = await until(async () => { const r = await boardRow(c, sentryKey); return r?.chips.some((x) => x.startsWith('Slack')) && r; }, { label: 'a Slack chip', timeoutMs: 30_000 });
ev.check('no new row', (await rows()).length === before, { before, after: (await rows()).length });
ev.check(`${sentryKey}'s chips now include Slack`, row.chips.includes('Slack · thread') && row.chips.includes('Sentry · 132 events'), row.chips);
await page.screenshot(ev.shot('board-two-sources'));

await openBoard(c, 'intake');
const linked = await intakeStatus(c, signal.fingerprint, (s) => s === `Linked to ${sentryKey}`, 'Linked to …');
ev.check(`the Intake tab says "Linked to ${sentryKey}"`, linked.status === `Linked to ${sentryKey}` && linked.source.startsWith('Slack'), linked);
await page.screenshot(ev.shot('intake-linked'));
ev.check('proof (fake YouTrack): still one create', (await yt.creates()).length === 1, (await yt.creates()).length);
const reacted = (await slack.state()).reactions[`C0SUPPORT:${root.ts}`] ?? [];
ev.check('proof (fake Slack): the thread was acknowledged with :eyes:', reacted.includes('eyes'), reacted);
writeScenarioState({ slackRoot: root.ts, slackFingerprint: signal.fingerprint });
c.close(); ev.save();
