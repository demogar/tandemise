import { randomBytes } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { BrainHostPort, BrainRepoPort, BrainWrite, SkillFile } from '@tandemise/domain';
import { hashSkillFiles, parseWorkflowDefinition } from '@tandemise/domain';
import type { Logger, WorkspaceId } from '@tandemise/shared';
import { errorMessage } from '@tandemise/shared';
import type { LoadedWorkflow, SkillFilesPort } from '../ports.js';
import type { SetupService } from '../services/setup-service.js';
import type { EventRecorder } from '../support/event-recorder.js';
import type { IdentityPort } from '../support/identity.js';
import { readSetup, renderSetup, SETUP_ROLES_DIR, type SetupSnapshot } from '../setup/codec.js';
import type { BrainService } from './brain-service.js';
import { BRAIN_WRITE_THROUGH_DEBOUNCE_MS } from './constants.js';
import { BRAIN_FACTORY, BRAIN_SKILLS } from './layout.js';

export interface BrainFactoryDeps {
  readonly repo: BrainRepoPort;
  readonly host: BrainHostPort;
  readonly setup: Pick<SetupService, 'snapshotFor' | 'applyFiles' | 'isApplyingFromBrain'>;
  readonly skillFiles?: Pick<SkillFilesPort, 'store' | 'read'> | undefined;
  readonly identity: IdentityPort;
  readonly recorder: EventRecorder;
  readonly log: Logger;
}

const shortId = (): string => randomBytes(3).toString('hex');

/**
 * The factory half of a linked brain (#51 spec §3, §8, §9):
 *
 *  - after a pull that changed `factory/` or `skills/`, the database is
 *    refreshed from the brain, every item taken, this machine's switches kept;
 *  - a person's edit in the app is written through to `factory/` as one commit
 *    (or a pull request when the brain says `humanEdits: pr`);
 *  - a rebase that conflicts on a factory, rules or decisions file moves the
 *    local commit to a branch and opens a pull request;
 *  - the brain's workflows and vendored skills are read from the clone.
 *
 * The refresh marks the project while it applies, and write-through ignores
 * edits made during it, so a refresh can never write itself back.
 */
export class BrainFactory {
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #what = new Map<string, string[]>();
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(private readonly brain: BrainService, private readonly deps: BrainFactoryDeps) {}

  // --------------------------------------------------------------- refresh

  async refreshFactory(workspaceId: WorkspaceId, fromSha: string | null, toSha: string | null): Promise<number> {
    if (fromSha === null || toSha === null || fromSha === toSha) return 0;
    const link = this.brain.linkOf(workspaceId);
    if (link === undefined) return 0;
    const changed = await this.deps.repo.diffAt(link.clonePath, fromSha, toSha);
    if (!changed.some((c) => c.path.startsWith(`${BRAIN_FACTORY}/`) || c.path.startsWith(`${BRAIN_SKILLS}/`))) return 0;
    const problems = await this.fillSkills(link.clonePath, toSha);
    const files = await this.brain.factoryFiles(link.clonePath, toSha);
    // Caller has no system variant: the local person applies it, as an import would.
    const result = await this.deps.setup.applyFiles({ personId: this.deps.identity.localPerson().id }, workspaceId, files, { mode: 'brain', choices: {} });
    this.brain.extraProblems.set(workspaceId, [...problems, ...result.problems]);
    this.deps.log.info('brain.factory_refreshed', { workspaceId, changes: result.applied, from: fromSha, to: toSha });
    // Events need a mission, and this belongs to none: the log and the screens carry it.
    this.deps.log.info('brain.note', { workspaceId, text: `Updated the factory from the brain (${result.applied} changes).` });
    this.deps.recorder.invalidate('workspaces');
    return result.applied;
  }

