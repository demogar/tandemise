import type { IntakeConfig, IntakeConfigSource, IntakeSourceConfig, TrackerConfig } from '@tandemise/domain';
import { emptyIntakeConfig } from '@tandemise/domain';
import { formatIntakeIssues, intakeFileV1, intakeSourceFile, trackerFileV1 } from '@tandemise/api-contract';
import type { Logger, WorkspaceId } from '@tandemise/shared';
import { TandemiseError } from '@tandemise/shared';

/** The brain's refusal, word for word (`SET_IN_BRAIN` in `brain/intake-config.ts`). */
export const INTAKE_SET_IN_BRAIN = "Set in this project's brain.";

/**
 * What intake needs from the brain (#51): which projects are linked, and their
 * `factory/tracker.yaml` / `factory/intake.yaml` at the last pull, as the
 * brain parsed them. `BrainIntakeConfigSource` is exactly this.
 */
export interface BrainIntakeReader {
  originFor(workspaceId: WorkspaceId): 'local' | 'brain';
  read(workspaceId: WorkspaceId): {
    readonly tracker: unknown;
    readonly sources: readonly unknown[];
    readonly dailyCap: number;
    readonly similarity: { readonly link: number; readonly ask: number };
  };
}

/**
 * Intake's configuration per project (Ruling 21): a project linked to a brain
 * reads the brain's files, any other project reads the local settings. The
 * brain parses its files loosely ("#52 validates each"), so everything it hands
 * over is checked again here with intake's own schemas:
 *
 * - a tracker that fails `trackerFileV1` reads as no tracker;
 * - a source that fails its schema is dropped and logged, the others kept,
 *   so one bad entry never switches off a team's whole intake;
 * - the file's other fields fall back to their defaults when invalid.
 *
 * `read` never throws (the port's contract). Writes go to the local settings,
 * and are refused for a linked project: its intake is edited in the brain.
 */
export class LinkedIntakeConfigSource implements IntakeConfigSource {
  readonly origin = 'local' as const;

  constructor(private readonly deps: {
    readonly local: IntakeConfigSource;
    readonly brain: BrainIntakeReader | null;
    readonly log: Logger;
  }) {}

  originFor(workspaceId: WorkspaceId): 'local' | 'brain' {
    return this.deps.brain?.originFor(workspaceId) ?? 'local';
  }

  read(workspaceId: WorkspaceId): IntakeConfig {
    const brain = this.deps.brain;
    if (brain === null || brain.originFor(workspaceId) !== 'brain') return this.deps.local.read(workspaceId);
    let raw: ReturnType<BrainIntakeReader['read']>;
    try {
      raw = brain.read(workspaceId);
    } catch (e) {
      this.deps.log.warn('intake.brain_config_unreadable', { workspaceId, error: String(e) });
      return emptyIntakeConfig();
    }
    let tracker: TrackerConfig | null = null;
    if (raw.tracker !== null && raw.tracker !== undefined) {
      const parsed = trackerFileV1.safeParse({ tracker: raw.tracker });
      if (parsed.success) tracker = parsed.data.tracker;
      else this.deps.log.warn('intake.brain_config_unreadable', { workspaceId, part: 'tracker', issues: formatIntakeIssues(parsed.error) });
    }
    const sources: IntakeSourceConfig[] = [];
    const ids = new Set<string>();
    for (const entry of raw.sources) {
      const parsed = intakeSourceFile.safeParse(entry);
      if (!parsed.success) {
        this.deps.log.warn('intake.brain_source_dropped', { workspaceId, issues: formatIntakeIssues(parsed.error) });
        continue;
      }
      if (ids.has(parsed.data.id)) {
        this.deps.log.warn('intake.brain_source_dropped', { workspaceId, sourceId: parsed.data.id, reason: 'duplicate id' });
        continue;
      }
      ids.add(parsed.data.id);
      sources.push(parsed.data);
    }
    const rest = intakeFileV1.safeParse({ sources: [], dailyCap: raw.dailyCap, similarity: raw.similarity });
    if (rest.success) return { tracker, sources, dailyCap: rest.data.dailyCap, similarity: rest.data.similarity };
    this.deps.log.warn('intake.brain_config_unreadable', { workspaceId, part: 'intake', issues: formatIntakeIssues(rest.error) });
    const defaults = emptyIntakeConfig();
    return { tracker, sources, dailyCap: defaults.dailyCap, similarity: defaults.similarity };
  }

  write(
    workspaceId: WorkspaceId,
    patch: { tracker?: TrackerConfig | null; intake?: Omit<IntakeConfig, 'tracker'> },
  ): IntakeConfig {
    if (this.originFor(workspaceId) === 'brain') throw new TandemiseError('CONFLICT', INTAKE_SET_IN_BRAIN);
    if (this.deps.local.write === undefined) {
      throw new TandemiseError('PRECONDITION_FAILED', 'Intake settings cannot be saved in this build.');
    }
    return this.deps.local.write(workspaceId, patch);
  }
}
