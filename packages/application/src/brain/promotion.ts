import { createHash } from 'node:crypto';
import type {
  BrainEntry, BrainHostPort, BrainProposal, BrainRecordRepositoryPort, BrainRepoPort, BrainWrite, RoleRepositoryPort, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { classifyBrainChange, isLoadable, scopeKey } from '@tandemise/domain';
import type { Clock, Logger, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, errorMessage } from '@tandemise/shared';
import type { BrainService } from './brain-service.js';
import { promotionVerdict, readEvalGates, type PromotionEvalPort } from './eval-gates.js';
import { BRAIN_RULES } from './layout.js';
import { promote } from './promoter.js';
import type { ReflectorDeps } from './reflector.js';

/** A lesson whose promotion was closed unmerged needs this many more net helpful votes first (spec §8). */
export const PROMOTION_REGAIN = 3;
export const NOT_EVALUATED = 'Not evaluated: this project has no promotion evals yet.';
/**
 * Helpful votes from at least this many distinct sources (a writer in one run
 * or mission each) before a lesson is proposed: one click, however weighted,
 * is not a pattern. A person who found it helpful in two missions counts twice.
 */
export const MIN_SUPPORTERS = 2;

const OPEN_STATES: ReadonlySet<BrainProposal['state']> = new Set(['evaluating', 'open', 'draft']);

export interface PromotionBundle {
  readonly key: string;
  readonly lessonIds: readonly string[];
  readonly scope: BrainEntry['scope'];
}

export interface PromotionsDeps extends ReflectorDeps {
  readonly repo: BrainRepoPort;
  readonly host: BrainHostPort;
  readonly records: BrainRecordRepositoryPort;
  readonly workspaces: Pick<WorkspaceRepositoryPort, 'get'>;
  readonly roles: Pick<RoleRepositoryPort, 'get'>;
  readonly evals: () => PromotionEvalPort;
  readonly clock: Clock;
  readonly log: Logger;
}

export function promotionId(lessonIds: readonly string[]): string {
  return createHash('sha256').update([...lessonIds].sort().join('\n')).digest('hex').slice(0, 10);
}

/**
 * Promotion: from lesson to rule, as an evaluated change to the brain (#51
 * spec §8). The promoter drafts the new text of one target file; code
 * classifies the diff; the project's promotion evals gate it; a small change
 * that passes may apply on its own when the project opts in, and everything
 * else is a pull request a person reviews. The only door through which the
 * factory changes itself.
 */
export class Promotions {
  readonly #inFlight = new Set<string>();
  readonly #background = new Set<string>();

  constructor(private readonly brain: BrainService, private readonly deps: PromotionsDeps) {}

  eligible(workspaceId: WorkspaceId): readonly PromotionBundle[] {
    const manifest = this.brain.cachedManifest(workspaceId);
    const now = this.deps.clock.now();
    const open = new Set(this.deps.records.proposals(workspaceId).filter((p) => OPEN_STATES.has(p.state)).flatMap((p) => p.lessonIds));
    const bundles = new Map<string, { lessonIds: string[]; scope: BrainEntry['scope'] }>();
    for (const e of this.brain.memory(workspaceId).entries) {
      if (e.kind !== 'lesson' || !isLoadable(e, now) || (e.state !== 'active' && e.state !== 'accepted')) continue;
      if (e.net < manifest.promotion.minHelpful || e.missions.length < manifest.promotion.minMissions) continue;
      if (e.supporters < MIN_SUPPORTERS) continue;
      if (e.promoted !== null || open.has(e.id)) continue;
      if (e.netSinceRejected !== null && e.netSinceRejected < PROMOTION_REGAIN) continue;
      const key = scopeKey(e.scope);
      const bundle = bundles.get(key) ?? { lessonIds: [], scope: e.scope };
      bundle.lessonIds.push(e.id);
      bundles.set(key, bundle);
    }
    return [...bundles.entries()].map(([key, b]) => ({ key, lessonIds: b.lessonIds.sort(), scope: b.scope }));
  }

  async proposeEligible(workspaceId: WorkspaceId): Promise<readonly BrainProposal[]> {
    const out: BrainProposal[] = [];
    for (const bundle of this.eligible(workspaceId)) {
      const p = await this.propose(workspaceId, bundle.lessonIds, {});
      if (p !== null) out.push(p);
    }
    return out;
  }

  /** Fire and forget, one at a time per project: after a person's vote and each background sync. */
  proposeSoon(workspaceId: WorkspaceId): void {
    if (this.#background.has(workspaceId) || this.eligible(workspaceId).length === 0) return;
    this.#background.add(workspaceId);
    void this.proposeEligible(workspaceId)
      .catch((e) => this.deps.log.warn('brain.promotion_failed', { workspaceId, error: errorMessage(e) }))
      .finally(() => this.#background.delete(workspaceId));
  }

  async propose(workspaceId: WorkspaceId, lessonIds: readonly string[], opts: { target?: 'rules' | 'role' }): Promise<BrainProposal | null> {
    const link = this.brain.linkOf(workspaceId);
    if (link === undefined) throw new TandemiseError('PRECONDITION_FAILED', 'This project has no brain. Link one in Project settings.');
    const memory = this.brain.memory(workspaceId);
    const lessons = lessonIds.flatMap((id) => memory.entries.filter((e) => e.id === (memory.aliases[id] ?? id)));
    if (lessons.length === 0) return null;
    const id = promotionId(lessons.map((l) => l.id));
    const branch = `tandemise/promote/${id}`;
    const existing = this.deps.records.proposal(id);
    if (existing !== undefined && OPEN_STATES.has(existing.state)) return existing;
    if (this.#inFlight.has(id)) return existing ?? null;
    this.#inFlight.add(id);
    try {
      // Another daemon may have proposed the same lessons: adopt its PR (spec §9).
      if (link.remote !== null) {
        const found = await this.deps.host.findPr(link.clonePath, branch).catch(() => null);
        if (found !== null && found.state === 'open') {
          const adopted: BrainProposal = {
            id, workspaceId, lessonIds: lessons.map((l) => l.id), targets: existing?.targets ?? [], classification: existing?.classification ?? 'structural',
            reasons: existing?.reasons ?? ['Opened by another teammate\'s daemon.'], branch, state: 'open', evalRunId: null,
            verdict: existing?.verdict ?? null, prUrl: found.url, appliedSha: null, createdAt: existing?.createdAt ?? this.deps.clock.now(), updatedAt: this.deps.clock.now(),
          };
          this.deps.records.upsertProposal(adopted);
          return adopted;
        }
      }
      return await this.#draft(workspaceId, id, branch, lessons, opts);
    } finally {
      this.#inFlight.delete(id);
    }
  }

  async #draft(workspaceId: WorkspaceId, id: string, branch: string, lessons: readonly BrainEntry[], opts: { target?: 'rules' | 'role' }): Promise<BrainProposal | null> {
    const link = this.brain.linkOf(workspaceId)!;
    const workspace = this.deps.workspaces.get(workspaceId);
    if (workspace === undefined) return null;
    const scope = lessons[0]!.scope;
    const target = opts.target === 'role' && scope.role !== undefined
      ? `factory/roles/${scope.role}.md`
      : scope.role !== undefined ? `${BRAIN_RULES}/role-${scope.role}.md`
        : scope.repo !== undefined ? `${BRAIN_RULES}/repo-${scope.repo}.md` : `${BRAIN_RULES}/project.md`;
    const head = (await this.deps.repo.head(link.clonePath)) ?? link.lastPulledSha;
    if (head === null) return null;
    const current = (await this.brain.readAt(workspaceId, head, target)) ?? '';
    // Rules without a role are the architect's to write.
    const role = this.deps.roles.get(scope.role ?? 'architecture', workspaceId);
    const pass = await promote(this.deps, { workspace, role }, {
      lessons: lessons.map((l) => ({ id: l.id, text: l.text, helpful: l.helpful, harmful: l.harmful, missions: l.missions, tracker: l.source.tracker ?? null })),
      targets: [{ path: target, text: current }],
    });
    this.deps.records.insertPass({
      id: pass.passId, workspaceId, missionId: null, taskId: null, kind: 'promote', signal: 'promotion', runtimeProfileId: pass.profileId,
      model: pass.model, status: 'problem' in pass.result ? 'failed' : 'ok', reason: 'problem' in pass.result ? pass.result.problem : null,
      usage: pass.usage, createdAt: this.deps.clock.now(),
    });
    if ('problem' in pass.result) {
      this.brain.reportProblem(workspaceId, `A promotion couldn't be drafted: ${pass.result.problem}`);
      return null;
    }
    // Everything the promoter wrote is scrubbed before it is classified or committed.
    const files = pass.result.output.files.map((f) => ({ path: f.path, content: this.brain.scrubDocumentFor(workspaceId, f.content) }));
    // Classified by code from the whole reply first: a promoter that touched evals/ is refused outright.
    const before = async (path: string): Promise<string | null> => (path.startsWith('evals/') ? null : this.brain.readAt(workspaceId, head, path));
    const fullDiff = await Promise.all(files.map(async (f) => ({ path: f.path, before: await before(f.path), after: f.content })));
    const first = classifyBrainChange(fullDiff);
    if (first.class === 'refused') {
      this.brain.reportProblem(workspaceId, `A promotion was dropped: ${first.reasons[0] ?? 'it was refused'}`);
      return null;
    }
    const drafted = fullDiff.find((d) => d.path === target);
    const dropped = fullDiff.filter((d) => d.path !== target).map((d) => d.path);
    if (dropped.length > 0) this.brain.reportProblem(workspaceId, `The promoter also tried to change ${dropped.join(', ')}; only ${target} was kept.`);
    if (drafted === undefined || drafted.after === null) return null;
    const after = drafted.after;
    const writes: BrainWrite[] = [{ path: target, mode: 'write', content: after }];
    const subject = `chore: promote ${lessons.length === 1 ? 'a lesson' : `${lessons.length} lessons`} to ${target}`;
    // The branch starts from the default branch as it is now, and the change is classified
    // against the file as it is now: a teammate's edit since the draft is never silently undone.
    const drawn = await this.brain.exclusive(workspaceId, async () => {
      const base = `refs/heads/${link.defaultBranch}`;
      const tip = await this.deps.repo.head(link.clonePath, base);
      const now = tip === null ? null : await this.deps.repo.readAt(link.clonePath, tip, target);
      if (now === after) return null;
      await this.deps.repo.branch(link.clonePath, branch, base);
      await this.deps.repo.commit(link.clonePath, writes, `${subject}\n\nTandemise-Promotion: ${id}`, null, { branch, from: base });
      return { before: now, classification: classifyBrainChange([{ path: target, before: now, after }]) };
    });
    if (drawn === null) return null;
    const classification = drawn.classification;
    const cls = classification.class === 'small' ? 'small' : 'structural';
    const kept = [{ path: target }];

    // Evals: the project's suites, the candidate is this branch, the baseline the default branch.
    const gates = readEvalGates(await this.brain.readEvalsForPromotion(workspaceId, head, 'evals/gates.yaml'));
    let verdict: BrainProposal['verdict'];
    let evalLines: string[];
    if ('problem' in gates) {
      verdict = 'failed';
      evalLines = [gates.problem];
    } else if (gates.suites.length === 0) {
      verdict = 'not_evaluated';
      evalLines = [NOT_EVALUATED];
    } else {
      const results = await this.deps.evals().run(workspaceId, gates.suites, branch);
      evalLines = [];
      let passed = results.length === gates.suites.length;
      for (const r of results) {
        if (r.scorecard === null) { passed = false; evalLines.push(`${r.suite}: ${r.problem ?? 'no scorecard'}`); continue; }
        const v = promotionVerdict(r.scorecard, gates.rule);
        if (!v.passed) passed = false;
        evalLines.push(`${r.suite}: ${v.lines.join(', ')}`);
      }
      verdict = passed ? 'passed' : 'failed';
    }

    const manifest = await this.brain.manifestAt(workspaceId, head);
    const now = this.deps.clock.now();
    const base: Omit<BrainProposal, 'state' | 'prUrl' | 'appliedSha'> = {
      id, workspaceId, lessonIds: lessons.map((l) => l.id), targets: kept.map((d) => d.path), classification: cls,
      reasons: classification.reasons, branch, evalRunId: null, verdict, createdAt: now, updatedAt: now,
    };
    let proposal: BrainProposal | null = null;
    if (cls === 'small' && manifest.promotion.autoApply === 'small' && verdict === 'passed') {
      const message = `${subject}\n\nTandemise-Promotion: ${id}\nTandemise-Eval: ${evalLines.join('; ')}`;
      const applied = await this.brain.exclusive(workspaceId, async () => {
        // Evals take time: if the file moved meanwhile, a person reviews it instead.
        const tip = await this.deps.repo.head(link.clonePath, `refs/heads/${link.defaultBranch}`);
        const now = tip === null ? null : await this.deps.repo.readAt(link.clonePath, tip, target);
        if (now !== drawn.before) return null;
        const sha = await this.deps.repo.commit(link.clonePath, writes, message, null);
        if (link.remote !== null) await this.brain.pushLocked(workspaceId);
        else this.brain.markPulled(workspaceId, sha);
        return sha;
      });
      if (applied !== null) proposal = { ...base, state: 'applied', prUrl: null, appliedSha: applied };
      else this.brain.reportProblem(workspaceId, `${target} changed while the promotion was evaluated, so it waits for review instead of applying on its own.`);
    }
    if (proposal !== null) {
      // applied above
    } else if (link.remote !== null) {
      const pushed = await this.brain.exclusive(workspaceId, () => this.deps.repo.push(link.clonePath, branch));
      if (pushed !== 'pushed') {
        this.brain.reportProblem(workspaceId, `Couldn't push the promotion branch ${branch}.`);
        proposal = { ...base, state: 'open', prUrl: null, appliedSha: null };
      } else {
        const failed = verdict === 'failed';
        const headline = lessons[0]!.text.slice(0, 60);
        const pr = await this.deps.host.openPr({
          clone: link.clonePath, head: branch, base: link.defaultBranch, draft: failed,
          title: failed ? `Did not pass evals: ${headline}` : `Promote: ${headline}`,
          body: this.#body(lessons, target, cls, classification.reasons, evalLines),
        });
        proposal = { ...base, state: failed ? 'draft' : 'open', prUrl: pr.url, appliedSha: null };
      }
    } else {
      // A brain on this machine only: the branch is the proposal, accepted or declined in the app.
      proposal = { ...base, state: 'open', prUrl: null, appliedSha: null };
    }
    this.deps.records.upsertProposal(proposal);
    await this.brain.append(workspaceId, lessons.map((l) => ({ op: 'promote' as const, id: l.id, target, pr: proposal.prUrl })), { actor: 'daemon' });
    await this.brain.flush(workspaceId);
    this.deps.log.info('brain.promotion', { workspaceId, id, state: proposal.state, classification: cls, verdict });
    return proposal;
  }

  #body(lessons: readonly BrainEntry[], target: string, cls: 'small' | 'structural', reasons: readonly string[], evalLines: readonly string[]): string {
    return [
      '## What changes and why',
      '',
      `${lessons.length === 1 ? 'A lesson keeps' : `${lessons.length} lessons keep`} proving useful, so this turns ${lessons.length === 1 ? 'it' : 'them'} into a rule in \`${target}\`.`,
      '',
      '## Lessons',
      '',
      ...lessons.map((l) => `- ${l.text} (helpful ${l.helpful}, harmful ${l.harmful}; from ${l.missions.join(', ') || 'no mission'}${l.source.tracker ? `; ${l.source.tracker}` : ''})`),
      '',
      '## Classification',
      '',
      `${cls === 'small' ? 'Small' : 'Structural'}: ${reasons.join(' ')}`,
      '',
      '## Evals',
      '',
      ...evalLines.map((l) => `- ${l}`),
      '',
      'Drafted by Tandemise from the brain\'s ledger. The evals were scored by the daemon, not by the model that drafted this.',
      '',
    ].join('\n');
  }

  /** On each sync: a merged PR is merged, a closed one rejects its lessons (spec §8). */
  async settle(workspaceId: WorkspaceId): Promise<void> {
    const link = this.brain.linkOf(workspaceId);
    if (link === undefined || link.remote === null) return;
    for (const p of this.deps.records.proposals(workspaceId)) {
      if ((p.state !== 'open' && p.state !== 'draft') || p.prUrl === null) continue;
      const state = await this.deps.host.prState(link.clonePath, p.prUrl).catch(() => null);
      if (state === 'merged') this.deps.records.upsertProposal({ ...p, state: 'merged', updatedAt: this.deps.clock.now() });
      if (state === 'closed') {
        this.deps.records.upsertProposal({ ...p, state: 'closed', updatedAt: this.deps.clock.now() });
        await this.brain.append(workspaceId, p.lessonIds.map((id) => ({ op: 'unpromote' as const, id, pr: p.prUrl })), { actor: 'daemon' });
      }
    }
  }

  async accept(id: string): Promise<BrainProposal> {
    const p = this.#require(id);
    const link = this.brain.linkOf(p.workspaceId);
    if (link === undefined || p.state !== 'open' || link.remote !== null) throw new TandemiseError('CONFLICT', 'Only a proposal waiting on this machine can be accepted here.');
    const ok = await this.brain.exclusive(p.workspaceId, async () => {
      let moved = await this.deps.repo.fastForward(link.clonePath, p.branch, link.defaultBranch);
      if (!moved) {
        // The default branch moved on (ledger lines): the proposal's files land as one commit, as a merge would.
        const tip = await this.deps.repo.head(link.clonePath, `refs/heads/${p.branch}`);
        const mainTip = await this.deps.repo.head(link.clonePath, `refs/heads/${link.defaultBranch}`);
        // Only when the targets on the default branch are still what the proposal started from.
        let unchanged = tip !== null && mainTip !== null;
        for (const path of unchanged ? p.targets : []) {
          if ((await this.deps.repo.readAt(link.clonePath, `${tip}~1`, path)) !== (await this.deps.repo.readAt(link.clonePath, mainTip!, path))) unchanged = false;
        }
        if (tip !== null && unchanged) {
          const writes: BrainWrite[] = [];
          for (const path of p.targets) {
            const text = await this.deps.repo.readAt(link.clonePath, tip, path);
            if (text !== null) writes.push({ path, mode: 'write', content: text });
          }
          if (writes.length > 0) {
            await this.deps.repo.commit(link.clonePath, writes, `chore: accept promotion ${p.id}\n\nTandemise-Promotion: ${p.id}`, null);
            moved = true;
          }
        }
      }
      if (moved) this.brain.markPulled(p.workspaceId, await this.deps.repo.head(link.clonePath));
      return moved;
    });
    if (!ok) throw new TandemiseError('CONFLICT', 'The brain moved since this was proposed. Decline it; the lesson will be proposed again.');
    const next: BrainProposal = { ...p, state: 'accepted', updatedAt: this.deps.clock.now() };
    this.deps.records.upsertProposal(next);
    await this.brain.refreshInfo(p.workspaceId);
    return next;
  }

  async decline(id: string): Promise<BrainProposal> {
    const p = this.#require(id);
    if (!OPEN_STATES.has(p.state)) throw new TandemiseError('CONFLICT', 'This proposal is already settled.');
    const next: BrainProposal = { ...p, state: 'declined', updatedAt: this.deps.clock.now() };
    this.deps.records.upsertProposal(next);
    await this.brain.append(p.workspaceId, p.lessonIds.map((lessonId) => ({ op: 'unpromote' as const, id: lessonId, pr: p.prUrl })), { actor: 'person' });
    return next;
  }

  async revert(id: string): Promise<BrainProposal> {
    const p = this.#require(id);
    if (p.state !== 'applied' || p.appliedSha === null) throw new TandemiseError('CONFLICT', 'Only a promotion that applied on its own can be reverted here.');
    const link = this.brain.linkOf(p.workspaceId)!;
    await this.brain.exclusive(p.workspaceId, async () => {
      const sha = await this.deps.repo.revert(link.clonePath, p.appliedSha!, `Revert promotion ${p.id}`);
      if (link.remote !== null) await this.brain.pushLocked(p.workspaceId);
      else this.brain.markPulled(p.workspaceId, sha);
    });
    const next: BrainProposal = { ...p, state: 'reverted', updatedAt: this.deps.clock.now() };
    this.deps.records.upsertProposal(next);
    return next;
  }

  #require(id: string): BrainProposal {
    const p = this.deps.records.proposal(id);
    if (p === undefined) throw TandemiseError.notFound('Proposal', id);
    return p;
  }
}
