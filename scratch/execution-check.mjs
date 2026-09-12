// End-to-end check of @tandemise/execution-core + @tandemise/execution-local.
// Run: node scratch/execution-check.mjs   (after `npx tsc -b packages/execution-local`)
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, stat, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Container, compose } from '@tandemise/kernel';
import { createLogger, createPaths, ids, isTandemiseError } from '@tandemise/shared';
import {
  EXECUTION_TARGET_MANAGER,
  PROCESS_SUPERVISOR,
  LOGGER,
  PATHS,
  executionCoreModule,
} from '@tandemise/execution-core';
import { GIT_SERVICE, executionLocalModule } from '@tandemise/execution-local';

let passed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) {
    console.error(`FAIL  ${label} ${detail}`);
    process.exitCode = 1;
    throw new Error(`assertion failed: ${label}`);
  }
  passed += 1;
  console.log(`PASS  ${label}${detail ? `  ${detail}` : ''}`);
};
const section = (n, title) => console.log(`\n--- ${n}. ${title} ---`);

const AUTHOR = {
  name: 'Tandemise developer',
  email: 'developer@tandemise.local',
  roleId: 'developer',
  runId: 'run_check',
  taskId: 'tsk_check',
};

const root = await mkdtemp(join(tmpdir(), 'tandemise-exec-'));
const repoPath = join(root, 'repo');
const home = join(root, 'home');

const container = new Container();
container.bindValue(LOGGER, createLogger({ level: 'warn' }));
container.bindValue(PATHS, createPaths(home));
compose(container, executionCoreModule, executionLocalModule);

const git = container.resolve(GIT_SERVICE);
const supervisor = container.resolve(PROCESS_SUPERVISOR);
const manager = container.resolve(EXECUTION_TARGET_MANAGER);

const workspaceId = ids.workspace();
const missionId = ids.mission();

