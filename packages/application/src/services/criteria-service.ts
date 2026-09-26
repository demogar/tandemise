import type { ArtifactRepositoryPort, Evaluation, MissionRepositoryPort } from '@tandemise/domain';
import type { MissionCriterionView } from '@tandemise/api-contract';
import { TandemiseError, type ArtifactId, type MissionId } from '@tandemise/shared';
import type { GateService } from '../engine/gates.js';
import type { CriteriaService } from '../services.js';

export interface CriteriaServiceDeps {
  readonly missions: MissionRepositoryPort;
  readonly artifacts: ArtifactRepositoryPort;
  /** The trace the gates read, so the checklist and the gate can never disagree. */
  readonly gates: GateService;
}

/**
 * The Done-when ledger as a person reads it (P5 spec §8).
 *
 * A service of its own rather than a projection so later work on the ledger -
 * proposing, accepting and adding criteria - lands beside `list` without
 * reaching into the feed.
 */
export class CriteriaServiceImpl implements CriteriaService {
  constructor(private readonly deps: CriteriaServiceDeps) {}

  list(missionId: MissionId): readonly MissionCriterionView[] {
    if (this.deps.missions.get(missionId) === undefined) throw TandemiseError.notFound('Mission', missionId);
    const { trace, qa } = this.deps.gates.trace(missionId);
    const report = qa === undefined ? null : this.#reportOf(qa);
    return trace.rows.map((row) => ({
      id: row.criterion.id,
      key: row.criterion.key,
      statement: row.criterion.statement,
      source: row.criterion.source,
      covers: row.criterion.covers,
      coveredBy: row.coveredBy,
      result: row.result,
      evidence: row.evidence,
      qaArtifactId: row.fromQa ? report : null,
      specArtifactId: row.criterion.specArtifactId,
      counted: row.counted,
      uncovered: row.uncovered,
      createdAt: row.criterion.createdAt,
    }));
  }

  /**
   * The QAReport a QA evaluation was lifted from: the one its run wrote, or
   * the task's newest when the run is unknown. Null when it has since been
   * withdrawn - the row then says what it says, but opens nothing.
   */
  #reportOf(qa: Evaluation): ArtifactId | null {
    const reports = this.deps.artifacts.listByTask(qa.taskId).filter((a) => a.type === 'QAReport');
    const own = qa.runId === null ? undefined : reports.find((a) => a.createdByRunId === qa.runId);
    return (own ?? reports[0])?.id ?? null;
  }
}
