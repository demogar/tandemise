// Crash-recovery shapes for worktree provisioning.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nullLogger, createPaths } from '../../packages/shared/dist/index.js';
import { NodeProcessSupervisor } from '../../packages/execution-local/dist/process/node-process-supervisor.js';
import { GitService } from '../../packages/execution-local/dist/git/git-service.js';
import { WorkspaceProvisioner } from '../../packages/execution-local/dist/workspace-provisioner.js';
import { WorktreeTargetFactory } from '../../packages/execution-local/dist/targets/worktree-factory.js';

const sandbox = mkdtempSync(join(tmpdir(), 'tdm-crash-'));
const repo = join(sandbox, 'repo'); const home = join(sandbox, 'home');
mkdirSync(repo); mkdirSync(home);
const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
g('init', '-q', '-b', 'main'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'A');
writeFileSync(join(repo, 'r.md'), 'x'); g('add', '.'); g('commit', '-qm', 'init');

const sup = new NodeProcessSupervisor(nullLogger);
const git = new GitService(sup, nullLogger);
const paths = createPaths(home);
const f = new WorktreeTargetFactory({ git, supervisor: sup, provisioner: new WorkspaceProvisioner(paths, nullLogger), log: nullLogger });
const req = { workspaceId: 'ws', missionId: 'ms', taskId: 'tk', kind: 'worktree', name: 'task a', repositoryPath: repo, missionSlug: 'm' };

const t = await f.provision(req);
const dir = t.workingDirectory;

console.log('A. directory deleted out from under git (rm -rf, no prune):');
rmSync(dir, { recursive: true, force: true });
const t2 = await f.provision(req);
console.log('   re-provisioned ok ->', existsSync(t2.workingDirectory), '| branch', t2.describe().branch);

console.log('\nB. branch already exists but no worktree (crash between branch and add):');
rmSync(t2.workingDirectory, { recursive: true, force: true });
execFileSync('git', ['worktree', 'prune'], { cwd: repo });
const t3 = await f.provision(req);
console.log('   re-provisioned ok ->', existsSync(t3.workingDirectory), '| branch', t3.describe().branch);

console.log('\nC. a non-empty unregistered directory is NOT clobbered:');
rmSync(t3.workingDirectory, { recursive: true, force: true });
execFileSync('git', ['worktree', 'prune'], { cwd: repo });
mkdirSync(t3.workingDirectory, { recursive: true });
writeFileSync(join(t3.workingDirectory, 'someones-data.txt'), 'keep me');
try {
  await f.provision(req);
  console.log('   CLOBBERED <-- unexpected');
} catch (e) {
  console.log('   refused:', e.code, '-', e.message.slice(0, 80));
  console.log('   data preserved ->', existsSync(join(t3.workingDirectory, 'someones-data.txt')));
}

console.log('\nD. worktree exists on a DIFFERENT branch:');
rmSync(t3.workingDirectory, { recursive: true, force: true });
execFileSync('git', ['worktree', 'prune'], { cwd: repo });
execFileSync('git', ['worktree', 'add', '-q', '-b', 'someone-else', t3.workingDirectory, 'main'], { cwd: repo });
try {
  await f.provision(req);
  console.log('   reused someone else\'s worktree <-- unexpected');
} catch (e) {
  console.log('   refused:', e.code, '-', e.message.slice(0, 90));
}

console.log('\nE. worktree exists with DETACHED head (branch === null):');
execFileSync('git', ['-C', t3.workingDirectory, 'checkout', '-q', '--detach'], {});
const t5 = await f.provision(req);
console.log('   reused, and the record claims branch =', JSON.stringify(t5.describe().branch));
console.log('   actual HEAD in that worktree        =', execFileSync('git', ['-C', t3.workingDirectory, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim());

await sup.killAll('done');
rmSync(sandbox, { recursive: true, force: true });
