import { TandemiseError, asId, ids, type ArtifactId, type Clock, type MissionId, type QuestionId } from '@tandemise/shared';
import type { MissionQuestion, MissionQuestionRepositoryPort, QuestionInput, QuestionStatus } from '@tandemise/domain';
import { questionKey } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';

interface QuestionRow {
  id: string;
  mission_id: string;
  key: string;
  text: string;
  why: string;
  options: string;
  answer: string | null;
  answered_by: string | null;
  status: string;
  refinement_artifact_id: string | null;
  position: number;
  created_at: string;
  answered_at: string | null;
}

const COLUMNS = 'id, mission_id, key, text, why, options, answer, answered_by, status, refinement_artifact_id, position, created_at, answered_at';

function fromRow(r: QuestionRow): MissionQuestion {
  return {
    id: asId<'QuestionId'>(r.id),
    missionId: asId<'MissionId'>(r.mission_id),
    key: r.key,
    text: r.text,
    why: r.why,
    options: parseJson<readonly string[]>(r.options, []),
    status: r.status as QuestionStatus,
    answer: r.answer,
    answeredBy: r.answered_by,
    refinementArtifactId: r.refinement_artifact_id === null ? null : asId<'ArtifactId'>(r.refinement_artifact_id),
    position: r.position,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
  };
}

/**
 * The questions refinement asked a person, and their answers (P6 spec §4).
 *
 * A newer pass replaces the questions still open - they were asked about a
 * request the new pass has read again - but never an answered one: what the
 * person decided stays decided, and reaches the planner.
 */
export class SqliteMissionQuestionRepository implements MissionQuestionRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #clock: Clock;
  readonly #insert;
  readonly #selectOne;
  readonly #selectByMission;
  readonly #count;
  readonly #staleOpen;
  readonly #answer;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    this.#insert = db.handle.prepare<QuestionRow>(
      `INSERT INTO mission_questions (${COLUMNS}) VALUES (
        :id, :mission_id, :key, :text, :why, :options, :answer, :answered_by, :status, :refinement_artifact_id, :position, :created_at, :answered_at)`,
    );
    this.#selectOne = db.handle.prepare<{ id: string }, QuestionRow>(`SELECT ${COLUMNS} FROM mission_questions WHERE id = :id`);
    this.#selectByMission = db.handle.prepare<{ missionId: string }, QuestionRow>(
      `SELECT ${COLUMNS} FROM mission_questions WHERE mission_id = :missionId ORDER BY position, created_at, id`,
    );
    this.#count = db.handle.prepare<{ missionId: string }, { n: number }>(
      'SELECT count(*) AS n FROM mission_questions WHERE mission_id = :missionId',
    );
    this.#staleOpen = db.handle.prepare<{ missionId: string }>(
      "UPDATE mission_questions SET status = 'stale' WHERE mission_id = :missionId AND status = 'open'",
    );
    this.#answer = db.handle.prepare<{ id: string; answer: string; by: string; at: string }>(
      "UPDATE mission_questions SET status = 'answered', answer = :answer, answered_by = :by, answered_at = :at WHERE id = :id AND status = 'open'",
    );
  }

  get(id: QuestionId): MissionQuestion | undefined {
    const row = this.#selectOne.get({ id });
    return row === undefined ? undefined : fromRow(row);
  }

  listByMission(missionId: MissionId): readonly MissionQuestion[] {
    return this.#selectByMission.all({ missionId }).map(fromRow);
  }

  replaceOpen(missionId: MissionId, refinementArtifactId: ArtifactId, questions: readonly QuestionInput[]): readonly MissionQuestion[] {
    return this.#db.transaction(() => {
      this.#staleOpen.run({ missionId });
      // Q<n> numbers on across passes, so "Q1" always names one question.
      const offset = this.#count.get({ missionId })?.n ?? 0;
      const now = this.#clock.now();
      return questions.filter((q) => q.text.trim().length > 0).map((q, i) => {
        const row: QuestionRow = {
          id: ids.question(), mission_id: missionId, key: questionKey(offset + i), text: q.text.trim(), why: q.why.trim(),
          options: toJson([...new Set(q.options.map((o) => o.trim()).filter((o) => o.length > 0))]),
          answer: null, answered_by: null, status: 'open', refinement_artifact_id: refinementArtifactId,
          position: offset + i, created_at: now, answered_at: null,
        };
        this.#insert.run(row);
        return fromRow(row);
      });
    });
  }

  answer(id: QuestionId, text: string, answeredBy: string): MissionQuestion {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (current === undefined) throw TandemiseError.notFound('Question', id);
      if (current.status !== 'open') {
        throw new TandemiseError('CONFLICT', current.status === 'stale'
          ? `${current.key} was replaced by a newer proposal; answer the newer questions instead.`
          : `${current.key} is already answered.`, { details: { questionId: id, status: current.status } });
      }
      this.#answer.run({ id, answer: text.trim(), by: answeredBy, at: this.#clock.now() });
      return this.get(id)!;
    });
  }
}
