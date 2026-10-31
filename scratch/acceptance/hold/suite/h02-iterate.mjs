// H2 — Iterate: a file written during the hold, from the terminal, is in the step's worktree.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { panelLabel, readState, stepOf, typeLine, waitScreen, worktreeOf, shoot } from '../common.mjs';

const c = await context();
const { page } = c;
const ev = new Evidence('H2', 'Iterate: what you make in the terminal lands in the step\'s worktree');
const { main: missionId } = readState();
const step = await stepOf(c, missionId);
ev.check('the panel is still open on the held step', (await panelLabel(c)) === `Terminal: ${step.title}` && step.status === 'HELD', await panelLabel(c));

await typeLine(c, 'write d.txt');
const screen = await waitScreen(c, 'wrote d.txt').catch(() => '');
ev.check('the session reports the file written', screen.includes('wrote d.txt'), screen.slice(-300));
await shoot(c, ev, 'wrote-file');

const worktree = await worktreeOf(c, missionId, step.id);
const file = worktree === null ? null : join(worktree, 'd.txt');
ev.check('proof (disk): d.txt is in the step\'s worktree', file !== null && existsSync(file), file);
ev.check('proof (disk): with what the session wrote', file !== null && existsSync(file) && readFileSync(file, 'utf8') === 'written in a held session\n');
c.close(); ev.save();
