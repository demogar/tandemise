import type { Timestamp } from '@tandemise/shared';

export interface GitStatusEntry {
  readonly path: string;
  /** Set for renames and copies. */
  readonly oldPath: string | null;
  /** Porcelain index status character, ' ' when unmodified. */
  readonly index: string;
  /** Porcelain worktree status character, ' ' when unmodified. */
  readonly worktree: string;
  readonly untracked: boolean;
  /** True while a merge is unresolved for this path. */
  readonly conflicted: boolean;
}

export interface GitStatus {
  readonly branch: string | null;
  readonly entries: readonly GitStatusEntry[];
  readonly clean: boolean;
}

export interface GitCommitSummary {
  readonly hash: string;
  readonly author: string;
  readonly email: string;
  readonly date: Timestamp;
  readonly subject: string;
}

export interface GitDiffStat {
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface GitFileChange {
  /** `A`, `M`, `D`, `R`, `C`, `T`, `U`. */
  readonly status: string;
  readonly path: string;
  readonly oldPath: string | null;
}

export interface GitWorktreeEntry {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly bare: boolean;
  readonly detached: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

export interface GitCommitResult {
  /** False when there was nothing to commit - not an error. */
  readonly committed: boolean;
  readonly hash: string | null;
}

/**
 * A merge either succeeded or left conflicts. Conflicts are returned as data
 * because resolving them is a task for an eligible developer role, never
 * something infrastructure code decides (MVP.md §11.3).
 */
export type MergeResult =
  | { readonly ok: true; readonly hash: string; readonly alreadyUpToDate: boolean }
  | { readonly ok: false; readonly conflictedPaths: readonly string[]; readonly message: string };
