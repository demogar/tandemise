import { TandemiseError, asId, type EvalRunId, type MissionId, type TaskId, type Timestamp, type WorkspaceId } from '@tandemise/shared';
import type {
  BrainPass, BrainProposal, BrainProposalState, BrainRecordRepositoryPort, WorkspaceBrain,
  WorkspaceBrainRepositoryPort, WriterId,
} from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { applyPatch } from '../patch.js';

interface BrainRow {
  workspace_id: string;
  remote: string | null;
  default_branch: string;
  clone_path: string;
  writer_id: string;
  last_pulled_sha: string | null;
  last_pushed_sha: string | null;
  last_sync_at: string | null;
  last_sync_error: string | null;
  fallback_branch: string | null;
  linked_at: string;
}

const toBrainRow = (b: WorkspaceBrain): BrainRow => ({
  workspace_id: b.workspaceId,
  remote: b.remote,
  default_branch: b.defaultBranch,
  clone_path: b.clonePath,
  writer_id: b.writerId,
  last_pulled_sha: b.lastPulledSha,
  last_pushed_sha: b.lastPushedSha,
  last_sync_at: b.lastSyncAt,
  last_sync_error: b.lastSyncError,
  fallback_branch: b.fallbackBranch,
  linked_at: b.linkedAt,
});

const fromBrainRow = (r: BrainRow): WorkspaceBrain => ({
  workspaceId: asId<'WorkspaceId'>(r.workspace_id),
  remote: r.remote,
  defaultBranch: r.default_branch,
  clonePath: r.clone_path,
  writerId: r.writer_id as WriterId,
  lastPulledSha: r.last_pulled_sha,
  lastPushedSha: r.last_pushed_sha,
  lastSyncAt: r.last_sync_at as Timestamp | null,
  lastSyncError: r.last_sync_error,
  fallbackBranch: r.fallback_branch,
  linkedAt: r.linked_at as Timestamp,
});

/** A project's link to its brain on this machine; see migration 023. */
export class SqliteWorkspaceBrainRepository implements WorkspaceBrainRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #insert;
  readonly #update;
  readonly #select;
  readonly #all;
  readonly #delete;

  constructor(db: TandemiseDatabase) {
    this.#db = db;
    const cols = 'workspace_id, remote, default_branch, clone_path, writer_id, last_pulled_sha, last_pushed_sha, last_sync_at, last_sync_error, fallback_branch, linked_at';
    this.#insert = db.handle.prepare<BrainRow>(
      `INSERT INTO workspace_brains (${cols}) VALUES (:workspace_id, :remote, :default_branch, :clone_path, :writer_id,
        :last_pulled_sha, :last_pushed_sha, :last_sync_at, :last_sync_error, :fallback_branch, :linked_at)`,
    );
    this.#update = db.handle.prepare<BrainRow>(
      `UPDATE workspace_brains SET remote = :remote, default_branch = :default_branch, clone_path = :clone_path,
         writer_id = :writer_id, last_pulled_sha = :last_pulled_sha, last_pushed_sha = :last_pushed_sha,
         last_sync_at = :last_sync_at, last_sync_error = :last_sync_error, fallback_branch = :fallback_branch,
         linked_at = :linked_at
       WHERE workspace_id = :workspace_id`,
    );
    this.#select = db.handle.prepare<{ id: string }, BrainRow>(`SELECT ${cols} FROM workspace_brains WHERE workspace_id = :id`);
    this.#all = db.handle.prepare<[], BrainRow>(`SELECT ${cols} FROM workspace_brains ORDER BY linked_at, workspace_id`);
    this.#delete = db.handle.prepare<{ id: string }>('DELETE FROM workspace_brains WHERE workspace_id = :id');
  }

  get(workspaceId: WorkspaceId): WorkspaceBrain | undefined {
    const row = this.#select.get({ id: workspaceId });
    return row === undefined ? undefined : fromBrainRow(row);
  }

  list(): readonly WorkspaceBrain[] {
    return this.#all.all().map(fromBrainRow);
  }

  create(brain: WorkspaceBrain): void {
    this.#insert.run(toBrainRow(brain));
  }

  update(workspaceId: WorkspaceId, patch: Partial<Omit<WorkspaceBrain, 'workspaceId'>>): WorkspaceBrain {
    return this.#db.transaction(() => {
      const current = this.get(workspaceId);
      if (current === undefined) throw TandemiseError.notFound('WorkspaceBrain', workspaceId);
      const next = applyPatch(current, patch);
      this.#update.run(toBrainRow(next));
      return next;
    });
  }

  remove(workspaceId: WorkspaceId): void {
    this.#delete.run({ id: workspaceId });
  }
}

