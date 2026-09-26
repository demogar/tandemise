import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { SetupFolderPort, StagedSetupWrite } from '@tandemise/application';
import {
  LEGACY_TANDEMISE_EXCLUDE_ENTRY, LEGACY_TANDEMISE_IGNORE_BODY, TANDEMISE_EXCLUDE_ENTRY, TANDEMISE_IGNORE_BODY, TANDEMISE_IGNORE_FILE,
} from '@tandemise/domain';
import { errorMessage, type Logger } from '@tandemise/shared';

const run = promisify(execFile);
const SETUP_DIR = '.tandemise';
/** What an import reads; anything else in the folder is listed as ignored. */
const READ = [/^tandemise\.yaml$/, /^routines\.yaml$/, /^roles\/[^/]+\.md$/, /^workflows\/[^/]+\.(ya?ml|json)$/];
/** Tandemise's own working files: never read, never listed. */
const SKIP = [/^out(\/|$)/, /^\.gitignore$/, /\.tandemise-staged$/];
const STAGED_SUFFIX = '.tandemise-staged';

/**
 * The `.tandemise` setup folder on disk (P15).
 *
 * Writes are staged: each file goes to `<destination>.tandemise-staged` first
 * and is renamed into place only on `commit`, after the database transaction
 * that goes with it has committed. A rename is atomic per file, so a reader
 * never sees half a file, and a failed import leaves no file behind.
 */
export class FileSetupFolder implements SetupFolderPort {
  constructor(private readonly log: Logger) {}

  async read(folder: string): Promise<{ root: string; files: Record<string, string>; ignored: string[] } | null> {
    const root = basename(folder) === SETUP_DIR ? folder : join(folder, SETUP_DIR);
    try {
      if (!(await stat(root)).isDirectory()) return null;
    } catch {
      return null;
    }
    const files: Record<string, string> = {};
    const ignored: string[] = [];
    for (const path of await walk(root, '', 2)) {
      if (SKIP.some((re) => re.test(path))) continue;
      if (!READ.some((re) => re.test(path))) {
        ignored.push(path);
        continue;
      }
      files[path] = await readFile(join(root, path), 'utf8');
    }
    return { root, files, ignored: ignored.sort() };
  }

  async stage(changes: { readonly write: Readonly<Record<string, string>>; readonly remove: readonly string[] }): Promise<StagedSetupWrite> {
    const staged: string[] = [];
    const discard = async (): Promise<void> => {
      await Promise.all(staged.map((path) => rm(`${path}${STAGED_SUFFIX}`, { force: true })));
    };
    try {
      for (const [path, content] of Object.entries(changes.write)) {
        if (!isAbsolute(path)) throw new Error(`Refusing a relative path: ${path}`);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}${STAGED_SUFFIX}`, content, 'utf8');
        staged.push(path);
      }
    } catch (e) {
      await discard();
      throw e;
    }
    return {
      commit: async () => {
        for (const path of staged) await rename(`${path}${STAGED_SUFFIX}`, path);
        for (const path of changes.remove) await rm(path, { force: true });
      },
      discard,
    };
  }

  async gitWarnings(repositoryPath: string, paths: readonly string[]): Promise<readonly string[]> {
    const warnings: string[] = [];
    await this.#repairIgnore(repositoryPath, warnings);
    if (paths.length === 0) return warnings;
    try {
      // Exit 1 means "nothing ignored"; only a real failure lands in catch.
      const { stdout } = await run('git', ['-C', repositoryPath, 'check-ignore', '--verbose', '--', ...paths]).catch((e: { code?: number; stdout?: string }) => {
        if (e.code === 1) return { stdout: '' };
        throw e;
      });
      const byRule = new Map<string, string[]>();
      for (const line of stdout.split('\n').filter((l) => l.trim() !== '')) {
        const [rule, path] = line.split('\t');
        if (rule === undefined || path === undefined) continue;
        byRule.set(rule, [...(byRule.get(rule) ?? []), path]);
      }
      for (const [rule, ignored] of byRule) {
        const [source, lineNo, pattern] = rule.split(':');
        const where = source === undefined ? 'a git ignore rule' : `${relativeTo(repositoryPath, source)} line ${lineNo ?? '?'}`;
        warnings.push(
          `Git ignores ${ignored.length === 1 ? ignored[0] : `${ignored.length} of these files`} because of "${pattern ?? ''}" in ${where}. `
          + 'Remove that rule, or add the files with `git add -f .tandemise`, so they can be committed.',
        );
      }
    } catch (e) {
      this.log.warn('setup.check_ignore_failed', { repositoryPath, error: errorMessage(e) });
      warnings.push(`Could not ask git whether these files are ignored: ${errorMessage(e)}`);
    }
    return warnings;
  }

  /**
   * Tandemise's own old lines hid all of `.tandemise/` from git. Only the
   * exact old ignore file and the exact old exclude line are changed.
   */
  async #repairIgnore(repositoryPath: string, warnings: string[]): Promise<void> {
    const ignoreFile = join(repositoryPath, TANDEMISE_IGNORE_FILE);
    try {
      if ((await readFile(ignoreFile, 'utf8')) === LEGACY_TANDEMISE_IGNORE_BODY) {
        await writeFile(ignoreFile, TANDEMISE_IGNORE_BODY, 'utf8');
        warnings.push(`Updated ${TANDEMISE_IGNORE_FILE}: it hid the whole folder from git; now it hides only Tandemise's working files.`);
      }
    } catch {
      // No ignore file: nothing of ours to repair.
    }
    try {
      const { stdout } = await run('git', ['-C', repositoryPath, 'rev-parse', '--git-common-dir']);
      const common = stdout.trim();
      const exclude = join(isAbsolute(common) ? common : join(repositoryPath, common), 'info', 'exclude');
      const text = await readFile(exclude, 'utf8').catch(() => null);
      if (text === null) return;
      const lines = text.split('\n');
      if (!lines.includes(LEGACY_TANDEMISE_EXCLUDE_ENTRY)) return;
      const next = lines.filter((l) => l !== LEGACY_TANDEMISE_EXCLUDE_ENTRY);
      if (!next.includes(TANDEMISE_EXCLUDE_ENTRY)) next.splice(next.length - (next.at(-1) === '' ? 1 : 0), 0, TANDEMISE_EXCLUDE_ENTRY);
      await writeFile(exclude, next.join('\n'), 'utf8');
      warnings.push(`Updated .git/info/exclude: the line "${LEGACY_TANDEMISE_EXCLUDE_ENTRY}" hid the whole folder from git; it now reads "${TANDEMISE_EXCLUDE_ENTRY}".`);
    } catch (e) {
      this.log.warn('setup.exclude_repair_failed', { repositoryPath, error: errorMessage(e) });
    }
  }
}

async function walk(root: string, prefix: string, depth: number): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (depth > 1 && !SKIP.some((re) => re.test(`${path}/`))) out.push(...await walk(root, path, depth - 1));
      else if (!SKIP.some((re) => re.test(`${path}/`))) out.push(`${path}/`);
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out.sort();
}

function relativeTo(root: string, path: string): string {
  const rel = relative(root, isAbsolute(path) ? path : join(root, path));
  return rel.startsWith('..') ? path : rel;
}
