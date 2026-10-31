import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { TandemiseError, type Logger } from '@tandemise/shared';
import type { ExecResult, ProcessSupervisor } from '@tandemise/execution-core';
import type { BrainFileChange, BrainPushResult, BrainRepoPort, BrainWrite } from '@tandemise/domain';

/** A clone of a remote can take longer than a local command. */
const CLONE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 60_000;
/** The identity a commit gets when no person is behind it (ledger batches). */
const DAEMON_AUTHOR = { name: 'Tandemise', email: 'tandemise@localhost' } as const;
const LEDGER_DIR = 'memory/ledger/';

export const LEDGER_APPEND_ONLY = 'Ledger files are append-only.';

/**
 * The brain repository through the `git` CLI (#51 spec §4).
 *
 * Every command runs with hooks off, no submodules, LFS smudge off and no
 * terminal prompt, as P13 clones skills. A `github.com` remote borrows gh's
 * credential helper, so Tandemise holds no GitHub credential of its own.
 * Ledger files are only ever opened for append: a `write` or `delete` under
 * `memory/ledger/` is refused before git is touched.
 */
export class GitBrainRepo implements BrainRepoPort {
  constructor(
    private readonly supervisor: ProcessSupervisor,
    private readonly log: Logger,
    /** Extra variables for git: the person's ssh agent, or a test's git config. */
    private readonly env: () => Readonly<Record<string, string>> = () => ({}),
  ) {}

  async clone(remote: string, into: string): Promise<void> {
    await mkdir(dirname(into), { recursive: true });
    const url = remoteUrl(remote);
    const result = await this.#git(dirname(into), ['clone', '--no-recurse-submodules', '--', url, into], { timeoutMs: CLONE_TIMEOUT_MS, url });
    if (result.exitCode !== 0) throw failed('clone', result);
  }

  async init(into: string, branch: string): Promise<void> {
    await mkdir(into, { recursive: true });
    await this.#must(into, ['init', '-b', branch]);
  }

  async setRemote(clone: string, remote: string): Promise<void> {
    const url = remoteUrl(remote);
    const has = await this.#git(clone, ['remote', 'get-url', 'origin']);
    await this.#must(clone, has.exitCode === 0 ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]);
  }

  async head(clone: string, ref = 'HEAD'): Promise<string | null> {
    const result = await this.#git(clone, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const sha = result.stdout.trim();
    return result.exitCode === 0 && sha !== '' ? sha : null;
  }

  async fetchAndRebase(clone: string, branch: string): Promise<{ head: string; conflicted: readonly string[]; offline: string | null; failed?: string }> {
    const current = async (): Promise<string> => (await this.head(clone)) ?? '';
    const origin = await this.#origin(clone);
    if (origin === null) return { head: await current(), conflicted: [], offline: null };
    const fetched = await this.#git(clone, ['fetch', '--no-tags', 'origin'], { url: origin });
    if (fetched.exitCode !== 0) return { head: await current(), conflicted: [], offline: lastLine(fetched) };
    if ((await this.head(clone, `refs/remotes/origin/${branch}`)) === null) return { head: await current(), conflicted: [], offline: null };
    if ((await this.head(clone)) === null) {
      // An unborn local branch (a fresh init that never committed): take the remote's.
      await this.#must(clone, ['reset', '--hard', `origin/${branch}`]);
      return { head: await current(), conflicted: [], offline: null };
    }
    const rebased = await this.#git(clone, ['rebase', `origin/${branch}`]);
    if (rebased.exitCode === 0) return { head: await current(), conflicted: [], offline: null };
    const conflicted = (await this.#git(clone, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').map((l) => l.trim()).filter(Boolean).sort();
    await this.#git(clone, ['rebase', '--abort']);
    // A rebase that failed with nothing conflicted (a dirty tree, a lock) is a failure, never a success.
    if (conflicted.length === 0) return { head: await current(), conflicted: [], offline: null, failed: lastLine(rebased) };
    return { head: await current(), conflicted, offline: null };
  }

  async commit(clone: string, files: readonly BrainWrite[], message: string, author: { name: string; email: string } | null, onto?: { branch: string; from: string }): Promise<string> {
    for (const file of files) {
      const path = safePath(file.path);
      if (path.startsWith(LEDGER_DIR) && file.mode !== 'append') throw TandemiseError.validation(LEDGER_APPEND_ONLY, { path });
    }
    if (onto !== undefined) {
      // Another branch: a throwaway worktree, so the checked-out branch and its files never move.
      const exists = (await this.head(clone, `refs/heads/${onto.branch}`)) !== null;
      const dir = await mkdtemp(join(tmpdir(), 'tandemise-brain-'));
      await rm(dir, { recursive: true, force: true });
      await this.#must(clone, exists ? ['worktree', 'add', '-f', dir, onto.branch] : ['worktree', 'add', '-f', '-b', onto.branch, dir, onto.from]);
      try {
        await this.commit(dir, files, message, author);
        return (await this.head(clone, `refs/heads/${onto.branch}`)) ?? '';
      } finally {
        await this.#git(clone, ['worktree', 'remove', '--force', dir]);
        await rm(dir, { recursive: true, force: true });
      }
    }
    // What each file was, so a commit that fails leaves the clone exactly as it found it.
    const originals = new Map<string, Buffer | null>();
    for (const file of files) {
      const absolute = join(clone, safePath(file.path));
      if (!originals.has(absolute)) originals.set(absolute, await readFile(absolute).catch(() => null));
    }
    try {
      await this.#writeAndCommit(clone, files, message, author);
    } catch (e) {
      for (const [absolute, before] of originals) {
        if (before === null) await rm(absolute, { force: true });
        else await writeFile(absolute, before);
      }
      await this.#git(clone, ['reset', '-q', '--', ...files.map((f) => safePath(f.path))]);
      throw e;
    }
    return (await this.head(clone)) ?? '';
  }

  async #writeAndCommit(clone: string, files: readonly BrainWrite[], message: string, author: { name: string; email: string } | null): Promise<void> {
    for (const file of files) {
      const absolute = join(clone, safePath(file.path));
      if (file.mode === 'delete') {
        await rm(absolute, { force: true });
        continue;
      }
      await mkdir(dirname(absolute), { recursive: true });
      if (file.mode === 'append') {
        // O_APPEND: the kernel puts every write at the end; nothing can truncate.
        const handle = await open(absolute, 'a');
        try {
          await handle.write(file.content);
        } finally {
          await handle.close();
        }
      } else {
        await writeFile(absolute, file.content, 'utf8');
      }
    }
    if (files.length > 0) await this.#must(clone, ['add', '-A', '--', ...files.map((f) => safePath(f.path))]);
    const staged = await this.#git(clone, ['diff', '--cached', '--quiet']);
    const who = author ?? DAEMON_AUTHOR;
    if (staged.exitCode !== 0) {
      await this.#must(clone, ['-c', `user.name=${who.name}`, '-c', `user.email=${who.email}`, 'commit', '--no-verify', '-q', '-m', message]);
    }
  }

