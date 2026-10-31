// I7 — You approve the plan in the Inbox and the scripted agent completes the mission. The fake YouTrack moves
// the item to the mapped onComplete state (In Review), and the one activity comment shows the criteria table:
// "Done in Tandemise — N of N criteria verified."
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { boardGroups, openBoard, readScenarioState, settle, yt } from '../common.mjs';

const c = await context();
const { page, until } = c;
const ev = new Evidence('I7', 'The mission completes: the item moves to In Review and the comment shows the criteria');
const { sentryKey, missionId, missionTitle } = readScenarioState();

await c.approvePlan(missionId, missionTitle);
const status = await settle(c, missionId);
ev.check('the mission completes', status === 'COMPLETE', status);

const state = await until(async () => { const i = await yt.issue(sentryKey); return i?.state === 'In Review' && i.state; }, { label: 'In Review', timeoutMs: 60_000 });
ev.check(`proof (fake YouTrack): ${sentryKey} is In Review (onComplete)`, state === 'In Review', state);
// Edits wait a minute after the last one (spec §7), so the completed body can take that long to land.
const activity = await until(async () => {
  const list = (await yt.comments(sentryKey)).filter((x) => x.text.startsWith('<!-- tandemise:activity -->'));
  return list.length === 1 && list[0].text.includes('criteria verified') && list;
}, { label: 'the completed activity comment', timeoutMs: 150_000, everyMs: 2000 });
// The spec step may add criteria of its own (the scripted agent adds one), so the check is "every one".
ev.check('proof (fake YouTrack): still one activity comment, now "Done in Tandemise — N of N criteria verified."', activity.length === 1 && /Done in Tandemise — (\d+) of \1 criteria verified\./.test(activity[0].text), activity[0].text);
ev.check("…with the criteria table: the item's own criterion is U1, Verified", /\| U1 \| Checkout no longer throws when the basket is empty \| Verified \|/.test(activity[0].text), activity[0].text);

await openBoard(c);
const row = await until(async () => (await boardGroups(c)).inReview?.rows.find((r) => r.key === sentryKey), { label: `${sentryKey} under In review`, timeoutMs: 30_000 });
ev.check(`the Board lists ${sentryKey} under In review, its mission Complete`, row.text.includes('Mission: Complete'), row.text);
await page.screenshot(ev.shot('board-in-review'));
c.close(); ev.save();
