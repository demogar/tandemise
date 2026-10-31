import type {
  ArtifactRepositoryPort, Closure, ClosureKind, ClosureResult, IntakeClosure, IntakeConfigSource, IntakeRepositoryPort, IntakeSignal,
  MemberRepositoryPort, Mission, MissionRepositoryPort, ProjectionBusPort, RepoRepositoryPort, SignalStatus, TrackedItem,
  TrackerItemRepositoryPort, UnitOfWork, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { githubRepoFromRemote, isTerminalMissionStatus, sourceLabel } from '@tandemise/domain';
import type { AckIntakeClosureRequest, IntakeClosureView, IntakeClosuresView } from '@tandemise/api-contract';
import type { ClosureId, Clock, Logger, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId, errorMessage } from '@tandemise/shared';
import { deliveryLinks } from '../support/delivery-links.js';
import { requireSeat, type Caller } from '../support/identity.js';
import type { IntakeScope } from './intake-service.js';

export interface ClosureServiceDeps {
  readonly intake: IntakeRepositoryPort;
  readonly config: IntakeConfigSource;
  /** The board cache: each closure names its item's key and link. */
  readonly items: Pick<TrackerItemRepositoryPort, 'byRef'>;
  readonly missions: Pick<MissionRepositoryPort, 'list'>;
  /** The mission's handoffs: its pull request and its newest commit. */
  readonly artifacts: Pick<ArtifactRepositoryPort, 'listByMission'>;
  /** The mission's repository, whose remote names the commit's repository. */
  readonly repositories: Pick<RepoRepositoryPort, 'get'>;
  /**
   * The runner host's `close`: the closure handed to its source's runner,
   * under the source's claim. Null when it is not this daemon's to close now
   * (a custom source's feed, a source switched off here, a claim held elsewhere).
   */
  readonly closer: { close(workspaceId: WorkspaceId, sourceId: string, closure: Closure): Promise<ClosureResult | null> };
  readonly workspaces: Pick<WorkspaceRepositoryPort, 'list'>;
  readonly members: MemberRepositoryPort;
  /** Tells open windows the Intake tab changed; optional for harnesses. */
  readonly projections?: Pick<ProjectionBusPort, 'invalidate'>;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly log: Logger;
}

/** Plan Task 13: after the eighth failed attempt the closure stays failed until Retry. */
export const CLOSURE_MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 3_600_000;
/** The signal statuses the loop owns: a signal there is never set back to `closure_pending` by a refresh. */
const CLOSURE_STATUSES: readonly SignalStatus[] = ['closure_pending', 'closed', 'closure_failed'];

/** Spec §8: 1 minute, doubling, up to 1 hour. `attempts` counts the one that just failed. */
export function closureBackoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), BACKOFF_MAX_MS);
}

/**
 * Closing the loop (spec §8, plan Task 13).
 *
 * The tracker is the truth: whenever a board refresh sees an item in a mapped
 * `done` state, whoever moved it there, every signal linked to it gets one
 * closure (`ensure(signal, 'done')`, keyed by `(signal, kind)`, so it is
 * written once however often the refresh sees it). A `wont_do` item closes
 * only the sources configured with `closeWontDo`, as `not_planned`.
 *
 * The scheduler's tick hands each due closure to the runner of its source
 * with the item, its mission's pull request and its newest commit. A failure
 * the source may get over is tried again after 1, 2, 4… minutes, up to an
 * hour; after the eighth attempt, or at once when the source refuses for good,
 * the closure is failed in the source's own words until a person retries it.
 * A runner checks the source for its own reply before writing (Slack, Discord,
 * GitHub), so a crash between writing and storing the result never writes
 * twice (Review Focus 5).
 *
 * A custom source has no runner: its closures wait on its feed, which its
 * runner reads and acknowledges over HTTP or the CLI.
 */
export class ClosureService {
  #passing: Promise<void> | null = null;

  constructor(private readonly deps: ClosureServiceDeps) {}

  // ------------------------------------------------------------------ detection

