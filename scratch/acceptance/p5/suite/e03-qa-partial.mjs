// E3 — QA verifies one of three criteria: the checklist reads 1 of 3, the release never passes, and the mission does not complete.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { createMission, resetStaffing, waitTask, feedShows, rowText, cancel, interventionText } from '../common.mjs';

const c = await context();
const { page, api, sleep } = c;
const ev = new Evidence('E3', 'Unverified criteria keep the release shut');
await resetStaffing(c);

const title = `E3 SCRIPTED_QA_PARTIAL ${Date.now().toString(36)}`;
const missionId = await createMission(c, title, ['The page greets the visitor by name', 'The page works offline']);
ev.note(`mission ${missionId}`);
await c.approvePlan(missionId, title);
const qa = await waitTask(c, missionId, 'qa', (t) => ['SUCCEEDED', 'BLOCKED', 'FAILED'].includes(t.status), 'qa settled', 120_000);
ev.check('QA passes its own gate: a skipped criterion is not a failed one', qa.status === 'SUCCEEDED', { status: qa.status, reason: qa.statusReason });
const release = await waitTask(c, missionId, 'release', (t) => ['SUCCEEDED', 'BLOCKED', 'FAILED'].includes(t.status), 'release settled', 120_000);
ev.check('the release blocks after its attempts', release.status === 'BLOCKED', { status: release.status, attempts: release.attempts, reason: release.statusReason });

const text = await feedShows(c, missionId, '1 of 3 verified');
ev.check('the checklist reads "1 of 3 verified"', text.includes('1 of 3 verified'), text);
const rows = await Promise.all(['AC1', 'AC2', 'AC3'].map((k) => rowText(c, k)));
ev.check('AC1 Verified; AC2 and AC3 Not verified, and say QA could not verify them', /Verified$/.test(rows[0]) && !rows[0].includes('Not verified') && rows.slice(1).every((r) => r.includes('Not verified') && r.includes('QA could not verify it')), rows);
const users = await Promise.all(['U1', 'U2'].map((k) => rowText(c, k)));
ev.check('U1 and U2 are not verified either: not everything covering them passed', users.every((r) => r.includes('Not verified')), users);
await page.screenshot(ev.shot('one-of-three'));

const card = await interventionText(c, 'release');
ev.check('the Inbox card for release reads "qa.criteria_unverified is 2, needs 0" and names AC2 and AC3', card.includes('Not met: qa.criteria_unverified is 2, needs 0') && /Not verified yet: AC2 \(.*\), AC3 \(/.test(card), card.slice(0, 1400));
await page.screenshot(ev.shot('inbox-card-unverified'));
void sleep;

const m = (await api.get(`/v1/missions/${missionId}`)).mission;
ev.check('the mission is not COMPLETE', m.status !== 'COMPLETE', m.status);
const facts = c.sql("SELECT body FROM run_events WHERE mission_id = ? AND json_extract(body, '$.type') = 'gate.evaluated' ORDER BY sequence DESC LIMIT 1", missionId)[0];
ev.check('proof (event log): the last gate evaluation names qa.criteria_unverified', (facts?.body ?? '').includes('qa.criteria_unverified is 2, needs 0'), facts?.body?.slice(0, 300));

await cancel(c, missionId, 'E3');
c.close(); ev.save();