  /** Fills this machine's skills store from `skills/<name>/<hash12>/`, each checked against its hash. */
  async fillSkills(clonePath: string, sha: string): Promise<string[]> {
    const problems: string[] = [];
    if (this.deps.skillFiles === undefined) return problems;
    const groups = new Map<string, { name: string; prefix: string; paths: string[] }>();
    for (const path of await this.deps.repo.listAt(clonePath, sha, BRAIN_SKILLS)) {
      const parts = path.split('/');
      if (parts.length < 4) continue;
      const key = `${parts[1]}/${parts[2]}`;
      const group = groups.get(key) ?? { name: parts[1] ?? '', prefix: parts[2] ?? '', paths: [] };
      group.paths.push(path);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const files: SkillFile[] = [];
      for (const path of group.paths) {
        const text = await this.deps.repo.readAt(clonePath, sha, path);
        if (text === null) continue;
        const bytes = new Uint8Array(Buffer.from(text, 'utf8'));
        files.push({ path: path.split('/').slice(3).join('/'), size: bytes.byteLength, bytes });
      }
      const hash = hashSkillFiles(files);
      if (!hash.startsWith(group.prefix)) {
        problems.push(`The brain's copy of ${group.name} doesn't match its pin.`);
        continue;
      }
      try {
        if ((await this.deps.skillFiles.read(hash)) === null) await this.deps.skillFiles.store(hash, files);
      } catch (e) {
        problems.push(`The brain's copy of ${group.name} could not be stored: ${errorMessage(e)}`);
      }
    }
    return problems;
  }

  // --------------------------------------------------------- write-through

