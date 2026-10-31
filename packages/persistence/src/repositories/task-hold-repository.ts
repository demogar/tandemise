import { asId, type MemberId, type MissionId, type TaskHoldId, type TaskId, type Timestamp } from '@tandemise/shared';
import type { HoldDiffStat, HoldEnding, TaskHold, TaskHoldRepositoryPort, TaskStatus } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { applyPatch } from '../patch.js';

interface TaskHoldRow {
  id: string;
  task_id: string;
  mission_id: string;
  held_by: string;
  from_status: string;
  runtime_profile_id: string;
  session_before: string | null;
  session_after: string | null;
  pty_pid: number | null;
  started_at: string;
  ended_at: string | null;
  ended_by: string | null;
  ending: string | null;
  consumed_at: string | null;
  diff_stat: string | null;
  dir: string;
}

const toRow = (h: TaskHold): TaskHoldRow => ({
  id: h.id,
  task_id: h.taskId,
  mission_id: h.missionId,
  held_by: h.heldBy,
  from_status: h.fromStatus,
  runtime_profile_id: h.runtimeProfileId,
  session_before: h.sessionBefore,
  session_after: h.sessionAfter,
  pty_pid: h.ptyPid,
  started_at: h.startedAt,
  ended_at: h.endedAt,
  ended_by: h.endedBy,
  ending: h.ending,
  consumed_at: h.consumedAt,
  diff_stat: h.diffStat === null ? null : JSON.stringify(h.diffStat),
  dir: h.dir,
});

const fromRow = (r: TaskHoldRow): TaskHold => ({
  id: asId<'TaskHoldId'>(r.id),
  taskId: asId<'TaskId'>(r.task_id) as TaskId,
  missionId: asId<'MissionId'>(r.mission_id) as MissionId,
  heldBy: r.held_by as MemberId,
  fromStatus: r.from_status as TaskStatus,
  runtimeProfileId: r.runtime_profile_id,
  sessionBefore: r.session_before,
  sessionAfter: r.session_after,
  ptyPid: r.pty_pid,
  startedAt: r.started_at as Timestamp,
  endedAt: r.ended_at as Timestamp | null,
  endedBy: r.ended_by as MemberId | null,
  ending: r.ending as HoldEnding | null,
  consumedAt: r.consumed_at as Timestamp | null,
  diffStat: r.diff_stat === null ? null : (JSON.parse(r.diff_stat) as HoldDiffStat),
  dir: r.dir,
});

/** A person's holds on agent steps; see migration 022. */
export class SqliteTaskHoldRepository implements TaskHoldRepositoryPort {
  readonly #insert;
  readonly #select;
  readonly #open;
  readonly #pending;
  readonly #update;
  readonly #byMission;

  constructor(db: TandemiseDatabase) {
    this.#insert = db.handle.prepare<TaskHoldRow>(
      `INSERT INTO task_holds (id, task_id, mission_id, held_by, from_status, runtime_profile_id, session_before,
         session_after, pty_pid, started_at, ended_at, ended_by, ending, consumed_at, diff_stat, dir)
       VALUES (:id, :task_id, :mission_id, :held_by, :from_status, :runtime_profile_id, :session_before,
         :session_after, :pty_pid, :started_at, :ended_at, :ended_by, :ending, :consumed_at, :diff_stat, :dir)`,
    );
    this.#select = db.handle.prepare<{ id: string }, TaskHoldRow>('SELECT * FROM task_holds WHERE id = :id');
    this.#open = db.handle.prepare<{ taskId: string }, TaskHoldRow>(
      'SELECT * FROM task_holds WHERE task_id = :taskId AND ended_at IS NULL',
    );
    this.#pending = db.handle.prepare<{ taskId: string }, TaskHoldRow>(
      `SELECT * FROM task_holds
        WHERE task_id = :taskId AND ended_at IS NOT NULL AND ending = 'continued' AND consumed_at IS NULL
        ORDER BY ended_at DESC LIMIT 1`,
    );
    this.#update = db.handle.prepare<TaskHoldRow>(
      `UPDATE task_holds SET held_by = :held_by, from_status = :from_status, runtime_profile_id = :runtime_profile_id,
         session_before = :session_before, session_after = :session_after, pty_pid = :pty_pid,
         ended_at = :ended_at, ended_by = :ended_by, ending = :ending, consumed_at = :consumed_at,
         diff_stat = :diff_stat, dir = :dir
       WHERE id = :id`,
    );
    this.#byMission = db.handle.prepare<{ missionId: string }, TaskHoldRow>(
      'SELECT * FROM task_holds WHERE mission_id = :missionId ORDER BY started_at, id',
    );
  }

  create(hold: TaskHold): void {
    this.#insert.run(toRow(hold));
  }

  get(id: TaskHoldId): TaskHold | undefined {
    const row = this.#select.get({ id });
    return row === undefined ? undefined : fromRow(row);
  }

  openFor(taskId: TaskId): TaskHold | undefined {
    const row = this.#open.get({ taskId });
    return row === undefined ? undefined : fromRow(row);
  }

  pendingContinuation(taskId: TaskId): TaskHold | undefined {
    const row = this.#pending.get({ taskId });
    return row === undefined ? undefined : fromRow(row);
  }

  update(id: TaskHoldId, patch: Partial<TaskHold>): void {
    const current = this.get(id);
    if (current === undefined) return;
    this.#update.run(toRow(applyPatch(current, patch)));
  }

  listByMission(missionId: MissionId): TaskHold[] {
    return this.#byMission.all({ missionId }).map(fromRow);
  }
}
