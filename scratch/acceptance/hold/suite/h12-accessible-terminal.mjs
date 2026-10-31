// H12 — The terminal panel is accessible (WCAG 2.1 AA): axe finds nothing, the terminal is a named region,
// screen reader mode puts xterm's output in the accessibility tree, F6 takes focus out of the terminal and back
// (2.1.2, no keyboard trap: the terminal keeps Tab and Escape for the program), Tab stays in the panel, and
// Escape outside the terminal closes the panel. Runs after H1, on its open panel, and leaves it open for H2.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { axe, iconNames, press } from '../../a11y/lib/audit.mjs';
import { cardHold, openFeed, panelButton, panelLabel, readState, shoot, stepOf } from '../common.mjs';

const c = await context();
const { page, sleep } = c;
const ev = new Evidence('H12', 'The terminal panel works with a keyboard and a screen reader');
const { main: missionId } = readState();
const step = await stepOf(c, missionId);
ev.check('the panel is open on the held step', (await panelLabel(c)) === `Terminal: ${step.title}`, await panelLabel(c));

const focused = () => page.evaluate(`(() => { const a = document.activeElement; return { terminal: !!a?.closest('.xterm'), inPanel: !!a?.closest('.terminal-panel'), name: (a?.innerText || a?.getAttribute('aria-label') || a?.tagName || '').trim() }; })()`);

for (const scheme of ['dark', 'light']) {
  await page.evaluate(`localStorage.setItem('tandemise.theme', '${scheme}'); document.documentElement.setAttribute('data-theme', '${scheme}')`);
  await sleep(500);
  const found = await axe(page, { context: `document.querySelector('.terminal-panel')` });
  ev.check(`${scheme}: axe (WCAG 2.0/2.1 A+AA) finds nothing in the panel`, found.ok, found.problems.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`));
}
const names = await iconNames(page);
ev.check('every control has an accessible name', names.ok, names.problems);
const region = await page.evaluate(`(() => { const r = document.querySelector('.terminal-panel__xterm'); return { role: r?.getAttribute('role'), label: r?.getAttribute('aria-label'), keys: document.getElementById(r?.getAttribute('aria-describedby') ?? '')?.innerText ?? '' }; })()`);
ev.check('the terminal is a named region, described by how to leave it', region.role === 'group' && region.label === `Terminal for ${step.title}` && region.keys.includes('F6'), region);

// Screen reader mode, as a person turns it on: the button reports its state and xterm builds its accessibility tree.
await panelButton(c, 'Screen reader mode');
await sleep(500);
const reader = await page.evaluate(`({ pressed: [...document.querySelectorAll('.terminal-panel button')].find((b) => b.innerText.trim() === 'Screen reader mode')?.getAttribute('aria-pressed'), tree: !!document.querySelector('.terminal-panel .xterm-accessibility') })`);
ev.check('Screen reader mode is a toggle that turns on xterm\'s accessibility tree', reader.pressed === 'true' && reader.tree, reader);
await panelButton(c, 'Screen reader mode');

// Into the terminal, then out with F6: Tab and Escape in the terminal belong to the program.
await page.evaluate(`document.querySelector('.terminal-panel .xterm-helper-textarea')?.focus()`);
await press(page, 'Tab');
await sleep(200);
ev.check('Tab in the terminal stays in the terminal (the program gets it)', (await focused()).terminal, await focused());
await press(page, 'F6');
await sleep(200);
const out = await focused();
ev.check('F6 moves focus out of the terminal to the panel\'s buttons', !out.terminal && out.inPanel, out);
const visible = await page.evaluate(`getComputedStyle(document.activeElement).outlineStyle !== 'none'`);
ev.check('and that button shows its focus ring', visible);
await shoot(c, ev, 'focus-out-of-terminal');
let stayed = true;
for (let i = 0; i < 12; i++) { await press(page, 'Tab'); await sleep(60); if (!(await focused()).inPanel) stayed = false; }
ev.check('Tab cycles inside the panel (it is a modal dialog)', stayed);
await press(page, 'F6');
await sleep(200);
ev.check('F6 again goes back into the terminal', (await focused()).terminal, await focused());

// Escape outside the terminal closes the panel; the hold and its session keep running.
await press(page, 'F6');
await sleep(150);
await press(page, 'Escape');
await sleep(500);
ev.check('Escape on the panel\'s buttons closes the panel', (await panelLabel(c)) === '', await panelLabel(c));
const held = await stepOf(c, missionId);
ev.check('proof (API): the step is still HELD after closing', held.status === 'HELD', held.status);

// Leave it as H2 expects: open again from the card.
await openFeed(c, missionId);
const again = await cardHold(c, 'design');
ev.check('its card offers Open terminal', again?.text === 'Open terminal', again);
await page.evaluate(`[...document.querySelector('[data-feed-card="design"]').querySelectorAll('button')].find((x) => x.innerText.trim() === 'Open terminal').click()`);
await c.until(async () => (await panelLabel(c)) !== '', { label: 'the terminal panel again', timeoutMs: 20_000 });
await page.evaluate(`localStorage.setItem('tandemise.theme', 'system'); document.documentElement.removeAttribute('data-theme')`);
c.close(); ev.save();
