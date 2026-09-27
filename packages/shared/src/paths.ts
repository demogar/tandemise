import { homedir } from 'node:os';
import { join, resolve, sep, isAbsolute } from 'node:path';

/**
 * Canonical on-disk layout (MVP.md §11.2). Centralised so that no subsystem
 * invents its own directory convention and so that a path-scope check has a
 * single definition of "inside the workspace".
 */
export interface TandemisePaths {
  readonly root: string;
  readonly db: string;
  readonly logs: string;
  readonly workspaces: string;
  workspace(workspaceId: string): string;
  repos(workspaceId: string): string;
  mission(workspaceId: string, missionId: string): string;
  worktrees(workspaceId: string, missionId: string): string;
  worktree(workspaceId: string, missionId: string, slug: string): string;
  artifacts(workspaceId: string): string;
  missionLogs(workspaceId: string, missionId: string): string;
  browserProfiles(workspaceId: string): string;
  /** The skills content store (P13), shared by every project: one folder per content hash. */
  readonly skills: string;
}

export function createPaths(root = defaultRoot()): TandemisePaths {
  const abs = resolve(root);
  const workspaces = join(abs, 'workspaces');
  const ws = (id: string) => join(workspaces, id);
  const mission = (w: string, m: string) => join(ws(w), 'missions', m);
  return {
    root: abs,
    db: join(abs, 'tandemise.db'),
    logs: join(abs, 'logs'),
    workspaces,
    workspace: ws,
    repos: (w) => join(ws(w), 'repos'),
    mission,
    worktrees: (w, m) => join(mission(w, m), 'worktrees'),
    worktree: (w, m, slug) => join(mission(w, m), 'worktrees', slug),
    artifacts: (w) => join(ws(w), 'artifacts'),
    missionLogs: (w, m) => join(mission(w, m), 'logs'),
    browserProfiles: (w) => join(ws(w), 'browser-profiles'),
    skills: join(abs, 'skills'),
  };
}

export function defaultRoot(): string {
  return process.env.TANDEMISE_HOME ?? join(homedir(), '.tandemise');
}

/**
 * True when `candidate` resolves inside `root`. Used by filesystem scoping
 * (MVP.md §19.2) - a grant names a root, and every path a worker touches must
 * pass this check. Compares with a trailing separator so `/a/bc` is not treated
 * as inside `/a/b`.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  if (c === r) return true;
  return c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Expands a leading `~` and resolves to an absolute path. */
export function expandPath(input: string): string {
  const expanded = input.startsWith('~') ? join(homedir(), input.slice(1)) : input;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** Filesystem-safe slug used for worktree directories and branch names. */
export function slugify(input: string, maxLength = 48): string {
  const s = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s || 'untitled').slice(0, maxLength).replace(/-+$/, '');
}
