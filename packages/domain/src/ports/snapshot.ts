/**
 * A GitHub pull request read for a hand-back link (spec A4). Only what a
 * hand-back needs: the diff and body become the pinned Evidence's content,
 * and the head ref becomes the `git.branch` / `git.commit` refs downstream
 * review and QA read.
 */
export interface PullRequestSnapshot {
  readonly url: string;
  readonly number: number;
  readonly repo: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly title: string;
  readonly body: string;
  readonly diff: string;
}

/**
 * Resolves a link handed back into the pull request it points to.
 *
 * One implementation shells out to `gh pr view` / `gh pr diff`
 * (integration-github); a stub used in tests returns canned snapshots.
 */
export interface PullRequestSnapshotPort {
  /** null when the URL is not a GitHub PR this machine can read. Never throws for "not mine". */
  read(url: string, cwd: string): Promise<PullRequestSnapshot | null>;
}
