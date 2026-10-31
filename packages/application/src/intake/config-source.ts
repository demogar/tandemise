import type { IntakeConfig, IntakeConfigSource, TrackerConfig } from '@tandemise/domain';
import { emptyIntakeConfig } from '@tandemise/domain';
import { formatIntakeIssues, intakeFileV1, trackerFileV1 } from '@tandemise/api-contract';
import type { Logger, WorkspaceId } from '@tandemise/shared';
import { TandemiseError } from '@tandemise/shared';
import type { SettingsStorePort } from '../ports.js';

/** The settings key intake keeps every project's local configuration under. */
export const INTAKE_SETTINGS_KEY = 'intake';

/** What one project stores: the two brain files' contents, as plain JSON. */
interface StoredProject {
  readonly tracker?: unknown;
  readonly intake?: unknown;
}

/**
 * Intake's configuration from the local settings file (plan Task 3; spec §4.1,
 * §6.2), for a project with no brain yet. Stored as
 * `{ intake: { [workspaceId]: { tracker?, intake? } } }` and checked with the
 * same schemas the brain's codec uses (`trackerFileV1`, `intakeFileV1`), so a
 * project moves to the brain without reshaping anything.
 *
 * `read` never throws: an entry that no longer parses (a hand edit, an older
 * shape) reads as unset and is logged, so a bad file never stops the daemon.
 * `write` refuses what would not parse, so nothing bad is stored from here.
 */
export class LocalIntakeConfigSource implements IntakeConfigSource {
  readonly origin = 'local' as const;

  constructor(private readonly deps: { readonly settings: SettingsStorePort; readonly log: Logger }) {}

  read(workspaceId: WorkspaceId): IntakeConfig {
    const stored = this.#all()[workspaceId];
    const config = { ...emptyIntakeConfig() };
    if (stored === undefined) return config;
    let tracker: TrackerConfig | null = null;
    if (stored.tracker !== undefined && stored.tracker !== null) {
      const parsed = trackerFileV1.safeParse({ tracker: stored.tracker });
      if (parsed.success) tracker = parsed.data.tracker;
      else this.deps.log.warn('intake.config_unreadable', { workspaceId, part: 'tracker', issues: formatIntakeIssues(parsed.error) });
    }
    if (stored.intake !== undefined && stored.intake !== null) {
      const parsed = intakeFileV1.safeParse(stored.intake);
      if (parsed.success) return { tracker, sources: parsed.data.sources, dailyCap: parsed.data.dailyCap, similarity: parsed.data.similarity };
      this.deps.log.warn('intake.config_unreadable', { workspaceId, part: 'intake', issues: formatIntakeIssues(parsed.error) });
    }
    return { ...config, tracker };
  }

  write(
    workspaceId: WorkspaceId,
    patch: { tracker?: TrackerConfig | null; intake?: Omit<IntakeConfig, 'tracker'> },
  ): IntakeConfig {
    const current = this.#all()[workspaceId] ?? {};
    const next: { tracker?: unknown; intake?: unknown } = { ...current };
    if (patch.tracker === null) {
      delete next.tracker;
    } else if (patch.tracker !== undefined) {
      const parsed = trackerFileV1.safeParse({ tracker: patch.tracker });
      if (!parsed.success) throw TandemiseError.validation(formatIntakeIssues(parsed.error), { part: 'tracker' });
      next.tracker = parsed.data.tracker;
    }
    if (patch.intake !== undefined) {
      const parsed = intakeFileV1.safeParse(patch.intake);
      if (!parsed.success) throw TandemiseError.validation(formatIntakeIssues(parsed.error), { part: 'intake' });
      next.intake = parsed.data;
    }
    this.deps.settings.write({ [INTAKE_SETTINGS_KEY]: { ...this.#all(), [workspaceId]: next } });
    return this.read(workspaceId);
  }

  #all(): Record<string, StoredProject> {
    const stored = this.deps.settings.read()[INTAKE_SETTINGS_KEY];
    return typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? (stored as Record<string, StoredProject>) : {};
  }
}
