import { createHash, randomBytes } from 'node:crypto';
import type {
  EvalBlobPort, IntakeAttachment, IntakeConfigSource, IntakeRepositoryPort, IntakeSignal, IntakeSourceConfig, MemberRepositoryPort,
  SignalStatus, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { sourceLabel } from '@tandemise/domain';
import {
  formatIntakeIssues, intakePushBody, pushedSignals, updateIntakeConfigRequest, validateIntakeSignal,
  type IngestResultView, type IntakeConfigView, type IntakeSignalV1, type IntakeSignalView, type IntakeTokenMintedView,
} from '@tandemise/api-contract';
import type { Clock, IntakeTokenId, Logger, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId } from '@tandemise/shared';
import { requireSeat, type Caller } from '../support/identity.js';
import { SlidingWindowLimit } from '../intake/rate-limit.js';

/**
 * Who a push is for: one project and one of its sources. From an intake token
 * the scope is the token's; from the daemon token it is named by the caller
 * (spec §2 "Auth").
 */
export interface IntakeScope {
  readonly workspaceId: WorkspaceId;
  readonly sourceId: string;
  /** Null when the push came with the daemon token (the desktop, the CLI). */
  readonly tokenId: IntakeTokenId | null;
}

export interface IntakeDeps {
  readonly intake: IntakeRepositoryPort;
  readonly config: IntakeConfigSource;
  /** Inline attachments, content-addressed (spec §1 "Attachments"). */
  readonly blobs: EvalBlobPort;
  readonly workspaces: Pick<WorkspaceRepositoryPort, 'get'>;
  readonly members: MemberRepositoryPort;
  readonly clock: Clock;
  readonly log: Logger;
}

/** Spec §2: each token, 60 signals a minute by default. */
export const INTAKE_SIGNALS_PER_MINUTE = 60;
/** What an intake token starts with, so a stray one is recognisable in a log or a shell history. */
export const INTAKE_TOKEN_PREFIX = 'tdi_';
const UNREADABLE_TITLE = '(unreadable signal)';

/**
 * The intake pipeline (spec §4), one service for every runner.
 *
 * Plan Task 3 implements its first two steps: validate against
 * `tandemise.intake/v1` and record. Everything that enters is recorded, a
 * rejected signal included, with the reason the push is answered with. Later
 * tasks add the noise filter, dedupe and the tracker; until then a valid
 * signal stays `received`.
 *
 * Signal text is data: nothing read from a signal selects the project, the
 * source, the tracker or a threshold. The scope comes from the token, or from
 * the daemon-token caller, and a signal that names another source is refused.
 */
export class IntakeService {
  readonly #limit: SlidingWindowLimit;

  constructor(private readonly deps: IntakeDeps) {
    this.#limit = new SlidingWindowLimit(deps.clock, INTAKE_SIGNALS_PER_MINUTE);
  }

  // ------------------------------------------------------------------ pushing

  /**
   * The scope of an HTTP push. With an intake token, the token decides, and a
   * query naming another project or source is refused. With the daemon token,
   * the query must name both.
   */
  pushScope(fromToken: IntakeScope | null, workspace: string | null, source: string | null): IntakeScope {
    if (fromToken !== null) {
      if ((source !== null && source !== fromToken.sourceId) || (workspace !== null && workspace !== fromToken.workspaceId)) {
        throw tokenScopeRefusal(fromToken.sourceId);
      }
      return fromToken;
    }
    if (workspace === null || workspace === '' || source === null || source === '') {
      throw TandemiseError.validation('Name the project and the source: ?workspace=<id>&source=<id>.');
    }
    return { workspaceId: asId<'WorkspaceId'>(workspace), sourceId: source, tokenId: null };
  }

  /** One signal. Refusals (no tracker, unknown source, wrong source, rate) throw; an invalid signal is recorded as rejected. */
  async ingest(scope: IntakeScope, raw: unknown): Promise<IngestResultView> {
    const source = this.#admit(scope, [raw]);
    return this.#record(scope, source, raw);
  }

  /** A push body: one signal or `{ signals: [...] }`. Each signal is checked on its own (RULINGS.md Ruling 2). */
  async ingestMany(scope: IntakeScope, body: unknown): Promise<readonly IngestResultView[]> {
    const parsed = intakePushBody.safeParse(body === undefined ? {} : body);
    if (!parsed.success) throw TandemiseError.validation(formatIntakeIssues(parsed.error));
    const raws = pushedSignals(parsed.data);
    const source = this.#admit(scope, raws);
    const results: IngestResultView[] = [];
    for (const raw of raws) results.push(await this.#record(scope, source, raw));
    return results;
  }

  /**
   * Everything that refuses a whole push, before anything is recorded: the
   * project, its tracker, the source, a signal naming another source, and
   * the rate limit, which counts signals rather than requests.
   */
  #admit(scope: IntakeScope, raws: readonly unknown[]): IntakeSourceConfig {
    if (this.deps.workspaces.get(scope.workspaceId) === undefined) throw TandemiseError.notFound('Workspace', scope.workspaceId);
    const config = this.deps.config.read(scope.workspaceId);
    if (config.tracker === null) throw new TandemiseError('CONFLICT', "Set this project's tracker first.");
    const source = config.sources.find((s) => s.id === scope.sourceId);
    if (source === undefined) {
      throw new TandemiseError('NOT_FOUND', `This project has no intake source '${scope.sourceId}'.`, { details: { sourceId: scope.sourceId } });
    }
    for (const raw of raws) {
      const named = readableSource(raw);
      if (named !== null && (named.kind !== source.kind || named.instance !== source.instance)) {
        throw scope.tokenId !== null
          ? tokenScopeRefusal(source.id)
          : TandemiseError.permissionDenied(`Signals for '${source.id}' must name it as their source (${source.kind}, ${source.instance}).`);
      }
    }
    const key = scope.tokenId ?? `daemon:${scope.workspaceId}:${scope.sourceId}`;
    if (!this.#limit.take(key, raws.length)) {
      throw new TandemiseError('RATE_LIMITED', `Too many signals from this source: at most ${INTAKE_SIGNALS_PER_MINUTE} a minute.`, { retryable: true });
    }
    return source;
  }

  async #record(scope: IntakeScope, source: IntakeSourceConfig, raw: unknown): Promise<IngestResultView> {
    const checked = validateIntakeSignal(raw);
    if (!checked.ok) {
      const fingerprint = checked.fingerprint ?? `invalid:${source.id}:${sha256(JSON.stringify(raw) ?? '').slice(0, 16)}`;
      const signal = this.deps.intake.recordRejected(scope.workspaceId, source.id, fingerprint, checked.title ?? UNREADABLE_TITLE, checked.reason);
      this.deps.log.info('intake.signal_rejected', { workspaceId: scope.workspaceId, sourceId: source.id, fingerprint });
      return { fingerprint, signalId: signal.id, status: 'rejected', reason: checked.reason };
    }
    const { signal, firstTime } = this.deps.intake.upsertSignal(scope.workspaceId, source.id, checked.signal, this.deps.clock.now());
    await this.#keepAttachments(signal, checked.signal);
    this.deps.log.info('intake.signal_recorded', { workspaceId: scope.workspaceId, sourceId: source.id, fingerprint: signal.fingerprint, firstTime });
    return { fingerprint: signal.fingerprint, signalId: signal.id, status: signal.status, reason: signal.reason };
  }

  /**
   * Inline content is stored by sha256, URLs are kept as links and never
   * fetched (spec §1: no SSRF surface). A repeat push adds only what is new.
   */
  async #keepAttachments(signal: IntakeSignal, parsed: IntakeSignalV1): Promise<void> {
    const list = parsed.attachments ?? [];
    if (list.length === 0) return;
    const kept = this.deps.intake.attachments(signal.id);
    for (const a of list) {
      const entry: Omit<IntakeAttachment, 'signalId'> = a.contentBase64 !== undefined
        ? { name: a.name, mediaType: a.mediaType, blobSha256: await this.deps.blobs.put(Buffer.from(a.contentBase64, 'base64')), url: null }
        : { name: a.name, mediaType: a.mediaType, blobSha256: null, url: a.url ?? null };
      const known = kept.some((k) => k.name === entry.name && k.blobSha256 === entry.blobSha256 && k.url === entry.url);
      if (!known) this.deps.intake.addAttachment(signal.id, entry);
    }
  }

  // ------------------------------------------------------------------ reading

  list(workspaceId: WorkspaceId, filter: { readonly statuses?: readonly SignalStatus[]; readonly limit?: number }): readonly IntakeSignalView[] {
    this.#requireWorkspace(workspaceId);
    return this.deps.intake.listSignals(workspaceId, filter).map((s) => this.#signalView(s));
  }

  #signalView(s: IntakeSignal): IntakeSignalView {
    return {
      id: s.id,
      sourceId: s.sourceId,
      fingerprint: s.fingerprint,
      sourceLabel: s.kind === '' ? s.sourceId : sourceLabel(s.kind),
      instance: s.instance,
      key: s.key,
      url: s.url,
      title: s.title,
      status: s.status,
      reason: s.reason,
      occurrences: s.occurrences,
      impact: s.impact,
      firstSeenAt: s.firstSeenAt,
      lastSeenAt: s.lastSeenAt,
      itemRef: this.deps.intake.linkFor(s.id)?.itemRef ?? null,
    };
  }

  // ------------------------------------------------------------------ configuration

  config(workspaceId: WorkspaceId): IntakeConfigView {
    this.#requireWorkspace(workspaceId);
    const read = this.deps.config.read(workspaceId);
    return { origin: this.deps.config.origin, editable: this.deps.config.write !== undefined, ...read };
  }

  /**
   * Takes the request unparsed: its file schemas fill defaults, so the parsed
   * shape differs from what a client sends, and parsing here keeps the zod
   * types out of the route.
   */
  configure(caller: Caller, workspaceId: WorkspaceId, body: unknown): IntakeConfigView {
    this.#requireWorkspace(workspaceId);
    requireSeat(this.deps, workspaceId, caller);
    const parsed = updateIntakeConfigRequest.safeParse(body === undefined ? {} : body);
    if (!parsed.success) throw TandemiseError.validation(formatIntakeIssues(parsed.error));
    const request = parsed.data;
    const write = this.deps.config.write?.bind(this.deps.config);
    if (write === undefined) {
      throw new TandemiseError('PRECONDITION_FAILED', "This project's intake is set in its brain. Change it there.");
    }
    write(workspaceId, {
      ...(request.tracker === undefined ? {} : { tracker: request.tracker }),
      ...(request.intake === undefined ? {} : { intake: request.intake }),
    });
    return this.config(workspaceId);
  }

  // ------------------------------------------------------------------ tokens

  /**
   * A push token for one source, shown once (spec §2). Only its sha256 is
   * stored, so a lost token is revoked and minted again, never recovered.
   */
  mintToken(caller: Caller, workspaceId: WorkspaceId, sourceId: string): IntakeTokenMintedView {
    this.#requireWorkspace(workspaceId);
    requireSeat(this.deps, workspaceId, caller);
    if (!this.deps.config.read(workspaceId).sources.some((s) => s.id === sourceId)) {
      throw new TandemiseError('NOT_FOUND', `This project has no intake source '${sourceId}'.`, { details: { sourceId } });
    }
    const token = `${INTAKE_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
    const row = this.deps.intake.tokens.create(workspaceId, sourceId, sha256(token), caller.personId);
    this.deps.log.info('intake.token_minted', { workspaceId, sourceId, tokenId: row.id });
    return { id: row.id, token };
  }

  revokeToken(_caller: Caller, id: IntakeTokenId): void {
    this.deps.intake.tokens.revoke(id);
    this.deps.log.info('intake.token_revoked', { tokenId: id });
  }

  /** The scope an intake token grants, or null for anything else, revoked tokens included. */
  resolveToken(token: string): IntakeScope | null {
    if (!token.startsWith(INTAKE_TOKEN_PREFIX)) return null;
    const row = this.deps.intake.tokens.byHash(sha256(token));
    if (row === undefined || row.revokedAt !== null) return null;
    return { workspaceId: row.workspaceId, sourceId: row.sourceId, tokenId: row.id };
  }

  #requireWorkspace(workspaceId: WorkspaceId): void {
    if (this.deps.workspaces.get(workspaceId) === undefined) throw TandemiseError.notFound('Workspace', workspaceId);
  }
}

function tokenScopeRefusal(sourceId: string): TandemiseError {
  return TandemiseError.permissionDenied(`This token can only push to '${sourceId}'.`, { sourceId });
}

/** The source a raw signal names, when both parts are strings; validation says the rest. */
function readableSource(raw: unknown): { kind: string; instance: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = (raw as { source?: unknown }).source;
  if (typeof source !== 'object' || source === null) return null;
  const { kind, instance } = source as { kind?: unknown; instance?: unknown };
  return typeof kind === 'string' && typeof instance === 'string' ? { kind, instance } : null;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
