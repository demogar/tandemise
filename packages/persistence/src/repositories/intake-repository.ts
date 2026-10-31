import {
  TandemiseError, asId, ids, type Clock, type ClosureId, type IntakeLinkId, type IntakeTokenId, type SignalId, type Timestamp,
  type WorkspaceId,
} from '@tandemise/shared';
import type {
  ClosureKind, ClosureState, Impact, IntakeAttachment, IntakeClosure, IntakeClosurePatch, IntakeLink, IntakeLinkedBy, IntakeLinkWritten,
  IntakeLinkStatus, IntakeReply, IntakeReporter, IntakeRepositoryPort, IntakeSignal, IntakeSignalInput, IntakeSourcePatch,
  IntakeSourceState, IntakeTokenRow, KindHint, SignalStatus,
} from '@tandemise/domain';
import { fingerprintOf, mergeImpact } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, parseJsonOrNull, toJson, toJsonOrNull } from '../json.js';
import { applyPatch } from '../patch.js';

interface SourceRow {
  workspace_id: string;
  source_id: string;
  kind: string;
  enabled: number;
  enabled_by: string | null;
  cursor: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  secret_refs: string;
  created_at: string;
  updated_at: string;
}

interface SignalRow {
  id: string;
  workspace_id: string;
  source_id: string;
  fingerprint: string;
  kind: string;
  instance: string;
  key: string;
  url: string;
  title: string;
  description: string;
  reporter: string | null;
  impact: string | null;
  labels: string;
  reply: string | null;
  kind_hint: string | null;
  occurrences: number;
  first_seen_at: string;
  last_seen_at: string;
  status: string;
  reason: string | null;
  candidate_ref: string | null;
  score: number | null;
  created_at: string;
  updated_at: string;
}

interface AttachmentRow {
  signal_id: string;
  name: string;
  media_type: string;
  blob_sha256: string | null;
  url: string | null;
}

interface LinkRow {
  id: string;
  workspace_id: string;
  signal_id: string;
  item_ref: string | null;
  status: string;
  linked_by: string;
  score: number | null;
  written: string | null;
  created_at: string;
  updated_at: string;
}

