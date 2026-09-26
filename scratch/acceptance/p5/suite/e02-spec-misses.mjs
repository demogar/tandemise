// E2 — A spec that leaves U2 uncovered is stored, the spec gate fails on criteria.uncovered_user by name, U2 reads "Not covered", and the retry is told U2.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { createMission, resetStaffing, waitTask, feedShows, rowText, cancel, promptsFor, interventionText } from '../common.mjs';

const c = await context();
const { page, sleep } = c;
const ev = new Evidence('E2', 'A spec that misses a Done-when line cannot pass');
await resetStaffing(c);

const title = `E2 SCRIPTED_SPEC_MISSES_U2 ${Date.now().toString(36)}`;
const missionId = await createMission(c, title, ['The page greets the visitor by name', 'The page works offline']);
ev.note(`mission ${missionId}`);
await c.approvePlan(missionId, title);
const spec = await waitTask(c, missionId, 'spec', (t) => ['BLOCKED', 'FAILED', 'SUCCEEDED'].includes(t.status), 'spec settled', 120_000);
ev.check('the spec task blocks after its attempts', spec.status === 'BLOCKED' && spec.attempts === 2, { status: spec.status, attempts: spec.attempts });

const card = await interventionText(c, 'spec');
ev.check('the Inbox card for spec reads "Not met: criteria.uncovered_user is 1, needs 0" and names U2', card.includes('Not met: criteria.uncovered_user is 1, needs 0') && card.includes('Not covered by the spec: U2 (The page works offline).'), card.slice(0, 1200));
await page.screenshot(ev.shot('inbox-card-not-met'));
await page.navigate(`#/missions/${missionId}`); await sleep(1500);
const text = await feedShows(c, missionId, 'Not covered');
const u2 = await rowText(c, 'U2');
ev.check('U2 reads "Not covered": nothing in the spec covers it yet', u2.includes('Not covered') && u2.includes('Nothing in the spec covers this yet'), u2);
ev.check('U1 is covered by AC1', (await rowText(c, 'U1')).includes('Covered by AC1'), await rowText(c, 'U1'));
ev.check('U2 still counts: "0 of 2 verified" (AC1 and U2)', text.includes('0 of 2 verified'), text);
await page.screenshot(ev.shot('u2-not-covered'));

const prompts = promptsFor(c, title).filter((p) => p.includes('### ProductSpec'));
const retry = prompts[1] ?? '';
ev.check('the spec ran twice', prompts.length === 2, prompts.length);
ev.check('the first prompt lists the ledger and says which lines to cover', prompts[0]?.includes('- U2: The page works offline') && prompts[0]?.includes("The person's Done-when lines are U1, U2"), (prompts[0] ?? '').match(/Done when[\s\S]{0,200}/)?.[0]);
ev.check('the retry prompt quotes the gate and names U2 with its words', retry.includes('criteria.uncovered_user is 1, needs 0') && retry.includes('leaves U2 uncovered ("The page works offline")'), retry.match(/Tandemise measured:[^\n]*/)?.[0]);

const rows = c.sql("SELECT key, covers, superseded_at IS NOT NULL AS superseded FROM mission_criteria WHERE mission_id = ? AND source = 'spec' ORDER BY created_at", missionId);
ev.check('proof (SQL): each attempt\'s spec was stored, covering only U1; the first superseded by the second', rows.length === 2 && rows.every((r) => r.covers === '["U1"]') && rows[0].superseded === 1 && rows[1].superseded === 0, rows);
const cards = (await c.approvals(missionId, 'PENDING')).filter((a) => a.kind === 'intervention');
ev.check('an intervention card asks you what to do', cards.length === 1, cards.map((a) => a.title));

await cancel(c, missionId, 'E2');
c.close(); ev.save();
