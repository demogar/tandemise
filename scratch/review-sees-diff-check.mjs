/**
 * An independent reviewer must be able to SEE the change (MVP.md §16.1, §17.3).
 *
 * Basing a review worktree on the mission's base branch hands the reviewer a
 * tree without the work in it, leaving it to review the ChangeSet's own
 * description of the diff — which is the claim, not the evidence. This proves
 * the reviewer's worktree is cut from the implementer's branch and contains the
 * implementer's file.
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitService, NodeProcessSupervisor, WorktreeTargetFactory, WorkspaceProvisioner } from '/Users/you/projects/tandemise/packages/execution-local/dist/index.js';
import { createLogger, createPaths, ids, systemClock } from '/Users/you/projects/tandemise/packages/shared/dist/index.js';

let bad = 0;
const ok = (n,c,d='') => { if(c) console.log(`  ok   ${n}${d?'  '+d:''}`); else { bad++; console.log(`  FAIL ${n}${d?'  '+d:''}`); } };

const root = mkdtempSync(join(tmpdir(), 'tdm-review-'));
const repo = join(root, 'repo');
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
execFileSync('mkdir', ['-p', repo]);
git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 't@t']); git(['config', 'user.name', 'T']);
writeFileSync(join(repo, 'app.js'), 'export const version = 1;\n');
git(['add', '-A']); git(['commit', '-qm', 'base']);

const log = createLogger({ level: 'error' });
const paths = createPaths(join(root, 'home'));
const supervisor = new NodeProcessSupervisor(log);
const gitService = new GitService(supervisor, log);
const provisioner = new WorkspaceProvisioner(paths, log);
const factory = new WorktreeTargetFactory({ git: gitService, supervisor, provisioner, log, clock: systemClock });

const workspaceId = ids.workspace(), missionId = ids.mission();

// The implementer works and commits on its own branch.
const implTarget = await factory.provision({
  id: ids.executionTarget(), workspaceId, missionId, taskId: ids.task(),
  kind: 'worktree', name: 'implement', repositoryPath: repo,
  baseBranch: 'main', missionSlug: 'demo',
});
const implDir = implTarget.describe().workingDirectory;
const implBranch = implTarget.describe().branch;
writeFileSync(join(implDir, 'feature.js'), 'export const clearCompleted = () => {};\n');
writeFileSync(join(implDir, 'app.js'), 'export const version = 2;\n');
git(['add', '-A'], implDir); git(['commit', '-qm', 'feat: clear completed'], implDir);
ok('the implementer committed on its own branch', !!implBranch, implBranch);

console.log('\n── the reviewer, based on the implementation branch');
const reviewTarget = await factory.provision({
  id: ids.executionTarget(), workspaceId, missionId, taskId: ids.task(),
  kind: 'worktree', name: 'review', repositoryPath: repo,
  baseBranch: implBranch, missionSlug: 'demo',
});
const reviewDir = reviewTarget.describe().workingDirectory;
ok('the reviewer got its own worktree', reviewDir !== implDir, reviewDir);
ok('the implementer\'s NEW file is present', existsSync(join(reviewDir, 'feature.js')));
ok('the implementer\'s EDIT is present',
   readFileSync(join(reviewDir, 'app.js'), 'utf8').includes('version = 2'));

const diff = git(['diff', '--stat', 'main...HEAD'], reviewDir);
ok('the reviewer can produce the real diff against base', diff.includes('feature.js') && diff.includes('app.js'), diff.replace(/\n/g, ' | '));

console.log('\n── contrast: based on main, the reviewer would be blind');
const blindTarget = await factory.provision({
  id: ids.executionTarget(), workspaceId, missionId, taskId: ids.task(),
  kind: 'worktree', name: 'blind', repositoryPath: repo,
  baseBranch: 'main', missionSlug: 'demo',
});
const blindDir = blindTarget.describe().workingDirectory;
ok('a base-branch worktree does NOT contain the change', !existsSync(join(blindDir, 'feature.js')),
   'this is what the reviewer used to get');

for (const t of [implTarget, reviewTarget, blindTarget]) { try { await t.dispose(); } catch {} }
console.log(`\n${bad === 0 ? 'REVIEWER SEES THE ACTUAL DIFF' : `${bad} FAILED`}`);
process.exit(bad === 0 ? 0 : 1);
