// E4 — QA fails AC2: the checklist shows AC2 "Failed" with QA's evidence, and the QA gate fails on qa.criteria_failed.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { createMission, resetStaffing, waitTask, feedShows, rowText, cancel, interventionText } from '../common.mjs';

const c = await context();
const { page, sleep, until } = c;
const ev = new Evidence('E4', 'A failed criterion shows as Failed and stops QA');
await resetStaffing(c);

const title = `E4 SCRIPTED_QA_FAIL_AC2 ${Date.now().toString(36)}`;
const missionId = await createMission(c, title, ['The page greets the visitor by name', 'The page works offline']);
ev.note(`mission ${missionId}`);
await c.approvePlan(missionId, title);
const qa = await waitTask(c, missionId, 'qa', (t) => ['SUCCEEDED', 'BLOCKED', 'FAILED'].includes(t.status), 'qa settled', 120_000);
ev.check('QA blocks: a failed criterion fails its gate', qa.status === 'BLOCKED', { status: qa.status, reason: qa.statusReason });

const text = await feedShows(c, missionId, 'Failed');
const ac2 = await rowText(c, 'AC2');
ev.check('AC2 reads "Failed" with QA\'s evidence', /Failed$/.test(ac2) && ac2.includes('The scripted check for AC2 failed'), ac2);
ev.check('AC1 reads "Verified"; the header reads "1 of 2 verified"', /Verified$/.test(await rowText(c, 'AC1')) && text.includes('1 of 2 verified'), text);
ev.check('the user lines AC2 covers read "Failed" too', /Failed$/.test(await rowText(c, 'U1')), await rowText(c, 'U1'));
await page.screenshot(ev.shot('ac2-failed'));


await page.evaluate(`(() => { const r = [...document.querySelectorAll('section[aria-label="Done when"] button.list__row')].find((x) => x.querySelector('.mono')?.innerText.trim() === 'AC2'); r?.click(); })()`);
const drawer = await until(async () => { const d = await c.dialogText('QA report'); return /AC2: FAIL/.test(d) && d; }, { label: 'QA report drawer', timeoutMs: 15_000 }).catch(() => c.dialogText('QA report'));
ev.check('clicking AC2 opens the QA report that failed it', /AC2: FAIL/.test(drawer) && drawer.includes('The scripted check for AC2 failed'), drawer.slice(0, 600));
await sleep(600);
await page.screenshot(ev.shot('qa-report-ac2'));
await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

const card = await interventionText(c, 'qa');
ev.check('the Inbox card for qa reads "qa.criteria_failed is 1, needs 0" and names AC2', card.includes('Not met: qa.criteria_failed is 1, needs 0') && card.includes('Failed in QA: AC2 ('), card.slice(0, 1400));
await page.screenshot(ev.shot('inbox-card-failed'));

const release = await c.task(missionId, 'release');
ev.check('the release never started', ['PENDING', 'READY'].includes(release.status) || release.attempts === 0, { status: release.status, attempts: release.attempts });

await cancel(c, missionId, 'E4');
c.close(); ev.save();