interface PassRow {
  id: string;
  workspace_id: string;
  mission_id: string | null;
  task_id: string | null;
  kind: string;
  signal: string;
  runtime_profile_id: string | null;
  model: string | null;
  status: string;
  reason: string | null;
  has_usage: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  wall_time_ms: number | null;
  created_at: string;
}

interface ProposalRow {
  id: string;
  workspace_id: string;
  lesson_ids: string;
  targets: string;
  classification: string;
  reasons: string;
  branch: string;
  state: string;
  eval_run_id: string | null;
  verdict: string | null;
  pr_url: string | null;
  applied_sha: string | null;
  created_at: string;
  updated_at: string;
}

const PASS_COLUMNS = `id, workspace_id, mission_id, task_id, kind, signal, runtime_profile_id, model, status, reason,
  has_usage, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, wall_time_ms, created_at`;
const PROPOSAL_COLUMNS = `id, workspace_id, lesson_ids, targets, classification, reasons, branch, state, eval_run_id,
  verdict, pr_url, applied_sha, created_at, updated_at`;

function fromPassRow(r: PassRow): BrainPass {
  const usage = r.has_usage === 1
    ? {
        ...(r.input_tokens === null ? {} : { inputTokens: r.input_tokens }),
        ...(r.output_tokens === null ? {} : { outputTokens: r.output_tokens }),
        ...(r.cache_read_tokens === null ? {} : { cacheReadTokens: r.cache_read_tokens }),
        ...(r.cache_write_tokens === null ? {} : { cacheWriteTokens: r.cache_write_tokens }),
        costUsd: r.cost_usd,
        ...(r.wall_time_ms === null ? {} : { wallTimeMs: r.wall_time_ms }),
      }
    : null;
  return {
    id: r.id,
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    missionId: r.mission_id === null ? null : (asId<'MissionId'>(r.mission_id) as MissionId),
    taskId: r.task_id === null ? null : (asId<'TaskId'>(r.task_id) as TaskId),
    kind: r.kind as BrainPass['kind'],
    signal: r.signal,
    runtimeProfileId: r.runtime_profile_id,
    model: r.model,
    status: r.status as BrainPass['status'],
    reason: r.reason,
    usage,
    createdAt: r.created_at as Timestamp,
  };
}

function fromProposalRow(r: ProposalRow): BrainProposal {
  return {
    id: r.id,
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    lessonIds: JSON.parse(r.lesson_ids) as string[],
    targets: JSON.parse(r.targets) as string[],
    classification: r.classification as BrainProposal['classification'],
    reasons: JSON.parse(r.reasons) as string[],
    branch: r.branch,
    state: r.state as BrainProposalState,
    evalRunId: r.eval_run_id === null ? null : (asId<'EvalRunId'>(r.eval_run_id) as EvalRunId),
    verdict: r.verdict as BrainProposal['verdict'],
    prUrl: r.pr_url,
    appliedSha: r.applied_sha,
    createdAt: r.created_at as Timestamp,
    updatedAt: r.updated_at as Timestamp,
  };
}

/** The brain's model passes and promotions; see migration 023. */
export class SqliteBrainRecordRepository implements BrainRecordRepositoryPort {
  readonly #insertPass;
  readonly #passes;
  readonly #upsertProposal;
  readonly #proposal;
  readonly #proposals;

