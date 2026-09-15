import { asId, type ArtifactId, type MissionId, type RunId } from '@tandemise/shared';
import type { RunInputRepositoryPort } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';

interface RunInputRow {
  run_id: string;
  artifact_id: string;
}

/**
 * What a run was actually handed, recorded straight from the context
 * compiler's `includedArtifactIds` (spec §3). Downstream impact reads this
 * table rather than re-deriving it from the plan, which is what keeps a
 * round's "what does this affect" answer honest even after the plan changes.
 */
export class SqliteRunInputRepository implements RunInputRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #insert;
  readonly #selectByRun;
  readonly #selectByMission;

  constructor(db: TandemiseDatabase) {
    this.#db = db;
    this.#insert = db.handle.prepare<{ runId: string; artifactId: string }>(
      'INSERT OR IGNORE INTO run_inputs (run_id, artifact_id) VALUES (:runId, :artifactId)',
    );
    this.#selectByRun = db.handle.prepare<{ runId: string }, { artifact_id: string }>(
      'SELECT artifact_id FROM run_inputs WHERE run_id = :runId',
    );
    this.#selectByMission = db.handle.prepare<{ missionId: string }, RunInputRow>(
      `SELECT i.run_id, i.artifact_id FROM run_inputs i
       JOIN runs r ON r.id = i.run_id
       WHERE r.mission_id = :missionId
       ORDER BY r.started_at, i.artifact_id`,
    );
  }

  /**
   * A restart may record the same run's inputs again; `INSERT OR IGNORE` on
   * the composite primary key makes that a no-op rather than a constraint
   * failure that would fail the run.
   */
  record(runId: RunId, artifactIds: readonly ArtifactId[]): void {
    this.#db.transaction(() => {
      for (const artifactId of artifactIds) this.#insert.run({ runId, artifactId });
    });
  }

  listByRun(runId: RunId): readonly ArtifactId[] {
    return this.#selectByRun.all({ runId }).map((r) => asId<'ArtifactId'>(r.artifact_id));
  }

  listByMission(missionId: MissionId): readonly { readonly runId: RunId; readonly artifactId: ArtifactId }[] {
    return this.#selectByMission
      .all({ missionId })
      .map((r) => ({ runId: asId<'RunId'>(r.run_id), artifactId: asId<'ArtifactId'>(r.artifact_id) }));
  }
}
