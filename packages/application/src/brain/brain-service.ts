import { randomBytes } from 'node:crypto';
import { rename, stat } from 'node:fs/promises';
import type {
  BrainHostPort, BrainRecordRepositoryPort, BrainRepoPort, BrainWrite, DecisionRepositoryPort, WorkspaceBrain,
  WorkspaceBrainRepositoryPort, WriterId,
} from '@tandemise/domain';
import { makeWriterId } from '@tandemise/domain';
import type { BrainAdoptPreview, BrainView, SetupItemView } from '@tandemise/api-contract';
import type { Clock, Logger, TandemisePaths, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, errorMessage, slugify } from '@tandemise/shared';
import type { LoadedWorkflow, SettingsStorePort, SkillFilesPort } from '../ports.js';
import { BrainFactory } from './factory-cache.js';
import type { WorkspaceService } from '../services.js';
import type { SetupService } from '../services/setup-service.js';
import type { SkillService } from '../services/skill-service.js';
import type { EventRecorder } from '../support/event-recorder.js';
import type { Caller, IdentityPort } from '../support/identity.js';
import { renderSetup, type SetupChoice } from '../setup/codec.js';
import { BRAIN_PULL_STALE_MS, BRAIN_RULES_WARN_CHARS } from './constants.js';
import { createBrainLayout, scrubDocument } from './create-layout.js';
import { decisionFiles } from './decisions.js';
import {
  BRAIN_EVALS, BRAIN_FACTORY, BRAIN_MANIFEST, BRAIN_RULES, readBrainManifest, remoteOf, type BrainManifest,
} from './layout.js';

export const EVALS_REFUSAL = 'The evals folder can only be changed by a person.';
const INSTALL_ID_KEY = 'brainInstallId';
const DEFAULT_BRANCH = 'main';

export interface BrainServiceDeps {
  readonly brains: WorkspaceBrainRepositoryPort;
  readonly records: BrainRecordRepositoryPort;
  readonly repo: BrainRepoPort;
  readonly host: BrainHostPort;
  readonly setup: Pick<SetupService, 'snapshotFor' | 'previewFiles' | 'applyFiles' | 'isApplyingFromBrain'>;
  readonly skills: Pick<SkillService, 'content'>;
  /** This machine's skills store, filled from the brain's vendored copies (spec §2). */
  readonly skillFiles?: Pick<SkillFilesPort, 'store' | 'read'>;
  readonly decisions: Pick<DecisionRepositoryPort, 'listByWorkspace'>;
  readonly workspaces: Pick<WorkspaceService, 'view'>;
  readonly paths: TandemisePaths;
  readonly settings: SettingsStorePort;
  readonly identity: IdentityPort;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
}

/** Something that runs after a sync moved `lastPulledSha` (the factory cache, intake config, promotions). */
export type BrainSyncListener = (workspaceId: WorkspaceId, from: string | null, to: string | null) => Promise<void>;

interface BrainInfo {
  rules: number;
  lessons: number;
  candidates: number;
  mcpsNeeded: number;
  problems: string[];
}

interface PendingAdopt {
  readonly remote: string;
  readonly clonePath: string;
  readonly head: string;
}

/**
 * A project's brain (#51): linking, the daemon's clone, pull and push.
 *
 * The daemon owns its clone under `TANDEMISE_HOME/brains/<workspaceId>/`.
 * Every git call for one project is serialised, so a background pull, a
 * ledger flush and a person's edit never race on the same clone. A failed
 * pull or push never blocks work: the clone stays usable and the Brain
 * section says, in words, what happened.
 */
export class BrainService {
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #info = new Map<string, BrainInfo>();
  readonly #pending = new Map<string, PendingAdopt>();
  readonly #listeners: BrainSyncListener[] = [];

  readonly #factory: BrainFactory;

