import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  applyProposal, draftProposals, foldOutcomes, githubRepoFromRemote,
  type OutcomeRepositoryPort, type Proposal, type ProposalHistory, type PullRequestPort, type Repository, type WorkspaceRepositoryPort,
} from '@tandemise/domain';
import type { CommandExecutor } from '@tandemise/integrations-core';
import { errorMessage, type Clock, type Logger, type WorkspaceId } from '@tandemise/shared';
import type { PlannerService } from '../planning/planner-service.js';
import { SHIPPED_FILES } from '../planning/factory-config.js';
import type { MergePolicyService } from './merge-policy-service.js';

/**
 * The factory's learning proposals (#53 §9.2): once a day, the outcome fold is
 * read and every tightening it supports is opened as a pull request on
 * `tandemise/promote/<id>` that edits `.tandemise/factory/<file>.yaml` on its
 * own branch. Nothing here touches the project's working tree or the files
 * the planner reads: a proposal only takes effect when a person merges it.
 * Task 20 sends these to the brain repository instead (#51 §8).
 */
export const PROPOSAL_SWEEP_EVERY_MS = 86_400_000;
const OUTCOME_WINDOW_MS = 90 * 86_400_000;

export interface ProposalServiceDeps {
  readonly workspaces: Pick<WorkspaceRepositoryPort, 'list'>;
  readonly planner: Pick<PlannerService, 'config' | 'repositories'>;
  readonly outcomes: Pick<OutcomeRepositoryPort, 'listByWorkspace'>;
  readonly pullRequests: Pick<PullRequestPort, 'open' | 'listByHead'>;
  readonly mergePolicy: () => Pick<MergePolicyService, 'backtest'>;
  readonly exec: CommandExecutor | null;
  readonly credentialEnv?: () => Readonly<Record<string, string>>;
  readonly clock: Clock;
  readonly log: Logger;
  readonly tmpRoot: string;
  /** A linked brain takes proposals instead of the project repository (#51 §8, #53 Task 20). */
  readonly brain?: () => Pick<import('../brain/brain-service.js').BrainService, 'linkOf' | 'readAt' | 'exclusive' | 'author'> | undefined;
  readonly brainRepo?: () => Pick<import('@tandemise/domain').BrainRepoPort, 'commit' | 'moveUnpushedTo' | 'push' | 'head'> | undefined;
  readonly brainHost?: () => Pick<import('@tandemise/domain').BrainHostPort, 'openPr'> | undefined;
}

export class ProposalService {
  #last = 0;
  #running = false;

  constructor(private readonly deps: ProposalServiceDeps) {}

