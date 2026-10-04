// F1 — A person's step shows what came in. On "Plan fit" an agent looks into the request and stops early: its
// handoff says the role is US-only and needs the person to decide. The person step after it was planned before
// that ran, and its objective points at a questions file that was never written. Its drawer must show the
// intake's headline, points and "Needs" line, with the full document a click away, before the stale objective.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { docsSize, ensureTeam, startMission, waitTask, writeState } from '../../p3/common.mjs';

const c = await context();
const { page, api } = c;
await docsSize(c);
const ev = new Evidence('F1', 'A person\'s step shows what the step before it handed over');
await ensureTeam(c);

const goal = 'Apply to the Ashby role SCRIPTED_NEEDS';
const missionId = await startMission(c, goal, 'Plan fit');
writeState({ f1: { missionId, goal } });
const intake = await waitTask(c, missionId, 'intake', (t) => t.status === 'SUCCEEDED', 'intake finished', 60_000);
const answer = await waitTask(c, missionId, 'answer', (t) => t.status === 'AWAITING_HUMAN', 'answer waits on the person', 60_000);
const evidence = (await api.get(`/v1/missions/${missionId}`)).artifacts.find((a) => a.type === 'Evidence' && a.taskId === intake.id);
ev.check('proof (API): intake wrote Evidence whose handoff needs a decision', evidence?.handoff?.needs?.startsWith('Decide: skip it'), evidence?.handoff);
ev.check('proof (API): the person step\'s view carries that Evidence as what came in',
  answer.inputs?.length === 1 && answer.inputs[0].id === evidence?.id, answer.inputs?.map((a) => ({ id: a.id, headline: a.handoff?.headline })));

await c.openTaskDrawer(missionId, 'answer');
const drawer = await c.dialogText('answer');
const at = (s) => drawer.indexOf(s);
ev.check('the drawer names the step it came from', drawer.toLowerCase().includes('from “intake”'), drawer.slice(0, 600));
ev.check('the drawer shows the intake headline and points',
  drawer.includes('The role is US-only, so I stopped before the CV') && drawer.includes('All 14 listed cities and all 4 pay tiers are in the US'), drawer.slice(0, 600));
ev.check('the drawer shows what it needs from the person', drawer.includes('Needs Decide: skip it, or ask whether Panama counts as Americas'), drawer.slice(0, 600));
ev.check('what came in reads before the objective planned ahead of it',
  at('The role is US-only') !== -1 && at('The role is US-only') < at('Read the questions in applications/23/questions.md'), { headline: at('The role is US-only'), objective: at('Read the questions in') });
await page.screenshot(ev.shot('person-step-what-came-in'));

// The full document opens in place.
const clicked = await page.evaluate(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].pop(); const b = d && [...d.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Full doc'); if (!b) return false; b.click(); return true; })()`);
const opened = clicked && await c.until(async () => (await c.dialogText('answer')).includes('Hide full doc'), { label: 'full doc open', timeoutMs: 10_000 }).catch(() => false);
ev.check('"Full doc" opens the Evidence in the drawer', opened, (await c.dialogText('answer')).slice(0, 800));
await page.screenshot(ev.shot('person-step-full-doc'));

c.close(); ev.save();
