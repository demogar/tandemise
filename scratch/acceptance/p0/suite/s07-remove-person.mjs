// A11 — removing a person: their agent goes inactive, work stops routing to it, history keeps their name.
import { context } from '../lib/ctx.mjs';
import { Evidence } from '../lib/evidence.mjs';

const c = await context();
const { page, api, sleep, until } = c;
const ana = await c.id('Ana Ruiz'); const figma = await c.id('Figma design agent');
const ev = new Evidence('A11', 'Remove a person');

await page.navigate('#/team'); await sleep(900);
await page.evaluate(`[...document.querySelectorAll('button')].find(x => x.offsetParent && x.innerText.trim().replace(/\\s+/g,' ').startsWith('AR Ana Ruiz'))?.click()`);
await sleep(700);
await page.click('Remove'); await sleep(500);
const confirmText = await page.text('main');
ev.check('confirmation explains the consequence in plain words', /Remove Ana Ruiz\?/.test(confirmText) && /agent stops taking work/.test(confirmText), confirmText.slice(confirmText.indexOf('Remove Ana'), confirmText.indexOf('Remove Ana') + 140));
await page.screenshot(ev.shot('confirm'));
const ok = await page.evaluate(`(() => { const q = [...document.querySelectorAll('*')].find((e) => e.offsetParent && e.children.length === 0 && e.innerText?.trim() === 'Remove Ana Ruiz?'); let n = q; for (let i = 0; i < 5 && n; i++) { n = n.parentElement; const b = n && [...n.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Remove'); if (b) { b.click(); return true; } } return false; })()`);
if (!ok) throw new Error('no confirm Remove');
const team = await until(async () => { const t = await c.team(); return t.find((m) => m.id === ana).status === 'removed' && t; }, { label: 'removed', timeoutMs: 10_000 });
const agent = team.find((m) => m.id === figma);
ev.check("Ana's seat is removed; her agent is kept but inactive", agent.status === 'active' && agent.active === false);
await page.navigate('#/team'); await sleep(1200);
ev.check('Team screen marks the agent "Inactive: owner removed"', /Figma design agent[\s\S]{0,80}Inactive/.test(await page.text('main')));
await page.screenshot(ev.shot('tree'));

const history = await c.ui.inbox('Everyone');
ev.check("past decisions still carry Ana's name", /by\s*Ana Ruiz/.test(history));

const title = `After Ana ${Date.now().toString(36)}`;
const missionId = await c.createMission(title);
await until(async () => (await api.get(`/v1/missions/${missionId}/tasks`)).length > 0, { label: 'tasks' });
const design = await c.task(missionId, 'design');
ev.check("design no longer routes to Ana's agent, nor silently to any runtime: it waits for a real person", design.wouldBe?.assignee?.id !== figma && design.wouldBe?.executor === 'human' && design.wouldBe?.responsible?.kind === 'person' && design.wouldBe?.responsible?.id !== ana, design.wouldBe);
await page.navigate(`#/missions/${missionId}/plan`); await sleep(1500);
await page.screenshot(ev.shot('plan'));
await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: A11 only needed the plan' });
c.close(); ev.save();
