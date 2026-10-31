import type { WorkspaceId } from '@tandemise/shared';
import type { IntakeConfig, TrackerConfig } from '../entities/intake.js';

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
