import type { LifecycleComponent } from '@tandemise/kernel';
import type { EventBusPort, WorkspaceBrainRepositoryPort } from '@tandemise/domain';
import { TERMINAL_MISSION_STATUSES } from '@tandemise/domain';
import { errorMessage, type Logger } from '@tandemise/shared';
import type { BrainService } from './brain-service.js';
import { BRAIN_BACKGROUND_PULL_MS } from './constants.js';

/**
 * Pulls every linked brain at daemon start and then in the background (#51
 * spec §4), so a teammate's push arrives even on an idle machine. A failed
 * pull is the brain's own business: it is shown in the Brain section and
 * never stops the daemon.
 */
export class BrainSyncLoop implements LifecycleComponent {
  readonly name = 'brain-sync';
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly brain: Pick<BrainService, 'sync' | 'missionEnded' | 'flushAll'>,
    private readonly brains: Pick<WorkspaceBrainRepositoryPort, 'list'>,
    private readonly log: Logger,
    /** Mission ends write a history line (spec §5). */
    private readonly bus: EventBusPort | null = null,
    private readonly intervalMs = BRAIN_BACKGROUND_PULL_MS,
  ) {}

  #unsubscribe: (() => void) | null = null;

  async start(): Promise<void> {
    this.#unsubscribe = this.bus?.subscribe((record) => {
      const body = record.body;
      if (body.type !== 'mission.status' || !(TERMINAL_MISSION_STATUSES as readonly string[]).includes(body.to)) return;
      void this.brain.missionEnded(record.missionId).catch((e) => this.log.warn('brain.history_failed', { missionId: record.missionId, error: errorMessage(e) }));
    }) ?? null;
    void this.#all('start');
    this.#timer = setInterval(() => { void this.#all('background'); }, this.intervalMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    // Nothing learned is left in memory at shutdown.
    await this.brain.flushAll().catch((e) => this.log.warn('brain.flush_failed', { error: errorMessage(e) }));
  }

  async #all(why: 'start' | 'background'): Promise<void> {
    for (const link of this.brains.list()) {
      try {
        await this.brain.sync(link.workspaceId, why);
      } catch (e) {
        this.log.warn('brain.sync_failed', { workspaceId: link.workspaceId, why, error: errorMessage(e) });
      }
    }
  }
}
