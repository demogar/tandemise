import { z } from 'zod';

const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * What a GitHub integration row may configure.
 *
 * Notably absent: anything credential-shaped. This integration reuses the
 * `gh` CLI's existing authenticated session and stores nothing (MVP.md §12.5),
 * so there is no token field to be tempted into filling.
 */
export const githubConfigSchema = z.object({
  defaultRepo: z.string().regex(REPO, 'expected owner/name')
    .optional()
    .describe('Repository used when a tool call omits `repo`, as owner/name'),
  hostname: z.string().optional()
    .describe('GitHub Enterprise host. Omit for github.com'),
}).strict();

export type GitHubConfig = z.infer<typeof githubConfigSchema>;

/**
 * The repository a call targets, as a scope-checkable string.
 *
 * When neither the call nor the config names one, `gh` would fall back to
 * whatever repository the working directory happens to be in. That is a fine
 * default for a person and a poor one for a grant: a scope of `acme/api` must
 * not be satisfiable by a cwd. So the unnamed case gets a sentinel that matches
 * no scope entry, and a scoped grant denies it.
 */
export function resolveRepo(config: GitHubConfig, requested: string | undefined): string {
  return requested ?? config.defaultRepo ?? UNNAMED_REPO;
}

export const UNNAMED_REPO = '(repository inferred from working directory)';

/** `--repo owner/name`, or nothing when the repository is to be inferred. */
export function repoArgs(repo: string): readonly string[] {
  return repo === UNNAMED_REPO ? [] : ['--repo', repo];
}

export function repoPositional(repo: string): readonly string[] {
  return repo === UNNAMED_REPO ? [] : [repo];
}
