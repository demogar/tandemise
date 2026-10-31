// B7 — Both homes write a lesson, then both press Sync now: both Brain screens list the same lessons and counters.
import { Evidence } from '../../p0/lib/evidence.mjs';
import { clickIn, home1, home2, lessonRows, openBrainTab, typeInto } from '../common.mjs';

const ev = new Evidence('B7', 'Two homes write lessons, sync, and see the same memory');
const a = await home1();
const b = await home2();
const remember = async (c, text) => {
  await openBrainTab(c, 'lessons');
  await typeInto(c, 'Remember this text', text);
  await c.sleep(300);
  await clickIn(c, '[aria-label="Remember this"]', 'Remember');
  await c.until(() => c.page.evaluate(`[...document.querySelectorAll('[aria-label="Lesson list"] .brain__text')].some((t) => t.innerText === ${JSON.stringify(text)})`), { label: `lesson ${text}`, timeoutMs: 30_000 });
};
const sync = async (c) => {
  await openBrainTab(c, 'sync');
  await clickIn(c, 'section[aria-label="Brain sync"]', 'Sync now');
  await c.until(async () => !(await c.page.evaluate(`document.body.innerText.includes('Syncing…')`)), { label: 'synced', timeoutMs: 60_000 });
  await c.sleep(800);
};
await remember(a, 'Home one: name branches after the issue.');
await remember(b, 'Home two: write the changelog line with the change.');
await sync(a);
await sync(b);
await sync(a);
await openBrainTab(a, 'lessons');
await openBrainTab(b, 'lessons');
const rowsA = await lessonRows(a);
const rowsB = await lessonRows(b);
const key = (rows) => JSON.stringify(rows.map((r) => [r.text, r.counters, r.state]));
ev.check('both lists have both lessons', [rowsA, rowsB].every((rows) => rows.some((r) => r.text.startsWith('Home one:')) && rows.some((r) => r.text.startsWith('Home two:'))), [rowsA.length, rowsB.length]);
ev.check('both Lessons lists show the same texts and counters', key(rowsA) === key(rowsB), { a: rowsA, b: rowsB });
await a.page.screenshot(ev.shot('home1-lessons'));
await b.page.screenshot(ev.shot('home2-lessons'));
a.close(); b.close(); ev.save();
