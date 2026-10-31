// B5 — A new mission on the same step: Task view → "What it knew" lists the lesson from B4 and project.md, and
// GET /v1/runs/:id/brain has the lesson's id in `loaded`.
import { Evidence } from '../../p0/lib/evidence.mjs';
import { home1, readState, runBuildMission, writeState } from '../common.mjs';

const c = await home1();
const ev = new Evidence('B5', 'The next run on the step loads the lesson, and the task shows what it knew');
const { b4 } = readState();
const run = await runBuildMission(c, `B5 hello page ${Date.now().toString(36)}`);
ev.check('the mission ran', run.status === 'COMPLETE', run.status);
await c.openTaskDrawer(run.id, run.task.title);
const knew = await c.until(() => c.page.evaluate(`[...document.querySelectorAll('[role=dialog]')].pop()?.querySelector('section[aria-label="What it knew"]')?.innerText ?? false`), { label: 'What it knew', timeoutMs: 20_000 });
ev.check('"What it knew" lists the lesson', knew.includes('Keep the header sticky on mobile.'), knew.slice(0, 400));
ev.check('and memory/rules/project.md', knew.includes('memory/rules/project.md'));
ev.check('in plain words', /^What it knew\s+Loaded 1 rules file and \d+ lessons?/.test(knew.trim()), knew.slice(0, 120));
await c.page.evaluate(`[...document.querySelectorAll('[role=dialog]')].pop()?.querySelector('section[aria-label="What it knew"]')?.scrollIntoView({ block: 'center' })`);
await c.sleep(400);
await c.page.screenshot(ev.shot('what-it-knew'));
const tasks = await c.api.get(`/v1/missions/${run.id}/tasks`);
const runId = tasks.find((t) => t.id === run.task.id)?.latestRun?.id;
const view = await c.api.get(`/v1/runs/${runId}/brain`);
ev.check('proof (API): runs.brain.loaded has the lesson id', view.loaded.some((e) => e.id === b4.lessonId), view.loaded.map((e) => e.id));
writeState({ b5: { missionId: run.id, taskTitle: run.task.title, taskId: run.task.id } });
c.close(); ev.save();
