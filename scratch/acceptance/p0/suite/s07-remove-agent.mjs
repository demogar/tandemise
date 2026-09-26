// A11 — removing a member: work stops routing to it, history keeps its name, and it can be restored.
// Agents-only since 0.4.0: the member removed is one of your agents (it used to be a person and their agent).
import { context, readState } from '../lib/ctx.mjs';
import { Evidence } from '../lib/evidence.mjs';

const c = await context();
const { page, api, sleep, until } = c;
const design = await c.id('Design agent');
const ev = new Evidence('A11', 'Remove an agent');

await page.navigate('#/team'); await sleep(900);
await page.evaluate(`[...document.querySelectorAll('button')].find(x => x.offsetParent && x.innerText.trim().replace(/\\s+/g,' ').startsWith('Design agent Agent'))?.click()`);
await sleep(700);
await page.click('Remove'); await sleep(500);
const confirmText = await page.text('body');
const at = confirmText.indexOf('Remove Design agent?');
ev.check('confirmation names the agent and says its past work keeps its name', at !== -1 && /Their past work keeps their name/.test(confirmText.slice(at, at + 200)), confirmText.slice(at, at + 60).replace(/\s+/g, " "));
await page.screenshot(ev.shot('confirm'));
const ok = await page.evaluate(`(() => { const q = [...document.querySelectorAll('*')].find((e) => e.offsetParent && e.children.length === 0 && e.innerText?.trim() === 'Remove Design agent?'); let n = q; for (let i = 0; i < 5 && n; i++) { n = n.parentElement; const b = n && [...n.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Remove'); if (b) { b.click(); return true; } } return false; })()`);
if (!ok) throw new Error('no confirm Remove');
await until(async () => (await c.team()).find((m) => m.id === design).status === 'removed', { label: 'removed', timeoutMs: 10_000 });
ev.check('the agent is removed and no longer active', (await c.team()).find((m) => m.id === design).active === false);
await page.navigate('#/team'); await sleep(1200);
const tree = await page.text('main');
ev.check('the Team screen hides it and offers "Show 1 removed member"', !/Design agent\s*\n\s*Agent/.test(tree) && /Show 1 removed member/.test(tree));
await page.click('Show 1 removed member'); await sleep(600);
ev.check('shown again, it reads "Removed"', /Design agent\s*\n\s*Agent · yours · Removed/.test(await page.text('main')));
await page.screenshot(ev.shot('tree'));

// History: the team mission's design and its decision still carry the agent's name.
const { team: teamMission } = readState();
const pastDesign = (await api.get(`/v1/missions/${teamMission}/artifacts`)).find((a) => a.type === 'DesignBrief');
ev.check('its past DesignBrief still names it as the author', pastDesign?.author?.id === design && pastDesign?.author?.name === 'Design agent', pastDesign?.author);
await page.navigate(`#/missions/${teamMission}/plan`); await sleep(1500);
ev.check('the finished mission\'s Plan still shows "Design agent"', /Design agent/.test(await page.text('main')));

const title = `After removal ${Date.now().toString(36)}`;
const missionId = await c.createMission(title);
await until(async () => (await api.get(`/v1/missions/${missionId}/tasks`)).length > 0, { label: 'tasks' });
const next = await c.task(missionId, 'design');
ev.check('design no longer routes to the removed agent, nor silently to any runtime: it waits for you', next.wouldBe?.assignee?.id !== design && next.wouldBe?.executor === 'human' && next.wouldBe?.responsible?.id === c.me, next.wouldBe);
await page.navigate(`#/missions/${missionId}/plan`); await sleep(1500);
await page.screenshot(ev.shot('plan'));
await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: A11 only needed the plan' });

// Restore it from its drawer: design routes to it again.
await page.navigate('#/team'); await sleep(900);
if (await page.evaluate(`[...document.querySelectorAll('button')].some(b => b.offsetParent && b.innerText.trim() === 'Show 1 removed member')`)) { await page.click('Show 1 removed member'); await sleep(500); }
await page.evaluate(`[...document.querySelectorAll('button')].find(x => x.offsetParent && x.innerText.trim().replace(/\\s+/g,' ').startsWith('Design agent Agent'))?.click()`);
await sleep(700);
await page.click('Restore');
await until(async () => (await c.team()).find((m) => m.id === design).status === 'active', { label: 'restored', timeoutMs: 10_000 });
const again = `After restore ${Date.now().toString(36)}`;
const againId = await c.createMission(again);
await until(async () => (await api.get(`/v1/missions/${againId}/tasks`)).length > 0, { label: 'tasks' });
const back = await c.task(againId, 'design');
ev.check('restored in its drawer, the agent takes design again', back.wouldBe?.executor === 'agent' && back.wouldBe?.assignee?.id === design, back.wouldBe);
await api.post(`/v1/missions/${againId}/cancel`, { reason: 'acceptance: A11 only needed the plan' });
c.close(); ev.save();
