// G3 — With the keyboard: select Low with j and press ⌥↑ to move it above a Normal; it becomes Normal and, when the slot frees, it is the one pulled.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { addToBacklog, backlogRows, cancelInWindow, openBacklog, press, readState, statusOf, timelineText } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('G3', 'Keyboard reorder: Low moved above Normal is pulled next');
const { g } = readState();

const second = await addToBacklog(c, `G3 normal: a settings page ${g.run}`);
const tSecond = (await c.api.get(`/v1/missions/${second}`)).mission.title;
await openBacklog(c);
let rows = await backlogRows(c);
ev.check('before: the new Normal is above Low', rows.map((r) => r.title).join('|') === `${tSecond}|${g.titles.low}`, rows.map((r) => `${r.chip} ${r.title}`));

await press(c, 'j');
rows = await backlogRows(c);
ev.check('j selects the second row (Low)', rows[1]?.selected === true && rows[1].title === g.titles.low, rows.map((r) => [r.title, r.selected]));
await page.screenshot(ev.shot('low-selected'));
await press(c, 'ArrowUp', { alt: true });
await until(async () => (await backlogRows(c))[0]?.title === g.titles.low, { label: 'low moved up', timeoutMs: 10_000 }).catch(() => undefined);
rows = await backlogRows(c);
const flash = await c.flash();
ev.check('⌥↑ moves Low above the Normal', rows.map((r) => r.title).join('|') === `${g.titles.low}|${tSecond}`, rows.map((r) => r.title));
ev.check('it now reads Normal (chip and select)', rows[0]?.chip === 'Normal' && rows[0].priority === 'Normal', rows[0]);
ev.check('the window says so', flash.startsWith('Now Normal priority, above “') && flash.includes(tSecond), flash);
ev.check('the selection follows the moved row', rows[0]?.selected === true, rows.map((r) => [r.title, r.selected]));
ev.check('proof (API): Low is now normal priority and ranked first', (await c.api.get(`/v1/missions/${g.low}`)).mission.priority === 'normal');
await page.screenshot(ev.shot('low-moved-up'));

// Free the slot the way a person would: cancel the mission in progress from its page.
await cancelInWindow(c, g.normal);
await until(async () => (await statusOf(c, g.low)) !== 'DRAFT', { label: 'low pulled', timeoutMs: 30_000 });
ev.check('proof (API): the moved mission is pulled; the other Normal waits', (await statusOf(c, g.low)) !== 'DRAFT' && (await statusOf(c, second)) === 'DRAFT', [await statusOf(c, g.low), await statusOf(c, second)]);
const timeline = await timelineText(c, g.low);
ev.check('its timeline: "Pulled from the backlog (1 of 1)"', timeline.includes('Pulled from the backlog (1 of 1)'), timeline.slice(0, 400));
await page.screenshot(ev.shot('low-pulled'));
await sleep(200);
c.close(); ev.save();
