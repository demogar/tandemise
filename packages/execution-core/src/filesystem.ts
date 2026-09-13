import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { constants as FS } from 'node:fs';
import * as fs from 'node:fs/promises';
import { TandemiseError, isPathInside } from '@tandemise/shared';

const sepChar = '/';

export type FileKind = 'file' | 'directory' | 'symlink' | 'other';

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: FileKind;
  readonly size: number;
}

/**
 * Filesystem access confined to a target's roots (MVP.md §19.2). Every path a
 * worker names is checked before it is touched; there is no unchecked escape.
 */
export interface FileSystemHandle {
  /** The absolute directories this handle may touch. */
  readonly roots: readonly string[];
  /** Validates and resolves a path. Throws PERMISSION_DENIED if it escapes. */
  resolve(path: string): Promise<string>;
  read(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  write(path: string, content: string | Uint8Array): Promise<void>;
  list(path?: string): Promise<readonly FileEntry[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
}

/**
 * The single implementation of path scoping.
 *
 * The threat is a worker that may be compromised or prompt-injected and that
 * can create files - including symlinks - inside its own worktree. So the check
 * cannot be lexical, and it cannot be "realpath the whole thing" either: a
 * *dangling* symlink makes `realpath` fail, and any fallback that re-appends the
 * unresolved tail hands back a path that was never actually resolved. That was a
 * real escape in an earlier version of this file - the resolver approved
 * `worktree/escape`, and `writeFile` then followed the link to
 * `~/.ssh/authorized_keys`.
 *
 * What this does instead is resolve **one component at a time**, from the root
 * down. Every component that exists is `lstat`ed; when it is a symlink, its
 * target is expanded and re-checked against the roots before traversal
 * continues. A link pointing outside is rejected whether or not its target
 * exists, so a dangling link is no longer a blind spot.
 *
 * Mutating operations additionally open the final component with `O_NOFOLLOW`,
 * so even if a link were planted between the check and the write, the kernel
 * refuses to follow it. Check-then-act on a path an adversary can modify is
 * never safe on its own.
 *
 * Roots are realpath'd once and cached, because on macOS the obvious root
 * (`/tmp/...`) is itself a symlink and a naive comparison would reject
 * everything.
 */
export class ScopedFileSystem implements FileSystemHandle {
  readonly roots: readonly string[];
  readonly #base: string;
  #realRoots: readonly string[] | undefined;

  constructor(base: string, extraRoots: readonly string[] = []) {
    this.#base = resolvePath(base);
    this.roots = [this.#base, ...extraRoots.map((r) => resolvePath(r))];
  }

  async resolve(path: string): Promise<string> {
    // Roots first: the lexical check consults the canonical spellings, so the
    // cache must be warm before it runs.
    const roots = await this.#resolvedRoots();
    const candidate = this.#normalize(path);
    const resolved = await resolveThroughLinks(candidate, roots, path);
    if (!this.#inside(resolved, roots)) {
      throw denied(path, this.roots, 'resolves outside the target through a link');
    }
    // The *resolved* path is returned, not the lexical one: callers must act on
    // the location we actually validated.
    return resolved;
  }

  async read(path: string): Promise<string> {
    return fs.readFile(await this.resolve(path), 'utf8');
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(await this.resolve(path)));
  }

  async write(path: string, content: string | Uint8Array): Promise<void> {
    const target = await this.resolve(path);
    await this.#mkdirWithin(dirname(target));
    // O_NOFOLLOW makes the kernel refuse a symlinked final component, closing
    // the window between the check above and the write below.
    let handle;
    try {
      handle = await fs.open(target, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | FS.O_NOFOLLOW, 0o644);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ELOOP') {
        throw denied(path, this.roots, 'is a symbolic link; refusing to write through it');
      }
      throw e;
    }
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
  }

  async list(path = '.'): Promise<readonly FileEntry[]> {
    const dir = await this.resolve(path);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: FileEntry[] = [];
    for (const e of entries) {
      const full = join(dir, e.name);
      const size = e.isFile() ? await fileSize(full) : 0;
      out.push({ name: e.name, path: full, kind: kindOf(e), size });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.stat(await this.resolve(path));
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.#mkdirWithin(await this.resolve(path));
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const target = await this.resolve(path);
    // Removing a root would delete the workspace out from under the target.
    if (this.roots.some((r) => resolvePath(r) === target)) {
      throw denied(path, this.roots, 'refusing to remove a target root');
    }
    await fs.rm(target, { recursive: options.recursive ?? false, force: true });
  }

  /**
   * Creates a directory chain, re-validating each level as it goes. Plain
   * `mkdir -p` on an already-validated path is not enough: an intermediate
   * component could be a link created after the check.
   */
  async #mkdirWithin(target: string): Promise<void> {
    const roots = await this.#resolvedRoots();
    if (!this.#inside(target, roots)) {
      throw denied(target, this.roots, 'resolves outside the target roots');
    }
    const missing: string[] = [];
    let cursor = target;
    while (!(await pathExists(cursor))) {
      missing.unshift(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    for (const dir of missing) {
      // Another caller may create the same level between the scan and here
      // (tasks sharing a checkout prepare `.tandemise/` at once). Losing that
      // race is fine: the containment check below still vets what is there.
      await fs.mkdir(dir).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
      const check = await resolveThroughLinks(dir, roots, dir);
      if (!this.#inside(check, roots)) {
        throw denied(dir, this.roots, 'resolves outside the target roots');
      }
    }
  }

  /**
   * Normalises a caller-supplied path to an absolute one. Deliberately does NOT
   * make the scope decision: `/tmp/x` and `/private/tmp/x` are the same
   * directory on macOS, and a lexical comparison rejects one spelling of a
   * legitimate path. The single scope decision is made in `resolve()`, against
   * the fully link-resolved result, which catches everything a lexical check
   * would have caught and nothing it would have wrongly refused.
   */
  #normalize(path: string): string {
    if (path.includes('\0')) {
      // A NUL truncates the path at the syscall boundary, so a name containing
      // one means something different to the kernel than it does to this check.
      throw TandemiseError.permissionDenied('Path contains a NUL byte', { path: '<redacted>' });
    }
    return isAbsolute(path) ? resolvePath(path) : resolvePath(this.#base, path);
  }

  #inside(candidate: string, roots: readonly string[]): boolean {
    return roots.some((r) => isPathInside(r, candidate));
  }

  /**
   * Canonicalised roots, computed once. A root that does not exist yet keeps its
   * given spelling - it will be created inside an already-validated parent.
   */
  async #resolvedRoots(): Promise<readonly string[]> {
    if (!this.#realRoots) {
      this.#realRoots = await Promise.all(
        this.roots.map(async (r) => {
          try { return await fs.realpath(r); } catch { return r; }
        }),
      );
    }
    return this.#realRoots;
  }
}