  constructor(db: TandemiseDatabase) {
    this.#insertPass = db.handle.prepare<PassRow>(
      `INSERT INTO brain_passes (${PASS_COLUMNS}) VALUES (:id, :workspace_id, :mission_id, :task_id, :kind, :signal,
        :runtime_profile_id, :model, :status, :reason, :has_usage, :input_tokens, :output_tokens, :cache_read_tokens,
        :cache_write_tokens, :cost_usd, :wall_time_ms, :created_at)`,
    );
    this.#passes = db.handle.prepare<{ ws: string; since: string }, PassRow>(
      `SELECT ${PASS_COLUMNS} FROM brain_passes WHERE workspace_id = :ws AND created_at >= :since ORDER BY created_at, id`,
    );
    this.#upsertProposal = db.handle.prepare<ProposalRow>(
      `INSERT INTO brain_proposals (${PROPOSAL_COLUMNS}) VALUES (:id, :workspace_id, :lesson_ids, :targets, :classification,
        :reasons, :branch, :state, :eval_run_id, :verdict, :pr_url, :applied_sha, :created_at, :updated_at)
       ON CONFLICT(id) DO UPDATE SET lesson_ids = excluded.lesson_ids, targets = excluded.targets,
         classification = excluded.classification, reasons = excluded.reasons, branch = excluded.branch,
         state = excluded.state, eval_run_id = excluded.eval_run_id, verdict = excluded.verdict,
         pr_url = excluded.pr_url, applied_sha = excluded.applied_sha, updated_at = excluded.updated_at`,
    );
    this.#proposal = db.handle.prepare<{ id: string }, ProposalRow>(`SELECT ${PROPOSAL_COLUMNS} FROM brain_proposals WHERE id = :id`);
    this.#proposals = db.handle.prepare<{ ws: string }, ProposalRow>(
      `SELECT ${PROPOSAL_COLUMNS} FROM brain_proposals WHERE workspace_id = :ws ORDER BY updated_at DESC, id`,
    );
  }

  insertPass(p: BrainPass): void {
    const u = p.usage;
    this.#insertPass.run({
      id: p.id,
      workspace_id: p.workspaceId,
      mission_id: p.missionId,
      task_id: p.taskId,
      kind: p.kind,
      signal: p.signal,
      runtime_profile_id: p.runtimeProfileId,
      model: p.model,
      status: p.status,
      reason: p.reason,
      has_usage: u === null ? 0 : 1,
      input_tokens: u?.inputTokens ?? null,
      output_tokens: u?.outputTokens ?? null,
      cache_read_tokens: u?.cacheReadTokens ?? null,
      cache_write_tokens: u?.cacheWriteTokens ?? null,
      cost_usd: u?.costUsd ?? null,
      wall_time_ms: u?.wallTimeMs ?? null,
      created_at: p.createdAt,
    });
  }

  passes(workspaceId: WorkspaceId, since: Timestamp): readonly BrainPass[] {
    return this.#passes.all({ ws: workspaceId, since }).map(fromPassRow);
  }

  upsertProposal(p: BrainProposal): void {
    this.#upsertProposal.run({
      id: p.id,
      workspace_id: p.workspaceId,
      lesson_ids: JSON.stringify(p.lessonIds),
      targets: JSON.stringify(p.targets),
      classification: p.classification,
      reasons: JSON.stringify(p.reasons),
      branch: p.branch,
      state: p.state,
      eval_run_id: p.evalRunId,
      verdict: p.verdict,
      pr_url: p.prUrl,
      applied_sha: p.appliedSha,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
    });
  }

  proposal(id: string): BrainProposal | undefined {
    const row = this.#proposal.get({ id });
    return row === undefined ? undefined : fromProposalRow(row);
  }

  proposals(workspaceId: WorkspaceId): readonly BrainProposal[] {
    return this.#proposals.all({ ws: workspaceId }).map(fromProposalRow);
  }
}
