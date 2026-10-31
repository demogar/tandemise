import type {
  Closure, ClosureResult, IntakeClaimsPort, IntakeConfigSource, IntakeRepositoryPort, IntakeRunner, IntakeSourceConfig, IntakeSourcePatch, MemberRepositoryPort,
  RunnerContext, RunnerHandle, RunnerWebhookRequest, SecretStorePort, WebhookMailboxPort, WebhookMessage, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import type { BoardView, IngestResultView } from '@tandemise/api-contract';
import type { MailboxMessage } from '@tandemise/api-contract/relay';
import type { Clock, Logger, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, errorMessage } from '@tandemise/shared';
import { requireSeat, type Caller } from '../support/identity.js';
import type { IntakeScope } from '../services/intake-service.js';
import { assertOrigin, sourceCredential, sourceMovedSentence, sourceOrigin } from './credential-origin.js';

/**
 * The team's webhook mailbox (relay spec, "The webhook mailbox"; Ruling 24),
 * through the coordination service: leased per project key, acked by id.
 * Solo it is the local coordination mailbox, with the same pull and ack.
 */
export interface RelayMailbox {
  /** False when this build binds no coordination: nothing to pull. */
  available(): boolean;
  projectKey(workspaceId: WorkspaceId): string;
  pull(projectKey: string, max: number, leaseSeconds: number): Promise<readonly MailboxMessage[]>;
  ack(ids: readonly string[]): Promise<unknown>;
}

export interface IntakeRunnerHostDeps {
  /** The shipped runners (`INTAKE_RUNNERS`), read per pass so the application names none. */
  readonly runners: () => readonly IntakeRunner[];
  readonly config: IntakeConfigSource;
  /** `intake_sources`: enablement, cursor, last check, last error, secret refs. */
  readonly intake: IntakeRepositoryPort;
  /** The one pipeline every runner pushes into (spec §4). */
  readonly pipeline: {
    ingest(scope: IntakeScope, raw: unknown, options?: { readonly fromRunner?: boolean }): Promise<IngestResultView>;
    settle(): Promise<void>;
  };
  /** "Check sources now" answers the refreshed board (plan Task 8). */
  readonly board: { refreshBoard(workspaceId: WorkspaceId): Promise<BoardView> };
  /** May this daemon run a source now (spec §3)? Always yes without the relay. */
  readonly claims: Pick<IntakeClaimsPort, 'source'>;
  readonly mailbox: WebhookMailboxPort;
  /** The relay's mailbox (Ruling 24). Optional: without it only the local one is drained. */
  readonly relayMailbox?: RelayMailbox | null;
  readonly secrets: Pick<SecretStorePort, 'resolve'>;
  readonly workspaces: Pick<WorkspaceRepositoryPort, 'get' | 'list'>;
  readonly members: MemberRepositoryPort;
  readonly clock: Clock;
  readonly log: Logger;
}

/** Spec §2: a poll source with no `every` is read every 10 minutes. */
const DEFAULT_EVERY_MINUTES = 10;
/** Plan Task 10: the mailbox is drained 20 deliveries at a time. */
const MAILBOX_BATCH = 20;
/** A refused source claim is asked again no sooner than this, so a busy relay is not asked every tick. */
const CLAIM_RETRY_MS = 30_000;
/**
 * A delivery claimed this long ago and never acked is handed back (RULINGS
 * ruling 17): its consumer died between pull and ack, or its ack failed.
 */
const STALE_CLAIM_MS = 10 * 60_000;
/** Ruling 24: a done delivery stays a day (a relay redelivery is recognised meanwhile), then is pruned. */
const PRUNE_DONE_MS = 24 * 3_600_000;
/**
 * Ruling 24: how long a relay pull leases what it took. A delivery for a
 * source this daemon does not run is not acked and is free again for the
 * daemon that runs it after this.
 */
const RELAY_LEASE_SECONDS = 60;
/** What a webhook delivery for a source no runner reads says on that source (plan Task 10). */
export const NO_RUNNER_FOR_SOURCE = 'No runner for this source.';
/** Why a closure fails at once when its project no longer configures the source (plan Task 13). */
export const SOURCE_NOT_CONFIGURED = 'This project no longer reads this source.';

/** A runner started for one project's source. */
interface Running {
  readonly runner: IntakeRunner;
  readonly handle: RunnerHandle;
  readonly abort: AbortController;
  /** The source's configuration it was started with: a change restarts it. */
  readonly config: string;
}

const keyOf = (workspaceId: WorkspaceId, sourceId: string): string => `${workspaceId}\u0000${sourceId}`;

/**
 * A source with no `intake_sources` row yet runs on this machine when the
 * project's configuration is local, and not when it comes from the brain
 * (Ruling 22): the brain is shared, the credentials and the choice to run
 * a source are each person's.
 */
export function sourceOnByDefault(config: Pick<IntakeConfigSource, 'origin' | 'originFor'>, workspaceId: WorkspaceId): boolean {
  return (config.originFor?.(workspaceId) ?? config.origin) !== 'brain';
}

/**
 * Drives the shipped intake runners (spec §2, plan Task 10).
 *
 * The scheduler's tick calls `tick()`, which returns at once: due polls
 * (`every`, default 10 minutes, measured from `intake_sources.last_checked_at`)
 * and socket runners run in the background, so a slow source never delays
 * dispatch. Every start and poll asks `IntakeClaimsPort.source` first, and a
 * refused claim skips silently: another daemon runs that source (spec §3).
 * "Check sources now" (`checkNow`) runs every poll of the project once, due or
 * not, waits for them and for the pipeline, then refreshes the board.
 *
 * A source runs when its project has a tracker, it is configured, a runner of
 * its kind is shipped, and this machine has not switched it off (its
 * `intake_sources` row, when there is one, is enabled). Custom kinds have no
 * runner here; they push over HTTP or the CLI.
 *
 * Webhook deliveries in the mailbox go to their source's runner's
 * `fromWebhook`, then into the pipeline, then are acked. One the runner
 * throws on is acked too, with the runner's words on the source's
 * `last_error`, so a bad delivery is never read again.
 *
 * The relay's mailbox is drained the same way (Ruling 24): per project key,
 * a delivery to the endpoint named after a configured source id goes to that
 * source, only on the daemon holding the source's lease (Ruling 22). One for
 * an endpoint no source is named after, or for a source another daemon runs,
 * is left unacked: the relay leases it again, and parks it after ten leases
 * as "couldn't be processed" for Settings.
 */
export class IntakeRunnerHost {
  readonly name = 'intake-runners';
  readonly #running = new Map<string, Running>();
  /** Polls in flight per source, so a tick never starts a second one and `checkNow` waits for it. */
  readonly #polls = new Map<string, Promise<void>>();
  readonly #refusedAtMs = new Map<string, number>();
  /** When this host last got each source's lease, so a poll source's lease is renewed between polls (spec §3). */
  readonly #heldAtMs = new Map<string, number>();
  /** When each socket runner's claim was last asked. */
  readonly #keptAtMs = new Map<string, number>();
  /** Everything started in the background, for `settle()`. */
  readonly #background = new Set<Promise<unknown>>();
  #passing = false;
  #draining = false;
  /** Whether this host has drained the mailbox yet: the first drain frees every claim a crash left. */
  #drainedOnce = false;
  #stopped = false;

  constructor(private readonly deps: IntakeRunnerHostDeps) {}

  // ------------------------------------------------------------------ the tick

  /** Scheduler hook: starts what is due in the background and returns at once. */
  tick(): void {
    if (this.#stopped) return;
    if (!this.#passing) {
      this.#passing = true;
      this.#track(this.#pass().finally(() => { this.#passing = false; }));
    }
    if (!this.#draining) {
      this.#draining = true;
      this.#track(this.#drain().finally(() => { this.#draining = false; }));
    }
  }

  /** "Check sources now" (spec §2): every poll of the project once, waited for, then the refreshed board. */
  async checkNow(caller: Caller, workspaceId: WorkspaceId): Promise<BoardView> {
    if (this.deps.workspaces.get(workspaceId) === undefined) throw TandemiseError.notFound('Workspace', workspaceId);
    requireSeat(this.deps, workspaceId, caller);
    const config = this.deps.config.read(workspaceId);
    if (config.tracker !== null) {
      await Promise.all(this.#runnable(workspaceId, config.sources)
        .filter(({ runner }) => runner.mode === 'poll')
        .map(async ({ source, runner }) => {
          // One already running may have listed before what the person just filed.
          await this.#polls.get(keyOf(workspaceId, source.id));
          await this.#poll(workspaceId, source, runner, { force: true });
        }));
      await this.deps.pipeline.settle();
    }
    return this.deps.board.refreshBoard(workspaceId);
  }

  /**
   * Hands one closure to the runner of its source (plan Task 13), with the
   * source's context (its secrets), under the source's claim (spec §8: with
   * several daemons, the closure runs under the source's claim). Null when it
   * is not this daemon's to close now: no shipped runner closes that kind (a
   * custom source's closure waits on its feed), the source is switched off on
   * this machine, or another daemon holds its claim. A source the project no
   * longer configures fails without retry.
   */
  async close(workspaceId: WorkspaceId, sourceId: string, closure: Closure): Promise<ClosureResult | null> {
    const source = this.deps.config.read(workspaceId).sources.find((s) => s.id === sourceId);
    if (source === undefined) return { ok: false, error: SOURCE_NOT_CONFIGURED, retryable: false };
    const runner = this.deps.runners().find((r) => r.kind === source.kind);
    if (runner?.close === undefined) return null;
    if (!this.#on(workspaceId, source.id)) return null;
    // A moved address waits for its person, like a source switched off (Ruling 23).
    const moved = this.#originProblem(workspaceId, source);
    if (moved !== null) {
      this.#save(workspaceId, source, { lastError: moved });
      return null;
    }
    if (!(await this.#claimed(workspaceId, source.id))) return null;
    return runner.close(closure, this.#context(workspaceId, source, new AbortController().signal));
  }

  /** Resolves when everything started so far has finished (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.#background.size > 0) await Promise.allSettled([...this.#background]);
  }

  /** Shutdown: stops every runner and waits for what was running. */
  async stopAll(): Promise<void> {
    this.#stopped = true;
    const running = [...this.#running.keys()];
    await Promise.allSettled(running.map((key) => this.#stop(key)));
    await this.settle();
  }

  /** `LifecycleHost`'s shutdown hook. */
  async stop(): Promise<void> {
    await this.stopAll();
  }

  async #pass(): Promise<void> {
    try {
      const seen = new Set<string>();
      const nowMs = this.deps.clock.epochMs();
      for (const workspace of this.deps.workspaces.list()) {
        const config = this.deps.config.read(workspace.id);
        if (config.tracker === null) continue;
        for (const { source, runner } of this.#runnable(workspace.id, config.sources)) {
          const key = keyOf(workspace.id, source.id);
          seen.add(key);
          if (runner.mode === 'socket') {
            // Started and its claim asked recently: nothing to do this tick.
            const kept = this.#keptAtMs.get(key);
            const fresh = this.#running.get(key)?.config === JSON.stringify(source) && kept !== undefined && nowMs - kept < CLAIM_RETRY_MS;
            if (!fresh && !this.#polls.has(key)) {
              this.#keptAtMs.set(key, nowMs);
              const keeping = this.#keepStarted(workspace.id, source, runner).finally(() => { this.#polls.delete(key); });
              this.#polls.set(key, keeping);
              this.#track(keeping);
            }
          } else if (runner.mode === 'poll' && this.#due(workspace.id, source, nowMs)) {
            this.#track(this.#poll(workspace.id, source, runner, { force: false }));
          } else if (runner.mode === 'poll' && this.#renewDue(key, nowMs)) {
            // The lease's heartbeat between polls (spec §3): kept every 30 s while this daemon reads the source.
            this.#heldAtMs.set(key, nowMs);
            this.#track(this.#claimed(workspace.id, source.id));
          }
        }
      }
      // A source taken out of the configuration, switched off, or whose project lost its tracker stops.
      for (const key of [...this.#running.keys()]) if (!seen.has(key)) await this.#stop(key);
    } catch (e) {
      this.deps.log.warn('intake.runners_tick_failed', { error: errorMessage(e) });
    }
  }

  #due(workspaceId: WorkspaceId, source: IntakeSourceConfig, nowMs: number): boolean {
    const key = keyOf(workspaceId, source.id);
    if (this.#polls.has(key)) return false;
    const refused = this.#refusedAtMs.get(key);
    if (refused !== undefined && nowMs - refused < CLAIM_RETRY_MS) return false;
    const last = this.deps.intake.source(workspaceId, source.id)?.lastCheckedAt ?? null;
    if (last === null) return true;
    return nowMs - Date.parse(last) >= everyMinutes(source) * 60_000;
  }

  /** Whether this host holds a poll source's lease and its 30 s renewal is due. */
  #renewDue(key: string, nowMs: number): boolean {
    const held = this.#heldAtMs.get(key);
    return held !== undefined && !this.#polls.has(key) && nowMs - held >= CLAIM_RETRY_MS;
  }

  /** The project's configured sources a shipped runner reads, minus those off on this machine. */
  #runnable(workspaceId: WorkspaceId, sources: readonly IntakeSourceConfig[]): { source: IntakeSourceConfig; runner: IntakeRunner }[] {
    const runners = this.deps.runners();
    const out: { source: IntakeSourceConfig; runner: IntakeRunner }[] = [];
    for (const source of sources) {
      const runner = runners.find((r) => r.kind === source.kind);
      if (runner === undefined) continue;
      if (!this.#on(workspaceId, source.id)) continue;
      out.push({ source, runner });
    }
    return out;
  }

  /**
   * Whether the source runs on this machine (Ruling 22): its `intake_sources`
   * row says so once there is one; before that, a source of the project's own
   * local configuration is on, and one from the brain is off until this
   * machine's person switches it on, so a team's brain never makes every
   * teammate's daemon read every source with their credentials.
   */
  #on(workspaceId: WorkspaceId, sourceId: string): boolean {
    return this.deps.intake.source(workspaceId, sourceId)?.enabled ?? sourceOnByDefault(this.deps.config, workspaceId);
  }

  // ------------------------------------------------------------------ polls and sockets

  /** One poll, under the source's claim. Never rejects: the outcome is on the source's row. */
  #poll(workspaceId: WorkspaceId, source: IntakeSourceConfig, runner: IntakeRunner, options: { force: boolean }): Promise<void> {
    const key = keyOf(workspaceId, source.id);
    const inFlight = this.#polls.get(key);
    if (inFlight !== undefined && !options.force) return inFlight;
    const run = (async () => {
      if (!(await this.#claimed(workspaceId, source.id))) return;
      try {
        this.#assertOrigin(workspaceId, source);
        const running = this.#ensure(workspaceId, source, runner);
        await running.handle.poll?.();
        this.#save(workspaceId, source, { lastCheckedAt: this.deps.clock.now(), lastError: null });
      } catch (e) {
        this.#save(workspaceId, source, { lastCheckedAt: this.deps.clock.now(), lastError: errorMessage(e) });
        this.deps.log.warn('intake.poll_failed', { workspaceId, sourceId: source.id, error: errorMessage(e) });
      }
    })().catch((e: unknown) => {
      this.deps.log.warn('intake.poll_crashed', { workspaceId, sourceId: source.id, error: errorMessage(e) });
    }).finally(() => {
      if (this.#polls.get(key) === run) this.#polls.delete(key);
    });
    this.#polls.set(key, run);
    return run;
  }

  /** A socket runner stays started while this daemon holds its source's claim. */
  async #keepStarted(workspaceId: WorkspaceId, source: IntakeSourceConfig, runner: IntakeRunner): Promise<void> {
    const key = keyOf(workspaceId, source.id);
    try {
      if (!(await this.#claimed(workspaceId, source.id))) {
        if (this.#running.has(key)) await this.#stop(key);
        return;
      }
      this.#assertOrigin(workspaceId, source);
      const before = this.#running.get(key);
      const running = this.#ensure(workspaceId, source, runner);
      if (running !== before) this.#save(workspaceId, source, { lastCheckedAt: this.deps.clock.now(), lastError: null });
    } catch (e) {
      this.#save(workspaceId, source, { lastError: errorMessage(e) });
      this.deps.log.warn('intake.runner_start_failed', { workspaceId, sourceId: source.id, error: errorMessage(e) });
    }
  }

  async #claimed(workspaceId: WorkspaceId, sourceId: string): Promise<boolean> {
    const key = keyOf(workspaceId, sourceId);
    let ok = false;
    try {
      ok = await this.deps.claims.source(workspaceId, sourceId);
    } catch (e) {
      this.deps.log.warn('intake.source_claim_failed', { workspaceId, sourceId, error: errorMessage(e) });
    }
    if (ok) {
      this.#refusedAtMs.delete(key);
      this.#heldAtMs.set(key, this.deps.clock.epochMs());
    } else {
      this.#refusedAtMs.set(key, this.deps.clock.epochMs());
      this.#heldAtMs.delete(key);
    }
    return ok;
  }

  /** The runner started for the source with its current configuration, (re)starting it when needed. */
  #ensure(workspaceId: WorkspaceId, source: IntakeSourceConfig, runner: IntakeRunner): Running {
    const key = keyOf(workspaceId, source.id);
    const config = JSON.stringify(source);
    const current = this.#running.get(key);
    if (current !== undefined && current.runner === runner && current.config === config) return current;
    if (current !== undefined) this.#track(this.#stop(key));
    const abort = new AbortController();
    const handle = runner.start(this.#context(workspaceId, source, abort.signal));
    const running: Running = { runner, handle, abort, config };
    this.#running.set(key, running);
    return running;
  }

  async #stop(key: string): Promise<void> {
    const running = this.#running.get(key);
    if (running === undefined) return;
    this.#running.delete(key);
    running.abort.abort();
    try {
      await running.handle.stop();
    } catch (e) {
      this.deps.log.warn('intake.runner_stop_failed', { error: errorMessage(e) });
    }
  }

  #context(workspaceId: WorkspaceId, source: IntakeSourceConfig, signal: AbortSignal): RunnerContext {
    const scope: IntakeScope = { workspaceId, sourceId: source.id, tokenId: null };
    return {
      workspaceId,
      source,
      push: (s) => this.deps.pipeline.ingest(scope, s, { fromRunner: true }),
      clock: this.deps.clock,
      secrets: {
        // By name, through the source's refs: Settings → Intake saves them (plan Task 11).
        // Never to an address other than the one they were saved for (Ruling 23):
        // this context's source is the configuration the runner was started with.
        get: async (name) => {
          const ref = this.deps.intake.source(workspaceId, source.id)?.secretRefs[name];
          if (ref === undefined) return undefined;
          this.#assertOrigin(workspaceId, source);
          return this.deps.secrets.resolve(ref);
        },
      },
      log: this.deps.log.child({ workspaceId, sourceId: source.id }),
      signal,
      cursor: {
        get: () => this.deps.intake.source(workspaceId, source.id)?.cursor ?? null,
        set: (value) => { this.#save(workspaceId, source, { cursor: (value ?? null) as IntakeSourcePatch['cursor'] }); },
      },
    };
  }

  // ------------------------------------------------------------------ the mailbox

  async #drain(): Promise<void> {
    try {
      this.#releaseStale();
      this.#prune();
      const messages = this.deps.mailbox.pull(MAILBOX_BATCH);
      for (const message of messages) await this.#deliver(message);
    } catch (e) {
      this.deps.log.warn('intake.mailbox_drain_failed', { error: errorMessage(e) });
    }
    await this.#drainRelay();
  }

  /** Done deliveries older than a day go (Ruling 24): the table keeps only what is waiting and what was just read. */
  #prune(): void {
    const pruned = this.deps.mailbox.prune(new Date(this.deps.clock.epochMs() - PRUNE_DONE_MS).toISOString());
    if (pruned > 0) this.deps.log.info('intake.webhooks_pruned', { count: pruned });
  }

  /**
   * Hands back deliveries a crash left claimed (RULINGS ruling 17). The local
   * mailbox has one consumer, this host, and drains one batch at a time, so
   * at its first drain any claim is a previous process's: all are freed. After
   * that, only a claim older than ten minutes is (an ack that failed), so a
   * second consumer the relay (#54) adds is never raced for a live one.
   */
  #releaseStale(): void {
    const nowMs = this.deps.clock.epochMs();
    const before = this.#drainedOnce ? new Date(nowMs - STALE_CLAIM_MS).toISOString() : new Date(nowMs).toISOString();
    this.#drainedOnce = true;
    const freed = this.deps.mailbox.releaseStale(before);
    if (freed > 0) this.deps.log.info('intake.webhook_claims_released', { count: freed });
  }

  async #deliver(message: WebhookMessage): Promise<void> {
    const { workspaceId } = message;
    const source = this.#sourceIn(workspaceId, message.sourceId);
    if (source === null) {
      this.deps.mailbox.ack(message.id);
      this.deps.log.warn('intake.webhook_unknown_source', { workspaceId, sourceId: message.sourceId });
      return;
    }
    const runner = this.deps.runners().find((r) => r.kind === source.kind);
    if (runner?.fromWebhook === undefined) {
      this.deps.mailbox.ack(message.id);
      this.#save(workspaceId, source, { lastError: NO_RUNNER_FOR_SOURCE });
      return;
    }
    if (!this.#on(workspaceId, source.id)) {
      this.deps.mailbox.ack(message.id);
      this.deps.log.info('intake.webhook_source_off', { workspaceId, sourceId: source.id });
      return;
    }
    await this.#read(workspaceId, source, runner, { headers: message.headers, body: message.body, receivedAt: message.receivedAt });
    this.deps.mailbox.ack(message.id);
  }

  /**
   * One delivery through its source's runner and into the pipeline. Never
   * throws: a delivery the runner refuses would be refused again, so it is
   * done all the same, with the runner's words on the source's `last_error`.
   */
  async #read(workspaceId: WorkspaceId, source: IntakeSourceConfig, runner: IntakeRunner, req: RunnerWebhookRequest): Promise<void> {
    if (runner.fromWebhook === undefined) return;
    try {
      const ctx = this.#context(workspaceId, source, new AbortController().signal);
      const signals = await runner.fromWebhook(req, ctx);
      for (const signal of signals) await ctx.push(signal);
    } catch (e) {
      this.#save(workspaceId, source, { lastError: errorMessage(e) });
      this.deps.log.warn('intake.webhook_failed', { workspaceId, sourceId: source.id, error: errorMessage(e) });
    }
  }

  /**
   * The source a delivery is for: the listener's path names the project and
   * the source (`/hooks/:workspaceId/:sourceId`, Ruling 24). Null when that
   * project has no tracker, no longer exists, or configures no such source.
   */
  #sourceIn(workspaceId: WorkspaceId, sourceId: string): IntakeSourceConfig | null {
    if (this.deps.workspaces.get(workspaceId) === undefined) return null;
    const config = this.deps.config.read(workspaceId);
    if (config.tracker === null) return null;
    return config.sources.find((s) => s.id === sourceId) ?? null;
  }

  // ------------------------------------------------------------------ the relay's mailbox

  /**
   * Drains the team's mailbox (Ruling 24) for each project key this daemon
   * has a project with a tracker and sources in. Each pull leases up to a
   * batch; what is done here is acked in one call at the end.
   */
  async #drainRelay(): Promise<void> {
    const relay = this.deps.relayMailbox;
    if (relay === undefined || relay === null) return;
    try {
      if (!relay.available()) return;
      const projects = new Map<string, WorkspaceId[]>();
      for (const workspace of this.deps.workspaces.list()) {
        const config = this.deps.config.read(workspace.id);
        if (config.tracker === null || config.sources.length === 0) continue;
        const key = relay.projectKey(workspace.id);
        projects.set(key, [...(projects.get(key) ?? []), workspace.id]);
      }
      for (const [projectKey, workspaceIds] of projects) {
        const messages = await relay.pull(projectKey, MAILBOX_BATCH, RELAY_LEASE_SECONDS);
        if (messages.length === 0) continue;
        const leases = new Map<string, Promise<boolean>>();
        const done: string[] = [];
        for (const message of messages) {
          if (await this.#deliverRelayed(projectKey, workspaceIds, message, leases)) done.push(message.id);
        }
        if (done.length > 0) await relay.ack(done);
      }
    } catch (e) {
      // The relay unreachable, or an ack lost: what was leased comes back, and what was read is recognised (`handled`).
      this.deps.log.warn('intake.relay_mailbox_drain_failed', { error: errorMessage(e) });
    }
  }

  /**
   * One relay delivery. The endpoint named after a source id is that
   * source's (Ruling 24). True when it is done here and may be acked.
   */
  async #deliverRelayed(projectKey: string, workspaceIds: readonly WorkspaceId[], message: MailboxMessage, leases: Map<string, Promise<boolean>>): Promise<boolean> {
    const key = `relay:${projectKey}:${message.id}`;
    const name = message.endpointName;
    let target: { workspaceId: WorkspaceId; source: IntakeSourceConfig } | null = null;
    for (const workspaceId of workspaceIds) {
      const source = name === undefined ? null : this.#sourceIn(workspaceId, name);
      if (source !== null) { target = { workspaceId, source }; break; }
    }
    if (target === null) {
      // Left for the relay: leased again later, parked after ten leases, shown in Settings as "couldn't be processed".
      this.deps.log.warn('intake.relay_webhook_unknown_endpoint', {
        projectKey, endpointId: message.endpointId, endpointName: name ?? null, messageId: message.id, attempts: message.attempts,
      });
      return false;
    }
    const { workspaceId, source } = target;
    // Read here before and its ack lost: done, not read twice (relay spec, "Ack").
    if (this.deps.mailbox.handled(key)) return true;
    const runner = this.deps.runners().find((r) => r.kind === source.kind);
    if (runner?.fromWebhook === undefined) {
      this.#save(workspaceId, source, { lastError: NO_RUNNER_FOR_SOURCE });
      this.deps.mailbox.recordHandled({ key, workspaceId, sourceId: source.id });
      return true;
    }
    // Off on this machine, or another daemon holds the source's lease: a teammate's daemon reads it.
    if (!this.#on(workspaceId, source.id)) return false;
    const leaseKey = keyOf(workspaceId, source.id);
    let lease = leases.get(leaseKey);
    if (lease === undefined) {
      lease = this.#claimed(workspaceId, source.id);
      leases.set(leaseKey, lease);
    }
    if (!(await lease)) return false;
    await this.#read(workspaceId, source, runner, { headers: message.headers, body: Buffer.from(message.bodyBase64, 'base64'), receivedAt: message.receivedAt });
    this.deps.mailbox.recordHandled({ key, workspaceId, sourceId: source.id });
    return true;
  }

  // ------------------------------------------------------------------ support

  /**
   * Writes the source's running state. The row's first save records the
   * machine's default (Ruling 22): on for the project's local configuration,
   * off for a source from the brain until this machine switches it on.
   */
  #save(workspaceId: WorkspaceId, source: IntakeSourceConfig, patch: IntakeSourcePatch): void {
    try {
      const first = this.deps.intake.source(workspaceId, source.id) === undefined;
      this.deps.intake.saveSource(workspaceId, source.id, { ...(first ? { kind: source.kind, enabled: sourceOnByDefault(this.deps.config, workspaceId) } : {}), ...patch });
    } catch (e) {
      this.deps.log.warn('intake.source_save_failed', { workspaceId, sourceId: source.id, error: errorMessage(e) });
    }
  }

  /**
   * Refuses, in plain words, to start or run a source whose address moved
   * since its secrets were saved (Ruling 23). A source with no secrets sends
   * none, and secrets saved before Ruling 23 adopt the address of first use.
   */
  #assertOrigin(workspaceId: WorkspaceId, source: IntakeSourceConfig): void {
    const refs = this.deps.intake.source(workspaceId, source.id)?.secretRefs ?? {};
    if (Object.keys(refs).length === 0) return;
    assertOrigin(this.deps.intake.credentialOrigins, workspaceId, sourceCredential(source.id), sourceOrigin(source, this.deps.runners()), sourceMovedSentence);
  }

  #originProblem(workspaceId: WorkspaceId, source: IntakeSourceConfig): string | null {
    try {
      this.#assertOrigin(workspaceId, source);
      return null;
    } catch (e) {
      return errorMessage(e);
    }
  }

  #track(p: Promise<unknown>): void {
    const tracked = p.catch(() => {}).finally(() => { this.#background.delete(tracked); });
    this.#background.add(tracked);
  }
}

function everyMinutes(source: IntakeSourceConfig): number {
  const minutes = source.every === undefined ? DEFAULT_EVERY_MINUTES : Number.parseInt(source.every, 10);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_EVERY_MINUTES;
}