function denied(path: string, roots: readonly string[], why: string): TandemiseError {
  return TandemiseError.permissionDenied(`Path '${path}' ${why}`, { path, roots: [...roots] });
}

function kindOf(e: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind {
  if (e.isSymbolicLink()) return 'symlink';
  if (e.isDirectory()) return 'directory';
  if (e.isFile()) return 'file';
  return 'other';
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await fs.stat(path)).size;
  } catch {
    return 0;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Guards against a symlink cycle, which would otherwise loop forever. */
const MAX_LINK_DEPTH = 24;

/**
 * Fully resolves `candidate` one component at a time, expanding every symlink it
 * meets, and returns the physical path the operation would actually act on. The
 * caller checks that result against the roots.
 *
 * Two properties matter, and `realpath` gives neither:
 *
 *  - It works for paths that do not exist yet, which is the common case because
 *    a worker is usually creating a file.
 *  - It treats a **dangling** symlink as a link rather than as a missing file.
 *    The target of a dangling link is exactly where a subsequent write lands, so
 *    it must be resolved even though nothing is there yet. Missing that was the
 *    escape this function exists to prevent.
 *
 * Links are expanded, not rejected: a repository may legitimately contain them,
 * and ancestors above the root routinely are them (on macOS `/tmp` is a symlink
 * to `/private/tmp`). Judging where the path *lands* is the correct test;
 * judging each hop in isolation would reject ordinary work.
 */
async function resolveThroughLinks(
  candidate: string,
  roots: readonly string[],
  original: string,
  depth = 0,
): Promise<string> {
  if (depth > MAX_LINK_DEPTH) {
    throw denied(original, roots, 'traverses too many symbolic links');
  }

  const parts = resolvePath(candidate).split(sepChar).filter(Boolean);
  let current = sepChar;

  for (let i = 0; i < parts.length; i++) {
    current = resolvePath(current, parts[i]!);

    let stat;
    try {
      stat = await fs.lstat(current);
    } catch {
      // This component does not exist. Neither can anything below it, so the
      // remainder is lexical and there is nothing left to expand.
      return resolvePath(current, ...parts.slice(i + 1));
    }

    if (!stat.isSymbolicLink()) continue;

    // `readlink` works on a dangling link - it reads the link text, not the
    // target - which is precisely why this path is safe where `realpath` was not.
    const link = await fs.readlink(current);
    const target = isAbsolute(link) ? resolvePath(link) : resolvePath(dirname(current), link);
    // Re-resolve from the link target with the remaining components appended;
    // the target may itself be, or contain, further links.
    return resolveThroughLinks(
      resolvePath(target, ...parts.slice(i + 1)),
      roots,
      original,
      depth + 1,
    );
  }

  return current;
}
