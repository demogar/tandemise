// I4 — A Sentry error with 3 events: not on the Board; the Intake tab says
// "Held back: 3 events in 24 h; this source needs 20"; nothing is filed in YouTrack.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { boardGroups, checkSourcesNow, intakeStatus, openBoard, sentry, yt } from '../common.mjs';

const c = await context();
const { page, until } = c;
const ev = new Evidence('I4', 'A quiet error is held back, with the reason in words');
const TITLE = 'RangeError: avatar upload too large';

await sentry.put({ id: '502', title: TITLE, culprit: 'profile/avatar.ts', level: 'error', count: 3, userCount: 1 });
await openBoard(c);
await checkSourcesNow(c);
const signal = await until(async () => (await c.api.get(`/v1/workspaces/${c.env.workspaceId}/intake/signals`)).find((s) => s.title === TITLE), { label: 'the quiet signal', timeoutMs: 30_000 });
const onBoard = Object.values(await boardGroups(c)).flatMap((g) => g.rows).some((r) => r.title === TITLE);
ev.check('not on the Board', !onBoard);

await openBoard(c, 'intake');
const row = await intakeStatus(c, signal.fingerprint, (s) => s.startsWith('Held back'), 'Held back');
ev.check('Intake: "Held back: 3 events in 24 h; this source needs 20"', row.status === 'Held back: 3 events in 24 h; this source needs 20', row);
await page.screenshot(ev.shot('intake-held-back'));
ev.check('proof (fake YouTrack): still one create', (await yt.creates()).length === 1, (await yt.creates()).length);
c.close(); ev.save();
