// C9 — Decline: the agent declines a note with a reason; the card shows it as declined, linked to the note.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { assertSolo, noRecordingFor, resetStaffing, waitTask, cancel } from '../common.mjs';

const c = await context();
const { page, sleep, until } = c;
const ev = new Evidence('C9', 'Decline: "Declined" on the card and in the reader, linked to the note');
await assertSolo(c, ev);
await resetStaffing(c);

const title = `C9 decline SCRIPTED_DECLINE ${Date.now().toString(36)}`;
const missionId = await c.createMission(title, { workflow: 'P2 solo' });
ev.note(`mission ${missionId}`);
await c.approvePlan(missionId, title);
const doc = await waitTask(c, missionId, 'doc', (t) => t.status === 'SUCCEEDED', 'doc done', 60_000);
const note = 'Add a dark mode toggle to the hello page';
const sent = await c.requestChangesOnCard(missionId, 'doc', note);
noRecordingFor(ev, 'composer', sent.bodyWhileOpen);
ev.check('the flash says "Round 2 started"', sent.flash === 'Round 2 started', sent.flash);
await waitTask(c, missionId, 'doc', (t) => t.round === 2 && t.status === 'SUCCEEDED', 'round 2 done', 60_000);
const thread = await c.feedback(doc.id);
ev.check('the note is closed in round 2 (declined notes still count as answered)', thread.items[0]?.status === 'addressed' && thread.items[0].round === 2, thread.items);

await page.navigate(`#/missions/${missionId}`); await sleep(1800);
const card = await c.cardText('doc');
ev.check('the card\'s What changed shows a Declined chip, the reason without the "Declined:" prefix, and the note\'s author', /What changed/i.test(card) && /Declined\s*\n?\s*the scripted agent keeps the page as it is/.test(card) && !/Declined:/.test(card) && /·\s*You/.test(card), card);
const chip = await page.evaluate(`document.querySelector('[data-feed-card="doc"] .feedcard__declined')?.innerText ?? null`);
ev.check('the Declined chip is its own element', chip === 'Declined', chip);
await page.evaluate(`document.querySelector('[data-feed-card="doc"]')?.scrollIntoView({ block: 'center' })`);
await page.screenshot(ev.shot('card-declined'));

await page.evaluate(`(() => { const card = document.querySelector('[data-feed-card="doc"]'); [...card.querySelectorAll('button')].find((x) => x.innerText.trim().startsWith('Full doc'))?.click(); })()`);
await until(async () => /Changes in v2/.test(await page.text('body')), { label: 'reader Changes in v2', timeoutMs: 15_000 }).catch(() => undefined);
await page.evaluate(`document.querySelectorAll('details.reader__change').forEach((d) => { d.open = true; })`);
await sleep(500);
const reader = await page.evaluate(`[...document.querySelectorAll('.drawer, [role=dialog]')].pop()?.innerText ?? ''`);
ev.check('the reader\'s "Changes in v2" marks it Declined and links it to the note text and author', /Changes in v2/i.test(reader) && /Declined/.test(reader) && reader.includes(note) && /You/.test(reader) && !/fb_/.test(reader), reader.slice(0, 1200));
await page.screenshot(ev.shot('reader-declined'));
const events = await c.events(missionId);
const addressed = events.find((e) => e.body.type === 'feedback.addressed' && e.body.feedbackId === thread.items[0].id);
ev.check('event feedback.addressed carries declined: true', addressed?.body.declined === true && addressed.body.round === 2, addressed?.body);
await page.navigate(`#/missions/${missionId}/timeline`); await sleep(1800);
ev.check('the timeline reads "Round 2 declined a note"', /Round 2 declined a note/.test(await page.text('main')));
await cancel(c, missionId, 'C9');
c.close(); ev.save();