  /**
   * Called on every board refresh with the project's cached items (plan Task
   * 13): writes the closures a done (or, with `closeWontDo`, won't-do) item
   * owes its linked signals, and moves those signals to `closure_pending`.
   */
  detect(workspaceId: WorkspaceId, items: readonly TrackedItem[]): void {
    const config = this.deps.config.read(workspaceId);
    const tracker = config.tracker;
    if (tracker === null) return;
    let wrote = false;
    for (const item of items) {
      const done = tracker.states.done.includes(item.state);
      if (!done && !tracker.states.wont_do.includes(item.state)) continue;
      const kind: ClosureKind = done ? 'done' : 'not_planned';
      for (const link of this.deps.intake.linksForItem(workspaceId, item.ref)) {
        // A pending link has not reached the tracker yet; a source that is the item closes with it.
        if (link.status !== 'done' || link.linkedBy === 'source_is_item') continue;
        const signal = this.deps.intake.getSignal(link.signalId);
        if (signal === undefined) continue;
        if (!done && config.sources.find((s) => s.id === signal.sourceId)?.closeWontDo !== true) continue;
        this.deps.unitOfWork.transaction(() => {
          this.deps.intake.closures.ensure(signal.id, kind);
          if (!CLOSURE_STATUSES.includes(signal.status)) {
            this.deps.intake.setStatus(signal.id, 'closure_pending', null);
            wrote = true;
          }
        });
      }
    }
    if (wrote) this.#invalidate();
  }

  // ------------------------------------------------------------------ the tick

  /** Scheduler hook: closes what is due in the background and returns at once (`settle()` waits). */
  tick(): void {
    if (this.#passing !== null) return;
    this.#passing = this.#pass().finally(() => { this.#passing = null; });
  }

  /** Resolves when the pass begun so far has finished (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.#passing !== null) await this.#passing;
  }

  async #pass(): Promise<void> {
    try {
      const known = new Set(this.deps.workspaces.list().map((w) => w.id));
      for (const closure of this.deps.intake.closures.due(this.deps.clock.now())) {
        const signal = this.deps.intake.getSignal(closure.signalId);
        if (signal === undefined || !known.has(signal.workspaceId)) continue;
        try {
          await this.#attempt(closure, signal);
        } catch (e) {
          // Storing the result failed (the runner may have written): the
          // closure stays as it was, and the runner's own-reply check makes
          // the next attempt a no-op at the source.
          this.deps.log.warn('intake.closure_failed_to_store', { closureId: closure.id, error: errorMessage(e) });
        }
      }
    } catch (e) {
      this.deps.log.warn('intake.closures_tick_failed', { error: errorMessage(e) });
    }
  }

  async #attempt(closure: IntakeClosure, signal: IntakeSignal): Promise<void> {
    const built = this.#build(closure, signal);
    let result: ClosureResult | null;
    if (built === null) {
      result = { ok: false, error: 'This signal is no longer linked to a task.', retryable: false };
    } else {
      try {
        result = await this.deps.closer.close(signal.workspaceId, signal.sourceId, built);
      } catch (e) {
        result = { ok: false, error: errorMessage(e), retryable: true };
      }
    }
    if (result === null) return;
    this.#store(closure, signal, result);
  }

  #store(closure: IntakeClosure, signal: IntakeSignal, result: ClosureResult): void {
    const now = this.deps.clock.now();
    if (result.ok) {
      this.deps.unitOfWork.transaction(() => {
        this.deps.intake.closures.update(closure.id, {
          state: 'closed', attempts: closure.attempts + 1, nextAttemptAt: null, externalId: result.externalId, lastError: null, closedAt: now,
        });
        this.deps.intake.setStatus(signal.id, 'closed', null);
      });
      this.deps.log.info('intake.closed', { closureId: closure.id, signalId: signal.id, kind: closure.kind });
    } else {
      const attempts = closure.attempts + 1;
      if (result.retryable && attempts < CLOSURE_MAX_ATTEMPTS) {
        this.deps.intake.closures.update(closure.id, {
          attempts, lastError: result.error, nextAttemptAt: new Date(this.deps.clock.epochMs() + closureBackoffMs(attempts)).toISOString(),
        });
      } else {
        this.#fail(closure.id, signal, result.error, attempts);
      }
      this.deps.log.warn('intake.closure_attempt_failed', { closureId: closure.id, signalId: signal.id, attempts, error: result.error });
    }
    this.#invalidate();
  }

  /** Failed in the source's own words; the signal says where (plan Task 13). */
  #fail(id: ClosureId, signal: IntakeSignal, error: string, attempts?: number): IntakeClosure {
    return this.deps.unitOfWork.transaction(() => {
      const failed = this.deps.intake.closures.update(id, {
        state: 'failed', nextAttemptAt: null, lastError: error, ...(attempts === undefined ? {} : { attempts }),
      });
      this.deps.intake.setStatus(signal.id, 'closure_failed', `Couldn't close at ${sourceLabel(signal.kind)}: ${error}`);
      return failed;
    });
  }

