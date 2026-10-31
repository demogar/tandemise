import type { CommandExecutor } from '@tandemise/integrations-core';

/**
 * Commits files on a fresh branch cut from `origin/<base>`, in a throwaway
 * worktree, and pushes it (#53). The checkout's own branch, its working tree
 * and any commits it hasn't pushed are never touched, so a proposal or a
 * reviewed edit can't carry, or overwrite, someone's unrelated work.
 */
export async function commitOnFreshBranch(input: {
  readonly exec: CommandExecutor;
  readonly repoPath: string;
  readonly base: string;
  readonly branch: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly message: string;
  readonly author: { readonly name: string; readonly email: string };
  readonly tmpDir: string;
  readonly env?: Readonly<Record<string, string>>;
}): Promise<void> {
  const git = (args: readonly string[], cwd = input.repoPath, stdin?: string) => input.exec.run({
    command: 'git', args, cwd, timeoutMs: 120_000, ...(stdin === undefined ? {} : { stdin }),
    env: { GIT_TERMINAL_PROMPT: '0', ...(input.env ?? {}) },
  });
  const must = async (what: string, run: Promise<{ exitCode: number; stderr: string }>): Promise<void> => {
    const r = await run;
    if (r.exitCode !== 0) throw new Error(`${what}: ${r.stderr.split('\n')[0] ?? 'git failed'}`);
  };
  await must(`couldn't fetch ${input.base}`, git(['fetch', '--quiet', 'origin', input.base]));
  await must(`couldn't start ${input.branch}`, git(['worktree', 'add', '-B', input.branch, input.tmpDir, `origin/${input.base}`]));
  try {
    for (const file of input.files) {
      const blob = await git(['hash-object', '-w', '--stdin'], input.tmpDir, file.content);
      if (blob.exitCode !== 0) throw new Error(`couldn't write ${file.path}`);
      await must(`couldn't stage ${file.path}`, git(['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},${file.path}`], input.tmpDir));
    }
    await must('couldn\'t commit', git(['-c', `user.name=${input.author.name}`, '-c', `user.email=${input.author.email}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', input.message], input.tmpDir));
    await must(`couldn't push ${input.branch}`, git(['push', '--quiet', '--force', 'origin', `${input.branch}:refs/heads/${input.branch}`], input.tmpDir));
  } finally {
    await git(['worktree', 'remove', '--force', input.tmpDir]);
  }
}
