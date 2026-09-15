// C8 — Your own step: a note on the docs step that waits for you shows on your card and in the drawer;
// completing the step records it as addressed in round 1.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { assertSolo, noRecordingFor, resetStaffing, waitTask, cancel } from '../common.mjs';

const c = await context();
const { page, api, sleep, until } = c;
const ev = new Evidence('C8', 'Your own step: the note shows on your card, completing it addresses the note');
await assertSolo(c, ev);
await resetStaffing(c);

const openDoIt = async () => {
  await page.navigate(`#/missions/${missionId}`); await sleep(1800);
  const ok = await page.evaluate(`(() => { const card = document.querySelector('[data-feed-card="docs"]'); const b = card && [...card.querySelectorAll('button')].find((x) => x.innerText.trim().startsWith('Do it')); if (!b) return false; b.click(); return true; })()`);
  if (!ok) throw new Error('no "Do it" on the docs card');
  await until(() => page.evaluate(`[...document.querySelectorAll('[role=dialog] textarea')].some((t) => (t.placeholder ?? '').startsWith('Paste what you produced'))`), { label: 'docs drawer', timeoutMs: 10_000 });
};

const title = `C8 person ${Date.now().toString(36)}`;
const missionId = await c.createMission(title);
ev.note(`mission ${missionId}`);
await c.approvePlan(missionId, title);
const docs = await waitTask(c, missionId, 'docs', (t) => t.status === 'AWAITING_HUMAN', 'docs waits for you', 120_000);
ev.check('docs is yours', docs.assignee?.id === c.me, docs.assignee);

await openDoIt();
const note = 'Mention the pricing page';
const opened = await page.evaluate(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].pop(); const b = [...d.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Request changes'); if (!b) return false; b.click(); return true; })()`);
ev.check('the drawer footer has Request changes', opened);
const sent = await c.sendComposer(note, { shot: ev.shot('composer') });
noRecordingFor(ev, 'composer over the drawer', sent.bodyWhileOpen);
ev.check('the flash says the note was added to the task', sent.flash === 'Added to the task', sent.flash);
await sleep(1200);
const drawer = await c.dialogText('');
const drawerOpen = await page.evaluate(`[...document.querySelectorAll('[role=dialog] textarea')].some((t) => (t.placeholder ?? '').startsWith('Paste what you produced'))`);
ev.check('the drawer is still open and its thread shows the note', drawerOpen && /Feedback/i.test(drawer) && drawer.includes(note), drawer.slice(0, 1500));
ev.check('the note is "For this step", not waiting for a round, with no Start round', /For this step/.test(drawer) && !/Waiting for a round/.test(drawer) && !/Start round/.test(drawer), drawer.slice(0, 1500));
await page.evaluate(`(() => { const el = [...document.querySelectorAll('[role=dialog] *')].find((x) => x.children.length === 0 && /^Feedback$/i.test(x.textContent.trim())); el?.scrollIntoView({ block: 'center' }); })()`);
await sleep(400);
noRecordingFor(ev, 'drawer', await page.text('body'));
await page.screenshot(ev.shot('drawer-note'));
const thread = await c.feedback(docs.id);
ev.check('the item is on the task, open in round 1, by you', thread.items.length === 1 && thread.items[0].status === 'open' && thread.items[0].round === 1 && thread.items[0].author?.id === c.me, thread.items);
await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await sleep(600);

await page.navigate(`#/missions/${missionId}`); await sleep(1800);
const card = await c.cardText('docs');
ev.check('your card shows "1 note pending" with the note', /1 note pending/.test(card) && card.includes(note), card);
noRecordingFor(ev, 'feed', await page.text('body'));
await page.evaluate(`document.querySelector('[data-feed-card="docs"]')?.scrollIntoView({ block: 'center' })`);
await sleep(400);
await page.screenshot(ev.shot('card-with-note'));

await openDoIt();
await page.fill('Paste what you produced', 'README: the hello page greets visitors by name. See the pricing page for plans.');
await page.click('Mark done');
const done = await waitTask(c, missionId, 'docs', (t) => t.status === 'SUCCEEDED', 'docs done', 30_000);
const after = await c.feedback(done.id);
ev.check('after completion the note is addressed in round 1', after.items[0]?.status === 'addressed' && after.items[0].round === 1, after.items);
const arts = c.sql('SELECT id, round, author_id AS authorId, type FROM artifacts WHERE task_id = ?', done.id);
ev.check('the artifact is round 1, authored by you', arts.length === 1 && arts[0].round === 1 && arts[0].authorId === c.me, arts);
ev.check('the task stays in round 1', done.round === 1);
const events = await c.events(missionId);
ev.check('the timeline records the note as answered', events.some((e) => e.taskId === done.id && e.body.type === 'feedback.addressed' && e.body.round === 1 && e.body.declined === false));
await page.navigate(`#/missions/${missionId}`); await sleep(1800);
const doneCard = await c.cardText('docs');
ev.check('the done card no longer shows the note as pending', !/note pending/.test(doneCard), doneCard);
await page.evaluate(`document.querySelector('[data-feed-card="docs"]')?.scrollIntoView({ block: 'center' })`);
await sleep(400);
await page.screenshot(ev.shot('card-done'));
await cancel(c, missionId, 'C8');
void api;
c.close(); ev.save();
