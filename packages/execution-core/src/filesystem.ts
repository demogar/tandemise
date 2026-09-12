import { dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { TandemiseError, isPathInside } from '@tandemise/shared';

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
 * Two checks, both required:
 *  1. *lexical* - after normalisation the path must sit under a declared root,
 *     which is what stops `../../etc/passwd`;
 *  2. *physical* - the nearest existing ancestor is `realpath`d and rechecked,
 *     which is what stops a symlink planted inside the worktree from pointing
 *     at the user's home directory. A lexical check alone is not a boundary.
 *
 * Roots are themselves realpath'd once and cached, because on macOS the obvious
 * root (`/tmp/...`) is a symlink and a naive comparison would reject every path.
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
    const candidate = this.#lexical(path);
    const real = await nearestRealPath(candidate);
    if (!this.#inside(real, await this.#resolvedRoots())) {
      throw denied(path, this.roots, 'resolves outside the target through a link');
    }
    return candidate;
  }

  async read(path: string): Promise<string> {
    return fs.readFile(await this.resolve(path), 'utf8');
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(await this.resolve(path)));
  }

  async write(path: string, content: string | Uint8Array): Promise<void> {
    const target = await this.resolve(path);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, content);
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
    await fs.mkdir(await this.resolve(path), { recursive: true });
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const target = await this.resolve(path);
    // Removing a root would delete the workspace out from under the target.
    if (this.roots.some((r) => resolvePath(r) === target)) {
      throw denied(path, this.roots, 'refusing to remove a target root');
    }
    await fs.rm(target, { recursive: options.recursive ?? false, force: true });
  }

  /** Lexical resolution + scope check. Never touches the disk. */
  #lexical(path: string): string {
    if (path.includes('\0')) {
      throw TandemiseError.permissionDenied('Path contains a NUL byte', { path: '<redacted>' });
    }
    const candidate = isAbsolute(path) ? resolvePath(path) : resolvePath(this.#base, path);
    if (!this.#inside(candidate, this.roots)) {
      throw denied(path, this.roots, 'resolves outside the target roots');
    }
    return candidate;
  }

  #inside(candidate: string, roots: readonly string[]): boolean {
    return roots.some((r) => isPathInside(r, candidate));
  }

  async #resolvedRoots(): Promise<readonly string[]> {
    if (!this.#realRoots) {
      this.#realRoots = await Promise.all(this.roots.map((r) => nearestRealPath(r)));
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

/**
 * `realpath` of the deepest existing ancestor, with the not-yet-existing tail
 * re-appended. Lets a *create* be scope-checked before anything is written.
 */
async function nearestRealPath(candidate: string): Promise<string> {
  let head = resolvePath(candidate);
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length === 0 ? await realpath(head) : join(await realpath(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return candidate; // reached the filesystem root
      tail.unshift(head.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      head = parent;
    }
  }
}
