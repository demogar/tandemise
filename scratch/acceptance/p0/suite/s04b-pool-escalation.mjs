// A16 — A pool with a single person who never responds opens up to the owners, and an owner takes it over in the window.
import { context, writeState } from '../lib/ctx.mjs';
import { Evidence } from '../lib/evidence.mjs';

const c = await context();
const { page, api, env, ui, sleep, until } = c;
const bo = await c.id('Bo Chen');
const ev = new Evidence('A16', 'One-person pool: nobody responds, the owner takes it');

// QA → anyone from a group, with only Bo picked, in the Staffing drawer.
await page.navigate('#/team/staffing'); await sleep(900);
await page.clickIn('QA Engineer', 'Edit'); await sleep(700);
await page.select('How this role is staffed', 'Anyone from a group'); await sleep(600);
const picks = async () => page.evaluate(`Object.fromEntries([...document.querySelectorAll('button.pick')].filter(b=>b.offsetParent).map(b=>[b.innerText.trim().replace(/^\\d+\\s*/,''), b.getAttribute('aria-pressed')]))`);
for (const [name, want] of Object.entries({ 'Bo Chen': true, 'Ana Ruiz': false, You: false, 'Maria Lopez': false })) {
  const now = (await picks())[name];
  if (now !== undefined && now !== String(want)) { await page.evaluate(`[...document.querySelectorAll('button.pick')].find(b=>b.offsetParent && b.innerText.trim().replace(/^\\d+\\s*/,'') === ${JSON.stringify(name)})?.click()`); await sleep(250); }
}
await page.click('Save'); await sleep(1000);
// The drawer's shortest escalation is an hour; shorten QA's through the API (setup only).
// Ana is gone (A11), so design is staffed to an active agent explicitly; otherwise it would wait for a person.
const archAgent = await c.id('Architecture agent');
await api.patch(`/v1/workspaces/${env.workspaceId}/staffing`, { qa: { escalateAfterMs: 60_000 }, design: { assignees: [archAgent], reviews: [] }, product: { reviews: [] }, architecture: { reviews: [] }, release: { reviews: [] } });
const qaStaffing = (await api.get(`/v1/workspaces/${env.workspaceId}/staffing`)).qa;
ev.check('QA staffed as a pool of Bo only', qaStaffing.mode === 'pool' && JSON.stringify(qaStaffing.assignees) === JSON.stringify([bo]), qaStaffing);

const title = `Pool of one ${Date.now().toString(36)}`;
const missionId = await c.createMission(title);
writeState({ poolOfOne: missionId });
await c.approvePlan(missionId, title);
const docs = await until(async () => { const t = await c.task(missionId, 'docs'); return t.status === 'AWAITING_HUMAN' && t; }, { label: 'docs', timeoutMs: 120_000 });
await c.ui.openTask('docs', title, 'For me');
await page.fill('Paste what you produced', 'README: the hello page greets visitors by name.');
await page.click('Mark done');

const qa = await until(async () => { const t = await c.task(missionId, 'qa'); return t.status === 'AWAITING_HUMAN' && t; }, { label: 'qa waiting', timeoutMs: 240_000, everyMs: 2000 });
ev.check('qa goes straight to Bo (a pool of one is his)', qa.assignee?.id === bo, qa.assignee?.name);
ev.check('not in your For me yet', !(await ui.inbox('For me')).includes('\nqa\n'));
const escalated = await until(async () => { const t = await c.task(missionId, 'qa'); return t.claimable.some((x) => x.id === c.me) && t; }, { label: 'escalated to owners', timeoutMs: 120_000, everyMs: 2000 });
ev.check('after about a minute you (owner) can take it; Bo stays assigned', escalated.assignee?.id === bo && escalated.claimable.some((x) => x.id === c.me));
const forMe = await ui.inbox('For me');
ev.check('now in your For me', /\nqa\n/.test(`\n${forMe}\n`));
await page.screenshot(ev.shot('inbox'));
await ui.openTask('qa', title, 'For me');
const claimFor = await page.evaluate(`(() => { const s = [...document.querySelectorAll('select')].find(x => x.offsetParent && /^(Claim for|Done by)/.test(x.labels?.[0]?.innerText||'')); return s ? { label: s.labels[0].innerText.split('\\n')[0], options: [...s.options].map(o=>o.text) } : null; })()`);
ev.note(`task view offers ${JSON.stringify(claimFor)}`);
if (claimFor?.label.startsWith('Done by')) await page.select('Done by', 'Demostenes');
const hasClaim = await page.evaluate(`[...document.querySelectorAll('button')].some(b => b.offsetParent && b.innerText.trim() === 'Claim')`);
if (hasClaim) { await page.click('Claim'); await sleep(1200); }
await page.screenshot(ev.shot('taken'));
await page.fill('Paste what you produced', 'QA plan: owner took over after nobody responded.');
await page.click('Mark done');
const done = await until(async () => { const t = await c.task(missionId, 'qa'); return t.status === 'SUCCEEDED' && t; }, { label: 'qa done', timeoutMs: 20_000 });
const art = (await api.get(`/v1/missions/${missionId}/artifacts`)).find((a) => a.taskId === done.id);
ev.check('you finished it: QAPlan by you', art?.author?.id === c.me, { author: art?.author?.name, assignee: done.assignee?.name });
await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: A16 proven' });
c.close(); ev.save();
