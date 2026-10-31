import type { ClosureId, IntakeLinkId, IntakeTokenId, SignalId, Timestamp, TrackerItemId, WebhookMessageId, WorkspaceId } from '@tandemise/shared';
import type {
  ClosureKind, IntakeAttachment, IntakeClosure, IntakeClosurePatch, IntakeConfig, IntakeLink, IntakeLinkedBy, IntakeSignal,
  IntakeSignalInput, IntakeSourcePatch, IntakeSourceState, IntakeTokenRow, SignalStatus, TrackerConfig, WebhookMessage,
} from '../entities/intake.js';
import type { TrackedItem, TrackerCommentMarker, TrackerCommentRow, TrackerItem } from '../entities/tracker.js';

/**
 * Where a project's intake configuration comes from (plan Task 1; spec §4.1,
 * §6.2). No service reads `settings.json` or a brain file directly: a local
 * implementation over the settings store ships now, and the brain (#51) plugs
 * in a read-only one later that parses `factory/tracker.yaml` and
 * `factory/intake.yaml` with the same schemas.
 */
export interface IntakeConfigSource {
  readonly origin: 'local' | 'brain';
  /**
   * Never throws. A project with nothing set reads as
   * `{ tracker: null, sources: [], dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } }`.
   */
  read(workspaceId: WorkspaceId): IntakeConfig;
  /** Local only: the brain is edited in its repository, not through the daemon. */
  write?(
    workspaceId: WorkspaceId,
    patch: { tracker?: TrackerConfig | null; intake?: Omit<IntakeConfig, 'tracker'> },
  ): IntakeConfig;
}

/**
 * Signals, their links, closures, sources and push tokens (plan Task 2).
 * Synchronous, like every repository port. Everything is keyed so a repeat or
 * a restart finds what is already there: signals by `(workspace, fingerprint)`,
 * links by signal, closures by `(signal, kind)`.
 */
export interface IntakeRepositoryPort {
  source(workspaceId: WorkspaceId, sourceId: string): IntakeSourceState | undefined;
  /** Creates the row on first save, which must name the `kind`. */
  saveSource(workspaceId: WorkspaceId, sourceId: string, patch: IntakeSourcePatch): IntakeSourceState;
  listSources(workspaceId: WorkspaceId): readonly IntakeSourceState[];
  /** Every enabled source, in any project. */
  listEnabledSources(): readonly IntakeSourceState[];

  /**
   * Records a signal in one transaction. A new fingerprint is a new `received`
   * row (`firstTime`). A repeat adds an occurrence, merges the impact
   * (`mergeImpact`), takes the latest text and keeps its status. A repeat of a
   * `rejected` signal that now parses enters the pipeline as new (`firstTime`).
   */
  upsertSignal(workspaceId: WorkspaceId, sourceId: string, signal: IntakeSignalInput, at: Timestamp): { signal: IntakeSignal; firstTime: boolean };
  /**
   * Records a signal that did not parse. A fingerprint already in the pipeline
   * is left as it is and returned: a bad repeat never undoes a good signal.
   */
  recordRejected(workspaceId: WorkspaceId, sourceId: string, fingerprint: string, title: string, reason: string): IntakeSignal;
  getSignal(id: SignalId): IntakeSignal | undefined;
  findSignal(workspaceId: WorkspaceId, fingerprint: string): IntakeSignal | undefined;
  /** Most recently seen first. */
  listSignals(workspaceId: WorkspaceId, filter?: { readonly statuses?: readonly SignalStatus[]; readonly limit?: number }): readonly IntakeSignal[];
  /** `extra` fields that are absent stay as they are; null clears them. */
  setStatus(id: SignalId, status: SignalStatus, reason: string | null, extra?: { readonly candidateRef?: string | null; readonly score?: number | null }): IntakeSignal;
  addAttachment(signalId: SignalId, attachment: Omit<IntakeAttachment, 'signalId'>): void;
  attachments(signalId: SignalId): readonly IntakeAttachment[];