try {
  // 1 ------------------------------------------------------------------
  section(1, 'temp git repository');
  await mkdir(repoPath, { recursive: true });
  await git.run(repoPath, ['init', '-b', 'main']);
  await writeFile(join(repoPath, 'README.md'), '# demo\n');
  await git.commitAll(repoPath, 'initial commit', AUTHOR);
  await writeFile(join(repoPath, 'conflict.txt'), 'base line\n');
  await git.commitAll(repoPath, 'add conflict.txt', AUTHOR);

  const history = await git.log(repoPath, 10);
  const baseCommit = await git.revParse(repoPath, 'main');
  check('repo has 2 commits', history.length === 2, history.map((c) => c.subject).join(' | '));
  check('default branch is main', (await git.defaultBranch(repoPath)) === 'main');
  check('commit is attributed to the role', history[0].author === AUTHOR.name, `author=${history[0].author}`);
  const body = (await git.run(repoPath, ['log', '-1', '--format=%B'])).stdout;
  check('commit carries role/run trailers', body.includes('Tandemise-Role: developer') && body.includes('Tandemise-Run: run_check'),
    body.trim().split('\n').slice(-3).join(' / '));
  check('manager knows both kinds', manager.kinds().join(',') === 'local,worktree', manager.kinds().join(','));

  // 2 ------------------------------------------------------------------
  section(2, 'provision worktree targets');
  const provision = (name) => manager.provision({
    workspaceId, missionId, taskId: ids.task(), kind: 'worktree',
    name, repositoryPath: repoPath, missionSlug: 'demo-mission',
  });
  const alpha = await provision('task alpha');
  const beta = await provision('task beta');

  check('worktree directory exists', (await stat(alpha.workingDirectory)).isDirectory(), alpha.workingDirectory);
  check('worktree is under ~/.tandemise layout',
    alpha.workingDirectory === createPaths(home).worktree(workspaceId, missionId, 'task-alpha'));
  check('branch follows tandemise/<mission>/<task>',
    alpha.describe().branch === 'tandemise/demo-mission/task-alpha', alpha.describe().branch);
  check('checked-out branch matches', (await git.currentBranch(alpha.workingDirectory)) === alpha.describe().branch);
  check('base commit matches the repository', (await git.revParse(alpha.workingDirectory, 'HEAD')) === baseCommit, baseCommit);
  check('target advertises isolation', alpha.capabilities().includes('isolated-workspace'), alpha.capabilities().join(','));
  check('git sees 3 worktrees', (await git.listWorktrees(repoPath)).length === 3);

  const reprovisioned = await manager.provision({
    workspaceId, missionId, taskId: alpha.describe().taskId, kind: 'worktree',
    name: 'task alpha', repositoryPath: repoPath, missionSlug: 'demo-mission',
  });
  check('re-provision is idempotent', reprovisioned.workingDirectory === alpha.workingDirectory,
    `still ${(await git.listWorktrees(repoPath)).length} worktrees`);

  // 3 ------------------------------------------------------------------
  section(3, 'exec inside the target');
  const status = await alpha.exec({ command: 'git', args: ['status', '--porcelain'] });
  check('git status exit 0 and clean', status.exitCode === 0 && status.stdout === '', JSON.stringify(status.stdout));
  const echoed = await alpha.exec({ command: 'echo', args: ['hello from', 'the worktree'] });
  check('echo stdout', echoed.stdout === 'hello from the worktree\n' && echoed.exitCode === 0, JSON.stringify(echoed.stdout));
  const failing = await alpha.exec({ command: 'sh', args: ['-c', 'echo to-stderr >&2; exit 3'] });
  check('non-zero exit and stderr are reported',
    failing.exitCode === 3 && failing.stderr.trim() === 'to-stderr', `exit=${failing.exitCode}`);
  const envLeak = await alpha.exec({ command: 'sh', args: ['-c', 'echo "${TANDEMISE_SECRET_CHECK:-<unset>}"'] });
  check('daemon env is not inherited by default', envLeak.stdout.trim() === '<unset>', envLeak.stdout.trim());
  const cwdEscape = await alpha.exec({ command: 'pwd', cwd: '../../..' }).catch((e) => e);
  check('exec cwd cannot escape the target', isTandemiseError(cwdEscape) && cwdEscape.code === 'PERMISSION_DENIED',
    cwdEscape?.code ?? String(cwdEscape));

  // 4 ------------------------------------------------------------------
  section(4, 'scoped filesystem');
  const fsHandle = alpha.filesystem();
  await fsHandle.write('src/feature.ts', 'export const feature = "alpha";\n');
  check('file written through the handle',
    (await readFile(join(alpha.workingDirectory, 'src/feature.ts'), 'utf8')).includes('alpha'));
  check('exists() sees it', await fsHandle.exists('src/feature.ts'));
  check('list() sees it', (await fsHandle.list('src')).map((e) => e.name).join(',') === 'feature.ts');

  const traversal = await fsHandle.write('../../etc/x', 'nope').catch((e) => e);
  check('relative traversal is rejected', isTandemiseError(traversal) && traversal.code === 'PERMISSION_DENIED',
    `${traversal?.code}: ${traversal?.message}`);
  const absolute = await fsHandle.write('/etc/x', 'nope').catch((e) => e);
  check('absolute escape is rejected', isTandemiseError(absolute) && absolute.code === 'PERMISSION_DENIED', absolute?.code);
  const traversalRead = await fsHandle.read('../../../../etc/hosts').catch((e) => e);
  check('traversal read is rejected', isTandemiseError(traversalRead) && traversalRead.code === 'PERMISSION_DENIED', traversalRead?.code);

  await symlink(root, join(alpha.workingDirectory, 'escape-hatch'));
  const viaSymlink = await fsHandle.write('escape-hatch/stolen.txt', 'nope').catch((e) => e);
  check('symlink escape is rejected', isTandemiseError(viaSymlink) && viaSymlink.code === 'PERMISSION_DENIED', viaSymlink?.code);
  await rm(join(alpha.workingDirectory, 'escape-hatch'));

  // 5 ------------------------------------------------------------------
  section(5, 'commit and merge back');
  await fsHandle.write('conflict.txt', 'alpha wins\n');
  const alphaCommit = await git.commitAll(alpha.workingDirectory, 'feat: alpha implementation', AUTHOR);
  check('worktree commit created', alphaCommit.committed && !!alphaCommit.hash, alphaCommit.hash);
  const changes = await git.diffNameStatus(repoPath, 'main', alpha.describe().branch);
  check('diffNameStatus lists the change',
    changes.some((c) => c.path === 'src/feature.ts' && c.status === 'A'), JSON.stringify(changes));
  const stats = await git.diffStat(repoPath, 'main', alpha.describe().branch);
  check('diffStat counts files', stats.filesChanged === 2 && stats.insertions === 2, JSON.stringify(stats));

  const merged = await git.merge(repoPath, alpha.describe().branch, { noFf: true });
  check('merge into main succeeded', merged.ok === true, merged.ok ? merged.hash : JSON.stringify(merged));
  check('merged content is on main',
    (await readFile(join(repoPath, 'conflict.txt'), 'utf8')).trim() === 'alpha wins');

  // 6 ------------------------------------------------------------------
  section(6, 'merge conflict is returned as data');
  await beta.filesystem().write('conflict.txt', 'beta wins\n');
  await git.commitAll(beta.workingDirectory, 'feat: beta implementation', AUTHOR);
  const conflict = await git.merge(repoPath, beta.describe().branch, { noFf: true });
  check('merge reports a conflict instead of throwing', conflict.ok === false, JSON.stringify(conflict));
  check('conflicted paths are listed',
    conflict.ok === false && conflict.conflictedPaths.join(',') === 'conflict.txt',
    conflict.ok === false ? conflict.conflictedPaths.join(',') : '');
  check('conflict was not auto-resolved',
    (await readFile(join(repoPath, 'conflict.txt'), 'utf8')).includes('<<<<<<<'));
  await git.abortMerge(repoPath);
  check('abortMerge restores the tree', await git.isClean(repoPath));

  // 7 ------------------------------------------------------------------
  section(7, 'cancellation escalation');
  const sleeper = supervisor.spawn({ command: 'sleep', args: ['60'], cwd: repoPath, label: 'sleep 60' });
  check('process is live and tracked',
    supervisor.liveProcesses().some((p) => p.pid === sleeper.pid), `pid=${sleeper.pid}`);
  check('ps sees the pid', psAlive(sleeper.pid));
  const exit = await sleeper.kill('verification', { graceMs: 250 });
  check('kill() resolved with a signal exit', exit.killedReason === 'verification' && exit.signal === 'SIGTERM',
    `signal=${exit.signal} reason=${exit.killedReason}`);
  check('ps no longer sees the pid', !psAlive(sleeper.pid), `pid=${sleeper.pid}`);
  check('supervisor forgot the process', supervisor.liveProcesses().length === 0);

  const timed = await supervisor.run({ command: 'sleep', args: ['30'], cwd: repoPath, timeoutMs: 300, killGraceMs: 200 });
  check('timeout is reported, not hung', timed.timedOut === true, `exit=${timed.exitCode} ms=${timed.durationMs}`);

  const beats = [];
  await supervisor.run({
    command: 'sh', args: ['-c', 'echo tick; sleep 0.4; echo tock'], cwd: repoPath,
    heartbeatMs: 100, onHeartbeat: (b) => beats.push(b),
  });
  check('heartbeats were emitted for a long-running process', beats.length >= 2,
    `${beats.length} beats, last bytesOut=${beats.at(-1)?.bytesOut}`);

  // Generated inside the child: a 3MB *argument* would hit ARG_MAX.
  const huge = await supervisor.run({
    command: 'sh', args: ['-c', "tr '\\0' 'x' < /dev/zero | head -c 3000000; echo"], cwd: repoPath,
  });
  const hugeLines = huge.stdout.split('\n').filter((l) => l.length > 0);
  check('a 3MB single line survives intact as one line',
    hugeLines.length === 1 && hugeLines[0].length === 3_000_000, `${hugeLines.length} line(s), ${hugeLines[0]?.length} chars`);

  const spawnFailure = await supervisor.run({ command: 'definitely-not-a-real-binary', cwd: repoPath }).catch((e) => e);
  check('a missing binary fails loudly', isTandemiseError(spawnFailure), spawnFailure?.message);

  // 8 ------------------------------------------------------------------
  section(8, 'release and cleanup');
  await beta.filesystem().write('unsaved.txt', 'work in progress\n');
  const dirtyPaths = await git.listChangedFiles(beta.workingDirectory);
  check('NUL-separated status parses exactly one path',
    dirtyPaths.length === 1 && dirtyPaths[0] === 'unsaved.txt', JSON.stringify(dirtyPaths));
  const retained = await manager.release(beta.describe());
  check('a dirty worktree is NOT removed', retained.released === false, retained.retainedReason);
  check('dirty worktree is still on disk', (await stat(beta.workingDirectory)).isDirectory());

  const salvaged = await manager.release(beta.describe(), {
    commitLeftovers: AUTHOR,
    commitMessage: 'chore(tandemise): salvage work in progress',
  });
  check('dirty work is salvaged to a commit, then released', salvaged.released === true && !!salvaged.commit, salvaged.commit);
  check('salvage commit is on the beta branch',
    (await git.log(repoPath, 1, beta.describe().branch))[0].subject.startsWith('chore(tandemise): salvage'));
  check('beta worktree directory is gone', !(await exists(beta.workingDirectory)));

  const releasedAlpha = await manager.release(alpha.describe());
  check('clean worktree released', releasedAlpha.released === true);
  check('alpha worktree directory is gone', !(await exists(alpha.workingDirectory)));
  const remaining = await git.listWorktrees(repoPath);
  check('only the main worktree remains', remaining.length === 1 && remaining[0].branch === 'main',
    remaining.map((w) => w.branch).join(','));
  check('branches survive the release',
    (await git.branchExists(repoPath, 'tandemise/demo-mission/task-alpha')) &&
    (await git.branchExists(repoPath, 'tandemise/demo-mission/task-beta')));

  const local = await manager.provision({
    workspaceId, missionId, taskId: ids.task(), kind: 'local',
    name: 'reviewer', repositoryPath: repoPath,
  });
  check('local target runs in the repository itself', local.workingDirectory === repoPath, local.workingDirectory);
  check('local target is not isolated', !local.capabilities().includes('isolated-workspace'), local.capabilities().join(','));
  check('local target execs', (await local.exec({ command: 'git', args: ['rev-parse', '--abbrev-ref', 'HEAD'] })).stdout.trim() === 'main');
  const localRelease = await manager.release(local.describe());
  check('releasing a local target never deletes the checkout',
    localRelease.released === true && (await exists(join(repoPath, 'README.md'))));

  await container.dispose();
  check('container disposal kills any stragglers', supervisor.liveProcesses().length === 0);

  console.log(`\nALL ${passed} CHECKS PASSED`);
} finally {
  await rm(root, { recursive: true, force: true });
}

function psAlive(pid) {
  try {
    execFileSync('ps', ['-p', String(pid)], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
