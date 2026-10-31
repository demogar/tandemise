// H9 — Refusals, in plain words. Hold is shown disabled, with the daemon's
// reason, for a finished step, a step still checking its work, and a step on
// a runtime that cannot open a terminal; the daemon refuses each in the same
// words. (An eval trial's steps are never shown in the window; that refusal is
// proven offline in scratch/hold-check.mjs.)
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { SCRIPTS, newMission, cardHold, drawerHold, fakeProfile, openFeed, readState, useRuntimes, waitStep, shoot } from '../common.mjs';

const c = await context();
const { page, api, sleep } = c;
const ev = new Evidence('H9', 'Refusals: Hold says why it is not offered, in the daemon\'s words');
const refusalOf = async (taskId) => {
  try { await api.post(`/v1/tasks/${taskId}/hold`); return null; } catch (e) { return { status: e.status, message: e.body?.error?.message }; }
};

// A finished step: the one H3 continued.
{
  const { main } = readState();
  const done = await waitStep(c, main, (t) => t.status === 'SUCCEEDED', 'the finished step');
  await c.openTaskDrawer(main, done.title);
  const button = await drawerHold(c);
  const words = 'This step is done; request changes instead.';
  ev.check('a finished step: Hold is disabled, and says why', button?.text === 'Hold' && button.disabled && button.title === words, button);
  await shoot(c, ev, 'done-step');
  const refused = await refusalOf(done.id);
  ev.check('proof (API): holding it is refused in the same words', refused?.status === 409 && refused.message === words, refused);
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);
}

// A step whose stream has ended but which is still running its checks (the repository's tests take 25 s).
{
  const quick = await fakeProfile(c, 'Hold fake quick', SCRIPTS.quick);
  await useRuntimes(c, [quick]);
  const missionId = await newMission(c, `Checked onboarding ${Date.now().toString(36)}`, 'Hold checked');
  const words = "It's checking its work. You can hold it once that's done.";
  const checking = await waitStep(c, missionId, (t) => t.status === 'RUNNING' && t.holdable.ok === false && t.holdable.reason === words, 'the step checking its work', { timeoutMs: 90_000 });
  ev.check('proof (API): the step is running, its agent finished, its checks going', checking.status === 'RUNNING' && checking.latestRun?.status !== 'RUNNING', checking.latestRun?.status);
  await openFeed(c, missionId);
  const button = await c.until(async () => { const b = await cardHold(c, 'design'); return b && b; }, { label: 'Hold on the card', timeoutMs: 10_000 }).catch(() => null);
  ev.check('while it checks its work: Hold on its card is disabled, and says why', button?.text === 'Hold' && button.disabled && button.title === words, button);
  await shoot(c, ev, 'checking');
  const refused = await refusalOf(checking.id);
  ev.check('proof (API): holding it is refused in the same words', refused?.status === 409 && refused.message === words, refused);
  await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: H9 proven' });
}

// A step on a runtime without an interactive session: the scripted command-line agent.
{
  await useRuntimes(c, [c.env.scriptedProfileId]);
  const missionId = await newMission(c, `No terminal SCRIPTED_SLOW_20S ${Date.now().toString(36)}`, 'Hold one');
  const words = 'Only Claude Code steps can be held for now.';
  const running = await waitStep(c, missionId, (t) => t.status === 'RUNNING' && ['STARTING', 'RUNNING'].includes(t.latestRun?.status), 'the scripted step running', { timeoutMs: 60_000 });
  ev.check('proof (API): the view says why', running.holdable.ok === false && running.holdable.reason === words, running.holdable);
  await openFeed(c, missionId);
  const button = await cardHold(c, 'design');
  ev.check('a runtime with no terminal: Hold is disabled, and says why', button?.text === 'Hold' && button.disabled && button.title === words, button);
  await shoot(c, ev, 'no-terminal');
  const refused = await refusalOf(running.id);
  ev.check('proof (API): holding it is refused in the same words, and it keeps running', refused?.status === 409 && refused.message === words
    && (await waitStep(c, missionId, () => true, 'view')).status === 'RUNNING', refused);
  await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: H9 proven' });
}

await useRuntimes(c, [await fakeProfile(c, 'Hold fake', SCRIPTS.long)]);
ev.note('an eval trial\'s step is refused with "Eval trials can\'t be held." — proven offline (scratch/hold-check.mjs); trial missions never appear in the window');
c.close(); ev.save();
