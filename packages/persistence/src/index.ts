/**
 * `@tandemise/persistence` - the SQLite implementation of every persistence
 * port defined by `@tandemise/domain`.
 *
 * Nothing above layer 2 imports this package directly. The composition root
 * registers `persistenceModule(...)` and everything else resolves ports by
 * token, which is what keeps SQLite out of the mission engine's type graph.
 */

export { openDatabase } from './database.js';
export type { OpenDatabaseOptions, SqliteHandle, Stmt, TandemiseDatabase } from './database.js';

export { MIGRATIONS, SCHEMA_VERSION, migrate, schemaVersion } from './migrations/index.js';
export type { Migration, MigrationResult } from './migrations/index.js';

export { persistenceModule } from './module.js';
export type { PersistenceOptions } from './module.js';

export * from './tokens.js';

export { parseJson, parseJsonOrNull, toJson, toJsonOrNull, fromSqlBool, toSqlBool } from './json.js';
export { applyPatch } from './patch.js';

export { SqliteWorkspaceRepository } from './repositories/workspace-repository.js';
export { SqliteRepoRepository } from './repositories/repo-repository.js';
export { SqliteMissionRepository } from './repositories/mission-repository.js';
export { SqliteTaskRepository } from './repositories/task-repository.js';
export { SqliteRunRepository } from './repositories/run-repository.js';
export { SqliteEventRepository } from './repositories/event-repository.js';
export { SqliteArtifactRepository } from './repositories/artifact-repository.js';
export { SqliteApprovalRepository } from './repositories/approval-repository.js';
export { SqliteRoleRepository } from './repositories/role-repository.js';
export { SqliteRuntimeProfileRepository } from './repositories/runtime-profile-repository.js';
export { SqliteExecutionTargetRepository } from './repositories/execution-target-repository.js';
export { SqliteIntegrationRepository } from './repositories/integration-repository.js';
export { SqliteAssignmentRepository } from './repositories/assignment-repository.js';
export { SqliteDecisionRepository } from './repositories/decision-repository.js';
export { SqliteEvaluationRepository } from './repositories/evaluation-repository.js';
export { SqliteCheckpointRepository } from './repositories/checkpoint-repository.js';
export { SqliteLeaseRepository } from './repositories/lease-repository.js';
export { createUnitOfWork } from './repositories/unit-of-work.js';
