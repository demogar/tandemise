import type { BrainRepoPort, EntryBody, LedgerEvent, MissionRepositoryPort } from '@tandemise/domain';
import { BRAIN_REDACTED, BRAIN_SECRET_REFUSAL, isTrialMission, scrubForBrain, validateLedgerEvent } from '@tandemise/domain';

const redactText = (t: string): string => redactSecrets(t).replace(/(?:gh|sk-|sk-ant-|github_pat_|figd_|xox|AKIA|jwt)?«redacted»/g, BRAIN_REDACTED);
import type { Clock, Logger, MissionId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, errorMessage, newId, redactSecrets } from '@tandemise/shared';
import type { WorkspaceService } from '../services.js';
import type { BrainService } from './brain-service.js';
import { BRAIN_LEDGER_COMMIT_MS } from './constants.js';
import { BRAIN_LEDGER } from './layout.js';

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before the writer stamps it: the writer adds `at` and `by`, and an id for an `add`. */
export type LedgerEventInput = Without<LedgerEvent, 'at' | 'by' | 'id'> & { readonly id?: string };

/** Who is writing: a person's refusal is an error they see; a model's is skipped and logged. */
export type LedgerActor = 'person' | 'reflector' | 'agent' | 'daemon';

export interface LedgerWriterDeps {
  readonly repo: BrainRepoPort;
  readonly missions: Pick<MissionRepositoryPort, 'get'>;
  readonly workspaces: Pick<WorkspaceService, 'view'>;
  readonly clock: Clock;
  readonly log: Logger;
}

/**
 * The only path into the ledger (#51 spec §5). It drops what an eval trial
 * would teach, validates every event, scrubs every text, and appends to this
 * writer's own file for the month: `memory/ledger/<yyyy>/<mm>/<writerId>.jsonl`.
 * Events are buffered and committed together at most every two minutes, at
 * mission end, on a person's sync and at shutdown; a rejected push rebases
 * and tries once more, a protected branch falls back to one standing PR.
 */
export class LedgerWriter {
  readonly #pending = new Map<string, LedgerEvent[]>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly brain: BrainService, private readonly deps: LedgerWriterDeps) {}

  pending(workspaceId: WorkspaceId): readonly LedgerEvent[] {
    return this.#pending.get(workspaceId) ?? [];
  }

