import type { BrainRepoPort, OutcomeEvent, OutcomeRepositoryPort } from '@tandemise/domain';
import { errorMessage, type Logger, type MissionId, type WorkspaceId } from '@tandemise/shared';
import type { BrainService } from './brain-service.js';
import { LedgerReader } from './memory.js';

/**
 * Outcomes shared through the brain (#53 §9.1, Task 20). Every outcome is
 * still written to the local table; in a project linked to a brain it is also
 * appended to the ledger as an `outcome` op, so every teammate's daemon folds
 * the same events into the same routing table with only git. Reads are the
 * local rows plus the ledger's outcomes at the last pull, by id, so one event
 * counts once however many places hold it. A link backfills the local rows
 * the ledger doesn't have yet, once.
 */
export class OutcomeHistory implements OutcomeRepositoryPort {
  readonly #ledger = new Map<string, readonly OutcomeEvent[]>();
  readonly #sent = new Set<string>();

  constructor(
    private readonly local: OutcomeRepositoryPort,
    private readonly brain: () => Pick<BrainService, 'linkOf' | 'append' | 'onSync'> | undefined,
    private readonly repo: () => BrainRepoPort | undefined,
    private readonly log: Logger,
  ) {
    try {
      brain()?.onSync((ws) => this.refresh(ws));
    } catch (e) {
      log.warn('outcomes.brain_unavailable', { error: errorMessage(e) });
    }
  }

  append(o: OutcomeEvent & { readonly workspaceId: WorkspaceId }): void {
    this.local.append(o);
    void this.send(o.workspaceId, o);
  }

  listByWorkspace(workspaceId: WorkspaceId, sinceIso: string): readonly OutcomeEvent[] {
    const byId = new Map<string, OutcomeEvent>();
    for (const o of this.#ledger.get(workspaceId) ?? []) if (o.at >= sinceIso) byId.set(o.id, o);
    for (const o of this.local.listByWorkspace(workspaceId, sinceIso)) byId.set(o.id, o);
    return [...byId.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  }

  /** The ledger's outcomes at the last pull. */
  async ledger(workspaceId: WorkspaceId): Promise<readonly OutcomeEvent[]> {
    const link = this.brain()?.linkOf(workspaceId);
    const repo = this.repo();
    if (link === undefined || link.lastPulledSha === null || repo === undefined) return [];
    const { events } = await new LedgerReader(repo).eventsAt(link.clonePath, link.lastPulledSha);
    return events.filter((e) => e.op === 'outcome').map((e) => {
      const { eid: _eid, ...rest } = e as typeof e & { eid?: string };
      return rest as unknown as OutcomeEvent;
    });
  }

  /** Re-reads the ledger, and sends it the local outcomes it doesn't have yet. */
  async refresh(workspaceId: WorkspaceId): Promise<void> {
    try {
      const fromLedger = await this.ledger(workspaceId);
      this.#ledger.set(workspaceId, fromLedger);
      if (this.brain()?.linkOf(workspaceId) === undefined) return;
      const known = new Set(fromLedger.map((o) => o.id));
      for (const o of this.local.listByWorkspace(workspaceId, '1970-01-01')) {
        if (!known.has(o.id)) await this.send(workspaceId, o);
      }
    } catch (e) {
      this.log.warn('outcomes.refresh_failed', { workspaceId, error: errorMessage(e) });
    }
  }

  /** Appends one outcome to the brain's ledger, once per process; a project with no brain is a no-op. */
  async send(workspaceId: WorkspaceId, o: OutcomeEvent): Promise<void> {
    const brain = this.brain();
    if (brain === undefined || brain.linkOf(workspaceId) === undefined || this.#sent.has(o.id)) return;
    this.#sent.add(o.id);
    const { op: _op, at: _at, by: _by, ...body } = o;
    try {
      await brain.append(workspaceId, [{ op: 'outcome', ...body }], { actor: 'daemon', missionId: o.mission as MissionId });
    } catch (e) {
      this.#sent.delete(o.id);
      this.log.warn('outcomes.ledger_failed', { workspaceId, error: errorMessage(e) });
    }
  }
}
