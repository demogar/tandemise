import type { LifecycleComponent } from '@tandemise/kernel';
import type { WorkspaceBrainRepositoryPort } from '@tandemise/domain';
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
    private readonly brain: Pick<BrainService, 'sync'>,
    private readonly brains: Pick<WorkspaceBrainRepositoryPort, 'list'>,
    private readonly log: Logger,
    private readonly intervalMs = BRAIN_BACKGROUND_PULL_MS,
  ) {}

  async start(): Promise<void> {
    void this.#all('start');
    this.#timer = setInterval(() => { void this.#all('background'); }, this.intervalMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
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
