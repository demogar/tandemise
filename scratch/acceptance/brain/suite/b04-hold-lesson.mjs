// B4 — A hold that changed a file becomes a lesson. Hold and interact (#50) is not merged on this branch, so the
// hold's record is published as #50 will publish it (task.hold_ended with a diff stat) through the daemon's
// test-only POST /v1/test/events. Everything after it is the real product: the reflector pass (the Brain agent),
// the lesson in the ledger, the "Learned: …" line in the mission's timeline, and Brain → Lessons.
import { Evidence } from '../../p0/lib/evidence.mjs';
import { home1, lessonRows, openBrainTab, runBuildMission, writeState } from '../common.mjs';

const c = await home1();
const ev = new Evidence('B4', 'A hold that changed a file teaches a lesson, shown on the feed and in Lessons');
const run = await runBuildMission(c, `B4 hello page ${Date.now().toString(36)}`);
ev.check('the mission ran', run.status === 'COMPLETE', run.status);
ev.note('substitution: #50 is not merged, so the hold record is published through POST /v1/test/events (task.hold_ended, ending continued, 1 file changed)');
await c.api.post('/v1/test/events', { missionId: run.id, taskId: run.task.id, body: { type: 'task.hold_ended', holdId: 'hold_b4', ending: 'continued', endedBy: null, sessionAfter: null, durationMs: 45_000, diffStat: { files: 1, insertions: 3, deletions: 1 } } });
const lesson = await c.until(async () => (await c.api.get(`/v1/workspaces/${c.env.workspaceId}/brain/entries`)).find((e) => e.text === 'Keep the header sticky on mobile.'), { label: 'lesson saved', timeoutMs: 60_000, everyMs: 1000 });
ev.check('proof (API): an active lesson, from your hold', lesson.state === 'active' && lesson.sourceLabel === 'your hold', lesson);

await c.page.navigate(`#/missions/${run.id}/timeline`);
const line = await c.until(() => c.page.evaluate(`(() => { const t = document.body.innerText; const i = t.indexOf("Learned: '"); return i >= 0 ? t.slice(i, i + 120) : false; })()`), { label: 'Learned line', timeoutMs: 30_000 });
ev.check('the mission timeline shows "Learned: … (from your hold)"', line.includes("Learned: 'Keep the header sticky on mobile.' (from your hold)"), line);
await c.page.screenshot(ev.shot('timeline-learned'));

await openBrainTab(c, 'lessons');
const rows = await lessonRows(c);
const row = rows.find((r) => r.text === 'Keep the header sticky on mobile.');
ev.check('Brain → Lessons lists it as active', row?.state === 'active', rows);
ev.check('with its source "your hold"', await c.page.evaluate(`[...document.querySelectorAll('[aria-label="Lesson list"] .brain__row')].some((r) => r.innerText.includes('Keep the header sticky on mobile.') && r.innerText.includes('From your hold'))`));
await c.page.screenshot(ev.shot('lessons'));
ev.note('real Claude Code was not run for B4: the hold itself (#50) is what drives a real session, and it is not on this branch');
writeState({ b4: { missionId: run.id, lessonId: lesson.id } });
c.close(); ev.save();
