// B9 — "Remember this" with a fake token in the text: the lesson is saved with "[redacted secret]", and the bare
// repository never contains the token.
import { Evidence } from '../../p0/lib/evidence.mjs';
import { clickIn, home1, openBrainTab, remoteLog, typeInto } from '../common.mjs';

const c = await home1();
const ev = new Evidence('B9', 'A secret typed into Remember this never reaches the brain');
const token = `ghp_${'B9'.repeat(18)}`;
await openBrainTab(c, 'lessons');
await typeInto(c, 'Remember this text', `Deploy with ${token} on Fridays.`);
await c.sleep(300);
await clickIn(c, '[aria-label="Remember this"]', 'Remember');
const row = await c.until(() => c.page.evaluate(`[...document.querySelectorAll('[aria-label="Lesson list"] .brain__text')].map((t) => t.innerText).find((t) => t.startsWith('Deploy with')) ?? false`), { label: 'saved lesson', timeoutMs: 30_000 });
ev.check('the row shows [redacted secret]', row === 'Deploy with [redacted secret] on Fridays.', row);
ev.check('the window never shows the token', !(await c.page.evaluate('document.body.innerText')).includes(token));
await c.page.screenshot(ev.shot('redacted'));
await openBrainTab(c, 'sync');
await clickIn(c, 'section[aria-label="Brain sync"]', 'Sync now');
await c.sleep(3000);
const log = remoteLog();
ev.check('the bare repository has the lesson', log.includes('Deploy with [redacted secret] on Fridays.'));
ev.check('and never the token: no ghp_ anywhere in git log -p --all', !log.includes('ghp_'));
c.close(); ev.save();
