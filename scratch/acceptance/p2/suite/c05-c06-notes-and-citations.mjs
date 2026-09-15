// C5 — Several notes: two notes given before the round runs both go into round 2, and the round cites both.
// C6 — Missing citation: the agent leaves the second note uncited once; the retry names the missing id; the next pass succeeds.
// The mission is paused from the header while doc's first pass runs (SCRIPTED_SLOW_20S), so round 2 cannot start between the notes.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { assertSolo, noRecordingFor, resetStaffing, waitTask, cancel } from '../common.mjs';

const c = await context();
const { page, api, sleep, until } = c;
const c5 = new Evidence('C5', 'Several notes: both go into one round and are cited');
const c6 = new Evidence('C6', 'Missing citation: the retry names the missing id, then succeeds');
await assertSolo(c, c5);
await resetStaffing(c);

const title = `C5 notes SCRIPTED_OMIT_CITATION_ONCE SCRIPTED_SLOW_20S ${Date.now().toString(36)}`;
const missionId = await c.createMission(title, { workflow: 'P2 solo' });
c5.note(`mission ${missionId}`);
await c.approvePlan(missionId, title);
await waitTask(c, missionId, 'doc', (t) => t.status === 'RUNNING', 'doc running', 60_000);
await c.missionAction(missionId, 'Pause');
const paused = await until(async () => { const m = (await api.get(`/v1/missions/${missionId}`)).mission; return m.status === 'PAUSED' && m; }, { label: 'paused', timeoutMs: 10_000 }).catch(async () => (await api.get(`/v1/missions/${missionId}`)).mission);
c5.check('paused from the header while doc runs', paused.status === 'PAUSED', paused.status);
const doc = await waitTask(c, missionId, 'doc', (t) => t.status === 'SUCCEEDED', 'doc done', 60_000);
c5.check('the mission stays paused after doc finishes', (await api.get(`/v1/missions/${missionId}`)).mission.status === 'PAUSED');

const first = await c.requestChangesOnCard(missionId, 'doc', 'Say who the page is for');
noRecordingFor(c5, 'first composer', first.bodyWhileOpen);
c5.check('first note: "Round 2 started"', first.flash === 'Round 2 started', first.flash);
await sleep(5500); // the flash from the first note fades before the second is sent
const second = await c.requestChangesOnCard(missionId, 'doc', 'Add a link to the pricing page');
c5.check('second note joins the waiting round: "Added to the task"', second.flash === 'Added to the task', second.flash);
await sleep(1000);
const waiting = await c.task(missionId, 'doc');
const thread = await c.feedback(doc.id);
// The first note started the round (in_round); the second is attached to it (open, round 2) and is promoted when the round runs.
c5.check('both notes are in round 2 before it runs', waiting.round === 2 && ['READY', 'PENDING'].includes(waiting.status) && thread.items.length === 2 && thread.items.every((i) => ['in_round', 'open'].includes(i.status) && i.round === 2), { status: waiting.status, round: waiting.round, items: thread.items.map((i) => [i.status, i.round]) });
const cardWaiting = await c.cardText('doc');
c5.check('the card counts both notes for the round that has not run: "2 notes for round 2", with no Start round',
  /2 notes for round 2/.test(cardWaiting) && !/Start round/.test(cardWaiting), cardWaiting);
c5.check('the card names no one in the round line', /Round 2: changes requested/.test(cardWaiting) && !/asked for changes/.test(cardWaiting), cardWaiting);
await page.screenshot(c5.shot('card-two-notes'));
await c.openTaskDrawer(missionId, 'doc');
const drawer = await c.dialogText('doc');
c5.check('the drawer thread lists both notes', drawer.includes('Say who the page is for') && drawer.includes('Add a link to the pricing page'), drawer.slice(0, 1200));
c5.check('both notes sit under "Round 2"; the second "Joins this round"; nothing waits for a round and there is no Start round',
  /Round 2/.test(drawer) && /Joins this round/.test(drawer) && !/Waiting for a round/.test(drawer) && !/Start round/.test(drawer), drawer.slice(0, 1500));
const warns = await page.evaluate(`[...document.querySelectorAll('[role=dialog]')].pop()?.querySelectorAll('.banner--warn').length ?? -1`);
c5.check('the drawer shows the round reason plainly, not as a warning, and with no personal name',
  warns === 0 && drawer.includes('Round 2: changes requested') && !/asked for changes/.test(drawer), { warns });
