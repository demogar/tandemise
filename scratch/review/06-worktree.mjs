// Worktree provisioning: idempotency after a crash, dirty-tree preservation,
// and the slug-collision hole.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nullLogger, createPaths } from '../../packages/shared/dist/index.js';
import { NodeProcessSupervisor } from '../../packages/execution-local/dist/process/node-process-supervisor.js';
import { GitService } from '../../packages/execution-local/dist/git/git-service.js';
import { WorkspaceProvisioner } from '../../packages/execution-local/dist/workspace-provisioner.js';
import { WorktreeTargetFactory } from '../../packages/execution-local/dist/targets/worktree-factory.js';

const sandbox = mkdtempSync(join(tmpdir(), 'tdm-wt-'));
const repo = join(sandbox, 'repo');
const home = join(sandbox, 'home');
mkdirSync(repo); mkdirSync(home);
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'A');
writeFileSync(join(repo, 'README.md'), '# hi\n');
git('add', '.'); git('commit', '-qm', 'init');

const supervisor = new NodeProcessSupervisor(nullLogger);
const gitSvc = new GitService(supervisor, nullLogger);
const paths = createPaths(home);
const factory = new WorktreeTargetFactory({
  git: gitSvc, supervisor, provisioner: new WorkspaceProvisioner(paths, nullLogger), log: nullLogger,
});

const req = (name) => ({
  workspaceId: 'ws_1', missionId: 'ms_1', taskId: 'tk_1', kind: 'worktree',
  name, repositoryPath: repo, missionSlug: 'm1',
});

console.log('=== 1. idempotent re-provision (crash recovery) ===');
const t1 = await factory.provision(req('implement login'));
console.log('   first  :', t1.workingDirectory, '| branch', t1.describe().branch);
const t2 = await factory.provision(req('implement login'));   // daemon died, retry
console.log('   second :', t2.workingDirectory, '| branch', t2.describe().branch);
console.log('   same directory reused ->', t1.workingDirectory === t2.workingDirectory);
console.log('   same target id?       ->', t1.id === t2.id, '(new id each time unless request.id is passed)');

console.log('\n=== 2. slug collision: two DIFFERENT tasks, one working tree ===');
const t3 = await factory.provision(req('Implement Login!'));
console.log('   "implement login" ->', t1.workingDirectory);
console.log('   "Implement Login!" ->', t3.workingDirectory);
console.log('   collided (MVP 11.2: two runs must never share a tree) ->', t1.workingDirectory === t3.workingDirectory);

console.log('\n=== 3. dirty tree on release is preserved ===');
writeFileSync(join(t1.workingDirectory, 'work-in-progress.txt'), 'unsaved work\n');
const retained = await factory.release(t1.describe());
console.log('   released =', retained.released, '| reason =', retained.retainedReason);
console.log('   directory still on disk ->', existsSync(t1.workingDirectory));
console.log('   file still there        ->', existsSync(join(t1.workingDirectory, 'work-in-progress.txt')));

console.log('\n=== 4. release with commitLeftovers salvages instead of discarding ===');
const salvaged = await factory.release(t1.describe(), {
  commitLeftovers: { name: 'Dev Role', email: 'dev@tandemise.local', roleId: 'developer', runId: 'run_9' },
});
console.log('   released =', salvaged.released, '| commit =', salvaged.commit?.slice(0, 8));
console.log('   directory removed ->', !existsSync(t1.workingDirectory));
console.log('   branch still holds the work:');
console.log(git('log', '--oneline', '-n', '2', t1.describe().branch).trim().split('\n').map((l) => '     ' + l).join('\n'));

console.log('\n=== 5. release of a dirty tree with force:true DISCARDS work ===');
const t5 = await factory.provision(req('scratch task'));
writeFileSync(join(t5.workingDirectory, 'lost.txt'), 'about to vanish\n');
const forced = await factory.release(t5.describe(), { force: true });
console.log('   released =', forced.released, '| commit =', forced.commit, '| directory gone ->', !existsSync(t5.workingDirectory));

console.log('\n=== 6. merge conflicts are reported, never auto-resolved ===');
git('checkout', '-q', '-b', 'feature');
writeFileSync(join(repo, 'README.md'), '# feature\n');
git('commit', '-qam', 'feature');
git('checkout', '-q', 'main');
writeFileSync(join(repo, 'README.md'), '# main\n');
git('commit', '-qam', 'main change');
const merged = await gitSvc.merge(repo, 'feature');
console.log('   ok =', merged.ok, '| conflicted =', JSON.stringify(merged.conflictedPaths));
console.log('   tree left in MERGING state (caller decides) ->', existsSync(join(repo, '.git', 'MERGE_HEAD')));
console.log('   conflict markers present ->', /<<<<<<</.test(execFileSync('cat', [join(repo, 'README.md')], { encoding: 'utf8' })));

await supervisor.killAll('done');
rmSync(sandbox, { recursive: true, force: true });
