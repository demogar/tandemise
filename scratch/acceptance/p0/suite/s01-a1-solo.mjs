// A1 — Solo, no configuration: a whole mission from the window, attribution proven through the API.
import { context, writeState } from '../lib/ctx.mjs';
import { Evidence } from '../lib/evidence.mjs';

const c = await context();
const ev = new Evidence('A1', 'Solo, no configuration');
const title = `A1 solo ${Date.now().toString(36)}`;
const missionId = await c.createMission(title);
writeState({ a1: missionId });
ev.note(`mission ${missionId}`);

await c.until(async () => (await c.approvals(missionId, 'PENDING')).some((a) => a.kind === 'plan'), { label: 'plan approval' });
const inbox = await c.ui.inbox('For me');
ev.check('plan approval appears in Inbox → For me, marked "For you"', new RegExp(`Approve the plan for ${title}\\?[^\\n]*\\n(?:[^\\n]*\\n)?\\s*For you`).test(inbox));
await c.page.screenshot(ev.shot('inbox-plan'));
await c.approvePlan(missionId, title);

// My own step lands in my Inbox, assigned to me (no claiming for a solo person).
const docs = await c.until(async () => { const t = await c.task(missionId, 'docs'); return t.status === 'AWAITING_HUMAN' && t; }, { label: 'docs waiting', timeoutMs: 120_000 });
ev.check('solo: your step is assigned to you, not up for grabs', docs.assignee?.id === c.me, docs.assignee);
ev.check('status reason has no double period', !/\.\.$/.test(docs.statusReason ?? ''), docs.statusReason);
await c.ui.openTask('docs', title, 'For me');
const card = await c.page.text('main');
ev.check('no Claim button for your own step', !/\nClaim\n/.test(card));
await c.page.screenshot(ev.shot('docs-open'));
await c.page.fill('Paste what you produced', 'README: the hello page greets visitors by name.');
await c.page.click('Mark done');

const mission = await c.until(async () => { const m = (await c.api.get(`/v1/missions/${missionId}`)).mission; return ['COMPLETE', 'FAILED', 'BLOCKED'].includes(m.status) && m; }, { label: 'mission end', timeoutMs: 300_000, everyMs: 2000 });
ev.check('mission completes', mission.status === 'COMPLETE', mission.status);
const tasks = await c.tasks(missionId);
ev.check('every task: responsible is you', Object.values(tasks).every((t) => t.responsible?.id === c.me), Object.values(tasks).map((t) => `${t.key}:${t.responsible?.name}`));
const arts = await c.api.get(`/v1/missions/${missionId}/artifacts`);
const evidence = arts.find((a) => a.type === 'Evidence');
ev.check('agent artifacts are authored by the runtime (no agents configured)', arts.filter((a) => !['Evidence', 'MissionPlan'].includes(a.type)).every((a) => a.author?.id === 'system:runtime'), arts.map((a) => `${a.type}:${a.author?.name}`));
ev.check('your docs are authored by you and readable as text', evidence?.author?.id === c.me && evidence?.mediaType === 'text/markdown', { author: evidence?.author?.name, mediaType: evidence?.mediaType });
const plan = (await c.approvals(missionId)).find((a) => a.kind === 'plan');
ev.check('plan approval addressed to you and decided by you (a member, not "user")', JSON.stringify(plan.addressees) === JSON.stringify([c.me]) && plan.decidedBy === c.me);

await c.page.navigate(`#/missions/${missionId}/plan`); await c.sleep(1500);
ev.check('Plan shows "Responsible You"', /Responsible\s*You/.test(await c.page.text('main')));
await c.page.screenshot(ev.shot('plan'));
await c.page.navigate(`#/missions/${missionId}/artifacts`); await c.sleep(1500);
await c.page.evaluate(`[...document.querySelectorAll('button,a,[role=button]')].find(b => b.offsetParent && b.innerText.trim().startsWith('docs'))?.click()`);
await c.sleep(1000);
const reader = await c.page.text('main');
ev.check('Artifacts reader shows your docs text and "by You"', reader.includes('greets visitors by name') && /by\s*You/.test(reader));
await c.page.screenshot(ev.shot('artifact-docs'));
c.close(); ev.save();