noRecordingFor(c5, 'drawer', await page.text('body'));
await page.screenshot(c5.shot('drawer-two-notes'));
c5.note(`card while waiting: ${cardWaiting.replace(/\n/g, ' | ')}`);
await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await sleep(500);

await c.missionAction(missionId, 'Resume');
const done = await waitTask(c, missionId, 'doc', (t) => t.status === 'SUCCEEDED' && t.round === 2, 'round 2 done', 90_000);
const [a, b] = thread.items;
const after = await c.feedback(doc.id);
c5.check('C5: both notes addressed in round 2', after.items.length === 2 && after.items.every((i) => i.status === 'addressed' && i.round === 2), after.items.map((i) => [i.text, i.status, i.round]));

// Reader: Changes in v2 links both notes.
await page.navigate(`#/missions/${missionId}`); await sleep(1800);
await page.evaluate(`(() => { const card = document.querySelector('[data-feed-card="doc"]'); [...card.querySelectorAll('button')].find((x) => x.innerText.trim().startsWith('Full doc'))?.click(); })()`);
await until(async () => /Changes in v2/.test(await page.text('body')), { label: 'reader Changes in v2', timeoutMs: 15_000 }).catch(() => undefined);
await page.evaluate(`document.querySelectorAll('details.reader__change').forEach((d) => { d.open = true; })`);
await sleep(500);
const reader = await page.evaluate(`[...document.querySelectorAll('.drawer, [role=dialog]')].pop()?.innerText ?? document.body.innerText`);
c5.check('C5: the reader\'s "Changes in v2" links both notes', /Changes in v2/i.test(reader) && reader.includes('Say who the page is for') && reader.includes('Add a link to the pricing page') && !/fb_/.test(reader), reader.slice(0, 1500));
await page.screenshot(c5.shot('reader-changes-v2'));
c5.save();

// C6: the first round-2 pass failed its handoff check, the retry was told which id to cite.
const runs = c.runs(done.id);
const round2 = runs.filter((r) => r.round === 2);
c6.check('round 2 took two passes: the round, then a retry', round2.length === 2 && round2[0].purpose === 'round' && round2[1].purpose === 'retry' && round2[1].status === 'SUCCEEDED', round2.map((r) => ({ purpose: r.purpose, status: r.status, attempt: r.attempt, error: r.errorMessage })));
const prompts = c.prompts().filter((p) => p.includes(title));
const retryPrompt = prompts.filter((p) => /must cite fb_/.test(p)).pop() ?? '';
c6.check('the retry prompt names the second note\'s id: "must cite <id>"', retryPrompt.includes(`must cite ${b.id}`) && !retryPrompt.includes(`must cite ${a.id}`), retryPrompt.match(/.*must cite.*/g));
c6.check('the task succeeded in round 2', done.status === 'SUCCEEDED' && done.round === 2);
await page.navigate(`#/missions/${missionId}/timeline`); await sleep(1800);
const timeline = await page.text('main');
const events = await c.events(missionId);
const failedHarvest = events.find((e) => e.taskId === done.id && e.body.type === 'task.status' && e.body.from === 'RUNNING' && e.body.to === 'READY');
c6.check('the retry reads "Round 2 left 1 note unanswered; trying again." on the timeline', failedHarvest?.body.reason === 'Round 2 left 1 note unanswered; trying again.' && timeline.includes('Round 2 left 1 note unanswered; trying again.'), failedHarvest?.body);
c6.check('the timeline shows no raw feedback id and no "Missing expected artifacts"', !/fb_[0-9a-z]{20}/.test(timeline) && !/Missing expected artifacts/.test(timeline), timeline.match(/fb_[0-9a-z]{20}|Missing expected artifacts/g));
await page.evaluate(`(() => { const el = [...document.querySelectorAll('main *')].filter((x) => x.children.length === 0 && /note unanswered/.test(x.textContent)).pop(); el?.scrollIntoView({ block: 'center' }); })()`);
await sleep(600);
await page.screenshot(c6.shot('timeline-retry'));
await cancel(c, missionId, 'C5/C6');
c.close(); c6.save();
