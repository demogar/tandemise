import {
  TandemiseError, asId, type Clock, type FeedbackId, type MissionId, type TaskId,
} from '@tandemise/shared';
import type { FeedbackAttachment, FeedbackItem, FeedbackRepositoryPort, FeedbackStatus } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';

interface FeedbackRow {
  id: string;
  task_id: string;
  artifact_id: string | null;
  author_id: string;
  recorded_by: string;
  text: string;
  attachments: string;
  status: string;
  round: number | null;
  created_at: string;
  updated_at: string;
}

function toRow(f: FeedbackItem): FeedbackRow {
  return {
    id: f.id,
    task_id: f.taskId,
    artifact_id: f.artifactId,
    author_id: f.authorId,
    recorded_by: f.recordedBy,
    text: f.text,
    attachments: toJson(f.attachments),
    status: f.status,
    round: f.round,
    created_at: f.createdAt,
    updated_at: f.updatedAt,
  };
}

function fromRow(r: FeedbackRow): FeedbackItem {
  return {
    id: asId<'FeedbackId'>(r.id),
    taskId: asId<'TaskId'>(r.task_id),
    artifactId: r.artifact_id === null ? null : asId<'ArtifactId'>(r.artifact_id),
    authorId: r.author_id,
    recordedBy: r.recorded_by,
    text: r.text,
    attachments: parseJson<readonly FeedbackAttachment[]>(r.attachments, []),
    status: r.status as FeedbackStatus,
    round: r.round,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS = 'id, task_id, artifact_id, author_id, recorded_by, text, attachments, status, round, created_at, updated_at';
const F_COLUMNS = COLUMNS.split(', ').map((c) => `f.${c}`).join(', ');

export class SqliteFeedbackRepository implements FeedbackRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #clock: Clock;
  readonly #insert;
  readonly #update;
  readonly #selectOne;
  readonly #selectByTask;
  readonly #selectByMission;
  readonly #selectByStatus;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    this.#insert = db.handle.prepare<FeedbackRow>(
      `INSERT INTO feedback (${COLUMNS}) VALUES (
        :id, :task_id, :artifact_id, :author_id, :recorded_by, :text, :attachments, :status, :round,
        :created_at, :updated_at)`,
    );
    this.#update = db.handle.prepare<{ id: string; status: string; round: number | null; updated_at: string }>(
      'UPDATE feedback SET status = :status, round = :round, updated_at = :updated_at WHERE id = :id',
    );
    this.#selectOne = db.handle.prepare<{ id: string }, FeedbackRow>(
      `SELECT ${COLUMNS} FROM feedback WHERE id = :id`,
    );
    this.#selectByTask = db.handle.prepare<{ taskId: string }, FeedbackRow>(
      `SELECT ${COLUMNS} FROM feedback WHERE task_id = :taskId ORDER BY created_at, id`,
    );
    this.#selectByMission = db.handle.prepare<{ missionId: string }, FeedbackRow>(
      `SELECT ${F_COLUMNS} FROM feedback f
       JOIN mission_tasks t ON t.id = f.task_id
       WHERE t.mission_id = :missionId
       ORDER BY f.created_at, f.id`,
    );
    this.#selectByStatus = db.handle.prepare<{ statuses: string }, FeedbackRow>(
      `SELECT ${COLUMNS} FROM feedback
       WHERE status IN (SELECT value FROM json_each(:statuses))
       ORDER BY created_at, id`,
    );
  }

  create(item: FeedbackItem): FeedbackItem {
    this.#insert.run(toRow(item));
    return item;
  }

  get(id: FeedbackId): FeedbackItem | undefined {
    const row = this.#selectOne.get({ id });
    return row ? fromRow(row) : undefined;
  }

  listByTask(taskId: TaskId): readonly FeedbackItem[] {
    return this.#selectByTask.all({ taskId }).map(fromRow);
  }

  listByMission(missionId: MissionId): readonly FeedbackItem[] {
    return this.#selectByMission.all({ missionId }).map(fromRow);
  }

  listByStatus(statuses: readonly FeedbackStatus[]): readonly FeedbackItem[] {
    if (statuses.length === 0) return [];
    return this.#selectByStatus.all({ statuses: toJson(statuses) }).map(fromRow);
  }

  update(id: FeedbackId, patch: Partial<Pick<FeedbackItem, 'status' | 'round'>>): FeedbackItem {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (current === undefined) throw TandemiseError.notFound('Feedback', id);
      const next: FeedbackItem = { ...current, ...patch, updatedAt: this.#clock.now() };
      this.#update.run({ id, status: next.status, round: next.round, updated_at: next.updatedAt });
      return next;
    });
  }
}
