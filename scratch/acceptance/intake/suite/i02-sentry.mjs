// I2 — A Sentry issue with 132 events; Check sources now. One new row on the Board with the chip
// "Sentry · 132 events"; the fake YouTrack recorded exactly one create, whose description has a Sources section.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { REAL_YOUTRACK, boardGroups, checkSourcesNow, openBoard, sentry, writeScenarioState, yt } from '../common.mjs';

const c = await context();
const { page, until } = c;
const ev = new Evidence('I2', 'A busy Sentry error becomes one tracker item, with its chip');
const TITLE = 'TypeError: basket is null';

await sentry.put({ id: '501', title: TITLE, culprit: 'checkout/basket.ts', level: 'error', count: 132, userCount: 41 });
await openBoard(c);
const rowsOf = (g) => Object.values(g).flatMap((x) => x.rows);
const before = rowsOf(await boardGroups(c));
const sawChecking = await checkSourcesNow(c);
ev.check('the button said "Checking…" while it waited', sawChecking);
const row = await until(async () => rowsOf(await boardGroups(c)).find((r) => r.title === TITLE), { label: 'the Sentry row', timeoutMs: 30_000 });
const after = rowsOf(await boardGroups(c));
ev.check('one new row on the Board', after.length === before.length + 1, { before: before.map((r) => r.key), after: after.map((r) => r.key) });
ev.check('its chip reads "Sentry · 132 events"', row.chips.includes('Sentry · 132 events'), row.chips);
ev.check('it is Ready', (await boardGroups(c)).ready.rows.some((r) => r.key === row.key), row.key);
await page.screenshot(ev.shot('board-sentry'));

if (!REAL_YOUTRACK) {
  const creates = await yt.creates();
  ev.check('proof (fake YouTrack): exactly one create', creates.length === 1, creates.length);
  const item = await yt.issue(row.key);
  ev.check('proof (fake YouTrack): its description has a "## Sources" section with the Sentry link', item?.description.includes('## Sources') && item.description.includes('/issues/501/'), item?.description);
}
writeScenarioState({ sentryKey: row.key });
c.close(); ev.save();