interface ClosureRow {
  id: string;
  signal_id: string;
  kind: string;
  state: string;
  attempts: number;
  next_attempt_at: string | null;
  external_id: string | null;
  last_error: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TokenRow {
  id: string;
  workspace_id: string;
  source_id: string;
  token_hash: string;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
}

const SOURCE_COLUMNS = `workspace_id, source_id, kind, enabled, enabled_by, cursor, last_checked_at, last_error, secret_refs,
  created_at, updated_at`;
const SIGNAL_COLUMNS = `id, workspace_id, source_id, fingerprint, kind, instance, key, url, title, description, reporter, impact,
  labels, reply, kind_hint, occurrences, first_seen_at, last_seen_at, status, reason, candidate_ref, score, created_at, updated_at`;
const LINK_COLUMNS = 'id, workspace_id, signal_id, item_ref, status, linked_by, score, written, created_at, updated_at';
const CLOSURE_COLUMNS = `id, signal_id, kind, state, attempts, next_attempt_at, external_id, last_error, closed_at, created_at,
  updated_at`;
const TOKEN_COLUMNS = 'id, workspace_id, source_id, token_hash, created_by, created_at, revoked_at';

function sourceFromRow(r: SourceRow): IntakeSourceState {
  return {
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    sourceId: r.source_id,
    kind: r.kind,
    enabled: r.enabled === 1,
    enabledBy: r.enabled_by,
    cursor: parseJsonOrNull<Readonly<Record<string, unknown>>>(r.cursor),
    lastCheckedAt: r.last_checked_at,
    lastError: r.last_error,
    secretRefs: parseJson<Readonly<Record<string, string>>>(r.secret_refs, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function sourceToRow(s: IntakeSourceState): SourceRow {
  return {
    workspace_id: s.workspaceId,
    source_id: s.sourceId,
    kind: s.kind,
    enabled: s.enabled ? 1 : 0,
    enabled_by: s.enabledBy,
    cursor: toJsonOrNull(s.cursor),
    last_checked_at: s.lastCheckedAt,
    last_error: s.lastError,
    secret_refs: toJson(s.secretRefs),
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

function signalFromRow(r: SignalRow): IntakeSignal {
  return {
    id: asId<'SignalId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    sourceId: r.source_id,
    fingerprint: r.fingerprint,
    kind: r.kind,
    instance: r.instance,
    key: r.key,
    url: r.url,
    title: r.title,
    description: r.description,
    reporter: parseJsonOrNull<IntakeReporter>(r.reporter),
    impact: parseJsonOrNull<Impact>(r.impact),
    labels: parseJson<readonly string[]>(r.labels, []),
    reply: parseJsonOrNull<IntakeReply>(r.reply),
    kindHint: r.kind_hint as KindHint | null,
    occurrences: r.occurrences,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    status: r.status as SignalStatus,
    reason: r.reason,
    candidateRef: r.candidate_ref,
    score: r.score,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function signalToRow(s: IntakeSignal): SignalRow {
  return {
    id: s.id,
    workspace_id: s.workspaceId,
    source_id: s.sourceId,
    fingerprint: s.fingerprint,
    kind: s.kind,
    instance: s.instance,
    key: s.key,
    url: s.url,
    title: s.title,
    description: s.description,
    reporter: toJsonOrNull(s.reporter),
    impact: toJsonOrNull(s.impact),
    labels: toJson(s.labels),
    reply: toJsonOrNull(s.reply),
    kind_hint: s.kindHint,
    occurrences: s.occurrences,
    first_seen_at: s.firstSeenAt,
    last_seen_at: s.lastSeenAt,
    status: s.status,
    reason: s.reason,
    candidate_ref: s.candidateRef,
    score: s.score,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

function linkFromRow(r: LinkRow): IntakeLink {
  return {
    id: asId<'IntakeLinkId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    signalId: asId<'SignalId'>(r.signal_id),
    itemRef: r.item_ref,
    status: r.status as IntakeLinkStatus,
    linkedBy: r.linked_by as IntakeLinkedBy,
    score: r.score,
    written: parseJsonOrNull<IntakeLinkWritten>(r.written),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function closureFromRow(r: ClosureRow): IntakeClosure {
  return {
    id: asId<'ClosureId'>(r.id),
    signalId: asId<'SignalId'>(r.signal_id),
    kind: r.kind as ClosureKind,
    state: r.state as ClosureState,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    externalId: r.external_id,
    lastError: r.last_error,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function closureToRow(c: IntakeClosure): ClosureRow {
  return {
    id: c.id,
    signal_id: c.signalId,
    kind: c.kind,
    state: c.state,
    attempts: c.attempts,
    next_attempt_at: c.nextAttemptAt,
    external_id: c.externalId,
    last_error: c.lastError,
    closed_at: c.closedAt,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

function tokenFromRow(r: TokenRow): IntakeTokenRow {
  return {
    id: asId<'IntakeTokenId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    sourceId: r.source_id,
    tokenHash: r.token_hash,
    createdBy: r.created_by,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  };
}

/** The leading `<kind>:` of a fingerprint, when it is a valid source kind (it cannot contain a colon). */
function kindOfFingerprint(fingerprint: string): string {
  const head = fingerprint.split(':', 1)[0] ?? '';
  return /^[a-z][a-z0-9-]{1,31}$/.test(head) && head.length < fingerprint.length ? head : '';
}

/** Intake (plan Task 2): signals, links, closures, sources and push tokens. */
export class SqliteIntakeRepository implements IntakeRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #clock: Clock;
  readonly #selectSource;
  readonly #selectSources;
  readonly #selectEnabledSources;
  readonly #upsertSource;
  readonly #selectSignal;
  readonly #findSignal;
  readonly #selectSignals;
  readonly #insertSignal;
  readonly #updateSignal;
  readonly #insertAttachment;
  readonly #selectAttachments;
  readonly #selectLink;
  readonly #selectLinkForSignal;
  readonly #insertLink;
  readonly #completeLink;
  readonly #setLinkWritten;
  readonly #repointLinks;
  readonly #linksForItem;
  readonly #pendingLinks;
  readonly #createdToday;
  readonly #selectClosure;
  readonly #findClosure;
  readonly #insertClosure;
  readonly #updateClosure;
  readonly #dueClosures;
  readonly #closuresForSource;
  readonly #insertToken;
  readonly #tokenByHash;
  readonly #tokenById;
  readonly #revokeToken;
  readonly #tokensFor;

  readonly closures: IntakeRepositoryPort['closures'];
  readonly tokens: IntakeRepositoryPort['tokens'];

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    const h = db.handle;

    this.#selectSource = h.prepare<{ ws: string; id: string }, SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM intake_sources WHERE workspace_id = :ws AND source_id = :id`,
    );
    this.#selectSources = h.prepare<{ ws: string }, SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM intake_sources WHERE workspace_id = :ws ORDER BY created_at, source_id`,
    );
    this.#selectEnabledSources = h.prepare<[], SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM intake_sources WHERE enabled = 1 ORDER BY created_at, workspace_id, source_id`,
    );
    this.#upsertSource = h.prepare<SourceRow>(
      `INSERT INTO intake_sources (${SOURCE_COLUMNS}) VALUES (:workspace_id, :source_id, :kind, :enabled, :enabled_by, :cursor,
         :last_checked_at, :last_error, :secret_refs, :created_at, :updated_at)
       ON CONFLICT (workspace_id, source_id) DO UPDATE SET kind = excluded.kind, enabled = excluded.enabled,
         enabled_by = excluded.enabled_by, cursor = excluded.cursor, last_checked_at = excluded.last_checked_at,
         last_error = excluded.last_error, secret_refs = excluded.secret_refs, updated_at = excluded.updated_at`,
    );

    this.#selectSignal = h.prepare<{ id: string }, SignalRow>(`SELECT ${SIGNAL_COLUMNS} FROM intake_signals WHERE id = :id`);
    this.#findSignal = h.prepare<{ ws: string; fp: string }, SignalRow>(
      `SELECT ${SIGNAL_COLUMNS} FROM intake_signals WHERE workspace_id = :ws AND fingerprint = :fp`,
    );
    // One statement for every filter: a NULL parameter disables its clause and
    // the status set arrives as a JSON array (as the mission list does).
    this.#selectSignals = h.prepare<{ ws: string; statuses: string | null; limit: number | null }, SignalRow>(
      `SELECT ${SIGNAL_COLUMNS} FROM intake_signals
       WHERE workspace_id = :ws AND (:statuses IS NULL OR status IN (SELECT value FROM json_each(:statuses)))
       ORDER BY last_seen_at DESC, id DESC
       LIMIT COALESCE(:limit, -1)`,
    );
    this.#insertSignal = h.prepare<SignalRow>(
      `INSERT INTO intake_signals (${SIGNAL_COLUMNS}) VALUES (:id, :workspace_id, :source_id, :fingerprint, :kind, :instance, :key,
         :url, :title, :description, :reporter, :impact, :labels, :reply, :kind_hint, :occurrences, :first_seen_at, :last_seen_at,
         :status, :reason, :candidate_ref, :score, :created_at, :updated_at)`,
    );
    this.#updateSignal = h.prepare<SignalRow>(
      `UPDATE intake_signals SET source_id = :source_id, kind = :kind, instance = :instance, key = :key, url = :url,
         title = :title, description = :description, reporter = :reporter, impact = :impact, labels = :labels, reply = :reply,
         kind_hint = :kind_hint, occurrences = :occurrences, first_seen_at = :first_seen_at, last_seen_at = :last_seen_at,
         status = :status, reason = :reason, candidate_ref = :candidate_ref, score = :score, updated_at = :updated_at
       WHERE id = :id`,
    );

    this.#insertAttachment = h.prepare<AttachmentRow & { now: string }>(
      `INSERT INTO intake_attachments (signal_id, name, media_type, blob_sha256, url, created_at, updated_at)
       VALUES (:signal_id, :name, :media_type, :blob_sha256, :url, :now, :now)`,
    );
    this.#selectAttachments = h.prepare<{ id: string }, AttachmentRow>(
      'SELECT signal_id, name, media_type, blob_sha256, url FROM intake_attachments WHERE signal_id = :id ORDER BY rowid',
    );

    this.#selectLink = h.prepare<{ id: string }, LinkRow>(`SELECT ${LINK_COLUMNS} FROM intake_links WHERE id = :id`);
    this.#selectLinkForSignal = h.prepare<{ id: string }, LinkRow>(`SELECT ${LINK_COLUMNS} FROM intake_links WHERE signal_id = :id`);
    this.#insertLink = h.prepare<LinkRow>(
      `INSERT INTO intake_links (${LINK_COLUMNS}) VALUES (:id, :workspace_id, :signal_id, :item_ref, :status, :linked_by, :score,
         :written, :created_at, :updated_at)`,
    );
    this.#completeLink = h.prepare<{ id: string; ref: string; now: string }>(
      "UPDATE intake_links SET item_ref = :ref, status = 'done', updated_at = :now WHERE id = :id",
    );
    this.#setLinkWritten = h.prepare<{ id: string; written: string | null; now: string }>(
      'UPDATE intake_links SET written = :written, updated_at = :now WHERE id = :id',
    );
    this.#repointLinks = h.prepare<{ ws: string; from: string; to: string; now: string }>(
      'UPDATE intake_links SET item_ref = :to, updated_at = :now WHERE workspace_id = :ws AND item_ref = :from',
    );
    this.#linksForItem = h.prepare<{ ws: string; ref: string }, LinkRow>(
      `SELECT ${LINK_COLUMNS} FROM intake_links WHERE workspace_id = :ws AND item_ref = :ref ORDER BY created_at, id`,
    );
    this.#pendingLinks = h.prepare<[], LinkRow>(
      `SELECT ${LINK_COLUMNS} FROM intake_links WHERE status = 'pending' ORDER BY created_at, id`,
    );
    // A pending create counts too: it is about to be an item, and the cap must
    // hold across a crash between the link and the tracker call.
    this.#createdToday = h.prepare<{ ws: string; source: string; since: string }, { n: number }>(
      `SELECT COUNT(*) AS n FROM intake_links l JOIN intake_signals s ON s.id = l.signal_id
       WHERE l.workspace_id = :ws AND s.source_id = :source AND l.linked_by = 'created' AND l.created_at >= :since`,
    );

    this.#selectClosure = h.prepare<{ id: string }, ClosureRow>(`SELECT ${CLOSURE_COLUMNS} FROM intake_closures WHERE id = :id`);
    this.#findClosure = h.prepare<{ signal: string; kind: string }, ClosureRow>(
      `SELECT ${CLOSURE_COLUMNS} FROM intake_closures WHERE signal_id = :signal AND kind = :kind`,
    );
    this.#insertClosure = h.prepare<ClosureRow>(
      `INSERT INTO intake_closures (${CLOSURE_COLUMNS}) VALUES (:id, :signal_id, :kind, :state, :attempts, :next_attempt_at,
         :external_id, :last_error, :closed_at, :created_at, :updated_at)
       ON CONFLICT (signal_id, kind) DO NOTHING`,
    );
    this.#updateClosure = h.prepare<ClosureRow>(
      `UPDATE intake_closures SET state = :state, attempts = :attempts, next_attempt_at = :next_attempt_at,
         external_id = :external_id, last_error = :last_error, closed_at = :closed_at, updated_at = :updated_at
       WHERE id = :id`,
    );
    this.#dueClosures = h.prepare<{ now: string }, ClosureRow>(
      `SELECT ${CLOSURE_COLUMNS} FROM intake_closures
       WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= :now)
       ORDER BY next_attempt_at, id`,
    );
    this.#closuresForSource = h.prepare<{ ws: string; source: string; after: string | null }, ClosureRow>(
      `SELECT ${CLOSURE_COLUMNS.split(',').map((c) => `c.${c.trim()}`).join(', ')}
       FROM intake_closures c JOIN intake_signals s ON s.id = c.signal_id
       WHERE s.workspace_id = :ws AND s.source_id = :source AND (:after IS NULL OR c.id > :after)
       ORDER BY c.id`,
    );

    this.#insertToken = h.prepare<TokenRow>(
      `INSERT INTO intake_tokens (${TOKEN_COLUMNS}) VALUES (:id, :workspace_id, :source_id, :token_hash, :created_by, :created_at,
         :revoked_at)`,
    );
    this.#tokenByHash = h.prepare<{ hash: string }, TokenRow>(`SELECT ${TOKEN_COLUMNS} FROM intake_tokens WHERE token_hash = :hash`);
    this.#tokenById = h.prepare<{ id: string }, TokenRow>(`SELECT ${TOKEN_COLUMNS} FROM intake_tokens WHERE id = :id`);
    this.#revokeToken = h.prepare<{ id: string; now: string }>(
      'UPDATE intake_tokens SET revoked_at = :now WHERE id = :id AND revoked_at IS NULL',
    );
    this.#tokensFor = h.prepare<{ ws: string }, TokenRow>(
      `SELECT ${TOKEN_COLUMNS} FROM intake_tokens WHERE workspace_id = :ws ORDER BY created_at, id`,
    );

    this.closures = {
      ensure: (signalId, kind) => this.#ensureClosure(signalId, kind),
      get: (id) => {
        const row = this.#selectClosure.get({ id });
        return row === undefined ? undefined : closureFromRow(row);
      },
      due: (nowIso) => this.#dueClosures.all({ now: nowIso }).map(closureFromRow),
      update: (id, patch) => this.#updateClosureBy(id, patch),
      listForSource: (ws, sourceId, afterId) =>
        this.#closuresForSource.all({ ws, source: sourceId, after: afterId ?? null }).map(closureFromRow),
    };
    this.tokens = {
      create: (ws, sourceId, tokenHash, createdBy) => {
        const row: TokenRow = {
          id: ids.intakeToken(), workspace_id: ws, source_id: sourceId, token_hash: tokenHash, created_by: createdBy,
          created_at: this.#clock.now(), revoked_at: null,
        };
        this.#insertToken.run(row);
        return tokenFromRow(row);
      },
      byHash: (tokenHash) => {
        const row = this.#tokenByHash.get({ hash: tokenHash });
        return row === undefined ? undefined : tokenFromRow(row);
      },
      revoke: (id: IntakeTokenId) => {
        if (this.#tokenById.get({ id }) === undefined) throw TandemiseError.notFound('Intake token', id);
        this.#revokeToken.run({ id, now: this.#clock.now() });
      },
      list: (ws) => this.#tokensFor.all({ ws }).map(tokenFromRow),
    };
  }

  // ---------------------------------------------------------------- sources

  source(workspaceId: WorkspaceId, sourceId: string): IntakeSourceState | undefined {
    const row = this.#selectSource.get({ ws: workspaceId, id: sourceId });
    return row === undefined ? undefined : sourceFromRow(row);
  }

  saveSource(workspaceId: WorkspaceId, sourceId: string, patch: IntakeSourcePatch): IntakeSourceState {
    return this.#db.transaction(() => {
      const now = this.#clock.now();
      let current = this.source(workspaceId, sourceId);
      if (current === undefined) {
        if (patch.kind === undefined) {
          throw new TandemiseError('INTERNAL', `Intake source ${sourceId} was saved for the first time without its kind`);
        }
        current = {
          workspaceId, sourceId, kind: patch.kind, enabled: false, enabledBy: null, cursor: null, lastCheckedAt: null,
          lastError: null, secretRefs: {}, createdAt: now, updatedAt: now,
        };
      }
      const next: IntakeSourceState = { ...applyPatch(current, patch), updatedAt: now };
      this.#upsertSource.run(sourceToRow(next));
      return next;
    });
  }

  listSources(workspaceId: WorkspaceId): readonly IntakeSourceState[] {
    return this.#selectSources.all({ ws: workspaceId }).map(sourceFromRow);
  }

  listEnabledSources(): readonly IntakeSourceState[] {
    return this.#selectEnabledSources.all().map(sourceFromRow);
  }

  // ---------------------------------------------------------------- signals

  upsertSignal(
    workspaceId: WorkspaceId, sourceId: string, signal: IntakeSignalInput, at: Timestamp,
  ): { signal: IntakeSignal; firstTime: boolean } {
    return this.#db.transaction(() => {
      const now = this.#clock.now();
      const fingerprint = fingerprintOf(signal);
      const text = {
        sourceId,
        kind: signal.source.kind,
        instance: signal.source.instance,
        key: signal.key,
        url: signal.url,
        title: signal.title,
        description: signal.description ?? '',
        reporter: signal.reporter ?? null,
        labels: signal.labels ?? [],
        reply: signal.reply ?? null,
        kindHint: signal.kindHint ?? null,
      };
      const found = this.#findSignal.get({ ws: workspaceId, fp: fingerprint });
      if (found === undefined) {
        const created: IntakeSignal = {
          ...text, id: ids.signal(), workspaceId, fingerprint, impact: signal.impact ?? null, occurrences: 1,
          firstSeenAt: at, lastSeenAt: at, status: 'received', reason: null, candidateRef: null, score: null,
          createdAt: now, updatedAt: now,
        };
        this.#insertSignal.run(signalToRow(created));
        return { signal: created, firstTime: true };
      }
      const current = signalFromRow(found);
      // A signal that never parsed before never entered the pipeline: now that
      // it does, it starts there as new, with its counts and sightings kept.
      const wasRejected = current.status === 'rejected';
      const next: IntakeSignal = {
        ...current,
        ...text,
        impact: mergeImpact(current.impact, signal.impact ?? null),
        occurrences: current.occurrences + 1,
        firstSeenAt: at < current.firstSeenAt ? at : current.firstSeenAt,
        lastSeenAt: at > current.lastSeenAt ? at : current.lastSeenAt,
        ...(wasRejected ? { status: 'received' as const, reason: null, candidateRef: null, score: null } : {}),
        updatedAt: now,
      };
      this.#updateSignal.run(signalToRow(next));
      return { signal: next, firstTime: wasRejected };
    });
  }

  recordRejected(workspaceId: WorkspaceId, sourceId: string, fingerprint: string, title: string, reason: string): IntakeSignal {
    return this.#db.transaction(() => {
      const now = this.#clock.now();
      const found = this.#findSignal.get({ ws: workspaceId, fp: fingerprint });
      if (found !== undefined) {
        const current = signalFromRow(found);
        // A bad repeat never undoes a good signal (RULINGS.md Ruling 6).
        if (current.status !== 'rejected') return current;
        const next: IntakeSignal = {
          ...current, sourceId, title, reason, occurrences: current.occurrences + 1, lastSeenAt: now, updatedAt: now,
        };
        this.#updateSignal.run(signalToRow(next));
        return next;
      }
      const created: IntakeSignal = {
        id: ids.signal(), workspaceId, sourceId, fingerprint, kind: kindOfFingerprint(fingerprint), instance: '', key: '', url: '',
        title, description: '', reporter: null, impact: null, labels: [], reply: null, kindHint: null, occurrences: 1,
        firstSeenAt: now, lastSeenAt: now, status: 'rejected', reason, candidateRef: null, score: null, createdAt: now, updatedAt: now,
      };
      this.#insertSignal.run(signalToRow(created));
      return created;
    });
  }

  getSignal(id: SignalId): IntakeSignal | undefined {
    const row = this.#selectSignal.get({ id });
    return row === undefined ? undefined : signalFromRow(row);
  }

  findSignal(workspaceId: WorkspaceId, fingerprint: string): IntakeSignal | undefined {
    const row = this.#findSignal.get({ ws: workspaceId, fp: fingerprint });
    return row === undefined ? undefined : signalFromRow(row);
  }

  listSignals(
    workspaceId: WorkspaceId, filter?: { readonly statuses?: readonly SignalStatus[]; readonly limit?: number },
  ): readonly IntakeSignal[] {
    return this.#selectSignals
      .all({
        ws: workspaceId,
        statuses: filter?.statuses === undefined ? null : toJson(filter.statuses),
        limit: filter?.limit ?? null,
      })
      .map(signalFromRow);
  }

  setStatus(
    id: SignalId, status: SignalStatus, reason: string | null,
    extra?: { readonly candidateRef?: string | null; readonly score?: number | null },
  ): IntakeSignal {
    return this.#db.transaction(() => {
      const current = this.getSignal(id);
      if (current === undefined) throw TandemiseError.notFound('Signal', id);
      const next: IntakeSignal = {
        ...current,
        status,
        reason,
        candidateRef: extra?.candidateRef === undefined ? current.candidateRef : extra.candidateRef,
        score: extra?.score === undefined ? current.score : extra.score,
        updatedAt: this.#clock.now(),
      };
      this.#updateSignal.run(signalToRow(next));
      return next;
    });
  }

  addAttachment(signalId: SignalId, a: Omit<IntakeAttachment, 'signalId'>): void {
    this.#insertAttachment.run({
      signal_id: signalId, name: a.name, media_type: a.mediaType, blob_sha256: a.blobSha256, url: a.url, now: this.#clock.now(),
    });
  }

  attachments(signalId: SignalId): readonly IntakeAttachment[] {
    return this.#selectAttachments.all({ id: signalId }).map((r) => ({
      signalId: asId<'SignalId'>(r.signal_id), name: r.name, mediaType: r.media_type, blobSha256: r.blob_sha256, url: r.url,
    }));
  }

  // ---------------------------------------------------------------- links

  linkFor(signalId: SignalId): IntakeLink | undefined {
    const row = this.#selectLinkForSignal.get({ id: signalId });
    return row === undefined ? undefined : linkFromRow(row);
  }

  createPendingLink(
    workspaceId: WorkspaceId, signalId: SignalId, itemRef: string | null, linkedBy: IntakeLinkedBy, score?: number | null,
  ): IntakeLink {
    const now = this.#clock.now();
    const row: LinkRow = {
      id: ids.intakeLink(), workspace_id: workspaceId, signal_id: signalId, item_ref: itemRef, status: 'pending',
      linked_by: linkedBy, score: score ?? null, written: null, created_at: now, updated_at: now,
    };
    this.#insertLink.run(row);
    return linkFromRow(row);
  }

  completeLink(id: IntakeLinkId, itemRef: string): IntakeLink {
    return this.#db.transaction(() => {
      this.#completeLink.run({ id, ref: itemRef, now: this.#clock.now() });
      const row = this.#selectLink.get({ id });
      if (row === undefined) throw TandemiseError.notFound('Intake link', id);
      return linkFromRow(row);
    });
  }

  setLinkWritten(id: IntakeLinkId, written: IntakeLinkWritten | null): void {
    this.#setLinkWritten.run({ id, written: toJsonOrNull(written), now: this.#clock.now() });
  }

  repointLinks(workspaceId: WorkspaceId, fromRef: string, toRef: string): number {
    return this.#repointLinks.run({ ws: workspaceId, from: fromRef, to: toRef, now: this.#clock.now() }).changes;
  }

  linksForItem(workspaceId: WorkspaceId, itemRef: string): readonly IntakeLink[] {
    return this.#linksForItem.all({ ws: workspaceId, ref: itemRef }).map(linkFromRow);
  }

  pendingLinks(): readonly IntakeLink[] {
    return this.#pendingLinks.all().map(linkFromRow);
  }

  createdToday(workspaceId: WorkspaceId, sourceId: string, dayStartIso: string): number {
    return this.#createdToday.get({ ws: workspaceId, source: sourceId, since: dayStartIso })?.n ?? 0;
  }

  // ---------------------------------------------------------------- closures

  #ensureClosure(signalId: SignalId, kind: ClosureKind): IntakeClosure {
    return this.#db.transaction(() => {
      const now = this.#clock.now();
      this.#insertClosure.run({
        id: ids.closure(), signal_id: signalId, kind, state: 'pending', attempts: 0, next_attempt_at: now, external_id: null,
        last_error: null, closed_at: null, created_at: now, updated_at: now,
      });
      const row = this.#findClosure.get({ signal: signalId, kind });
      if (row === undefined) throw new TandemiseError('INTERNAL', `Closure ${kind} was not stored for ${signalId}`);
      return closureFromRow(row);
    });
  }

  #updateClosureBy(id: ClosureId, patch: IntakeClosurePatch): IntakeClosure {
    return this.#db.transaction(() => {
      const row = this.#selectClosure.get({ id });
      if (row === undefined) throw TandemiseError.notFound('Closure', id);
      // `applyPatch` skips only undefined, so an explicit null clears a field.
      const next: IntakeClosure = { ...applyPatch(closureFromRow(row), patch), updatedAt: this.#clock.now() };
      this.#updateClosure.run(closureToRow(next));
      return next;
    });
  }
}
