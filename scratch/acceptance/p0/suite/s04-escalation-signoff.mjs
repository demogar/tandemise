// A10 — an unanswered request climbs the tree; A5 — the lead also signs off.
import { context, writeState } from '../lib/ctx.mjs';
import { Evidence } from '../lib/evidence.mjs';

const c = await context();
const { page, api, env, ui, sleep, until } = c;
const ana = await c.id('Ana Ruiz'); const maria = await c.id('Maria Lopez');

const a5 = new Evidence('A5', 'The lead also signs off (both_sign_off)');
await page.navigate('#/team'); await sleep(900);
await page.evaluate(`[...document.querySelectorAll('button')].find(x => x.offsetParent && x.innerText.trim().replace(/\\s+/g,' ').includes('Maria Lopez Director'))?.click()`);
await sleep(700);
if ((await page.evaluate(`(() => { const el = [...document.querySelectorAll('button,[role=switch],input[type=checkbox]')].find(b => b.offsetParent && (b.innerText?.trim() === 'Sign off on delegated work' || b.getAttribute('aria-label') === 'Sign off on delegated work' || b.closest('label')?.innerText.includes('Sign off on delegated work'))); return el ? (el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed') ?? String(el.checked)) : undefined; })()`)) !== 'true') await page.click('Sign off on delegated work');
await page.screenshot(a5.shot('maria-drawer'));
await page.click('Save');
a5.check("Maria's drawer toggle stores oversight = both_sign_off", Boolean(await until(async () => (await c.team()).find((m) => m.id === maria && m.oversight === 'both_sign_off'), { label: 'oversight', timeoutMs: 8000 })));

// The Staffing drawer's shortest escalation is an hour; the run shortens design's through the API (setup only).
await api.patch(`/v1/workspaces/${env.workspaceId}/staffing`, { design: { escalateAfterMs: 60_000 } });

const title = `Escalation ${Date.now().toString(36)}`;
const missionId = await c.createMission(title);
writeState({ escalation: missionId });
const pendingDesign = async () => { const t = await c.task(missionId, 'design'); return (await c.approvals(missionId, 'PENDING')).filter((a) => a.taskId === t.id && a.kind !== 'check'); };
await c.approvePlan(missionId, title);
await until(async () => (await c.approvals(missionId, 'PENDING')).some((a) => a.title === 'Approve the output of spec?'), { label: 'spec approval', timeoutMs: 60_000 });
await c.decideInInbox('Approve the output of spec?', { filter: 'For me' });

const a10 = new Evidence('A10', 'Nobody answers: the request climbs the tree');
const [first] = await until(async () => { const a = await pendingDesign(); return a.length && a; }, { label: 'design approval', timeoutMs: 90_000 });
a10.check('starts with Ana only', JSON.stringify(first.addressees) === JSON.stringify([ana]));
const t0 = Date.now();
const lvl1 = await until(async () => { const [a] = await pendingDesign(); return a?.escalationLevel === 1 && a; }, { label: 'level 1', timeoutMs: 100_000, everyMs: 2000 });
a10.check('about a minute later it reaches Maria (level 1)', JSON.stringify(lvl1.addressees) === JSON.stringify([ana, maria]), { seconds: Math.round((Date.now() - t0) / 1000) });
a10.check('Inbox: "For Ana Ruiz and Maria Lopez · Escalated to Maria Lopez"', /Approve the output of design\?[^\n]*\n(?:[^\n]*\n)?\s*For Ana Ruiz and Maria Lopez[\s·]*Escalated to Maria Lopez/.test(await ui.inbox('Everyone')));
await page.screenshot(a10.shot('maria'));
const lvl2 = await until(async () => { const [a] = await pendingDesign(); return a?.escalationLevel === 2 && a; }, { label: 'level 2', timeoutMs: 100_000, everyMs: 2000 });
a10.check('another minute later it reaches you (level 2)', JSON.stringify(lvl2.addressees) === JSON.stringify([ana, maria, c.me]));
const forMe = await ui.inbox('For me');
a10.check('For me: names you and says "Escalated to you"', /Approve the output of design\?[^\n]*\n(?:[^\n]*\n)?\s*For you[\s\S]{0,60}Escalated to you/.test(forMe), forMe.slice(0, 250));
await page.screenshot(a10.shot('you'));
await page.navigate(`#/missions/${missionId}/timeline`); await sleep(1500);
a10.check('timeline shows the escalations', /escalat/i.test(await page.text('main')));
await page.screenshot(a10.shot('timeline'));
a10.save();

await c.decideInInbox('Approve the output of design?', { recordingFor: 'Ana Ruiz' });
const signOff = await until(async () => (await pendingDesign()).find((a) => a.id !== first.id), { label: 'sign-off card', timeoutMs: 20_000 });
a5.check('after Ana approves, design still waits', (await c.task(missionId, 'design')).status === 'AWAITING_APPROVAL');
a5.check('a sign-off card goes to Maria only', JSON.stringify(signOff.addressees) === JSON.stringify([maria]));
await ui.openItem('Approve the output of design?', 'Everyone');
const card = await page.text('main');
a5.check('card shows the "Lead sign-off" badge, not the raw marker row', /Lead sign-off/.test(card) && !/Sign-off\s*\n\s*lead/.test(card));
await page.screenshot(a5.shot('lead-signoff'));
await c.decideInInbox('Approve the output of design?', { recordingFor: 'Maria Lopez' });
const done = await until(async () => { const t = await c.task(missionId, 'design'); return t.status === 'SUCCEEDED' && t; }, { label: 'design done', timeoutMs: 20_000 });
const decided = (await c.approvals(missionId)).find((a) => a.id === signOff.id);
a5.check('design succeeds only after Maria signs off (recorded by you)', done && decided.decidedBy === maria && decided.recordedBy === c.me);
a5.save();

await api.patch(`/v1/workspaces/${env.workspaceId}/staffing`, { design: { escalateAfterMs: 86_400_000 } });
await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: A5/A10 proven' });
c.close();
