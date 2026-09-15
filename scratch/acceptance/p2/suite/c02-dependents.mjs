// C2 — Tweak with dependents: Request changes on a design that a finished build used opens the impact dialog.
// Mission 1 chooses "Redo them after the new version"; mission 2 chooses "Keep their work".
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { assertSolo, noRecordingFor, agent, resetStaffing, waitTask, cancel } from '../common.mjs';

const c = await context();
const { page, env, sleep, until } = c;
const ev = new Evidence('C2', 'Tweak with dependents: the impact dialog, Redo and Keep');
await assertSolo(c, ev);
await resetStaffing(c);
const designer = await agent(c, 'Design agent', ['design'], env.scriptedProfileId);
const coder = await agent(c, 'Coding agent', ['development'], env.scriptedProfileId);
const reviewer = await agent(c, 'Review agent', ['review'], env.scriptedProfileId);
await c.staff({ design: { assignees: [designer], reviews: [] }, development: { assignees: [coder], reviews: [] }, review: { assignees: [reviewer], reviews: [] } });

const clickChoice = (text) => page.evaluate(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].pop(); const l = d && [...d.querySelectorAll('label')].find((x) => x.innerText.trim().startsWith(${JSON.stringify(text)})); const i = l?.querySelector('input'); if (!i) return false; i.click(); return true; })()`);
const clickInDialog = (text) => page.evaluate(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].pop(); const b = d && [...d.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(text)} && !x.disabled); if (!b) return false; b.click(); return true; })()`);

/** A finished chain, then Request changes on design → the dialog. Returns what the scenario needs to judge the choice. */
async function toDialog(label) {
  const title = `C2 ${label} ${Date.now().toString(36)}`;
  const missionId = await c.createMission(title, { workflow: 'P2 chain' });
  ev.note(`${label}: mission ${missionId}`);
  await c.approvePlan(missionId, title);
  await waitTask(c, missionId, 'review', (t) => t.status === 'SUCCEEDED', `${label}: chain done`, 120_000);
  const tasks = await c.tasks(missionId);
  const buildRun = tasks.build.latestRun;
  const sent = await c.requestChangesOnCard(missionId, 'design', label === 'redo' ? 'Make the greeting larger' : 'Use a warmer colour for the greeting');
  noRecordingFor(ev, `${label} composer`, sent.bodyWhileOpen);
  const dialog = await until(() => c.dialogText('Round 2 of'), { label: `${label}: impact dialog`, timeoutMs: 10_000 }).catch(() => '');
  return { title, missionId, tasks, buildRun, dialog };
}

// ---- Redo
{
  const { missionId, tasks, buildRun, dialog } = await toDialog('redo');
  // Workflow steps are titled by their keys, so the dialog names the task "design".
  ev.check('redo: the dialog opens as "Round 2 of design"', /^Round 2 of design\n/.test(dialog), dialog);
  ev.check('redo: it lists Build (done) and says it used Design v1', /Build \(done\)[^.]*used Design v1/.test(dialog), dialog);
  ev.check('redo: it offers Redo and Keep, Start round 2 and Not now', /Redo them after the new version/.test(dialog) && /Keep their work/.test(dialog) && /Start round 2/.test(dialog) && /Not now/.test(dialog));
  await page.screenshot(ev.shot('dialog'));
  ev.check('redo: chose "Redo them after the new version"', await clickChoice('Redo them after the new version'));
  await sleep(400);
  const redoDialog = await c.dialogText('Round 2 of');
  ev.check('redo: each dependent has its checkbox, ticked', /\nbuild\nreview\n/.test(redoDialog) && (await page.evaluate(`[...[...document.querySelectorAll('[role=dialog]')].pop().querySelectorAll('input[type=checkbox]')].every((i) => i.checked)`)), redoDialog);
  await page.screenshot(ev.shot('dialog-redo'));
  ev.check('redo: clicked Start round 2', await clickInDialog('Start round 2'));
  const reset = await until(async () => { const t = await c.task(missionId, 'build'); return t.status === 'PENDING' && t; }, { label: 'build back to PENDING', timeoutMs: 10_000, everyMs: 200 }).catch(async () => c.task(missionId, 'build'));
  ev.check('redo: build goes back to PENDING, "Redone after design round 2"', reset.status === 'PENDING' && /Redone after design round 2/.test(reset.statusReason ?? ''), { status: reset.status, reason: reset.statusReason });
  const design2 = await waitTask(c, missionId, 'design', (t) => t.round === 2 && t.status === 'SUCCEEDED', 'design round 2', 60_000);
  const rebuilt = await waitTask(c, missionId, 'build', (t) => t.status === 'SUCCEEDED' && t.latestRun?.id !== buildRun.id, 'build reran', 90_000);
  const designArts = c.sql('SELECT id, round FROM artifacts WHERE task_id = ? ORDER BY created_at', design2.id);
  const inputs = c.sql('SELECT a.id, a.task_id AS taskId, a.round, a.type FROM run_inputs ri JOIN artifacts a ON a.id = ri.artifact_id WHERE ri.run_id = ?', rebuilt.latestRun.id);
  const v2 = designArts.find((a) => a.round === 2);
  ev.check('redo: build reran and its new run used design v2', Boolean(v2) && inputs.some((a) => a.id === v2.id) && !inputs.some((a) => a.taskId === design2.id && a.id !== v2.id), { inputs, designArts });
  ev.check('redo: build was not flagged for attention', rebuilt.needsAttention === false);
  // Review read the build being replaced, so the redo reran it too: one more run than before, on the new build.
  const rereviewed = await waitTask(c, missionId, 'review', (t) => t.status === 'SUCCEEDED' && t.runCount > tasks.review.runCount, 'review reran after redo', 90_000)
    .catch(async () => c.task(missionId, 'review'));
  ev.check('redo: review reran (its run count increased) and succeeded', rereviewed.status === 'SUCCEEDED' && rereviewed.runCount > tasks.review.runCount,
    { before: tasks.review.runCount, after: rereviewed.runCount, status: rereviewed.status });
  await page.navigate(`#/missions/${missionId}`); await sleep(1800);
  const feed = await page.text('main');
  ev.check('redo: the feed shows design as Round 2', /Round 2/.test(await c.cardText('design')), await c.cardText('design'));
  await page.screenshot(ev.shot('redo-feed'));
  await page.navigate(`#/missions/${missionId}/timeline`); await sleep(1800);
  const timeline = await page.text('main');
  ev.check('redo: the timeline says "Round 2 started" and "Redone: build"', /Round 2 started/.test(timeline) && /Redone: build/.test(timeline), timeline.slice(0, 600));
  await page.screenshot(ev.shot('redo-timeline'));
  noRecordingFor(ev, 'redo feed', feed);
  await cancel(c, missionId, 'C2 redo');
  void tasks;
}

