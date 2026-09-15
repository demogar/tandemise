// C7 — AI reviewer feedback: a review agent's blocking findings become notes on build, authored by the agent;
// build starts round 2 by itself, the review is redone and passes. No fix tasks.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { assertSolo, resetStaffing, agent, waitTask, cancel, noRecordingFor } from '../common.mjs';

const c = await context();
const { page, api, env, sleep, until } = c;
const ev = new Evidence('C7', 'AI reviewer: findings become notes, round 2 starts by itself, the review passes');
await assertSolo(c, ev);
await resetStaffing(c);
const reviewer = await agent(c, 'Review agent', ['review'], env.scriptedProfileId);
await c.staff({ review: { assignees: [reviewer], reviews: [] } });

const title = `C7 reviewer SCRIPTED_REVIEW_BLOCKING ${Date.now().toString(36)}`;
const missionId = await c.createMission(title, { workflow: 'P2 chain' });
ev.note(`mission ${missionId}`);
await c.approvePlan(missionId, title);

const settled = await until(async () => {
  const ts = await c.tasks(missionId);
  const m = (await api.get(`/v1/missions/${missionId}`)).mission;
  if (['BLOCKED', 'FAILED'].includes(m.status)) return ts;
  return ts.build?.round === 2 && ts.build.status === 'SUCCEEDED' && ts.review?.status === 'SUCCEEDED' && c.runs(ts.review.id).length >= 2 && ts;
}, { label: 'review loop settles', timeoutMs: 180_000, everyMs: 1500 });
const { build, review } = settled;
const thread = await c.feedback(build.id);
const byAgent = thread.items.filter((i) => i.author?.name === 'Review agent');
ev.check('build\'s thread holds a note authored by "Review agent", recorded by Tandemise', byAgent.length >= 1 && byAgent.every((i) => i.author.kind === 'agent' && /Tandemise/i.test(i.recordedBy?.name ?? '')), thread.items.map((i) => ({ author: i.author, recordedBy: i.recordedBy, status: i.status, round: i.round, text: i.text })));
ev.check('the note is the finding, addressed in round 2', byAgent[0]?.status === 'addressed' && byAgent[0].round === 2 && /greeting ignores the visitor name/i.test(byAgent[0].text), byAgent[0]);
const events = await c.events(missionId);
const started = events.find((e) => e.taskId === build.id && e.body.type === 'task.round_started' && e.body.round === 2);
ev.check('build round 2 started without a person', build.round === 2 && Boolean(started) && started.actorId !== c.me && !events.some((e) => e.taskId === build.id && e.body.type === 'feedback.given' && e.actorId === c.me), { round: build.round, actor: started?.actorId, downstream: started?.body.downstream });
const reviewRuns = c.runs(review.id);
ev.check('review ran twice', reviewRuns.length === 2 && reviewRuns.every((r) => r.status === 'SUCCEEDED'), reviewRuns.map((r) => ({ purpose: r.purpose, status: r.status, round: r.round })));
const reports = c.sql("SELECT id, created_at FROM artifacts WHERE task_id = ? AND type = 'ReviewReport' ORDER BY created_at", review.id);
const last = reports.length ? (await api.get(`/v1/artifacts/${reports[reports.length - 1].id}`)) : null;
const first = reports.length ? (await api.get(`/v1/artifacts/${reports[0].id}`)) : null;
ev.check('the first ReviewReport failed and the last one passes', reports.length === 2 && /verdict: "fail"/.test(first?.body ?? '') && /verdict: "pass"/.test(last?.body ?? ''), { reports: reports.length, first: (first?.body ?? '').match(/verdict: .*/)?.[0], last: (last?.body ?? '').match(/verdict: .*/)?.[0] });
const keys = Object.keys(await c.tasks(missionId));
ev.check('no fix_ or recheck task was planned', !keys.some((k) => k.startsWith('fix_') || k.includes('_recheck_')), keys);
const end = await until(async () => { const m = (await api.get(`/v1/missions/${missionId}`)).mission; return ['COMPLETE', 'BLOCKED', 'FAILED'].includes(m.status) && m; }, { label: 'mission end', timeoutMs: 20_000 }).catch(async () => (await api.get(`/v1/missions/${missionId}`)).mission);
ev.check('the mission completes', end.status === 'COMPLETE', { status: end.status, reason: end.statusReason });

await page.navigate(`#/missions/${missionId}`); await sleep(1800);
const buildCard = await c.cardText('build');
ev.check('the build card shows Round 2 and What changed with the Review agent\'s name', /Round 2/.test(buildCard) && /What changed/i.test(buildCard) && /Review agent/.test(buildCard), buildCard);
noRecordingFor(ev, 'feed', await page.text('body'));
await page.screenshot(ev.shot('feed-after-loop'));
await c.openTaskDrawer(missionId, 'build');
const drawer = await c.dialogText('build');
ev.check('the build drawer thread shows the Review agent\'s note under Round 2', /Feedback/i.test(drawer) && /Round 2/.test(drawer) && /Review agent/.test(drawer), drawer.slice(0, 1500));
await page.evaluate(`(() => { const el = [...document.querySelectorAll('[role=dialog] *')].find((x) => x.children.length === 0 && /^Feedback$/i.test(x.textContent.trim())); el?.scrollIntoView({ block: 'start' }); })()`);
await sleep(500);
await page.screenshot(ev.shot('build-drawer-thread'));
await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await cancel(c, missionId, 'C7');
await resetStaffing(c);
c.close(); ev.save();
