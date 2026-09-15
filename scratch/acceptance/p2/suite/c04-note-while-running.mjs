// C4 — Note while running: a note to a running task is queued, then delivered when the pass ends,
// as one extra pass in the same round, with attempts unchanged.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { assertSolo, noRecordingFor, resetStaffing, waitTask, cancel } from '../common.mjs';

const c = await context();
const { page, sleep } = c;
const ev = new Evidence('C4', 'Note while running: queued, delivered at the end of the pass, same round');
await assertSolo(c, ev);
await resetStaffing(c);

const title = `C4 running SCRIPTED_SLOW_20S ${Date.now().toString(36)}`;
const missionId = await c.createMission(title, { workflow: 'P2 solo' });
ev.note(`mission ${missionId}`);
await c.approvePlan(missionId, title);
const running = await waitTask(c, missionId, 'doc', (t) => t.status === 'RUNNING', 'doc running', 60_000);
const startedAt = Date.now();
const note = 'Mention the pricing page';
const sent = await c.requestChangesOnCard(missionId, 'doc', note, { shot: ev.shot('composer-running') });
noRecordingFor(ev, 'composer', sent.bodyWhileOpen);
ev.check('the flash says the note waits for the pass', sent.flash === 'Queued: delivered when the current pass ends', sent.flash);
await sleep(1200);
const card = await c.cardText('doc');
const thread = await c.feedback(running.id);
const stillRunning = (await c.task(missionId, 'doc')).status === 'RUNNING';
ev.check('sent while the first pass was still running', stillRunning && Date.now() - startedAt < 20_000, { stillRunning, ms: Date.now() - startedAt });
ev.check('right after sending, the card shows "1 note pending" with the note, and no Start round', /1 note pending/.test(card) && card.includes(note) && !/Start round/.test(card), card);
ev.check('the item is queued', thread.items.length === 1 && thread.items[0].status === 'queued', thread.items);
await page.screenshot(ev.shot('running-card-note-pending'));

const done = await waitTask(c, missionId, 'doc', (t) => t.status === 'SUCCEEDED', 'doc done', 90_000);
const runs = c.runs(done.id);
ev.check('attempts unchanged and still round 1', done.attempts === 1 && done.round === 1, { attempts: done.attempts, round: done.round });
ev.check('exactly two runs: the pass, then a feedback pass', runs.length === 2 && runs[0].purpose === 'round' && runs[1].purpose === 'feedback' && runs.every((r) => r.round === 1), runs.map((r) => ({ purpose: r.purpose, round: r.round, status: r.status, attempt: r.attempt })));
const after = await c.feedback(done.id);
ev.check('the note is addressed in round 1', after.items[0]?.status === 'addressed' && after.items[0].round === 1, after.items);
const prompts = c.prompts().filter((p) => p.includes(title));
ev.check('the last prompt the agent got carries the note\'s id', prompts.length >= 2 && prompts[prompts.length - 1].includes(thread.items[0].id) && prompts[prompts.length - 1].includes(note), { prompts: prompts.length });
await page.navigate(`#/missions/${missionId}`); await sleep(1800);
const doneCard = await c.cardText('doc');
ev.check('the done card has no pending note and no round badge', !/note pending/.test(doneCard) && !/Round 2/.test(doneCard), doneCard);
await page.screenshot(ev.shot('done-card'));
await cancel(c, missionId, 'C4');
c.close(); ev.save();
