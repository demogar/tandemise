// H5 — Restart the daemon mid-hold. The terminal dies with it and the panel
// says the session ended; the step is still HELD after the restart, and
// "Open the terminal again" resumes the session the terminal had captured.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context, SCRATCH } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { holdsOf, panelButton, panelLabel, panelText, readState, screenText, stepOf, waitScreen, shoot } from '../common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let c = await context();
const ev = new Evidence('H5', 'Restart the daemon mid-hold: still HELD, and reopening resumes the captured session');
const { main: missionId } = readState();
const step = await stepOf(c, missionId);
ev.check('the panel is open on the held step', (await panelLabel(c)) === `Terminal: ${step.title}` && step.status === 'HELD');

const oldPid = c.env.pid;
// The daemon's own stop, as quitting it would: it ends its terminals on the way out.
process.kill(oldPid, 'SIGTERM');
await c.until(() => { try { process.kill(oldPid, 0); return false; } catch { return true; } }, { label: 'daemon stopped', timeoutMs: 20_000 });
ev.note(`daemon ${oldPid} stopped`);
// The window swaps to its daemon-down state as soon as the daemon goes, taking the mission screen (and the panel on it) with it;
// what the panel says about the dropped socket is asserted once the window is back, below.
// Then the window itself: the daemon is gone, said in the sidebar or on the not-running screen.
const DOWN = /The Tandemise daemon is not running|Connecting to the daemon…|Daemon offline|Reconnecting…/;
const down = await c.until(async () => { const t = await c.page.text('body'); return DOWN.test(t) && t; }, { label: 'the window notices', timeoutMs: 30_000 })
  .catch(() => c.page.text('body'));
ev.check('the window says the daemon is gone', DOWN.test(down), down.match(DOWN)?.[0] ?? down.slice(0, 200));
await shoot(c, ev, 'daemon-gone');

// The same daemon command the run started with, against the same home.
execFileSync(process.execPath, [join(here, '../../p0/setup.mjs'), SCRATCH], { env: { ...process.env, SCRIPTED_DELAY_MS: '1500' }, stdio: ['ignore', 'pipe', 'inherit'] });
const env = JSON.parse(readFileSync(join(SCRATCH, 'env.json'), 'utf8'));
ev.check('proof: a new daemon is up', env.pid !== oldPid, { old: oldPid, now: env.pid });
// The window finds the new daemon; when it shows its "not running" screen, Retry is how a person brings it back.
await c.until(async () => {
  const body = await c.page.text('body');
  if (/Retry/.test(body) && !body.includes('Daemon connected')) await c.page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Retry')?.click()`);
  return body.includes('Daemon connected');
}, { label: 'window reconnected', timeoutMs: 60_000, everyMs: 1500 });
c.close();
c = await context();

const after = await stepOf(c, missionId);
const [hold] = holdsOf(c, step.id);
ev.check('proof (API): after the restart the step is still HELD', after.status === 'HELD' && after.hold !== null, { status: after.status, reason: after.statusReason });
ev.check('proof (API): its terminal is not open', after.hold?.terminalOpen === false, after.hold);

// Back on the mission, the panel is where it was; the terminal behind it is gone.
if ((await panelLabel(c)) === '') {
  await c.page.navigate(`#/missions/${missionId}`);
  await c.until(async () => (await panelLabel(c)) !== '', { label: 'panel back', timeoutMs: 20_000 });
}
await c.until(async () => (await panelText(c)).includes('Open the terminal again'), { label: 'reopen offered', timeoutMs: 20_000 });
const offer = await panelText(c);
ev.check('back on the mission, the panel says "The session ended." and offers "Open the terminal again"', offer.includes('The session ended.') && offer.includes('Open the terminal again'), offer);
ev.check('with the daemon\'s own words for why: there is no terminal open for this step', offer.includes('This step has no open terminal.'), offer);
await shoot(c, ev, 'session-ended');

await panelButton(c, 'Open the terminal again');
const resumed = await waitScreen(c, 'Fake session', { timeoutMs: 30_000 }).catch(() => screenText(c));
// The fake's session writes its id through the session hook ("fake-session-<time>"); the first terminal resumed sess-hold-….
const captured = /Fake session (fake-session-\d+)/.exec(resumed)?.[1] ?? null;
ev.check('the terminal opens again on the session the first terminal captured, not the run\'s', captured !== null && hold?.sessionBefore !== captured, { resumed: resumed.slice(0, 200), before: hold?.sessionBefore });
const reopened = await stepOf(c, missionId);
ev.check('proof (API): its terminal is open again, same hold', reopened.hold?.terminalOpen === true && reopened.hold.holdId === hold?.id, reopened.hold);
await shoot(c, ev, 'reopened');
c.close(); ev.save();
