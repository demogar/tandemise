// E6 — After the runs, no trial is left behind in the project: `git worktree list` shows no trial worktree
// and `git branch --list 'tandemise/eval-trial*'` shows no trial branch, although the runs of E2 and E4
// worked in trial worktrees on such branches (their execution targets say so).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { TERMINAL, readState } from '../common.mjs';

const c = await context();
const { api, env, until } = c;
const ev = new Evidence('E6', 'No trial worktree or branch is left after the runs');
const { e1 } = readState();
if (!e1?.suiteId) throw new Error('E6 needs E1 first (the suite)');

const runs = await api.get(`/v1/evals/suites/${e1.suiteId}/runs`);
ev.check('proof (API): every eval run on the suite has ended', runs.length >= 2 && runs.every((r) => TERMINAL.includes(r.status)), runs.map((r) => ({ id: r.id, status: r.status })));
const trials = runs.flatMap((r) => r.trials);
ev.check('proof (API): no trial is still running', trials.every((t) => t.status !== 'running' && t.status !== 'queued'), trials.map((t) => t.status));

// Where the trials worked: the execution targets of the trial missions' tasks.
const targets = c.sql(`SELECT t.branch AS branch, t.working_directory AS path, t.status AS status FROM execution_targets t
  JOIN missions m ON m.id = t.mission_id WHERE m.eval_trial_id IS NOT NULL`);
ev.note(`trial execution targets: ${JSON.stringify(targets)}`);
ev.check('proof (SQL): the trials did work on tandemise/eval-trial-* branches', targets.length > 0 && targets.some((t) => (t.branch ?? '').startsWith('tandemise/eval-trial-')), targets.slice(0, 4));

const git = (...args) => execFileSync('git', args, { cwd: env.project }).toString().trim();
// Cleanup runs as each trial ends; give the last one a moment.
const clean = await until(() => !/eval-trial/.test(git('worktree', 'list')) && git('branch', '--list', 'tandemise/eval-trial*') === '', { label: 'trial worktrees and branches gone', timeoutMs: 30_000 }).catch(() => false);
const worktrees = git('worktree', 'list');
const branches = git('branch', '--list', 'tandemise/eval-trial*');
ev.note(`git worktree list:\n${worktrees}`);
ev.note(`git branch --list 'tandemise/eval-trial*': ${JSON.stringify(branches)}`);
ev.check('`git worktree list` in the project shows no trial worktree', clean && !/eval-trial/.test(worktrees), worktrees);
ev.check('`git branch --list \'tandemise/eval-trial*\'` in the project shows none', branches === '', branches);
const leftover = targets.filter((t) => t.path && existsSync(t.path));
ev.check('no trial worktree folder is left on disk', leftover.length === 0, leftover);
ev.note(`the project's other tandemise/* branches (real missions): ${JSON.stringify(git('branch', '--list', 'tandemise/*'))}`);

c.close(); ev.save();
