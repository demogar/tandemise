import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { SkillFile } from '@tandemise/domain';
import { MAX_SKILL_BYTES, MAX_SKILL_FILES, SKILL_FILE, SKILL_IGNORED_NAMES, formatSkillSize, hashSkillFiles } from '@tandemise/domain';
import type { ScannedSkillFolder, SkillFilesPort } from '@tandemise/application';
import { errorMessage, isPathInside, type Logger } from '@tandemise/shared';

const run = promisify(execFile);

/** A clone that takes longer than this is abandoned. */
const CLONE_TIMEOUT_MS = 60_000;
/** Folder for the ones that don't exist, "missing" reads better than an ENOENT. */
const NOT_A_FOLDER = 'This folder does not exist or cannot be read.';

class Refused extends Error {}

/**
 * The skills' side of the filesystem (P13): reading the person's folders under
 * the skill rules, cloning a repository, and the content store.
 *
 * Every file is read as bytes and nothing is ever executed. A clone runs git
 * with hooks pointed at /dev/null, no submodules, no tags, no terminal prompt
 * and LFS smudging off, into a temporary folder that is removed afterwards.
 *
 * The store is `<home>/skills/<hash>/…`, shared by every project: identical
 * files are kept once. Content is written to a temporary folder and renamed
 * into place, so a half-written version never exists under its hash; a read
 * re-hashes the files and treats a mismatch as missing.
 */
export class DaemonSkillFiles implements SkillFilesPort {
  constructor(
    private readonly storeRoot: string,
    private readonly root: string,
    private readonly log: Logger,
  ) {}

  discoverRoot(): string {
    return this.root;
  }