// ---- Keep
{
  const { missionId, tasks, dialog } = await toDialog('keep');
  ev.check('keep: the dialog lists Build (done) and says it used Design v1', /Build \(done\)[^.]*used Design v1/.test(dialog), dialog);
  ev.check('keep: chose "Keep their work"', await clickChoice('Keep their work'));
  await sleep(300);
  await page.screenshot(ev.shot('dialog-keep'));
  ev.check('keep: clicked Start round 2', await clickInDialog('Start round 2'));
  await sleep(1000);
  ev.check('keep: build stays SUCCEEDED right after', (await c.task(missionId, 'build')).status === 'SUCCEEDED');
  await waitTask(c, missionId, 'design', (t) => t.round === 2 && t.status === 'SUCCEEDED', 'design round 2', 60_000);
  const flagged = await waitTask(c, missionId, 'build', (t) => t.needsAttention, 'build flagged', 20_000).catch(async () => c.task(missionId, 'build'));
  ev.check('keep: build is still SUCCEEDED on its first run, and flagged once design round 2 lands', flagged.status === 'SUCCEEDED' && flagged.needsAttention === true && flagged.latestRun?.id === tasks.build.latestRun.id, { status: flagged.status, needsAttention: flagged.needsAttention });
  await page.navigate(`#/missions/${missionId}/timeline`); await sleep(1800);
  const timeline = await page.text('main');
  ev.check('keep: the timeline says build was built against design v1 and v2 is out', /Built against design v1; v2 is out\./.test(timeline), timeline.slice(0, 800));
  // Nobody asked build for changes: the line says it stands on an older version, and the engine noticed, not the design agent.
  ev.check('keep: the timeline titles it "Built on an older version of design", not "needs changes"',
    /Built on an older version of design/.test(timeline) && !/work needs changes/.test(timeline), timeline.slice(0, 800));
  const flagEvent = (await c.events(missionId)).find((e) => e.taskId === flagged.id && e.body.type === 'task.attention');
  ev.check('keep: the flag is recorded by Tandemise as stale input', flagEvent?.actorId === 'system' && flagEvent.body.kind === 'stale_input', flagEvent && { actor: flagEvent.actorId, body: flagEvent.body });
  await page.screenshot(ev.shot('keep-timeline'));
  await page.navigate(`#/missions/${missionId}/plan`); await sleep(1800);
  const plan = await page.text('main');
  ev.check('keep: the Plan card reads "Built on an older version of design", with no "Changes requested after the fact"',
    /Built on an older version of design/.test(plan) && !/Changes requested after the fact/.test(plan), plan.slice(0, 1200));
  ev.check('Plan tab: task cards show no raw tsk_ ids and the plan strip no art_ id until Details', !/tsk_[0-9a-z]{6}|art_[0-9a-z]{6}/.test(plan), plan.match(/(tsk|art)_[0-9a-z]+/g));
  await page.screenshot(ev.shot('keep-flag'));
  await cancel(c, missionId, 'C2 keep');
}
await resetStaffing(c);
c.close(); ev.save();