  /** One of the project's edit hooks fired. Debounced, then written through once. */
  edited(workspaceId: WorkspaceId, what: string): void {
    if (this.deps.setup.isApplyingFromBrain(workspaceId)) return;
    if (this.brain.linkOf(workspaceId) === undefined) return;
    this.#what.set(workspaceId, [...(this.#what.get(workspaceId) ?? []), what]);
    const prior = this.#timers.get(workspaceId);
    if (prior !== undefined) clearTimeout(prior);
    const timer = setTimeout(() => {
      this.#timers.delete(workspaceId);
      const run = this.flushEdits(workspaceId).catch((e) => this.deps.log.warn('brain.write_through_failed', { workspaceId, error: errorMessage(e) }));
      this.#inFlight.set(workspaceId, run);
      void run.finally(() => { if (this.#inFlight.get(workspaceId) === run) this.#inFlight.delete(workspaceId); });
    }, BRAIN_WRITE_THROUGH_DEBOUNCE_MS);
    timer.unref?.();
    this.#timers.set(workspaceId, timer);
  }

  /** Writes pending edits now; what the debounce timer runs. */
  async flushEdits(workspaceId: WorkspaceId): Promise<void> {
    const whats = this.#what.get(workspaceId) ?? [];
    this.#what.delete(workspaceId);
    if (whats.length === 0) return;
    await this.brain.exclusive(workspaceId, async () => {
      const link = this.brain.linkOf(workspaceId);
      if (link === undefined) return;
      const head = await this.deps.repo.head(link.clonePath);
      if (head === null) return;
      const writes = await this.#factoryWrites(workspaceId, link.clonePath, head);
      if (writes.length === 0) return;
      const what = [...new Set(whats)].join(', ');
      const manifest = await this.brain.manifestAt(workspaceId, head);
      await this.deps.repo.commit(link.clonePath, writes, `chore: ${what}`, this.brain.author());
      if (manifest.humanEdits === 'direct' && link.remote !== null) {
        const pushed = await this.brain.pushLocked(workspaceId);
        if (pushed !== 'protected') return;
      } else if (manifest.humanEdits === 'direct' || link.remote === null) {
        // A brain on this machine only: the commit is the edit.
        const now = await this.deps.repo.head(link.clonePath);
        this.brain.markPulled(workspaceId, now);
        return;
      }
      // `humanEdits: pr`, or a protected default branch: the edit goes to a branch and a pull request.
      const branch = `tandemise/edit/${link.writerId}/${shortId()}`;
      await this.deps.repo.moveUnpushedTo(link.clonePath, branch, link.defaultBranch);
      const pushed = await this.deps.repo.push(link.clonePath, branch, { setUpstream: false });
      if (pushed !== 'pushed') {
        this.brain.reportProblem(workspaceId, `Couldn't push your edit (${what}); it waits on the branch ${branch}.`);
        return;
      }
      try {
        const pr = await this.deps.host.openPr({
          clone: link.clonePath, head: branch, base: link.defaultBranch, title: what.charAt(0).toUpperCase() + what.slice(1), draft: false,
          body: `## What and why\n\n${what}, made in Tandemise by ${this.brain.author().name}.\n\nThis brain asks for edits as pull requests (\`humanEdits: pr\` in brain.yaml).\n`,
        });
        this.deps.log.info('brain.edit_pr_opened', { workspaceId, url: pr.url });
      } catch (e) {
        this.brain.reportProblem(workspaceId, `Couldn't open a pull request for your edit: ${errorMessage(e)}`);
      }
    });
  }

  /** Waits for a scheduled write-through (tests and shutdown). */
  async settle(workspaceId: WorkspaceId): Promise<void> {
    const timer = this.#timers.get(workspaceId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(workspaceId);
      await this.flushEdits(workspaceId);
    }
    await this.#inFlight.get(workspaceId);
  }

  /**
   * The factory files this machine's rows say, against the brain's. Workflows,
   * the tracker, intake and MCPs are never written from rows, and the knowledge
   * fields live in `memory/rules/project.md` once a brain is linked.
   */
  async #factoryWrites(workspaceId: WorkspaceId, clonePath: string, head: string): Promise<BrainWrite[]> {
    const brainFiles = await this.brain.factoryFiles(clonePath, head);
    const theirs = readSetup(brainFiles).snapshot;
    const mine = await this.deps.setup.snapshotFor(workspaceId, { mcps: false });
    const merged: SetupSnapshot = {
      ...mine,
      project: mine.project === null ? null : { ...mine.project, knowledge: theirs.project?.knowledge ?? mine.project.knowledge },
      workflows: null,
      mcps: null,
      tracker: null,
      intake: null,
    };
    const rendered = renderSetup(merged).files;
    const writes: BrainWrite[] = [];
    for (const file of rendered) {
      if (brainFiles[file.path] !== file.content) writes.push({ path: `${BRAIN_FACTORY}/${file.path}`, mode: 'write', content: file.content });
    }
    for (const path of Object.keys(brainFiles)) {
      if (path.startsWith(`${SETUP_ROLES_DIR}/`) && !rendered.some((f) => f.path === path)) writes.push({ path: `${BRAIN_FACTORY}/${path}`, mode: 'delete' });
    }
    return writes;
  }

  // ------------------------------------------------------------ conflicts

  /** spec §9: the local change moves to a branch and a pull request; the cache follows the default branch. */
  async resolveConflict(workspaceId: WorkspaceId, conflicted: readonly string[]): Promise<string> {
    const link = this.brain.linkOf(workspaceId);
    const file = conflicted[0] ?? 'the brain';
    if (link === undefined) return `Your change to ${file} conflicts with the brain.`;
    const branch = `tandemise/local/${link.writerId}/${shortId()}`;
    await this.deps.repo.moveUnpushedTo(link.clonePath, branch, link.defaultBranch);
    let where = `the branch ${branch}`;
    if ((await this.deps.repo.push(link.clonePath, branch)) === 'pushed') {
      try {
        const pr = await this.deps.host.openPr({
          clone: link.clonePath, head: branch, base: link.defaultBranch, title: 'Your change conflicts with the brain', draft: false,
          body: `## What and why\n\nA change made on this machine conflicts with one already in the brain:\n\n${conflicted.map((c) => `- \`${c}\``).join('\n')}\n\nResolve it here and merge, or close it to keep the brain's version.\n`,
        });
        where = pr.url;
      } catch (e) {
        this.deps.log.warn('brain.conflict_pr_failed', { workspaceId, error: errorMessage(e) });
      }
    }
    return `Your change to ${file} conflicts with one already in the brain. Opened ${where} to sort it out.`;
  }

  // ------------------------------------------------------------ workflows

  async brainWorkflows(workspaceId: WorkspaceId): Promise<readonly LoadedWorkflow[]> {
    const link = this.brain.linkOf(workspaceId);
    if (link === undefined || link.lastPulledSha === null) return [];
    const out: LoadedWorkflow[] = [];
    const dir = `${BRAIN_FACTORY}/workflows`;
    for (const path of await this.deps.repo.listAt(link.clonePath, link.lastPulledSha, dir)) {
      const file = path.slice(dir.length + 1);
      if (file.includes('/') || !/\.(ya?ml|json)$/.test(file)) continue;
      const id = file.replace(/\.(ya?ml|json)$/, '');
      const text = (await this.deps.repo.readAt(link.clonePath, link.lastPulledSha, path)) ?? '';
      const where = `${link.clonePath}/${path}`;
      let raw: unknown;
      try {
        raw = parseYaml(text);
      } catch (e) {
        out.push({ id, path: where, definition: null, issues: [{ path: '(file)', message: errorMessage(e) }], text, origin: 'brain' });
        continue;
      }
      const parsed = parseWorkflowDefinition(raw);
      out.push(parsed.ok
        ? { id, path: where, definition: parsed.value, issues: [], text, origin: 'brain' }
        : { id, path: where, definition: null, issues: parsed.error, text, origin: 'brain' });
    }
    return out;
  }
}
