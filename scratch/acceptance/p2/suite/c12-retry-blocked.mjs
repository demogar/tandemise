// C12 — Retry from blocked: "Retry with a note" in the task drawer runs round 2, framed as a request, not a gate failure.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { assertSolo, noRecordingFor, resetStaffing, waitTask, cancel } from '../common.mjs';

const c = await context();
const { page, api, sleep, until } = c;
const ev = new Evidence('C12', 'Retry from blocked: the note reaches the agent as a request');
await assertSolo(c, ev);
await resetStaffing(c);

const title = `C12 blocked SCRIPTED_FAIL_UNTIL_NOTE ${Date.now().toString(36)}`;
const missionId = await c.createMission(title, { workflow: 'P2 solo' });
ev.note(`mission ${missionId}`);
await c.approvePlan(missionId, title);
const blocked = await waitTask(c, missionId, 'doc', (t) => ['BLOCKED', 'FAILED'].includes(t.status), 'doc blocked', 120_000);
ev.check('doc is BLOCKED after its attempts', blocked.status === 'BLOCKED', { status: blocked.status, reason: blocked.statusReason, attempts: blocked.attempts });

await c.openTaskDrawer(missionId, 'doc');
const drawerBefore = await c.dialogText('doc');
ev.check('the drawer shows the reason and "Retry task" under it', /Retry task/.test(drawerBefore), drawerBefore.slice(0, 800));
const note = 'Write it even if short';
await page.fill('Note for the retry', note);
await sleep(400);
const drawer = await c.dialogText('doc');
ev.check('with a note the button reads "Retry with this note"', /Retry with this note/.test(drawer), drawer.slice(0, 800));
noRecordingFor(ev, 'drawer', await page.text('body'));
await page.evaluate(`document.querySelector('[role=dialog] .retry-note')?.scrollIntoView({ block: 'center' })`);
await sleep(300);
await page.screenshot(ev.shot('drawer-retry-note'));
const clicked = await page.evaluate(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].pop(); const b = [...d.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Retry with this note' && !x.disabled); if (!b) return false; b.click(); return true; })()`);
ev.check('clicked "Retry with this note"', clicked);

const done = await waitTask(c, missionId, 'doc', (t) => t.status === 'SUCCEEDED' || (t.round === 2 && ['BLOCKED', 'FAILED'].includes(t.status)), 'doc after retry', 90_000);
ev.check('the task succeeded in round 2', done.status === 'SUCCEEDED' && done.round === 2, { status: done.status, round: done.round, reason: done.statusReason });
const thread = await c.feedback(done.id);
ev.check('the note became an item, addressed in round 2, by you', thread.items.length === 1 && thread.items[0].text === note && thread.items[0].status === 'addressed' && thread.items[0].round === 2 && thread.items[0].author?.id === c.me, thread.items);
const prompts = c.prompts().filter((p) => p.includes(title));
const last = prompts[prompts.length - 1] ?? '';
ev.check('the last prompt carries "Feedback to address" with the note', last.includes('Feedback to address') && last.includes(note), { prompts: prompts.length });
ev.check('and is not framed as a gate failure', !last.includes("did not satisfy this task's completion gate"), last.match(/.*completion gate.*/g));
await sleep(1000);
const drawerAfter = await c.dialogText('doc');
ev.check('the open drawer now shows the note under Round 2', /Round 2/.test(drawerAfter) && drawerAfter.includes(note) && !/Retry with this note/.test(drawerAfter), drawerAfter.slice(0, 1200));
await page.evaluate(`(() => { const el = [...document.querySelectorAll('[role=dialog] *')].find((x) => x.children.length === 0 && /^Feedback$/i.test(x.textContent.trim())); el?.scrollIntoView({ block: 'center' }); })()`);
await sleep(400);
await page.screenshot(ev.shot('drawer-after-round-2'));
await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
const m = await until(async () => { const x = (await api.get(`/v1/missions/${missionId}`)).mission; return x.status === 'COMPLETE' && x; }, { label: 'mission complete', timeoutMs: 20_000 }).catch(async () => (await api.get(`/v1/missions/${missionId}`)).mission);
ev.check('the mission completes', m.status === 'COMPLETE', m.status);
await cancel(c, missionId, 'C12');
c.close(); ev.save();
