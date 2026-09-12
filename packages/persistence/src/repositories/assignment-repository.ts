import { asId, type TaskId, type WorkerAssignmentId } from '@tandemise/shared';
import type {
  AssignmentBudgets, AssignmentRepositoryPort, CapabilityGrant, WorkerAssignment,
} from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';

interface AssignmentRow {
  id: string;
  workspace_id: string;
  mission_id: string;
  task_id: string;
  role_id: string;
  runtime_profile_id: string;
  execution_target_id: string;
  grants: string;
  budgets: string;
  created_at: string;
}

/**
 * A budget that cannot be decoded must not read as "unlimited". Zero attempts
 * and zero wall time stop the assignment instead of letting it run unbounded.
 */
const FAIL_CLOSED_BUDGETS: AssignmentBudgets = { maxWallTimeMs: 0, maxAttempts: 0 };

function toRow(a: WorkerAssignment): AssignmentRow {
  return {
    id: a.id,
    workspace_id: a.workspaceId,
    mission_id: a.missionId,
    task_id: a.taskId,
    role_id: a.roleId,
    runtime_profile_id: a.runtimeProfileId,
    execution_target_id: a.executionTargetId,
    grants: toJson(a.grants),
    budgets: toJson(a.budgets),
    created_at: a.createdAt,
  };
}

function fromRow(r: AssignmentRow): WorkerAssignment {
  return {
    id: asId<'WorkerAssignmentId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    missionId: asId<'MissionId'>(r.mission_id),
    taskId: asId<'TaskId'>(r.task_id),
    roleId: r.role_id,
    runtimeProfileId: asId<'RuntimeProfileId'>(r.runtime_profile_id),
    executionTargetId: asId<'ExecutionTargetId'>(r.execution_target_id),
    grants: parseJson<readonly CapabilityGrant[]>(r.grants, []),
    budgets: parseJson<AssignmentBudgets>(r.budgets, FAIL_CLOSED_BUDGETS),
    createdAt: r.created_at,
  };
}

const COLUMNS = `id, workspace_id, mission_id, task_id, role_id, runtime_profile_id,
  execution_target_id, grants, budgets, created_at`;

/**
 * Assignments are immutable once written: they record what a run was permitted
 * to do at the moment it was created, which is only auditable if nothing can
 * retroactively widen it. A change of permissions is a new assignment.
 */
export class SqliteAssignmentRepository implements AssignmentRepositoryPort {
  readonly #insert;
  readonly #selectOne;
  readonly #selectByTask;

  constructor(db: TandemiseDatabase) {
    this.#insert = db.handle.prepare<AssignmentRow>(
      `INSERT INTO worker_assignments (${COLUMNS}) VALUES (
        :id, :workspace_id, :mission_id, :task_id, :role_id, :runtime_profile_id,
        :execution_target_id, :grants, :budgets, :created_at)`,
    );
    this.#selectOne = db.handle.prepare<{ id: string }, AssignmentRow>(
      `SELECT ${COLUMNS} FROM worker_assignments WHERE id = :id`,
    );
    this.#selectByTask = db.handle.prepare<{ taskId: string }, AssignmentRow>(
      `SELECT ${COLUMNS} FROM worker_assignments WHERE task_id = :taskId ORDER BY created_at, id`,
    );
  }

  create(assignment: WorkerAssignment): WorkerAssignment {
    this.#insert.run(toRow(assignment));
    return assignment;
  }

  get(id: WorkerAssignmentId): WorkerAssignment | undefined {
    const row = this.#selectOne.get({ id });
    return row ? fromRow(row) : undefined;
  }

  listByTask(taskId: TaskId): readonly WorkerAssignment[] {
    return this.#selectByTask.all({ taskId }).map(fromRow);
  }
}
