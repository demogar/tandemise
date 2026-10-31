// H4 — Close the panel mid-hold: the terminal keeps running, and opening it
// again from the step's drawer repaints what it showed.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { drawerButton, drawerHold, holdsOf, panelButton, panelLabel, readState, screenText, stepOf, waitScreen, shoot } from '../common.mjs';

const c = await context();
const { page, sleep, until } = c;
const ev = new Evidence('H4', 'Close the panel mid-hold: the terminal keeps going, and reopening repaints it');
const { main: missionId } = readState();
const step = await stepOf(c, missionId);

await panelButton(c, 'Close terminal');
await until(async () => (await panelLabel(c)) === '', { label: 'panel closed', timeoutMs: 5000 });
ev.check('Close terminal closes the panel', (await panelLabel(c)) === '');
await sleep(1500);
const after = await stepOf(c, missionId);
ev.check('proof (API): the step is still HELD, its terminal still open', after.status === 'HELD' && after.hold?.terminalOpen === true, after.hold);
const pid = c.sql('SELECT pty_pid AS pid FROM task_holds WHERE task_id = ? AND ended_at IS NULL', step.id)[0]?.pid;
const alive = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
ev.check('proof (OS): the terminal process is still running', typeof pid === 'number' && alive, { pid, alive });

await c.openTaskDrawer(missionId, step.title);
const footer = await page.evaluate(`[...document.querySelectorAll('.modal .modal__foot button')].map((b) => b.innerText.trim())`);
ev.check('the held step\'s drawer offers Open terminal, Release and Continue', ['Open terminal', 'Release', 'Continue'].every((l) => footer.includes(l)), footer);
ev.check('and no Hold', (await drawerHold(c))?.text === 'Open terminal', await drawerHold(c));
await shoot(c, ev, 'drawer-held');
await drawerButton(c, 'Open terminal');
await until(async () => (await panelLabel(c)) !== '', { label: 'panel', timeoutMs: 10_000 });
ev.check('the drawer steps aside for the panel', await page.evaluate(`!document.querySelector('.modal')`));
const repainted = await waitScreen(c, 'wrote d.txt').catch(() => screenText(c));
ev.check('the reopened panel repaints the scrollback: the greeting, your typing, the file', repainted.includes('Fake session') && repainted.includes('> hello from the panel') && repainted.includes('wrote d.txt'), repainted);
ev.check('proof (DB): still the same hold', holdsOf(c, step.id).length === 1);
await shoot(c, ev, 'reopened');
c.close(); ev.save();