  linkFor(signalId: SignalId): IntakeLink | undefined;
  /** Written before the tracker call. UNIQUE on the signal: a second one throws. The ref is null until a create returns. */
  createPendingLink(workspaceId: WorkspaceId, signalId: SignalId, itemRef: string | null, linkedBy: IntakeLinkedBy, score?: number | null): IntakeLink;
  completeLink(id: IntakeLinkId, itemRef: string): IntakeLink;
  /** Moves every link from a duplicate to the item it duplicates; returns how many moved. */
  repointLinks(workspaceId: WorkspaceId, fromRef: string, toRef: string): number;
  linksForItem(workspaceId: WorkspaceId, itemRef: string): readonly IntakeLink[];
  /** Links a crash left `pending`, in any project, oldest first. */
  pendingLinks(): readonly IntakeLink[];
  /** Links with `linked_by = 'created'` for signals of that source, written since `dayStartIso` (the daily cap). */
  createdToday(workspaceId: WorkspaceId, sourceId: string, dayStartIso: string): number;

  readonly closures: {
    /** Returns the existing closure for `(signal, kind)`, or a new `pending` one due now. */
    ensure(signalId: SignalId, kind: ClosureKind): IntakeClosure;
    /** Pending closures whose next attempt is at or before `nowIso`, oldest first. */
    due(nowIso: string): readonly IntakeClosure[];
    update(id: ClosureId, patch: IntakeClosurePatch): IntakeClosure;
    /** A source's closures in id order, after `afterId` when given. */
    listForSource(workspaceId: WorkspaceId, sourceId: string, afterId?: string): readonly IntakeClosure[];
  };

  readonly tokens: {
    create(workspaceId: WorkspaceId, sourceId: string, tokenHash: string, createdBy: string | null): IntakeTokenRow;
    /** Revoked tokens are returned too, with `revokedAt` set: the caller refuses them. */
    byHash(tokenHash: string): IntakeTokenRow | undefined;
    revoke(id: IntakeTokenId): void;
    list(workspaceId: WorkspaceId): readonly IntakeTokenRow[];
  };
}

/**
 * The board cache and the comments Tandemise keeps on each item (plan Task 2).
 * The tracker is the truth; this is what the last refresh saw, plus the state
 * Tandemise last wrote.
 */
export interface TrackerItemRepositoryPort {
  /** By `(workspace, ref)`: an existing item keeps its id and written state. */
  upsert(workspaceId: WorkspaceId, item: TrackerItem): TrackedItem;
  get(id: TrackerItemId): TrackedItem | undefined;
  byRef(workspaceId: WorkspaceId, ref: string): TrackedItem | undefined;
  byKey(workspaceId: WorkspaceId, key: string): TrackedItem | undefined;
  list(workspaceId: WorkspaceId): readonly TrackedItem[];
  setWrittenState(id: TrackerItemId, state: string | null): void;
  /** Forgets every cached item of the project not in `keepRefs`. A mission that pointed at one keeps running, unlinked. */
  removeMissing(workspaceId: WorkspaceId, keepRefs: readonly string[]): void;
  comment(workspaceId: WorkspaceId, ref: string, marker: TrackerCommentMarker): TrackerCommentRow | undefined;
  saveComment(workspaceId: WorkspaceId, ref: string, marker: TrackerCommentMarker, commentId: string, body: string): void;
  dropComment(workspaceId: WorkspaceId, ref: string, marker: TrackerCommentMarker): void;
}

/**
 * Webhook deliveries waiting to be read (plan Global Constraints). The opt-in
 * listener puts; the runners pull. Backed locally by `intake_webhook_inbox`;
 * the relay (#54) can supply its own later.
 */
export interface WebhookMailboxPort {
  put(msg: { readonly sourceId: string; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array }): WebhookMessageId;
  /** Claims up to `max` unclaimed messages, oldest first. */
  pull(max: number): readonly WebhookMessage[];
  /** Done: never pulled again. */
  ack(id: WebhookMessageId): void;
  /** Not done: pulled again by the next `pull`. A message already acked stays done. */
  release(id: WebhookMessageId): void;
}
