import { defineModule, type Resolver, type TandemiseModule } from '@tandemise/kernel';
import { nullLogger, systemClock, type Clock, type Logger } from '@tandemise/shared';
import { openDatabase, type TandemiseDatabase } from './database.js';
import { migrate } from './migrations/index.js';
import { SqliteApprovalRepository } from './repositories/approval-repository.js';
import { SqliteArtifactRepository } from './repositories/artifact-repository.js';
import { SqliteAssignmentRepository } from './repositories/assignment-repository.js';
import { SqliteCheckpointRepository } from './repositories/checkpoint-repository.js';
import { SqliteDecisionRepository } from './repositories/decision-repository.js';
import { SqliteEvaluationRepository } from './repositories/evaluation-repository.js';
import { SqliteEventRepository } from './repositories/event-repository.js';
import { SqliteExecutionTargetRepository } from './repositories/execution-target-repository.js';
import { SqliteIntegrationRepository } from './repositories/integration-repository.js';
import { SqliteLeaseRepository } from './repositories/lease-repository.js';
import { SqliteMissionRepository } from './repositories/mission-repository.js';
import { SqliteRepoRepository } from './repositories/repo-repository.js';
import { SqliteRoleRepository } from './repositories/role-repository.js';
import { SqliteRunRepository } from './repositories/run-repository.js';
import { SqliteRuntimeProfileRepository } from './repositories/runtime-profile-repository.js';
import { SqliteTaskRepository } from './repositories/task-repository.js';
import { SqliteWorkspaceRepository } from './repositories/workspace-repository.js';
import { createUnitOfWork } from './repositories/unit-of-work.js';
import {
  APPROVAL_REPOSITORY, ARTIFACT_REPOSITORY, ASSIGNMENT_REPOSITORY, CHECKPOINT_REPOSITORY,
  DATABASE, DECISION_REPOSITORY, EVALUATION_REPOSITORY, EVENT_REPOSITORY,
  EXECUTION_TARGET_REPOSITORY, INTEGRATION_REPOSITORY, LEASE_REPOSITORY, MISSION_REPOSITORY,
  REPO_REPOSITORY, ROLE_REPOSITORY, RUN_REPOSITORY, RUNTIME_PROFILE_REPOSITORY,
  TASK_REPOSITORY, UNIT_OF_WORK, WORKSPACE_REPOSITORY,
} from './tokens.js';

export interface PersistenceOptions {
  /** Database file path, or `:memory:`. */
  readonly path: string;
  readonly logger?: Logger;
  readonly clock?: Clock;
  /**
   * Skips the migration run. Only for a caller that has already migrated the
   * same file (the daemon does this during its startup compatibility check),
   * never as a way to open an unmigrated database.
   */
  readonly skipMigrations?: boolean;
}

const SOURCE = '@tandemise/persistence';

/**
 * Binds the SQLite implementation of every persistence port.
 *
 * The database is opened and migrated eagerly inside the factory rather than
 * lazily on first use: a schema that this binary cannot open must fail at
 * composition, while the composition root can still report it, not halfway
 * through the first mission (MVP.md §20.4).
 */
export function persistenceModule(options: PersistenceOptions): TandemiseModule {
  const logger = options.logger ?? nullLogger;
  const clock = options.clock ?? systemClock;

  return defineModule(SOURCE, (container) => {
    container.bind(
      DATABASE,
      (): TandemiseDatabase => {
        const db = openDatabase({ path: options.path, logger });
        if (!options.skipMigrations) migrate(db, logger);
        return db;
      },
      { source: SOURCE, dispose: (db) => db.close() },
    );

    const db = (r: Resolver): TandemiseDatabase => r.resolve(DATABASE);

    container.bind(UNIT_OF_WORK, (r) => createUnitOfWork(db(r)), { source: SOURCE });
    container.bind(WORKSPACE_REPOSITORY, (r) => new SqliteWorkspaceRepository(db(r), clock), { source: SOURCE });
    container.bind(REPO_REPOSITORY, (r) => new SqliteRepoRepository(db(r), clock), { source: SOURCE });
    container.bind(MISSION_REPOSITORY, (r) => new SqliteMissionRepository(db(r), clock), { source: SOURCE });
    container.bind(TASK_REPOSITORY, (r) => new SqliteTaskRepository(db(r), clock), { source: SOURCE });
    container.bind(RUN_REPOSITORY, (r) => new SqliteRunRepository(db(r), clock), { source: SOURCE });
    container.bind(EVENT_REPOSITORY, (r) => new SqliteEventRepository(db(r)), { source: SOURCE });
    container.bind(ARTIFACT_REPOSITORY, (r) => new SqliteArtifactRepository(db(r)), { source: SOURCE });
    container.bind(APPROVAL_REPOSITORY, (r) => new SqliteApprovalRepository(db(r)), { source: SOURCE });
    container.bind(ROLE_REPOSITORY, (r) => new SqliteRoleRepository(db(r)), { source: SOURCE });
    container.bind(RUNTIME_PROFILE_REPOSITORY, (r) => new SqliteRuntimeProfileRepository(db(r), clock), { source: SOURCE });
    container.bind(EXECUTION_TARGET_REPOSITORY, (r) => new SqliteExecutionTargetRepository(db(r)), { source: SOURCE });
    container.bind(INTEGRATION_REPOSITORY, (r) => new SqliteIntegrationRepository(db(r), clock), { source: SOURCE });
    container.bind(ASSIGNMENT_REPOSITORY, (r) => new SqliteAssignmentRepository(db(r)), { source: SOURCE });
    container.bind(DECISION_REPOSITORY, (r) => new SqliteDecisionRepository(db(r)), { source: SOURCE });
    container.bind(EVALUATION_REPOSITORY, (r) => new SqliteEvaluationRepository(db(r)), { source: SOURCE });
    container.bind(CHECKPOINT_REPOSITORY, (r) => new SqliteCheckpointRepository(db(r)), { source: SOURCE });
    container.bind(LEASE_REPOSITORY, (r) => new SqliteLeaseRepository(db(r), clock), { source: SOURCE });
  });
}