  constructor(private readonly deps: BrainServiceDeps) {
    this.#factory = new BrainFactory(this, {
      repo: deps.repo, host: deps.host, setup: deps.setup, skillFiles: deps.skillFiles, identity: deps.identity,
      recorder: deps.recorder, log: deps.log,
    });
    this.onSync((ws, from, to) => this.#factory.refreshFactory(ws, from, to).then(() => undefined));
    this.resolveConflict = (ws, conflicted) => this.#factory.resolveConflict(ws, conflicted);
    this.beforeAdoptPreview.push(async (_ws, clonePath, head) => { await this.#factory.fillSkills(clonePath, head); });
  }

  /** A person's edit in the app on this project (Team → Roles, routines, settings): written through (spec §8). */
  edited(workspaceId: WorkspaceId, what: string): void {
    this.#factory.edited(workspaceId, what);
  }

  /** Waits for a scheduled write-through to finish. */
  settleEdits(workspaceId: WorkspaceId): Promise<void> {
    return this.#factory.settle(workspaceId);
  }

  /** The brain's own workflows, read at the last pull (spec §2 precedence). */
  brainWorkflows(workspaceId: WorkspaceId): Promise<readonly LoadedWorkflow[]> {
    return this.#factory.brainWorkflows(workspaceId);
  }

  /** A local-only brain moved: its new head is what the next run reads. */
  markPulled(workspaceId: WorkspaceId, sha: string | null): void {
    if (this.deps.brains.get(workspaceId) === undefined) return;
    this.deps.brains.update(workspaceId, { lastPulledSha: sha, lastSyncAt: this.deps.clock.now() });
  }

  /** A problem to show on the Brain section until the next sync. */
  reportProblem(workspaceId: WorkspaceId, problem: string): void {
    this.extraProblems.set(workspaceId, [...(this.extraProblems.get(workspaceId) ?? []), problem]);
    const info = this.#info.get(workspaceId);
    if (info !== undefined) info.problems.push(problem);
    this.deps.log.warn('brain.problem', { workspaceId, problem });
  }

  /** Registers work that follows a sync (Task 6's factory refresh, intake config, promotions). */
  onSync(listener: BrainSyncListener): void {
    this.#listeners.push(listener);
  }

  /** The project's link on this machine, if any. */
  linkOf(workspaceId: WorkspaceId): WorkspaceBrain | undefined {
    return this.deps.brains.get(workspaceId);
  }

  // ------------------------------------------------------------------ view

  view(workspaceId: WorkspaceId): BrainView {
    const row = this.deps.brains.get(workspaceId);
    const info = this.#info.get(workspaceId) ?? { rules: 0, lessons: 0, candidates: 0, mcpsNeeded: 0, problems: [] };
    if (row === undefined) {
      return {
        linked: false, remote: null, remoteUrl: null, writerId: null, lastPulledSha: null, lastPushedSha: null, lastSyncAt: null,
        status: 'unlinked', statusLine: 'This project has no brain yet.', problems: [],
        counts: { rules: 0, lessons: 0, candidates: 0, mcpsNeeded: 0 },
      };
    }
    const when = row.lastSyncAt === null ? '' : ` (last synced ${clockTime(row.lastSyncAt)})`;
    let status: BrainView['status'];
    let statusLine: string;
    const problems = [...info.problems];
    if (row.remote === null) {
      status = 'local_only';
      statusLine = 'This brain is only on this machine. Share it to work with others.';
    } else if (row.lastSyncError !== null && row.lastSyncError.startsWith("Couldn't reach")) {
      status = 'offline';
      statusLine = `Working from your copy of the brain${when}. ${row.lastSyncError}`;
    } else if (row.fallbackBranch !== null) {
      status = 'protected';
      statusLine = `Your default branch is protected, so lessons go to a pull request: ${this.fallbackPr.get(workspaceId) ?? row.fallbackBranch}.`;
    } else {
      status = 'up_to_date';
      statusLine = `Up to date${when}.`;
    }
    if (row.lastSyncError !== null && status !== 'offline') problems.unshift(row.lastSyncError);
    return {
      linked: true,
      remote: row.remote,
      remoteUrl: row.remote !== null && row.remote.startsWith('github.com/') ? `https://${row.remote}` : null,
      writerId: row.writerId,
      lastPulledSha: row.lastPulledSha,
      lastPushedSha: row.lastPushedSha,
      lastSyncAt: row.lastSyncAt,
      status,
      statusLine,
      problems,
      counts: { rules: info.rules, lessons: info.lessons, candidates: info.candidates, mcpsNeeded: info.mcpsNeeded },
    };
  }

  /** The PR a protected default branch sends ledger commits to, once known (Task 9). */
  readonly fallbackPr = new Map<string, string>();

  // ------------------------------------------------------------------ linking

  async link(caller: Caller, workspaceId: WorkspaceId, req: LinkRequest): Promise<BrainView | BrainAdoptPreview> {
    this.deps.workspaces.view(workspaceId);
    const existing = this.deps.brains.get(workspaceId);
    if (existing !== undefined) {
      throw new TandemiseError('CONFLICT', `This project already has a brain: ${existing.remote ?? 'on this machine'}.`);
    }
    return this.#exclusive(workspaceId, async () => {
      switch (req.mode) {
        case 'create': return this.#create(caller, workspaceId, req.owner, req.name);
        case 'local': return this.#local(caller, workspaceId);
        case 'adopt': return this.#adoptPreview(workspaceId, req.remote);
      }
    });
  }

  async applyAdopt(caller: Caller, workspaceId: WorkspaceId, req: { hash: string; choices: Readonly<Record<string, SetupChoice>> }): Promise<BrainView> {
    const pending = this.#pending.get(workspaceId);
    if (pending === undefined) throw TandemiseError.validation('Preview the brain first, then link it.');
    if (this.deps.brains.get(workspaceId) !== undefined) {
      throw new TandemiseError('CONFLICT', `This project already has a brain: ${this.deps.brains.get(workspaceId)?.remote ?? 'on this machine'}.`);
    }
    return this.#exclusive(workspaceId, async () => {
      const files = await this.factoryFiles(pending.clonePath, pending.head);
      const { hash } = await this.deps.setup.previewFiles(workspaceId, files);
      if (hash !== req.hash) throw new TandemiseError('CONFLICT', 'The brain changed since the preview. Preview again.');
      await this.deps.setup.applyFiles(caller, workspaceId, files, { choices: req.choices, mode: 'import' });
      this.deps.brains.create({
        workspaceId, remote: pending.remote, defaultBranch: DEFAULT_BRANCH, clonePath: pending.clonePath, writerId: this.#writerId(),
        lastPulledSha: pending.head, lastPushedSha: pending.head, lastSyncAt: this.deps.clock.now(), lastSyncError: null,
        fallbackBranch: null, linkedAt: this.deps.clock.now(),
      });
      this.#pending.delete(workspaceId);
      this.deps.log.info('brain.adopted', { workspaceId, remote: pending.remote });
      await this.#notify(workspaceId, null, pending.head);
      await this.#refreshInfo(workspaceId);
      this.deps.recorder.invalidate('workspaces');
      return this.view(workspaceId);
    });
  }

  async unlink(caller: Caller, workspaceId: WorkspaceId): Promise<BrainView> {
    void caller;
    return this.#exclusive(workspaceId, async () => {
      const row = this.deps.brains.get(workspaceId);
      if (row === undefined) return this.view(workspaceId);
      // The database already holds the factory as of lastPulledSha (the cache
      // refresh keeps it current), so nothing else needs copying. The clone stays.
      this.deps.brains.remove(workspaceId);
      this.#info.delete(workspaceId);
      await this.#notify(workspaceId, row.lastPulledSha, null);
      this.deps.log.info('brain.unlinked', { workspaceId });
      this.deps.recorder.invalidate('workspaces');
      return this.view(workspaceId);
    });
  }

  /** "Share this brain": a brain kept on this machine gets a GitHub remote. */
  async share(caller: Caller, workspaceId: WorkspaceId, req: { owner: string; name: string }): Promise<BrainView> {
    void caller;
    return this.#exclusive(workspaceId, async () => {
      const row = this.#require(workspaceId);
      if (row.remote !== null) throw new TandemiseError('CONFLICT', `This brain is already shared: ${row.remote}.`);
      const created = await this.deps.host.createRepo(req.owner, req.name);
      const remote = remoteOf(created.remote);
      await this.deps.repo.setRemote(row.clonePath, remote);
      const pushed = await this.deps.repo.push(row.clonePath, row.defaultBranch, { setUpstream: true });
      const head = await this.deps.repo.head(row.clonePath);
      this.deps.brains.update(workspaceId, {
        remote, lastPushedSha: pushed === 'pushed' ? head : null, lastSyncAt: this.deps.clock.now(),
        lastSyncError: pushed === 'pushed' ? null : `Couldn't reach ${hostOf(remote)}.`,
      });
      this.deps.recorder.invalidate('workspaces');
      return this.view(workspaceId);
    });
  }

  // ------------------------------------------------------------------ sync

  async sync(workspaceId: WorkspaceId, why: 'start' | 'stale' | 'background' | 'person'): Promise<BrainView> {
    if (this.deps.brains.get(workspaceId) === undefined) return this.view(workspaceId);
    await this.#exclusive(workspaceId, () => this.#syncLocked(workspaceId, why));
    return this.view(workspaceId);
  }

  /** The brain commit an attempt reads: the head after a pull, when the last pull is stale. */
  async pin(workspaceId: WorkspaceId): Promise<string | null> {
    const row = this.deps.brains.get(workspaceId);
    if (row === undefined) return null;
    const age = row.lastSyncAt === null ? Infinity : this.deps.clock.epochMs() - Date.parse(row.lastSyncAt);
    if (age > BRAIN_PULL_STALE_MS || row.lastPulledSha === null) await this.sync(workspaceId, 'stale');
    return this.deps.brains.get(workspaceId)?.lastPulledSha ?? null;
  }

  /** A file at a commit. `evals/` is never readable this way (spec §8). */
  async readAt(workspaceId: WorkspaceId, sha: string, path: string): Promise<string | null> {
    if (isEvalsPath(path)) throw TandemiseError.validation(EVALS_REFUSAL);
    const row = this.#require(workspaceId);
    return this.deps.repo.readAt(row.clonePath, sha, path);
  }

  /** Files under a directory at a commit, `evals/` excluded. */
  async listAt(workspaceId: WorkspaceId, sha: string, dir: string): Promise<readonly string[]> {
    if (isEvalsPath(dir)) throw TandemiseError.validation(EVALS_REFUSAL);
    const row = this.#require(workspaceId);
    return (await this.deps.repo.listAt(row.clonePath, sha, dir)).filter((p) => !isEvalsPath(p));
  }

  /** The brain manifest at a commit; the defaults when it is missing or broken. */
  async manifestAt(workspaceId: WorkspaceId, sha: string): Promise<BrainManifest> {
    const text = await this.readAt(workspaceId, sha, BRAIN_MANIFEST);
    const read = text === null ? null : readBrainManifest(text);
    if (read !== null && 'manifest' in read) return read.manifest;
    return {
      version: 1, project: this.deps.workspaces.view(workspaceId).workspace.name, repositories: [],
      promotion: { autoApply: 'off', minHelpful: 3, minMissions: 2 }, humanEdits: 'direct',
    };
  }

  /** `factory/` at a commit, as setup files relative to it. */
  async factoryFiles(clonePath: string, sha: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const path of await this.deps.repo.listAt(clonePath, sha, BRAIN_FACTORY)) {
      const text = await this.deps.repo.readAt(clonePath, sha, path);
      if (text !== null) files[path.slice(BRAIN_FACTORY.length + 1)] = text;
    }
    return files;
  }

  /**
   * Runs `fn` with this project's clone to itself. Exposed for the ledger
   * writer and write-through, which commit to the same clone.
   */
  exclusive<T>(workspaceId: WorkspaceId, fn: () => Promise<T>): Promise<T> {
    return this.#exclusive(workspaceId, fn);
  }

  /** Pushes the default branch; a rejected push rebases once and tries again (spec §4). */
  async pushLocked(workspaceId: WorkspaceId): Promise<'pushed' | 'rejected' | 'protected' | 'offline' | 'local'> {
    const row = this.#require(workspaceId);
    if (row.remote === null) return 'local';
    let result = await this.deps.repo.push(row.clonePath, row.defaultBranch);
    if (result === 'rejected') {
      const rebased = await this.deps.repo.fetchAndRebase(row.clonePath, row.defaultBranch);
      if (rebased.offline === null && rebased.conflicted.length === 0) result = await this.deps.repo.push(row.clonePath, row.defaultBranch);
    }
    const head = await this.deps.repo.head(row.clonePath);
    if (result === 'pushed') this.deps.brains.update(workspaceId, { lastPushedSha: head, lastPulledSha: head, lastSyncError: null, lastSyncAt: this.deps.clock.now() });
    else if (result === 'offline') this.deps.brains.update(workspaceId, { lastSyncError: `Couldn't reach ${hostOf(row.remote)}.` });
    return result;
  }

  // ------------------------------------------------------------------ internals

  async #syncLocked(workspaceId: WorkspaceId, why: string): Promise<void> {
    const row = this.#require(workspaceId);
    const from = row.lastPulledSha;
    if (row.remote === null) {
      const head = await this.deps.repo.head(row.clonePath);
      this.deps.brains.update(workspaceId, { lastPulledSha: head, lastSyncAt: this.deps.clock.now(), lastSyncError: null });
      if (head !== from) await this.#notify(workspaceId, from, head);
      await this.#refreshInfo(workspaceId);
      return;
    }
    const pulled = await this.deps.repo.fetchAndRebase(row.clonePath, row.defaultBranch);
    if (pulled.offline !== null) {
      this.deps.log.warn('brain.offline', { workspaceId, why, detail: pulled.offline });
      this.deps.brains.update(workspaceId, { lastSyncError: `Couldn't reach ${hostOf(row.remote)}.` });
      this.deps.recorder.invalidate('workspaces');
      return;
    }
    let syncError: string | null = null;
    if (pulled.conflicted.length > 0) syncError = await this.resolveConflict(workspaceId, pulled.conflicted);
    const ahead = (await this.deps.repo.head(row.clonePath)) !== (await this.deps.repo.head(row.clonePath, `refs/remotes/origin/${row.defaultBranch}`));
    if (ahead) {
      const pushed = await this.pushLocked(workspaceId);
      if (pushed === 'protected') syncError ??= null;
    }
    const head = await this.deps.repo.head(row.clonePath);
    this.deps.brains.update(workspaceId, {
      lastPulledSha: head, lastSyncAt: this.deps.clock.now(), lastSyncError: syncError,
      ...(ahead ? {} : { lastPushedSha: this.deps.brains.get(workspaceId)?.lastPushedSha ?? head }),
    });
    if (head !== from) await this.#notify(workspaceId, from, head);
    await this.#refreshInfo(workspaceId);
    this.deps.recorder.invalidate('workspaces');
  }

  /**
   * A rebase conflicted on a factory, rules or decisions file (spec §9). The
   * default implementation only reports it; Task 6 replaces it with the move
   * to a branch and a pull request.
   */
  resolveConflict: (workspaceId: WorkspaceId, conflicted: readonly string[]) => Promise<string | null> = async (_ws, conflicted) =>
    `Your change to ${conflicted[0] ?? 'the brain'} conflicts with the brain.`;

  async #notify(workspaceId: WorkspaceId, from: string | null, to: string | null): Promise<void> {
    for (const listener of this.#listeners) {
      try {
        await listener(workspaceId, from, to);
      } catch (e) {
        this.deps.log.warn('brain.sync_listener_failed', { workspaceId, error: errorMessage(e) });
      }
    }
  }

  /** Counts and problems shown on the Brain section, read at `lastPulledSha`. */
  async #refreshInfo(workspaceId: WorkspaceId): Promise<void> {
    const row = this.deps.brains.get(workspaceId);
    if (row === undefined || row.lastPulledSha === null) return;
    const problems: string[] = [];
    const rules = (await this.deps.repo.listAt(row.clonePath, row.lastPulledSha, BRAIN_RULES)).filter((p) => p.endsWith('.md'));
    for (const path of rules) {
      const text = (await this.deps.repo.readAt(row.clonePath, row.lastPulledSha, path)) ?? '';
      if (text.length > BRAIN_RULES_WARN_CHARS) problems.push(`${path} is ${text.length.toLocaleString('en-US')} characters. Every agent reads it, so keep it under ${BRAIN_RULES_WARN_CHARS.toLocaleString('en-US')}.`);
    }
    let mcpsNeeded = 0;
    try {
      const { items } = await this.deps.setup.previewFiles(workspaceId, await this.factoryFiles(row.clonePath, row.lastPulledSha));
      mcpsNeeded = items.filter((i) => i.kind === 'mcps' && i.action === 'add').length;
    } catch (e) {
      problems.push(`The brain's factory could not be read: ${errorMessage(e)}`);
    }
    const prior = this.#info.get(workspaceId);
    this.#info.set(workspaceId, {
      rules: rules.length, lessons: prior?.lessons ?? 0, candidates: prior?.candidates ?? 0, mcpsNeeded,
      problems: [...problems, ...(this.extraProblems.get(workspaceId) ?? [])],
    });
  }

  /** Problems other parts of the brain report for the Brain section (a broken tracker.yaml, say). */
  readonly extraProblems = new Map<string, string[]>();

  /** Lesson counts from the ledger fold (Task 9). */
  setLessonCounts(workspaceId: WorkspaceId, lessons: number, candidates: number): void {
    const info = this.#info.get(workspaceId) ?? { rules: 0, lessons: 0, candidates: 0, mcpsNeeded: 0, problems: [] };
    this.#info.set(workspaceId, { ...info, lessons, candidates });
  }

  async refreshInfo(workspaceId: WorkspaceId): Promise<void> {
    await this.#refreshInfo(workspaceId);
  }

  async #create(caller: Caller, workspaceId: WorkspaceId, owner: string, name: string): Promise<BrainView> {
    void caller;
    const created = await this.deps.host.createRepo(owner, name);
    const remote = remoteOf(created.remote);
    const clonePath = await this.#freshClonePath(workspaceId);
    await this.deps.repo.init(clonePath, DEFAULT_BRANCH);
    const project = this.deps.workspaces.view(workspaceId).workspace.name;
    await this.deps.repo.commit(clonePath, await this.#layout(workspaceId), `chore: create the brain for ${project}`, this.#author());
    await this.deps.repo.setRemote(clonePath, remote);
    const pushed = await this.deps.repo.push(clonePath, DEFAULT_BRANCH, { setUpstream: true });
    const head = await this.deps.repo.head(clonePath);
    this.deps.brains.create({
      workspaceId, remote, defaultBranch: DEFAULT_BRANCH, clonePath, writerId: this.#writerId(),
      lastPulledSha: head, lastPushedSha: pushed === 'pushed' ? head : null, lastSyncAt: this.deps.clock.now(),
      lastSyncError: pushed === 'pushed' ? null : `Couldn't reach ${hostOf(remote)}.`, fallbackBranch: null, linkedAt: this.deps.clock.now(),
    });
    this.deps.log.info('brain.created', { workspaceId, remote });
    await this.#notify(workspaceId, null, head);
    await this.#refreshInfo(workspaceId);
    this.deps.recorder.invalidate('workspaces');
    return this.view(workspaceId);
  }

  async #local(caller: Caller, workspaceId: WorkspaceId): Promise<BrainView> {
    void caller;
    const clonePath = await this.#freshClonePath(workspaceId);
    await this.deps.repo.init(clonePath, DEFAULT_BRANCH);
    const project = this.deps.workspaces.view(workspaceId).workspace.name;
    await this.deps.repo.commit(clonePath, await this.#layout(workspaceId), `chore: create the brain for ${project}`, this.#author());
    const head = await this.deps.repo.head(clonePath);
    this.deps.brains.create({
      workspaceId, remote: null, defaultBranch: DEFAULT_BRANCH, clonePath, writerId: this.#writerId(),
      lastPulledSha: head, lastPushedSha: null, lastSyncAt: this.deps.clock.now(), lastSyncError: null,
      fallbackBranch: null, linkedAt: this.deps.clock.now(),
    });
    await this.#notify(workspaceId, null, head);
    await this.#refreshInfo(workspaceId);
    this.deps.recorder.invalidate('workspaces');
    return this.view(workspaceId);
  }

  async #adoptPreview(workspaceId: WorkspaceId, remoteInput: string): Promise<BrainAdoptPreview> {
    const remote = remoteOf(remoteInput);
    const clonePath = await this.#freshClonePath(workspaceId);
    try {
      await this.deps.repo.clone(remote, clonePath);
    } catch (e) {
      throw TandemiseError.validation(`Couldn't read the brain at ${remote}: ${errorMessage(e)}`);
    }
    const head = await this.deps.repo.head(clonePath);
    if (head === null) throw TandemiseError.validation(`${remote} has no commits yet. Create the brain there first, or choose Create a brain.`);
    for (const listener of this.beforeAdoptPreview) await listener(workspaceId, clonePath, head);
    const files = await this.factoryFiles(clonePath, head);
    const { hash, items } = await this.deps.setup.previewFiles(workspaceId, files);
    this.#pending.set(workspaceId, { remote, clonePath, head });
    const rules = (await this.deps.repo.listAt(clonePath, head, BRAIN_RULES)).filter((p) => p.endsWith('.md')).length;
    return {
      hash,
      items: items as readonly SetupItemView[],
      brain: { rules, lessons: 0, mcpsNeeded: items.filter((i) => i.kind === 'mcps' && i.action === 'add').map((i) => i.name) },
    };
  }

  /** Work that must run on a fresh clone before the adopt preview (Task 6 fills the skills store). */
  readonly beforeAdoptPreview: ((workspaceId: WorkspaceId, clonePath: string, head: string) => Promise<void>)[] = [];

  async #layout(workspaceId: WorkspaceId): Promise<BrainWrite[]> {
    const view = this.deps.workspaces.view(workspaceId);
    const repos = view.repositories.map((r) => ({ name: r.name, path: r.path }));
    const scrub = (t: string): string => scrubDocument(t, repos);
    const snapshot = await this.deps.setup.snapshotFor(workspaceId, { mcps: true });
    const rendered = renderSetup(snapshot);
    const skills: { name: string; hash: string; files: { path: string; content: string }[] }[] = [];
    for (const pin of snapshot.skills ?? []) {
      const files = await this.deps.skills.content(pin.hash);
      if (files === null) continue;
      skills.push({ name: pin.name, hash: pin.hash, files: files.map((f) => ({ path: f.path, content: Buffer.from(f.bytes).toString('utf8') })) });
    }
    const manifest: BrainManifest = {
      version: 1,
      project: view.workspace.name,
      // By remote, never by local path (spec §1): a repository with no remote is left out.
      repositories: view.repositories.filter((r) => r.remoteUrl !== null).map((r) => ({ name: r.name, remote: remoteOf(r.remoteUrl ?? '') })),
      promotion: { autoApply: 'off', minHelpful: 3, minMissions: 2 },
      humanEdits: 'direct',
    };
    return createBrainLayout({
      manifest,
      setupFiles: rendered.files,
      knowledge: view.workspace.knowledge,
      decisions: decisionFiles(this.deps.decisions.listByWorkspace(workspaceId), scrub),
      skills,
      scrub,
    });
  }

  /** The clone path; a clone left by an earlier unlink is moved aside, never deleted. */
  async #freshClonePath(workspaceId: WorkspaceId): Promise<string> {
    const path = this.deps.paths.brain(workspaceId);
    const exists = await stat(path).then(() => true, () => false);
    if (exists) await rename(path, `${path}.unlinked-${this.deps.clock.epochMs()}`);
    return path;
  }

  #writerId(): WriterId {
    const settings = this.deps.settings.read();
    let installId = typeof settings[INSTALL_ID_KEY] === 'string' ? (settings[INSTALL_ID_KEY] as string) : '';
    if (!/^[0-9a-f]{16}$/.test(installId)) {
      installId = randomBytes(8).toString('hex');
      this.deps.settings.write({ [INSTALL_ID_KEY]: installId });
    }
    return makeWriterId(this.deps.identity.localPerson().displayName, installId);
  }

  /** The local person as a git author; their edits are theirs (spec §8). */
  #author(): { name: string; email: string } {
    const person = this.deps.identity.localPerson();
    const handle = person.handles['github'] ?? slugify(person.displayName, 40);
    return { name: person.displayName, email: `${handle}@users.noreply.tandemise.local` };
  }

  author(): { name: string; email: string } {
    return this.#author();
  }

  #require(workspaceId: WorkspaceId): WorkspaceBrain {
    const row = this.deps.brains.get(workspaceId);
    if (row === undefined) throw new TandemiseError('PRECONDITION_FAILED', 'This project has no brain. Link one in Project settings.');
    return row;
  }

  #exclusive<T>(workspaceId: WorkspaceId, fn: () => Promise<T>): Promise<T> {
    const prior = this.#locks.get(workspaceId) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    const settled = next.then(() => undefined, () => undefined);
    this.#locks.set(workspaceId, settled);
    void settled.then(() => { if (this.#locks.get(workspaceId) === settled) this.#locks.delete(workspaceId); });
    return next;
  }
}

export type LinkRequest =
  | { readonly mode: 'create'; readonly owner: string; readonly name: string }
  | { readonly mode: 'adopt'; readonly remote: string }
  | { readonly mode: 'local' };

export function isEvalsPath(path: string): boolean {
  const p = path.replace(/^\.?\/+/, '');
  return p === BRAIN_EVALS || p.startsWith(`${BRAIN_EVALS}/`);
}

/** The host a person would recognise, for "Couldn't reach github.com." */
export function hostOf(remote: string): string {
  const m = /^([a-z0-9.-]+\.[a-z]{2,})\//i.exec(remote);
  return m?.[1] ?? "the brain's remote";
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
