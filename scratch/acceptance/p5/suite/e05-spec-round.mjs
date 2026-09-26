// E5 — Request changes on the spec: round 2 adds AC3, the old criteria are superseded, AC3 reads "Not verified", and QA then verifies all three.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { createMission, resetStaffing, waitTask, feedShows, rowText, cancel } from '../common.mjs';

const c = await context();
const { page, api, until } = c;
const ev = new Evidence('E5', 'A revised spec replaces its criteria');
await resetStaffing(c, { reviewSpec: true });

const title = `E5 SCRIPTED_SPEC_TWO_ACS ${Date.now().toString(36)}`;
const missionId = await createMission(c, title, ['The page greets the visitor by name', 'The page works offline']);
ev.note(`mission ${missionId}`);
await c.approvePlan(missionId, title);
const spec = await waitTask(c, missionId, 'spec', (t) => t.status === 'AWAITING_APPROVAL', 'spec in review', 90_000);
let text = await feedShows(c, missionId, '0 of 2 verified');
ev.check('round 1: AC1 and AC2, "0 of 2 verified", no AC3', text.includes('0 of 2 verified') && (await rowText(c, 'AC2')) !== '' && (await rowText(c, 'AC3')) === '', text);
await page.screenshot(ev.shot('round-1-two-criteria'));

await c.decideInInbox('Approve the output of spec?', { filter: 'For me', option: 'Request changes', note: 'Add a criterion for how fast the page loads.' });
await waitTask(c, missionId, 'spec', (t) => t.round === 2 && t.status === 'AWAITING_APPROVAL', 'spec round 2 in review', 90_000);
text = await feedShows(c, missionId, 'AC3');
const ac3 = await rowText(c, 'AC3');
ev.check('round 2 adds AC3, which reads "Not verified"', ac3.includes('Not verified') && ac3.includes('Covers U1, U2'), ac3);
ev.check('the header now reads "0 of 3 verified"', text.includes('0 of 3 verified'), text);
await page.screenshot(ev.shot('round-2-ac3'));

const rows = c.sql("SELECT key, superseded_at IS NOT NULL AS superseded, spec_artifact_id AS spec FROM mission_criteria WHERE mission_id = ? AND source = 'spec' ORDER BY created_at, position", missionId);
const old = rows.filter((r) => r.superseded === 1);
const live = rows.filter((r) => r.superseded === 0);
ev.check('proof (SQL): round 1\'s AC1 and AC2 are superseded', old.map((r) => r.key).join(',') === 'AC1,AC2', rows);
ev.check('proof (SQL): AC1, AC2, AC3 are live, from the round-2 spec', live.map((r) => r.key).join(',') === 'AC1,AC2,AC3' && new Set(live.map((r) => r.spec)).size === 1 && live[0].spec !== old[0]?.spec, live);
const shown = (await api.get(`/v1/missions/${missionId}/criteria`)).map((v) => v.key);
ev.check('the checklist shows only the live criteria', shown.join(',') === 'U1,U2,AC1,AC2,AC3', shown);

await c.decideInInbox('Approve the output of spec?', { filter: 'For me' });
await waitTask(c, missionId, 'release', (t) => ['SUCCEEDED', 'BLOCKED', 'FAILED'].includes(t.status), 'release settled', 120_000);
text = await feedShows(c, missionId, '3 of 3 verified');
ev.check('after QA: "3 of 3 verified"', text.includes('3 of 3 verified'), text);
await page.screenshot(ev.shot('three-of-three'));
const m = await until(async () => { const x = (await api.get(`/v1/missions/${missionId}`)).mission; return x.status === 'COMPLETE' && x; }, { label: 'complete', timeoutMs: 20_000 }).catch(async () => (await api.get(`/v1/missions/${missionId}`)).mission);
ev.check('the mission completes', m.status === 'COMPLETE', m.status);
void spec;

await cancel(c, missionId, 'E5');
await resetStaffing(c);
c.close(); ev.save();