  tick(): void {
    const now = this.deps.clock.epochMs();
    if (this.#running || now - this.#last < PROPOSAL_SWEEP_EVERY_MS) return;
    this.#last = now;
    this.#running = true;
    void this.sweep().catch((e: unknown) => this.deps.log.warn('proposals.failed', { error: errorMessage(e) })).finally(() => { this.#running = false; });
  }

  /** Every workspace; returns the proposals it opened. */
  async sweep(): Promise<readonly Proposal[]> {
    const opened: Proposal[] = [];
    for (const ws of this.deps.workspaces.list()) {
      try {
        opened.push(...await this.#sweepWorkspace(ws.id));
      } catch (e) {
        this.deps.log.warn('proposals.workspace_failed', { workspaceId: ws.id, error: errorMessage(e) });
      }
    }
    return opened;
  }

  async #sweepWorkspace(workspaceId: WorkspaceId): Promise<Proposal[]> {
    const repository = this.deps.planner.repositories(workspaceId)[0];
    const repo = repository === undefined ? null : githubRepoFromRemote(repository.remoteUrl);
    if (repository === undefined || repo === null || this.deps.exec === null) return [];
    const config = await this.deps.planner.config(workspaceId);
    const events = this.deps.outcomes.listByWorkspace(workspaceId, new Date(this.deps.clock.epochMs() - OUTCOME_WINDOW_MS).toISOString());
    const stats = foldOutcomes(events);
    const current = { planner: config.planner, routing: config.routing, merge: config.merge };
    const candidates = draftProposals(stats, events, current, {});
    const prior: Record<string, ProposalHistory[string]> = {};
    for (const p of candidates) {
      const prs = await this.deps.pullRequests.listByHead(repository.path, repo, branchOf(p));
      const live = prs.find((x) => x.state !== 'CLOSED');
      const closed = prs.filter((x) => x.state === 'CLOSED').sort((a, b) => b.number - a.number)[0];
      if (live !== undefined) prior[p.id] = { state: live.state === 'MERGED' ? 'merged' : 'open', evidence: 0 };
      else if (closed !== undefined) prior[p.id] = { state: 'closed', evidence: Number(/Evidence: (\d+) outcome/.exec(closed.body)?.[1] ?? 0) };
    }
    const proposals = draftProposals(stats, events, current, prior);
    const opened: Proposal[] = [];
    const link = this.deps.brain?.()?.linkOf(workspaceId);
    for (const p of proposals) {
      if (p.kind !== 'tighten') continue; // never: loosening is a person's edit
      const backtest = p.file === 'merge' && !('error' in config.merge)
        ? (await this.deps.mergePolicy().backtest(workspaceId, applyProposal(config.merge as unknown as Record<string, unknown>, p.edit))).sentence
        : null;
      if (link !== undefined) {
        // The brain's promotion path: a branch in the brain repository and a PR there. A brain on this machine only gets none.
        if (link.remote === null || !(await this.#openInBrain(workspaceId, p, backtest))) continue;
      } else {
        await this.#open(repository, repo, p, backtest);
      }
      opened.push(p);
    }
    return opened;
  }

  async #openInBrain(workspaceId: WorkspaceId, p: Proposal, backtest: string | null): Promise<boolean> {
    const brain = this.deps.brain?.();
    const repo = this.deps.brainRepo?.();
    const host = this.deps.brainHost?.();
    const link = brain?.linkOf(workspaceId);
    if (brain === undefined || repo === undefined || host === undefined || link === undefined || link.lastPulledSha === null) return false;
    const file = `factory/${p.file}.yaml`;
    const shown = await brain.readAt(workspaceId, link.lastPulledSha, file);
    const raw = shown !== null ? (parseYaml(shown) as Record<string, unknown>) : (SHIPPED_FILES[p.file] as Record<string, unknown>);
    const head = branchOf(p);
    return brain.exclusive(workspaceId, async () => {
      await repo.commit(link.clonePath, [{ path: file, mode: 'write', content: stringifyYaml(applyProposal(raw, p.edit)) }], p.title, brain.author());
      await repo.moveUnpushedTo(link.clonePath, head, link.defaultBranch);
      const pushed = await repo.push(link.clonePath, head, { setUpstream: false });
      if (pushed !== 'pushed') return false;
      await host.openPr({ clone: link.clonePath, head, base: link.defaultBranch, title: p.title, body: proposalBody(file, p, backtest), draft: false });
      return true;
    });
  }

  async #open(repository: Repository, repo: string, p: Proposal, backtest: string | null): Promise<void> {
    const exec = this.deps.exec!;
    const head = branchOf(p);
    const base = repository.defaultBranch;
    const dir = `${this.deps.tmpRoot}/${p.id}-${this.deps.clock.epochMs()}`;
    const file = `.tandemise/factory/${p.file}.yaml`;
    const git = (args: readonly string[], cwd = repository.path, stdin?: string) => exec.run({
      command: 'git', args, cwd, timeoutMs: 120_000, ...(stdin === undefined ? {} : { stdin }),
      env: { GIT_TERMINAL_PROMPT: '0', ...this.deps.credentialEnv?.() },
    });
    await git(['fetch', '--quiet', 'origin', base]);
    const shown = await git(['show', `origin/${base}:${file}`]);
    const raw = shown.exitCode === 0 ? (parseYaml(shown.stdout) as Record<string, unknown>) : (SHIPPED_FILES[p.file] as Record<string, unknown>);
    const next = stringifyYaml(applyProposal(raw, p.edit));
    const added = await git(['worktree', 'add', '-B', head, dir, `origin/${base}`]);
    if (added.exitCode !== 0) throw new Error(`couldn't start ${head}: ${added.stderr}`);
    try {
      const blob = await git(['hash-object', '-w', '--stdin'], dir, next);
      await git(['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},${file}`], dir);
      const committed = await git(['-c', 'user.name=Tandemise', '-c', 'user.email=factory@tandemise.local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', p.title], dir);
      if (committed.exitCode !== 0) throw new Error(`couldn't commit the proposal: ${committed.stderr}`);
      const pushed = await git(['push', '--quiet', '--force', 'origin', `${head}:refs/heads/${head}`], dir);
      if (pushed.exitCode !== 0) throw new Error(`couldn't push ${head}: ${pushed.stderr}`);
    } finally {
      await git(['worktree', 'remove', '--force', dir]);
    }
    await this.deps.pullRequests.open({ cwd: repository.path, repo, head, base, title: p.title, body: proposalBody(file, p, backtest) });
  }
}

function proposalBody(file: string, p: Proposal, backtest: string | null): string {
  return [
    `The factory proposes a tighter rule from what happened, for you to review (#53 §9.2). It changes \`${file}\` at \`${p.edit.path}\`.`,
    '',
    `Evidence: ${p.evidence.outcomeIds.length} outcomes, from missions:`,
    ...p.evidence.missions.map((m) => `- \`${m}\``),
    ...(backtest === null ? [] : ['', `Backtest: ${backtest}`]),
    '',
    'Nothing changes until this is merged. Close it to say no; it is proposed again only when the evidence doubles.',
  ].join('\n');
}

const branchOf = (p: Proposal): string => `tandemise/promote/${p.id}`;
