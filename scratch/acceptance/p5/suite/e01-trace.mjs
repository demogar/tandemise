// E1 — Two Done-when lines become U1 and U2; the spec answers with AC1 covering both; QA verifies AC1 and the checklist reads 1 of 1.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { createMission, resetStaffing, waitTask, feedShows, rowText, cancel } from '../common.mjs';

const c = await context();
const { page, api, sleep, until } = c;
const ev = new Evidence('E1', 'Done-when lines trace from the request to QA');
// The spec waits for your review, so the checklist can be read between the spec and QA.
await resetStaffing(c, { reviewSpec: true });

const title = `E1 trace ${Date.now().toString(36)}`;
const lines = ['The page greets the visitor by name', 'The page works offline'];
const missionId = await createMission(c, title, lines);
ev.note(`mission ${missionId}`);

let text = await feedShows(c, missionId, 'U2');
ev.check('the feed opens with "Done when" listing U1 and U2 in the person\'s words', /Done when/.test(text) && text.includes('U1') && text.includes(lines[0]) && text.includes('U2') && text.includes(lines[1]), text);
ev.check('before a spec both lines count: "0 of 2 verified"', text.includes('0 of 2 verified'), text);
ev.check('each reads "Not verified" and "The spec will cover this"', (await rowText(c, 'U1')).includes('Not verified') && (await rowText(c, 'U2')).includes('The spec will cover this'), await rowText(c, 'U2'));
await page.screenshot(ev.shot('ledger-at-creation'));

await c.approvePlan(missionId, title);
await waitTask(c, missionId, 'spec', (t) => t.status === 'AWAITING_APPROVAL', 'spec waiting for review', 90_000);
text = await feedShows(c, missionId, '0 of 1 verified');
const ac1 = await rowText(c, 'AC1');
ev.check('after the spec the header reads "0 of 1 verified"', text.includes('0 of 1 verified'), text);
ev.check('AC1 "Covers U1, U2" and is "Not verified", waiting for QA', ac1.includes('Covers U1, U2') && ac1.includes('Not verified') && ac1.includes('Waiting for QA'), ac1);
ev.check('U1 and U2 each say "Covered by AC1"', (await rowText(c, 'U1')).includes('Covered by AC1') && (await rowText(c, 'U2')).includes('Covered by AC1'), [await rowText(c, 'U1'), await rowText(c, 'U2')]);
await page.screenshot(ev.shot('spec-covers-both'));

await c.decideInInbox('Approve the output of spec?', { filter: 'For me' });
await waitTask(c, missionId, 'release', (t) => ['SUCCEEDED', 'BLOCKED', 'FAILED'].includes(t.status), 'release settled', 120_000);
text = await feedShows(c, missionId, '1 of 1 verified');
ev.check('after QA the header reads "1 of 1 verified"', text.includes('1 of 1 verified'), text);
const rows = await Promise.all(['U1', 'U2', 'AC1'].map((k) => rowText(c, k)));
ev.check('every row reads "Verified"', rows.every((r) => /Verified$/.test(r) && !r.includes('Not verified')), rows);
ev.check('AC1 shows QA\'s evidence', rows[2].includes('Scripted check for AC1 passed'), rows[2]);
await page.screenshot(ev.shot('all-verified'));

// The row opens the QA report it was verified by.
await page.evaluate(`(() => { const r = [...document.querySelectorAll('section[aria-label="Done when"] button.list__row')].find((x) => x.querySelector('.mono')?.innerText.trim() === 'AC1'); r?.click(); })()`);
// The reader loads the document after the drawer opens: wait for its body, not just the frame.
const drawer = await until(async () => { const d = await c.dialogText('QA report'); return /AC1: PASS/.test(d) && d; }, { label: 'QA report drawer', timeoutMs: 15_000 }).catch(() => c.dialogText('QA report'));
ev.check('clicking AC1 opens the QA report that verified it', /AC1: PASS/.test(drawer), drawer.slice(0, 600));
await sleep(600);
await page.screenshot(ev.shot('qa-report-from-row'));
await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

const view = await api.get(`/v1/missions/${missionId}/criteria`);
ev.check('proof (API): U1, U2, AC1 all PASS; AC1 carries the QA report id', view.map((v) => `${v.key}:${v.result}`).join(',') === 'U1:PASS,U2:PASS,AC1:PASS' && typeof view[2].qaArtifactId === 'string', view.map((v) => ({ key: v.key, result: v.result, covers: v.covers, coveredBy: v.coveredBy })));
const m = await until(async () => { const x = (await api.get(`/v1/missions/${missionId}`)).mission; return x.status === 'COMPLETE' && x; }, { label: 'complete', timeoutMs: 20_000 }).catch(async () => (await api.get(`/v1/missions/${missionId}`)).mission);
ev.check('the mission completes', m.status === 'COMPLETE', m.status);
const rel = await c.task(missionId, 'release');
ev.check('proof: the release gate read qa.criteria_unverified 0', rel.status === 'SUCCEEDED', { status: rel.status, reason: rel.statusReason });

await cancel(c, missionId, 'E1');
await resetStaffing(c);
c.close(); ev.save();
