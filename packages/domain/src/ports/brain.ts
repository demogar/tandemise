/**
 * The brain's two outside worlds (#51 spec §4), declared in the domain so
 * `execution-local` (git) and `integration-github` (gh) can implement them
 * without importing the application layer, as `PullRequestSnapshotPort` is.
 */

/**
 * One file change in a brain commit. Ledger files are only ever written with
 * `append`, which the git adapter implements with an `O_APPEND` open: no code
 * path can truncate or rewrite a ledger line.
 */
export type BrainWrite =
  | { readonly path: string; readonly mode: 'append'; readonly content: string }
  | { readonly path: string; readonly mode: 'write'; readonly content: string }
  | { readonly path: string; readonly mode: 'delete' };

export type BrainPushResult = 'pushed' | 'rejected' | 'protected' | 'offline';

export interface BrainFileChange {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface BrainRepoPort {
  clone(remote: string, into: string): Promise<void>;
  init(into: string, branch: string): Promise<void>;
  setRemote(clone: string, remote: string): Promise<void>;
  head(clone: string, ref?: string): Promise<string | null>;
  /** Never throws for a network failure: `offline` carries git's sentence instead. */
  fetchAndRebase(clone: string, branch: string): Promise<{ head: string; conflicted: readonly string[]; offline: string | null }>;
  /**
   * Commits on the checked-out branch, or with `onto` on another branch
   * (created from `from` when missing) without touching the checked-out one.
   */
  commit(clone: string, files: readonly BrainWrite[], message: string, author: { name: string; email: string } | null, onto?: { branch: string; from: string }): Promise<string>;
  push(clone: string, branch: string, opts?: { force?: false; setUpstream?: boolean }): Promise<BrainPushResult>;
  branch(clone: string, name: string, from: string): Promise<void>;
  /** Moves local commits not on `origin/<base>` to `branch`, resets `base` to origin. Returns the moved shas. */
  moveUnpushedTo(clone: string, branch: string, base: string): Promise<readonly string[]>;
  fastForward(clone: string, branch: string, onto: string): Promise<boolean>;
  revert(clone: string, sha: string, message: string): Promise<string>;
  readAt(clone: string, sha: string, path: string): Promise<string | null>;
  /** Recursive, repo-relative, sorted. */
  listAt(clone: string, sha: string, dir: string): Promise<readonly string[]>;
  diffAt(clone: string, base: string, head: string): Promise<readonly BrainFileChange[]>;
}

export type BrainPrState = 'open' | 'merged' | 'closed';

export interface BrainHostPort {
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Always private. */
  createRepo(owner: string, name: string): Promise<{ remote: string }>;
  openPr(input: { clone: string; head: string; base: string; title: string; body: string; draft: boolean }): Promise<{ url: string }>;
  findPr(clone: string, head: string): Promise<{ url: string; state: BrainPrState } | null>;
  prState(clone: string, url: string): Promise<BrainPrState | null>;
}
