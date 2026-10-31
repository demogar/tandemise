import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { BrainHostPort, BrainRepoPort } from '@tandemise/domain';
import type { CommandExecutor } from '@tandemise/integrations-core';
import { commitOnFreshBranch } from '../support/branch-commit.js';
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
    private readonly brain: () => Pick<BrainService, 'linkOf' | 'readAt' | 'exclusive' | 'author' | 'pushLocked' | 'markPulled' | 'manifestAt' | 'reportProblem'> | undefined,
    private readonly repo: () => Pick<BrainRepoPort, 'commit' | 'head'> | undefined,
    private readonly local: FactoryConfigSourcePort,
    /** For an edit opened as a pull request (`humanEdits: pr`). */
    private readonly extras: () => { exec: CommandExecutor; host: Pick<BrainHostPort, 'openPr'>; tmpRoot: string; credentialEnv?: () => Readonly<Record<string, string>> } | undefined = () => undefined,
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

  /**
   * A person's edit. With `humanEdits: pr` in brain.yaml it becomes a pull
   * request in the brain (a fresh branch from origin; the clone's own commits
   * are left alone). Otherwise, and always for turning auto-merge off, it is a
   * commit that takes effect on this machine at once and is pushed; a push that
   * fails is said in the Brain section and goes out on the next sync.
   */
  async write(name: FactoryFileName, repositoryPath: string, raw: unknown, workspaceId?: string): Promise<{ readonly path: string; readonly ref: string; readonly proposed?: string }> {
    const brain = workspaceId === undefined ? undefined : this.brain();
    const repo = this.repo();
    const ws = workspaceId === undefined ? undefined : (asId<'WorkspaceId'>(workspaceId) as WorkspaceId);
    const link = ws === undefined ? undefined : brain?.linkOf(ws);
    if (brain === undefined || repo === undefined || link === undefined || ws === undefined) return this.local.write(name, repositoryPath, raw, workspaceId);
    const path = `${BRAIN_FACTORY}/${name}.yaml`;
    const text = stringifyYaml(raw);
    const ref = `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
    // Turning safety on never waits for a review.
    const killSwitch = name === 'merge' && (raw as { autoMerge?: unknown } | null)?.autoMerge === 'off';
    const head = await repo.head(link.clonePath);
    const manifest = head === null ? null : await brain.manifestAt(ws, head).catch(() => null);
    const extras = this.extras();
    if (!killSwitch && manifest?.humanEdits === 'pr' && link.remote !== null && extras !== undefined) {
      const branch = `tandemise/edit/${link.writerId}/${name}-${Date.now().toString(36)}`;
      await brain.exclusive(ws, () => commitOnFreshBranch({
        exec: extras.exec, repoPath: link.clonePath, base: link.defaultBranch, branch, files: [{ path, content: text }],
        message: `chore: edit the ${name} policy`, author: brain.author(), tmpDir: `${extras.tmpRoot}/${branch.replace(/\//g, '-')}`, env: extras.credentialEnv?.() ?? {},
      }));
      const pr = await extras.host.openPr({
        clone: link.clonePath, head: branch, base: link.defaultBranch, title: `Edit the ${name} policy`, draft: false,
        body: `## What and why\n\nAn edit to \`${path}\`, made in Tandemise by ${brain.author().name}.\n\nThis brain asks for edits as pull requests (\`humanEdits: pr\` in brain.yaml); it takes effect when this merges.\n`,
      });
      return { path, ref, proposed: pr.url };
    }
    await brain.exclusive(ws, async () => {
      await repo.commit(link.clonePath, [{ path, mode: 'write', content: text }], `chore: edit the ${name} policy`, brain.author());
      // In effect here at once, pushed or not.
      brain.markPulled(ws, await repo.head(link.clonePath));
      if (link.remote === null) return;
      const pushed = await brain.pushLocked(ws).catch(() => 'offline' as const);
      if (pushed !== 'pushed') {
        brain.reportProblem(ws, `Your change to ${path} is in effect on this machine but couldn't be pushed (${pushed}); it goes out on the next sync.`);
      }
    });
    return { path, ref };
  }
}