  /**
   * The closure a runner gets: the signal, its item, and from the item's
   * mission (the open one, else the newest) the first pull request and the
   * newest commit, in the repository its remote names (plan Task 13).
   */
  #build(closure: IntakeClosure, signal: IntakeSignal): Closure | null {
    const item = this.#itemOf(signal);
    if (item === null) return null;
    const mission = item.cached === undefined ? null : this.#missionOf(signal.workspaceId, item.cached);
    return {
      kind: closure.kind,
      signal: { fingerprint: signal.fingerprint, key: signal.key, url: signal.url, instance: signal.instance, title: signal.title, reply: signal.reply },
      item: { key: item.key, url: item.url },
      prUrl: mission === null ? null : deliveryLinks(this.deps.artifacts, mission.id).find((l) => l.kind === 'pr')?.url ?? null,
      commit: mission === null ? null : this.#commitOf(mission),
    };
  }

  #itemOf(signal: IntakeSignal): { key: string; url: string; cached: TrackedItem | undefined } | null {
    const ref = this.deps.intake.linkFor(signal.id)?.itemRef ?? null;
    if (ref === null) return null;
    const cached = this.deps.items.byRef(signal.workspaceId, ref);
    // The cache keeps every item a link points at (RULINGS ruling 13); the ref's own key is the fallback.
    return cached === undefined ? { key: ref.slice(ref.indexOf(':') + 1), url: '', cached } : { key: cached.key, url: cached.url, cached };
  }

  #missionOf(workspaceId: WorkspaceId, item: TrackedItem): Mission | null {
    const missions = this.deps.missions.list({ workspaceId }).filter((m) => m.trackerItemId === item.id);
    return missions.find((m) => !isTerminalMissionStatus(m.status)) ?? missions[0] ?? null;
  }

  #commitOf(mission: Mission): { sha: string; repo: string } | null {
    const repository = mission.repositoryId === null ? undefined : this.deps.repositories.get(mission.repositoryId);
    const repo = githubRepoFromRemote(repository?.remoteUrl ?? null);
    if (repo === null) return null;
    let newest: { sha: string; at: string } | null = null;
    for (const artifact of this.deps.artifacts.listByMission(mission.id)) {
      for (const ref of artifact.sourceRefs) {
        if (ref.kind === 'git.commit' && ref.value !== '' && (newest === null || artifact.createdAt >= newest.at)) newest = { sha: ref.value, at: artifact.createdAt };
      }
    }
    return newest === null ? null : { sha: newest.sha, repo };
  }

  // ------------------------------------------------------------------ Retry, and the custom feed

  /** The Intake tab's Retry (spec §8): a pending or failed closure is due now, with its attempts reset. */
  retry(caller: Caller, id: string): IntakeClosureView {
    const { closure, signal } = this.#require(id);
    requireSeat(this.deps, signal.workspaceId, caller);
    if (closure.state === 'closed') throw new TandemiseError('PRECONDITION_FAILED', `Already closed at ${sourceLabel(signal.kind)}.`);
    const pending = this.deps.unitOfWork.transaction(() => {
      const next = this.deps.intake.closures.update(closure.id, { state: 'pending', attempts: 0, nextAttemptAt: this.deps.clock.now(), lastError: null });
      this.deps.intake.setStatus(signal.id, 'closure_pending', null);
      return next;
    });
    this.#invalidate();
    return this.#view(pending, this.deps.intake.getSignal(signal.id) ?? signal);
  }

  /**
   * Who reads a feed: an intake token reads its own source only; the daemon
   * token names the project and the source (spec §2, as a push does).
   */
  feedScope(fromToken: IntakeScope | null, workspace: string | null, sourceId: string | null): IntakeScope {
    if (fromToken !== null) {
      if ((sourceId !== null && sourceId !== '' && sourceId !== fromToken.sourceId) || (workspace !== null && workspace !== '' && workspace !== fromToken.workspaceId)) {
        throw TandemiseError.permissionDenied(`This token can only read the closures of '${fromToken.sourceId}'.`, { sourceId: fromToken.sourceId });
      }
      return fromToken;
    }
    if (workspace === null || workspace === '' || sourceId === null || sourceId === '') {
      throw TandemiseError.validation('Name the project and the source: ?workspace=<id>&sourceId=<id>.');
    }
    return { workspaceId: asId<'WorkspaceId'>(workspace), sourceId, tokenId: null };
  }

  /** A source's closures in id order, after `after` when given (spec §2). */
  feed(scope: IntakeScope, after: string | null): IntakeClosuresView {
    const closures = this.deps.intake.closures.listForSource(scope.workspaceId, scope.sourceId, after === null || after === '' ? undefined : after);
    return {
      closures: closures.flatMap((c) => {
        const signal = this.deps.intake.getSignal(c.signalId);
        return signal === undefined ? [] : [this.#view(c, signal)];
      }),
    };
  }

  /**
   * A custom runner's answer (spec §2): `ok` closes the closure and its
   * signal; an error fails it in the runner's words. An intake token acks
   * only its own source's closures; any other is not found for it. An ack of
   * a closure already closed changes nothing. `caller` is read only for the
   * daemon token: an intake token names no person.
   */
  ack(fromToken: IntakeScope | null, caller: () => Caller, id: string, answer: AckIntakeClosureRequest): IntakeClosureView {
    const { closure, signal } = this.#require(id);
    if (fromToken !== null) {
      if (fromToken.workspaceId !== signal.workspaceId || fromToken.sourceId !== signal.sourceId) throw TandemiseError.notFound('Closure', id);
    } else {
      requireSeat(this.deps, signal.workspaceId, caller());
    }
    if (closure.state === 'closed') return this.#view(closure, signal);
    let next: IntakeClosure;
    if (answer.ok) {
      next = this.deps.unitOfWork.transaction(() => {
        const closed = this.deps.intake.closures.update(closure.id, {
          state: 'closed', attempts: closure.attempts + 1, nextAttemptAt: null, lastError: null, closedAt: this.deps.clock.now(),
        });
        this.deps.intake.setStatus(signal.id, 'closed', null);
        return closed;
      });
    } else {
      next = this.#fail(closure.id, signal, answer.error ?? 'The runner could not close it.', closure.attempts + 1);
    }
    this.#invalidate();
    return this.#view(next, this.deps.intake.getSignal(signal.id) ?? signal);
  }

  #require(id: string): { closure: IntakeClosure; signal: IntakeSignal } {
    const closure = this.deps.intake.closures.get(asId<'ClosureId'>(id));
    const signal = closure === undefined ? undefined : this.deps.intake.getSignal(closure.signalId);
    if (closure === undefined || signal === undefined) throw TandemiseError.notFound('Closure', id);
    return { closure, signal };
  }

  #view(closure: IntakeClosure, signal: IntakeSignal): IntakeClosureView {
    const item = this.#itemOf(signal);
    const mission = item?.cached === undefined ? null : this.#missionOf(signal.workspaceId, item.cached);
    return {
      id: closure.id,
      fingerprint: signal.fingerprint,
      key: signal.key,
      url: signal.url,
      kind: closure.kind,
      state: closure.state,
      item: { key: item?.key ?? '', url: item?.url ?? '' },
      prUrl: mission === null ? null : deliveryLinks(this.deps.artifacts, mission.id).find((l) => l.kind === 'pr')?.url ?? null,
      reply: signal.reply === null ? null : { address: signal.reply.address },
      lastError: closure.lastError,
    };
  }

  #invalidate(): void {
    this.deps.projections?.invalidate('intake');
  }
}
