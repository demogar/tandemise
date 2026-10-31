// H8 — "Now": a running step shows, in plain words, what it is doing this
// moment, on its Plan card, its feed card and in its drawer, and the line
// changes as the run's events arrive. The step it starts is the one H1-H5 and
// H3 hold.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { SCRIPTS, newMission, fakeProfile, nowInDrawer, nowOnFeedCard, nowOnPlanCard, openFeed, stepOf, useRuntimes, waitStep, writeState, shoot } from '../common.mjs';

const c = await context();
const { page, sleep } = c;
const ev = new Evidence('H8', '"Now": a running step says what it is doing, and the line follows its events');

const fake = await fakeProfile(c, 'Hold fake', SCRIPTS.long);
await useRuntimes(c, [fake]);
ev.note('setup: the Design agent runs on a fake runtime that resumes and opens an interactive session on a PTY');

// HOLD_SLOW_NOW spaces the fake's events five seconds apart, so each one can be read on screen.
const missionId = await newMission(c, `Onboarding HOLD_SLOW_NOW ${Date.now().toString(36)}`, 'Hold one');
writeState({ main: missionId });
const running = await waitStep(c, missionId, (t) => t.status === 'RUNNING' && t.latestRun?.status === 'RUNNING', 'the step running', { timeoutMs: 90_000 });
const title = running.title;
ev.check('proof (API): the step runs on the fake runtime', running.latestRun.runtimeProfileId === fake, running.runtimeName);

// The Plan card, watched while the run goes: every distinct line it shows.
await page.navigate(`#/missions/${missionId}/plan`);
await sleep(1200);
const seen = [];
const deadline = Date.now() + 30_000;
let shot = false;
while (Date.now() < deadline) {
  const line = await nowOnPlanCard(c, title);
  if (line && seen[seen.length - 1] !== line) seen.push(line);
  if (!shot && line.includes('Running npm test')) { await shoot(c, ev, 'plan-card-now'); shot = true; }
  if (seen.some((l) => l.startsWith('Now Editing'))) break;
  await sleep(250);
}
ev.check('the Plan card shows a "Now" line while the step runs', seen.length > 0, seen);
ev.check('the line changes as events arrive (at least three different lines)', new Set(seen).size >= 3, seen);
ev.check('it says what it does in words: "Running npm test" for a shell command', seen.some((l) => l === 'Now Running npm test'), seen);
ev.check('a file it edits reads relative to its worktree: "Editing .tandemise/out/DesignBrief.md"', seen.includes('Now Editing .tandemise/out/DesignBrief.md'), seen);
ev.check('no raw tool names in it', seen.every((l) => !/\b(Bash|Write|tool\.started)\b/.test(l)), seen);

await openFeed(c, missionId);
const feedNow = await nowOnFeedCard(c, 'design');
ev.check('the feed card shows the same "Now" line', feedNow.startsWith('Now ') && feedNow === seen[seen.length - 1], { feedNow, last: seen[seen.length - 1] });
await shoot(c, ev, 'feed-card-now');

await c.openTaskDrawer(missionId, title);
const drawerNow = await nowInDrawer(c);
ev.check('the task drawer shows it at the top', drawerNow === feedNow, drawerNow);
await shoot(c, ev, 'drawer-now');
await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await sleep(400);

const view = await stepOf(c, missionId);
ev.check('proof (API): the view says the same', view.now === drawerNow.replace(/^Now /, ''), view.now);
c.close(); ev.save();
