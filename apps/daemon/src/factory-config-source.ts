import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { SHIPPED_FILES, type FactoryConfigSourcePort, type FactoryFileName, type LoadedFactoryFile } from '@tandemise/application';
import { errorMessage } from '@tandemise/shared';

/** Where a project keeps its factory files, relative to each repository root. */
const FACTORY_DIR = join('.tandemise', 'factory');

const refOf = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;

/**
 * The factory's files on disk (#53): each repository's `.tandemise/factory/`
 * in order (the default repository first), then `<TANDEMISE_HOME>/factory/`,
 * then the shipped defaults. A file that is not YAML keeps its error: a broken
 * `merge.yaml` must never read as the shipped policy.
 */
export class FileFactoryConfigSource implements FactoryConfigSourcePort {
  constructor(private readonly homeDir: string) {}

  async read(name: FactoryFileName, repositoryPaths: readonly string[], _workspaceId?: string): Promise<LoadedFactoryFile> {
    const candidates: { origin: 'project' | 'home'; path: string }[] = [
      ...repositoryPaths.flatMap((root) => ['yaml', 'yml'].map((ext) => ({ origin: 'project' as const, path: join(root, FACTORY_DIR, `${name}.${ext}`) }))),
      ...['yaml', 'yml'].map((ext) => ({ origin: 'home' as const, path: join(this.homeDir, `${name}.${ext}`) })),
    ];
    for (const { origin, path } of candidates) {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      try {
        return { name, origin, path, raw: parseYaml(text) as unknown, error: null, ref: refOf(text) };
      } catch (e) {
        return { name, origin, path, raw: null, error: errorMessage(e).split('\n')[0] ?? 'not YAML', ref: refOf(text) };
      }
    }
    return { name, origin: 'shipped', path: null, raw: SHIPPED_FILES[name], error: null, ref: 'shipped' };
  }

  async write(name: FactoryFileName, repositoryPath: string, raw: unknown): Promise<{ readonly path: string; readonly ref: string }> {
    const dir = join(repositoryPath, FACTORY_DIR);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${name}.yaml`);
    const text = stringifyYaml(raw);
    // Written beside, then renamed: a half-written merge policy is never read.
    const staged = `${path}.tmp-${process.pid}`;
    await writeFile(staged, text, 'utf8');
    await rename(staged, path);
    return { path, ref: refOf(text) };
  }
}