  async discover(): Promise<{ exists: boolean; folders: readonly string[] }> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return { exists: false, folders: [] };
    }
    const folders: string[] = [];
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      const path = join(this.root, name);
      try {
        // A linked skill folder (a common way to share one) counts, wherever it points.
        if ((await stat(path)).isDirectory()) folders.push(path);
      } catch {
        // A dangling link is not a skill.
      }
    }
    return { exists: true, folders };
  }

  async scan(folder: string): Promise<ScannedSkillFolder> {
    let root: string;
    try {
      root = await realpath(folder);
      if (!(await stat(root)).isDirectory()) return refused(folder, NOT_A_FOLDER);
    } catch {
      return refused(folder, NOT_A_FOLDER);
    }
    const files: SkillFile[] = [];
    let size = 0;
    const visited = new Set<string>([root]);

    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const name of (await readdir(dir)).sort()) {
        if (SKILL_IGNORED_NAMES.includes(name)) continue;
        const path = join(dir, name);
        const rel = prefix === '' ? name : `${prefix}/${name}`;
        const info = await lstat(path);
        let real = path;
        if (info.isSymbolicLink()) {
          try {
            real = await realpath(path);
          } catch {
            throw new Refused(`${rel} is a link to something that does not exist.`);
          }
          if (!isPathInside(root, real)) throw new Refused(`${rel} links outside the skill folder (to ${real}).`);
        }
        const target = info.isSymbolicLink() ? await stat(real) : info;
        if (target.isDirectory()) {
          // A link back up the tree would loop forever.
          if (visited.has(real)) continue;
          visited.add(real);
          await walk(real, rel);
          continue;
        }
        if (!target.isFile()) continue;
        if (files.length + 1 > MAX_SKILL_FILES) throw new Refused(`This skill has more than ${MAX_SKILL_FILES} files; the limit is ${MAX_SKILL_FILES}.`);
        size += target.size;
        if (size > MAX_SKILL_BYTES) {
          throw new Refused(`This skill is over ${formatSkillSize(MAX_SKILL_BYTES)}; the limit is ${formatSkillSize(MAX_SKILL_BYTES)}.`);
        }
        const bytes = new Uint8Array(await readFile(real));
        files.push({ path: rel, size: bytes.byteLength, bytes });
      }
    };

    try {
      await walk(root, '');
    } catch (e) {
      if (e instanceof Refused) return { folder, files: [], sizeBytes: size, problem: e.message };
      return refused(folder, `This folder could not be read: ${errorMessage(e)}`);
    }
    if (!files.some((f) => f.path === SKILL_FILE)) {
      return { folder, files, sizeBytes: size, problem: 'No SKILL.md in this folder. A skill is a folder with a SKILL.md at its top.' };
    }
    return { folder, files, sizeBytes: size, problem: null };
  }

  async fetchGit(source: { url: string; subpath?: string; ref?: string }): Promise<{ folder: string; dispose(): Promise<void> }> {
    if (!/^(https?:\/\/|ssh:\/\/|git@[^:]+:|file:\/\/|\/)/.test(source.url)) {
      throw new Error('Use an https://, ssh://, git@host: or file:// address.');
    }
    const dir = await mkdtemp(join(tmpdir(), 'tandemise-skill-'));
    const dispose = async (): Promise<void> => { await rm(dir, { recursive: true, force: true }); };
    try {
      await run('git', [
        '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always',
        'clone', '--depth', '1', '--no-tags', '--single-branch', '--no-recurse-submodules',
        ...(source.ref === undefined ? [] : ['--branch', source.ref]),
        '--', source.url, join(dir, 'repo'),
      ], {
        timeout: CLONE_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_ASKPASS: 'echo' },
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (e) {
      await dispose();
      const stderr = (e as { stderr?: string }).stderr?.trim().split('\n').pop();
      throw new Error(stderr && stderr.length > 0 ? stderr : errorMessage(e));
    }
    const repo = join(dir, 'repo');
    const folder = source.subpath === undefined || source.subpath === '' ? repo : join(repo, source.subpath);
    if (!isPathInside(repo, folder)) {
      await dispose();
      throw new Error('The subfolder must stay inside the repository.');
    }
    return { folder, dispose };
  }

  async store(hash: string, files: readonly SkillFile[]): Promise<void> {
    const final = this.#dir(hash);
    if (await exists(final)) return;
    await mkdir(this.storeRoot, { recursive: true });
    const staging = await mkdtemp(join(this.storeRoot, `.incoming-${hash.slice(0, 8)}-`));
    try {
      for (const file of files) {
        const path = join(staging, ...file.path.split('/'));
        if (!isPathInside(staging, path)) throw new Error(`Refusing to store ${file.path}.`);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.bytes);
      }
      try {
        await rename(staging, final);
      } catch (e) {
        // Another import stored the same content first: that copy is identical.
        if (!(await exists(final))) throw e;
        await rm(staging, { recursive: true, force: true });
      }
    } catch (e) {
      await rm(staging, { recursive: true, force: true });
      throw e;
    }
  }

  async read(hash: string): Promise<readonly SkillFile[] | null> {
    const dir = this.#dir(hash);
    if (!(await exists(dir))) return null;
    const files: SkillFile[] = [];
    const walk = async (current: string): Promise<void> => {
      for (const name of (await readdir(current)).sort()) {
        const path = join(current, name);
        const info = await lstat(path);
        if (info.isDirectory()) { await walk(path); continue; }
        if (!info.isFile()) continue;
        const bytes = new Uint8Array(await readFile(path));
        files.push({ path: relative(dir, path).split(sep).join('/'), size: bytes.byteLength, bytes });
      }
    };
    try {
      await walk(dir);
    } catch (e) {
      this.log.warn('skills.read_failed', { hash, error: errorMessage(e) });
      return null;
    }
    if (hashSkillFiles(files) !== hash) {
      this.log.warn('skills.content_changed', { hash });
      return null;
    }
    return files;
  }

  async drop(hash: string): Promise<void> {
    await rm(this.#dir(hash), { recursive: true, force: true });
  }

  #dir(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Not a skill content hash.');
    return join(this.storeRoot, hash);
  }
}

function refused(folder: string, problem: string): ScannedSkillFolder {
  return { folder, files: [], sizeBytes: 0, problem };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