  workspacesWithPending(): readonly WorkspaceId[] {
    return [...this.#pending.entries()].filter(([, v]) => v.length > 0).map(([k]) => k as WorkspaceId);
  }

  async append(
    workspaceId: WorkspaceId,
    inputs: readonly LedgerEventInput[],
    opts: { readonly actor: LedgerActor; readonly missionId?: MissionId | null },
  ): Promise<readonly LedgerEvent[]> {
    const link = this.brain.linkOf(workspaceId);
    if (link === undefined) throw new TandemiseError('PRECONDITION_FAILED', 'This project has no brain. Link one in Project settings.');
    // An eval must not teach the brain (spec §6).
    if (opts.missionId !== undefined && opts.missionId !== null && isTrialMission(this.deps.missions.get(opts.missionId))) return [];
    const repos = this.deps.workspaces.view(workspaceId).repositories.map((r) => ({ name: r.name, path: r.path }));
    const out: LedgerEvent[] = [];
    for (const input of inputs) {
      const at = this.deps.clock.now();
      // A unique id per event, so a retried flush that appends it twice folds once.
      let candidate: Record<string, unknown> = { ...input, at, by: link.writerId, eid: `${link.writerId}:${newId('x').slice(2)}` };
      const refuse = (reason: string): boolean => {
        if (opts.actor === 'person') throw TandemiseError.validation(reason);
        this.deps.log.warn('brain.lesson_refused', { workspaceId, actor: opts.actor, reason });
        return true;
      };
      if ('mission' in input && typeof input.mission === 'string') candidate['mission'] = redactText(input.mission);
      if (input.op === 'add') {
        candidate['id'] = input.id ?? `${link.writerId}:${newId('x').slice(2)}`;
        const scrubbed = scrubForBrain(input.entry.text, repos);
        if ('refused' in scrubbed) { refuse(scrubbed.refused); continue; }
        // Scope values are text too: a secret or a machine path in one never reaches the brain.
        const scope: Record<string, unknown> = {};
        let refused = false;
        for (const [key, value] of Object.entries(input.entry.scope)) {
          const values = Array.isArray(value) ? value as string[] : [value as string];
          const clean: string[] = [];
          for (const v of values) {
            const s = scrubForBrain(v, repos);
            if ('refused' in s || s.text.includes(BRAIN_REDACTED)) { refused = true; break; }
            // A repository path rewritten as `<repo>:<rest>` is a path glob inside that repository.
            clean.push(key === 'paths' ? s.text.replace(/^[^/:]+:/, '') : s.text);
          }
          if (refused) break;
          scope[key] = Array.isArray(value) ? clean : clean[0];
        }
        if (refused) { refuse('A lesson\'s scope can\'t name a secret or a path on your machine.'); continue; }
        const entry: EntryBody = {
          ...input.entry,
          text: scrubbed.text,
          scope: scope as EntryBody['scope'],
          source: { ...input.entry.source, mission: redactText(input.entry.source.mission) },
        };
        candidate = { ...candidate, entry };
      } else if (input.op === 'retire') {
        const scrubbed = scrubForBrain(input.reason, repos);
        candidate = { ...candidate, reason: 'text' in scrubbed ? scrubbed.text : BRAIN_SECRET_REFUSAL };
      }
      const valid = validateLedgerEvent(candidate);
      if ('problem' in valid) {
        if (opts.actor === 'person') throw TandemiseError.validation(`That can't be saved: ${valid.problem}`);
        this.deps.log.warn('brain.event_invalid', { workspaceId, actor: opts.actor, problem: valid.problem });
        continue;
      }
      out.push(valid.event);
    }
    if (out.length === 0) return out;
    this.#pending.set(workspaceId, [...(this.#pending.get(workspaceId) ?? []), ...out]);
    this.#schedule(workspaceId);
    return out;
  }

  /** Commits and pushes what is buffered for one project. */
  async flush(workspaceId: WorkspaceId): Promise<void> {
    const timer = this.#timers.get(workspaceId);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(workspaceId);
    await this.brain.exclusive(workspaceId, async () => {
      const events = this.#pending.get(workspaceId) ?? [];
      if (events.length === 0) return;
      const link = this.brain.linkOf(workspaceId);
      if (link === undefined) { this.#pending.delete(workspaceId); return; }
      const now = new Date(this.deps.clock.now());
      const path = `${BRAIN_LEDGER}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${link.writerId}.jsonl`;
      const content = events.map((e) => `${JSON.stringify(e)}\n`).join('');
      try {
        await this.deps.repo.commit(link.clonePath, [{ path, mode: 'append', content }], `chore: lessons from ${link.writerId}`, null);
      } catch (e) {
        this.deps.log.warn('brain.ledger_commit_failed', { workspaceId, error: errorMessage(e) });
        this.#schedule(workspaceId);
        return;
      }
      // Committed: they live in the clone now, whatever the push does.
      this.#pending.set(workspaceId, (this.#pending.get(workspaceId) ?? []).slice(events.length));
      const head = await this.deps.repo.head(link.clonePath);
      this.brain.markPulled(workspaceId, head);
      if (link.remote !== null) await this.brain.pushLocked(workspaceId);
      await this.brain.refreshInfo(workspaceId);
    });
  }

  async flushAll(): Promise<void> {
    for (const ws of this.workspacesWithPending()) {
      try {
        await this.flush(ws);
      } catch (e) {
        this.deps.log.warn('brain.ledger_flush_failed', { workspaceId: ws, error: errorMessage(e) });
      }
    }
  }

  #schedule(workspaceId: WorkspaceId): void {
    if (this.#timers.has(workspaceId)) return;
    const timer = setTimeout(() => {
      this.#timers.delete(workspaceId);
      void this.flush(workspaceId).catch((e) => this.deps.log.warn('brain.ledger_flush_failed', { workspaceId, error: errorMessage(e) }));
    }, BRAIN_LEDGER_COMMIT_MS);
    timer.unref?.();
    this.#timers.set(workspaceId, timer);
  }
}
