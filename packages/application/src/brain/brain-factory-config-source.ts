import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { BrainRepoPort } from '@tandemise/domain';
import { asId, type WorkspaceId } from '@tandemise/shared';
import type { FactoryConfigSourcePort, FactoryFileName, LoadedFactoryFile } from '../ports.js';
import type { BrainService } from './brain-service.js';
import { BRAIN_FACTORY } from './layout.js';

/**
 * The factory's files from the brain (#53 Task 20, #51 §2): `factory/planner.yaml`,
 * `routing.yaml` and `merge.yaml` at the brain's last pull, with the commit as
 * their ref. A project with no brain, or a file the brain doesn't have, reads
 * the local source (the project repository, this computer, built in). A
 * person's edit to a linked project's file is a commit to the brain's
 * `factory/`, pushed like any other edit to it; nothing else writes there.
 */
export class BrainFirstFactoryConfigSource implements FactoryConfigSourcePort {
  constructor(
    private readonly brain: () => Pick<BrainService, 'linkOf' | 'readAt' | 'exclusive' | 'author' | 'pushLocked' | 'markPulled'> | undefined,
    private readonly repo: () => Pick<BrainRepoPort, 'commit' | 'head'> | undefined,
    private readonly local: FactoryConfigSourcePort,
  ) {}

  async read(name: FactoryFileName, repositoryPaths: readonly string[], workspaceId?: string): Promise<LoadedFactoryFile> {
    const brain = workspaceId === undefined ? undefined : this.brain();
    const ws = workspaceId === undefined ? undefined : (asId<'WorkspaceId'>(workspaceId) as WorkspaceId);
    const link = ws === undefined ? undefined : brain?.linkOf(ws);
    if (brain !== undefined && ws !== undefined && link !== undefined && link.lastPulledSha !== null) {
      const path = `${BRAIN_FACTORY}/${name}.yaml`;
      const text = await brain.readAt(ws, link.lastPulledSha, path).catch(() => null);
      if (text !== null) {
        const ref = `brain:${link.lastPulledSha.slice(0, 12)}`;
        try {
          return { name, origin: 'brain', path, raw: parseYaml(text) as unknown, error: null, ref };
        } catch (e) {
          return { name, origin: 'brain', path, raw: null, error: String(e).split('\n')[0] ?? 'not YAML', ref };
        }
      }
    }
    return this.local.read(name, repositoryPaths, workspaceId);
  }

  async write(name: FactoryFileName, repositoryPath: string, raw: unknown, workspaceId?: string): Promise<{ readonly path: string; readonly ref: string }> {
    const brain = workspaceId === undefined ? undefined : this.brain();
    const repo = this.repo();
    const ws = workspaceId === undefined ? undefined : (asId<'WorkspaceId'>(workspaceId) as WorkspaceId);
    const link = ws === undefined ? undefined : brain?.linkOf(ws);
    if (brain === undefined || repo === undefined || link === undefined || ws === undefined) return this.local.write(name, repositoryPath, raw, workspaceId);
    const path = `${BRAIN_FACTORY}/${name}.yaml`;
    const text = stringifyYaml(raw);
    await brain.exclusive(ws, async () => {
      await repo.commit(link.clonePath, [{ path, mode: 'write', content: text }], `chore: edit the ${name} policy`, brain.author());
      // A person's edit, pushed as one. A brain on this machine only takes the
      // commit as its pull; a pushed one is pulled back on the next sync.
      const pushed = link.remote === null ? 'local' : await brain.pushLocked(ws);
      if (pushed === 'local' || pushed === 'pushed') brain.markPulled(ws, await repo.head(link.clonePath));
    });
    return { path, ref: `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 12)}` };
  }
}
