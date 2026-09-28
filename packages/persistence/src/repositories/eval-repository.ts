import { TandemiseError, asId, type EvalCaseId, type EvalRunId, type EvalSuiteId, type EvalTrialId, type WorkspaceId } from '@tandemise/shared';
import type {
  EvalCandidate, EvalCase, EvalCaseProvenance, EvalCaseSnapshot, EvalRepositoryPort, EvalRun, EvalRunStatus,
  EvalSuite, EvalTrial, EvalTrialStatus, EvalVariantLabel, TrialScore,
} from '@tandemise/domain';
import { DEFAULT_RETRY_POLICY, EMPTY_KNOWLEDGE } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';
import { applyPatch } from '../patch.js';

interface SuiteRow {
  id: string;
  workspace_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface CaseRow {
  id: string;
  suite_id: string;
  name: string;
  repository_id: string;
  base_sha: string;
  snapshot: string;
  provenance: string;
  created_by: string | null;
  created_at: string;
}

interface RunRow {
  id: string;
  suite_id: string;
  workspace_id: string;
  status: string;
  reason: string | null;
  repeats: number;
  spend_cap_usd: number;
  candidate: string;
  variants: string;
  scorecard: string | null;
  started_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface TrialRow {
  id: string;
  run_id: string;
  case_id: string;
  variant: string;
  repeat: number;
  seq: number;
  mission_id: string | null;
  status: string;
  reason: string | null;
  score: string | null;
  started_at: string | null;
  finished_at: string | null;
}

const SUITE_COLUMNS = 'id, workspace_id, name, created_at, updated_at';
const CASE_COLUMNS = 'id, suite_id, name, repository_id, base_sha, snapshot, provenance, created_by, created_at';
const RUN_COLUMNS = 'id, suite_id, workspace_id, status, reason, repeats, spend_cap_usd, candidate, variants, scorecard, started_by, created_at, started_at, finished_at';
const TRIAL_COLUMNS = 'id, run_id, case_id, variant, repeat, seq, mission_id, status, reason, score, started_at, finished_at';

function suiteFromRow(r: SuiteRow): EvalSuite {
  return {
    id: asId<'EvalSuiteId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function caseToRow(c: EvalCase): CaseRow {
  return {
    id: c.id,
    suite_id: c.suiteId,
    name: c.name,
    repository_id: c.snapshot.repositoryId,
    base_sha: c.snapshot.baseSha,
    snapshot: toJson(c.snapshot),
    provenance: toJson(c.provenance),
    created_by: c.createdBy,
    created_at: c.createdAt,
  };
}

// A corrupt or hand-edited row must not take the daemon down on read (see
// `parseJson`'s doc comment); these are real, valid shapes rather than an
// unsafe cast, exactly like `FAIL_CLOSED_EXECUTION` elsewhere.
const FALLBACK_SNAPSHOT: EvalCaseSnapshot = {
  repositoryId: asId<'RepositoryId'>(''),
  baseSha: '',
  inputs: [],
  step: {
    key: '', title: '', roleId: '', objective: '', expectedOutputs: [], inputArtifacts: [],
    requiredCapabilities: [], completionGate: '', retryPolicy: DEFAULT_RETRY_POLICY, maxWallTimeMs: 0,
    modelPolicy: null, stepModel: null, stepSkills: [],
  },
  mission: { title: '', goal: '', constraints: [], knowledge: EMPTY_KNOWLEDGE, decisions: [], answers: [] },
  criteria: [],
};
const FALLBACK_PROVENANCE: EvalCaseProvenance = {
  missionId: asId<'MissionId'>(''),
  missionTitle: '',
  taskId: asId<'TaskId'>(''),
  runId: asId<'RunId'>(''),
  inputArtifactIds: [],
  referenceOutputs: [],
};

function caseFromRow(r: CaseRow): EvalCase {
  return {
    id: asId<'EvalCaseId'>(r.id),
    suiteId: asId<'EvalSuiteId'>(r.suite_id),
    name: r.name,
    snapshot: parseJson<EvalCaseSnapshot>(r.snapshot, FALLBACK_SNAPSHOT),
    provenance: parseJson<EvalCaseProvenance>(r.provenance, FALLBACK_PROVENANCE),
    createdBy: r.created_by === null ? null : asId<'PersonId'>(r.created_by),
    createdAt: r.created_at,
  };
}

function runToRow(run: EvalRun): RunRow {
  return {
    id: run.id,
    suite_id: run.suiteId,
    workspace_id: run.workspaceId,
    status: run.status,
    reason: run.reason,
    repeats: run.repeats,
    spend_cap_usd: run.spendCapUsd,
    candidate: toJson(run.candidate),
    variants: toJson(run.variants),
    scorecard: run.scorecard === null ? null : toJson(run.scorecard),
    started_by: run.startedBy,
    created_at: run.createdAt,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
  };
}

const EMPTY_CANDIDATE: EvalCandidate = { kind: 'setup', folder: '' };

function runFromRow(r: RunRow): EvalRun {
  return {
    id: asId<'EvalRunId'>(r.id),
    suiteId: asId<'EvalSuiteId'>(r.suite_id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    status: r.status as EvalRunStatus,
    reason: r.reason,
    repeats: r.repeats,
    spendCapUsd: r.spend_cap_usd,
    candidate: parseJson<EvalCandidate>(r.candidate, EMPTY_CANDIDATE),
    variants: parseJson<EvalRun['variants']>(r.variants, { baseline: { label: 'baseline', roles: {} }, candidate: { label: 'candidate', roles: {} } }),
    scorecard: r.scorecard === null ? null : (parseJson<unknown>(r.scorecard, null)),
    startedBy: r.started_by === null ? null : asId<'PersonId'>(r.started_by),
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

function trialToRow(t: EvalTrial): TrialRow {
  return {
    id: t.id,
    run_id: t.runId,
    case_id: t.caseId,
    variant: t.variant,
    repeat: t.repeat,
    seq: t.seq,
    mission_id: t.missionId,
    status: t.status,
    reason: t.reason,
    score: t.score === null ? null : toJson(t.score),
    started_at: t.startedAt,
    finished_at: t.finishedAt,
  };
}

function trialFromRow(r: TrialRow): EvalTrial {
  return {
    id: asId<'EvalTrialId'>(r.id),
    runId: asId<'EvalRunId'>(r.run_id),
    caseId: asId<'EvalCaseId'>(r.case_id),
    variant: r.variant as EvalVariantLabel,
    repeat: r.repeat,
    seq: r.seq,
    missionId: r.mission_id === null ? null : asId<'MissionId'>(r.mission_id),
    status: r.status as EvalTrialStatus,
    reason: r.reason,
    score: r.score === null ? null : parseJson<TrialScore | null>(r.score, null),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/**
 * Eval suites, saved cases, and the runs and trials tried against them (P3b
 * spec Part B, §B6). Follows `skill-repository.ts`: one prepared statement
 * per method, `update*` inside `#db.transaction`.
 */
export class SqliteEvalRepository implements EvalRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #insertSuite;
  readonly #selectSuite;
  readonly #listSuites;
  readonly #deleteSuite;
  readonly #insertCase;
  readonly #selectCase;
  readonly #listCases;
  readonly #deleteCase;
  readonly #insertRun;
  readonly #selectRun;
  readonly #updateRun;
  readonly #listRuns;
  readonly #activeRuns;
  readonly #insertTrial;
  readonly #selectTrial;
  readonly #updateTrial;
  readonly #listTrials;

  constructor(db: TandemiseDatabase) {
    this.#db = db;
    this.#insertSuite = db.handle.prepare<SuiteRow>(
      `INSERT INTO eval_suites (${SUITE_COLUMNS}) VALUES (:id, :workspace_id, :name, :created_at, :updated_at)`,
    );
    this.#selectSuite = db.handle.prepare<{ id: string }, SuiteRow>(`SELECT ${SUITE_COLUMNS} FROM eval_suites WHERE id = :id`);
    // A suite's case count, so the list screen shows it without a second round trip per suite.
    this.#listSuites = db.handle.prepare<{ workspaceId: string }, SuiteRow & { cases: number }>(
      `SELECT s.id, s.workspace_id, s.name, s.created_at, s.updated_at, COUNT(c.id) AS cases
       FROM eval_suites s LEFT JOIN eval_cases c ON c.suite_id = s.id
       WHERE s.workspace_id = :workspaceId
       GROUP BY s.id
       ORDER BY s.name COLLATE NOCASE, s.id`,
    );
    this.#deleteSuite = db.handle.prepare<{ id: string }>('DELETE FROM eval_suites WHERE id = :id');
    this.#insertCase = db.handle.prepare<CaseRow>(
      `INSERT INTO eval_cases (${CASE_COLUMNS}) VALUES (
        :id, :suite_id, :name, :repository_id, :base_sha, :snapshot, :provenance, :created_by, :created_at)`,
    );
    this.#selectCase = db.handle.prepare<{ id: string }, CaseRow>(`SELECT ${CASE_COLUMNS} FROM eval_cases WHERE id = :id`);
    this.#listCases = db.handle.prepare<{ suiteId: string }, CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM eval_cases WHERE suite_id = :suiteId ORDER BY created_at, id`,
    );
    this.#deleteCase = db.handle.prepare<{ id: string }>('DELETE FROM eval_cases WHERE id = :id');
    this.#insertRun = db.handle.prepare<RunRow>(
      `INSERT INTO eval_runs (${RUN_COLUMNS}) VALUES (
        :id, :suite_id, :workspace_id, :status, :reason, :repeats, :spend_cap_usd, :candidate, :variants, :scorecard,
        :started_by, :created_at, :started_at, :finished_at)`,
    );
    this.#selectRun = db.handle.prepare<{ id: string }, RunRow>(`SELECT ${RUN_COLUMNS} FROM eval_runs WHERE id = :id`);
    this.#updateRun = db.handle.prepare<RunRow>(
      `UPDATE eval_runs SET status = :status, reason = :reason, scorecard = :scorecard, started_at = :started_at, finished_at = :finished_at
       WHERE id = :id`,
    );
    this.#listRuns = db.handle.prepare<{ suiteId: string }, RunRow>(
      `SELECT ${RUN_COLUMNS} FROM eval_runs WHERE suite_id = :suiteId ORDER BY created_at, id`,
    );
    // One eval run per workspace at a time is a rule the service enforces; this
    // is its read, across every workspace, oldest first.
    this.#activeRuns = db.handle.prepare<[], RunRow>(
      `SELECT ${RUN_COLUMNS} FROM eval_runs WHERE status IN ('queued','running') ORDER BY created_at, id`,
    );
    this.#insertTrial = db.handle.prepare<TrialRow>(
      `INSERT INTO eval_trials (${TRIAL_COLUMNS}) VALUES (
        :id, :run_id, :case_id, :variant, :repeat, :seq, :mission_id, :status, :reason, :score, :started_at, :finished_at)`,
    );
    this.#selectTrial = db.handle.prepare<{ id: string }, TrialRow>(`SELECT ${TRIAL_COLUMNS} FROM eval_trials WHERE id = :id`);
    this.#updateTrial = db.handle.prepare<TrialRow>(
      `UPDATE eval_trials SET status = :status, reason = :reason, score = :score, mission_id = :mission_id,
         started_at = :started_at, finished_at = :finished_at
       WHERE id = :id`,
    );
    this.#listTrials = db.handle.prepare<{ runId: string }, TrialRow>(
      `SELECT ${TRIAL_COLUMNS} FROM eval_trials WHERE run_id = :runId ORDER BY seq`,
    );
  }

  createSuite(suite: EvalSuite): EvalSuite {
    this.#insertSuite.run({
      id: suite.id, workspace_id: suite.workspaceId, name: suite.name,
      created_at: suite.createdAt, updated_at: suite.updatedAt,
    });
    return suite;
  }

  getSuite(id: EvalSuiteId): EvalSuite | undefined {
    const row = this.#selectSuite.get({ id });
    return row === undefined ? undefined : suiteFromRow(row);
  }

  listSuites(workspaceId: WorkspaceId): readonly (EvalSuite & { readonly cases: number })[] {
    return this.#listSuites.all({ workspaceId }).map((row) => ({ ...suiteFromRow(row), cases: row.cases }));
  }

  deleteSuite(id: EvalSuiteId): void {
    this.#deleteSuite.run({ id });
  }

  insertCase(c: EvalCase): EvalCase {
    this.#insertCase.run(caseToRow(c));
    return c;
  }

  getCase(id: EvalCaseId): EvalCase | undefined {
    const row = this.#selectCase.get({ id });
    return row === undefined ? undefined : caseFromRow(row);
  }

  listCases(suiteId: EvalSuiteId): readonly EvalCase[] {
    return this.#listCases.all({ suiteId }).map(caseFromRow);
  }

  deleteCase(id: EvalCaseId): void {
    this.#deleteCase.run({ id });
  }

  insertRun(run: EvalRun): EvalRun {
    this.#insertRun.run(runToRow(run));
    return run;
  }

  getRun(id: EvalRunId): EvalRun | undefined {
    const row = this.#selectRun.get({ id });
    return row === undefined ? undefined : runFromRow(row);
  }

  updateRun(id: EvalRunId, patch: Partial<Pick<EvalRun, 'status' | 'reason' | 'scorecard' | 'startedAt' | 'finishedAt'>>): EvalRun {
    return this.#db.transaction(() => {
      const current = this.getRun(id);
      if (current === undefined) throw TandemiseError.notFound('EvalRun', id);
      const next = applyPatch(current, patch);
      this.#updateRun.run(runToRow(next));
      return next;
    });
  }

  listRuns(suiteId: EvalSuiteId): readonly EvalRun[] {
    return this.#listRuns.all({ suiteId }).map(runFromRow);
  }

  activeRuns(): readonly EvalRun[] {
    return this.#activeRuns.all().map(runFromRow);
  }

  insertTrials(trials: readonly EvalTrial[]): void {
    this.#db.transaction(() => {
      for (const trial of trials) this.#insertTrial.run(trialToRow(trial));
    });
  }

  getTrial(id: EvalTrialId): EvalTrial | undefined {
    const row = this.#selectTrial.get({ id });
    return row === undefined ? undefined : trialFromRow(row);
  }

  updateTrial(id: EvalTrialId, patch: Partial<Pick<EvalTrial, 'status' | 'reason' | 'score' | 'missionId' | 'startedAt' | 'finishedAt'>>): EvalTrial {
    return this.#db.transaction(() => {
      const current = this.getTrial(id);
      if (current === undefined) throw TandemiseError.notFound('EvalTrial', id);
      const next = applyPatch(current, patch);
      this.#updateTrial.run(trialToRow(next));
      return next;
    });
  }

  listTrials(runId: EvalRunId): readonly EvalTrial[] {
    return this.#listTrials.all({ runId }).map(trialFromRow);
  }
}
