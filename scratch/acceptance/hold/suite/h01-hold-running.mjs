// H1 — Hold a running step. Hold on its feed card: the run ends RESUMABLE, the
// step is HELD, and the terminal panel shows the session it resumed. What you
// type reaches it (the fake echoes it). Shown in the dark and light themes.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { cardHold, holdFromCard, holdsOf, openFeed, panelLabel, panelText, readState, screenText, stepOf, typeLine, waitScreen, waitStep, writeState, shoot } from '../common.mjs';

const c = await context();
const { page, sleep } = c;
const ev = new Evidence('H1', 'Hold a running step: the panel shows its resumed session and takes your typing');
const { main: missionId } = readState();

const before = await waitStep(c, missionId, (t) => t.status === 'RUNNING' && t.latestRun?.status === 'RUNNING', 'the step running');
const runId = before.latestRun.id;
writeState({ attemptsBeforeHold: before.attempts });
ev.check('proof (API): the step is running, and the view offers a hold', before.holdable.ok === true && before.hold === null, before.holdable);

await openFeed(c, missionId);
const button = await cardHold(c, 'design');
ev.check('its in-progress card offers Hold, next to its other actions', button?.text === 'Hold' && !button.disabled, button);
await shoot(c, ev, 'card-hold');

await holdFromCard(c, missionId);
ev.check('Hold opens the terminal panel, named for the step', (await panelLabel(c)) === `Terminal: ${before.title}`, await panelLabel(c));
const header = await panelText(c);
ev.check('the panel says who holds it: "Held by You"', header.includes('Held by You'), header);
ev.check('it offers Continue, Release and Close terminal', ['Continue', 'Release', 'Close terminal'].every((label) => header.includes(label)), header);

const held = await stepOf(c, missionId);
const [hold] = holdsOf(c, held.id);
ev.check('proof (API): the step is HELD, its terminal open', held.status === 'HELD' && held.hold?.terminalOpen === true, { status: held.status, hold: held.hold });
const run = c.runs(held.id).find((r) => r.id === runId);
ev.check('proof (DB): the run it stopped ended RESUMABLE', run?.status === 'RESUMABLE', run);
ev.check('proof (DB): the hold started from that run\'s session', hold?.sessionBefore === run?.sessionId && hold.fromStatus === 'RUNNING', { hold, session: run?.sessionId });

const greeting = await waitScreen(c, 'Fake session');
ev.check('the terminal shows the session it resumed', greeting.includes(`Fake session ${hold?.sessionBefore}`), greeting);

await typeLine(c, 'hello from the panel');
const echoed = await waitScreen(c, '> hello from the panel').catch(() => screenText(c));
ev.check('what you type reaches the session (it echoes it back)', echoed.includes('> hello from the panel'), echoed);

// The panel in both themes, as the OS would choose them.
for (const scheme of ['dark', 'light']) {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await sleep(700);
  const colours = await page.evaluate(`(() => { const s = document.querySelector('.terminal-panel .xterm-screen canvas, .terminal-panel .xterm-rows'); const body = document.querySelector('.terminal-panel__body'); return { body: getComputedStyle(body).backgroundColor, rows: s ? getComputedStyle(s).color : null }; })()`);
  ev.note(`${scheme}: terminal background ${colours.body}, text ${colours.rows}`);
  await shoot(c, ev, `panel-${scheme}`);
}
await page.send('Emulation.setEmulatedMedia', { features: [] });
await sleep(400);
c.close(); ev.save();