  async push(clone: string, branch: string, opts?: { force?: false; setUpstream?: boolean }): Promise<BrainPushResult> {
    const origin = await this.#origin(clone);
    if (origin === null) return 'offline';
    const result = await this.#git(clone, ['push', '--no-verify', ...(opts?.setUpstream ? ['-u'] : []), 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { url: origin });
    if (result.exitCode === 0) return 'pushed';
    const text = `${result.stderr}\n${result.stdout}`;
    if (/protected branch|GH006|pre-receive hook declined/i.test(text)) return 'protected';
    if (/\[rejected\]|non-fast-forward|fetch first|\(stale info\)/i.test(text)) return 'rejected';
    this.log.warn('brain.push_failed', { clone, branch, error: lastLine(result) });
    return 'offline';
  }

  async branch(clone: string, name: string, from: string): Promise<void> {
    await this.#must(clone, ['branch', '-f', name, from]);
  }

  async moveUnpushedTo(clone: string, branch: string, base: string): Promise<readonly string[]> {
    const upstream = `refs/remotes/origin/${base}`;
    const hasUpstream = (await this.head(clone, upstream)) !== null;
    const range = hasUpstream ? [`${upstream}..refs/heads/${base}`] : [`refs/heads/${base}`];
    const shas = (await this.#must(clone, ['rev-list', '--reverse', ...range])).split('\n').map((l) => l.trim()).filter(Boolean);
    if (shas.length === 0) return [];
    if (!hasUpstream) {
      await this.#must(clone, ['branch', '-f', branch, `refs/heads/${base}`]);
      return shas;
    }
    // Ledger commits stay on the default branch (they never conflict); only the rest moves.
    const ledgerOnly = async (sha: string): Promise<boolean> => {
      const paths = (await this.#must(clone, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha])).split('\n').map((l) => l.trim()).filter(Boolean);
      return paths.length > 0 && paths.every((p) => p.startsWith(LEDGER_DIR));
    };
    const keep: string[] = [];
    const move: string[] = [];
    for (const sha of shas) (await ledgerOnly(sha) ? keep : move).push(sha);
    if (move.length === 0) return [];
    // The branch starts where this clone's work started, so its commits apply as they were made.
    const forkPoint = (await this.#must(clone, ['merge-base', `refs/heads/${base}`, upstream])).trim();
    await this.#must(clone, ['branch', '-f', branch, forkPoint]);
    const dir = await mkdtemp(join(tmpdir(), 'tandemise-brain-'));
    await rm(dir, { recursive: true, force: true });
    await this.#must(clone, ['worktree', 'add', '-f', dir, branch]);
    try {
      for (const sha of move) await this.#must(dir, ['-c', `user.name=${DAEMON_AUTHOR.name}`, '-c', `user.email=${DAEMON_AUTHOR.email}`, 'cherry-pick', '--allow-empty', sha]);
    } finally {
      await this.#git(clone, ['worktree', 'remove', '--force', dir]);
      await rm(dir, { recursive: true, force: true });
    }
    await this.#must(clone, ['reset', '--hard', upstream]);
    for (const sha of keep) await this.#must(clone, ['-c', `user.name=${DAEMON_AUTHOR.name}`, '-c', `user.email=${DAEMON_AUTHOR.email}`, 'cherry-pick', sha]);
    return move;
  }

  async fastForward(clone: string, branch: string, onto: string): Promise<boolean> {
    const ancestor = await this.#git(clone, ['merge-base', '--is-ancestor', `refs/heads/${onto}`, `refs/heads/${branch}`]);
    if (ancestor.exitCode !== 0) return false;
    const checkedOut = (await this.#git(clone, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
    if (checkedOut === onto) await this.#must(clone, ['merge', '--ff-only', '-q', `refs/heads/${branch}`]);
    else await this.#must(clone, ['update-ref', `refs/heads/${onto}`, `refs/heads/${branch}`]);
    return true;
  }

  async revert(clone: string, sha: string, message: string): Promise<string> {
    try {
      await this.#must(clone, ['revert', '--no-commit', sha]);
      await this.#must(clone, ['-c', `user.name=${DAEMON_AUTHOR.name}`, '-c', `user.email=${DAEMON_AUTHOR.email}`, 'commit', '--no-verify', '-q', '-m', message]);
    } catch (e) {
      // A revert that conflicts is abandoned, so the clone is never left mid-revert.
      await this.#git(clone, ['revert', '--abort']);
      await this.#git(clone, ['reset', '-q', '--merge']);
      throw e;
    }
    return (await this.head(clone)) ?? '';
  }

  async readAt(clone: string, sha: string, path: string): Promise<string | null> {
    const result = await this.#git(clone, ['show', `${sha}:${safePath(path)}`]);
    return result.exitCode === 0 ? result.stdout : null;
  }

  async listAt(clone: string, sha: string, dir: string): Promise<readonly string[]> {
    const args = ['ls-tree', '-r', '--name-only', sha];
    if (dir !== '' && dir !== '.') args.push('--', safePath(dir));
    const result = await this.#git(clone, args);
    if (result.exitCode !== 0) return [];
    return result.stdout.split('\n').map((l) => l.trim()).filter(Boolean).sort();
  }

  async diffAt(clone: string, base: string, head: string): Promise<readonly BrainFileChange[]> {
    const names = (await this.#must(clone, ['diff', '--name-only', '--no-renames', base, head])).split('\n').map((l) => l.trim()).filter(Boolean).sort();
    const out: BrainFileChange[] = [];
    for (const path of names) out.push({ path, before: await this.readAt(clone, base, path), after: await this.readAt(clone, head, path) });
    return out;
  }

  // ------------------------------------------------------------------ git

  async #origin(clone: string): Promise<string | null> {
    const result = await this.#git(clone, ['remote', 'get-url', 'origin']);
    const url = result.stdout.trim();
    return result.exitCode === 0 && url !== '' ? url : null;
  }

  #git(cwd: string, args: readonly string[], opts: { timeoutMs?: number; url?: string } = {}): Promise<ExecResult> {
    const github = opts.url !== undefined && /github\.com/i.test(opts.url);
    return this.supervisor.run({
      command: 'git',
      args: [
        '--no-pager',
        '-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false',
        ...(github ? ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'] : []),
        ...args,
      ],
      cwd,
      env: { ...this.env(), GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_ASKPASS: 'echo', GIT_ADVICE: '0' },
      timeoutMs: opts.timeoutMs ?? COMMAND_TIMEOUT_MS,
      label: `brain git ${args[0] ?? ''}`,
    });
  }

  async #must(cwd: string, args: readonly string[]): Promise<string> {
    const result = await this.#git(cwd, args);
    if (result.exitCode !== 0) throw failed(args[0] === '-c' ? (args.find((a) => !a.includes('=') && a !== '-c') ?? 'git') : (args[0] ?? 'git'), result);
    return result.stdout;
  }
}

/** `github.com/<owner>/<name>` as people write it, turned into a URL git can fetch. */
export function remoteUrl(remote: string): string {
  if (/^[a-z0-9.-]+\.[a-z]{2,}\/[^/\s]+\/[^/\s]+$/i.test(remote) && !remote.startsWith('/')) {
    return `https://${remote.replace(/\.git$/, '')}.git`;
  }
  return remote;
}

function safePath(path: string): string {
  const normalized = normalize(path).replace(/\\/g, '/');
  if (isAbsolute(normalized) || normalized.startsWith('../') || normalized === '..') {
    throw TandemiseError.validation(`A brain path stays inside the brain: ${path}`);
  }
  return normalized;
}

function lastLine(result: ExecResult): string {
  const lines = `${result.stderr}\n${result.stdout}`.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? `git exited ${result.exitCode}`;
}

function failed(what: string, result: ExecResult): TandemiseError {
  return new TandemiseError(result.timedOut ? 'TIMEOUT' : 'INTERNAL', `git ${what} failed: ${lastLine(result)}`);
}
