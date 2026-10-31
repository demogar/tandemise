import { asId, type MissionId, type Timestamp, type WorkspaceId } from '@tandemise/shared';
import type {
  MergeDecisionPatch, MergeDecisionRecord, MergeDecisionRepositoryPort, OutcomeEvent, OutcomeRepositoryPort,
  PlanDecision, PlanDecisionRepositoryPort,
} from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';

/** Plan decisions, merge decisions and outcomes (#53); see migration 022. */
interface PlanDecisionRow {
  id: string; mission_id: string; policy_ref: string; basis: string; profile: string; lane: string; lane_because: string;
  workflow_id: string; modules: string; dropped: string; steps: string; approvals: string; skipped: string;
  tiebreak: string | null; lightened_by_person: number; created_at: string;
}

export class SqlitePlanDecisionRepository implements PlanDecisionRepositoryPort {
  readonly #insert;
  readonly #byMission;

  constructor(db: TandemiseDatabase) {
    this.#insert = db.handle.prepare<PlanDecisionRow>(
      `INSERT INTO plan_decisions (id, mission_id, policy_ref, basis, profile, lane, lane_because, workflow_id, modules, dropped,
         steps, approvals, skipped, tiebreak, lightened_by_person, created_at)
       VALUES (:id, :mission_id, :policy_ref, :basis, :profile, :lane, :lane_because, :workflow_id, :modules, :dropped,
         :steps, :approvals, :skipped, :tiebreak, :lightened_by_person, :created_at)`,
    );
    this.#byMission = db.handle.prepare<{ missionId: string }, PlanDecisionRow>(
      'SELECT * FROM plan_decisions WHERE mission_id = :missionId ORDER BY created_at, id',
    );
  }

  create(d: PlanDecision): void {
    this.#insert.run({
      id: d.id, mission_id: d.missionId, policy_ref: d.policyRef, basis: d.basis, profile: JSON.stringify(d.profile),
      lane: d.lane, lane_because: d.laneBecause, workflow_id: d.workflowId, modules: JSON.stringify(d.modules),
      dropped: JSON.stringify(d.dropped), steps: JSON.stringify(d.steps), approvals: JSON.stringify(d.approvals),
      skipped: JSON.stringify(d.skipped), tiebreak: d.tiebreak === null ? null : JSON.stringify(d.tiebreak),
      lightened_by_person: d.lightenedByPerson ? 1 : 0, created_at: d.createdAt,
    });
  }

  latest(missionId: MissionId): PlanDecision | undefined {
    return this.listByMission(missionId).at(-1);
  }

  listByMission(missionId: MissionId): readonly PlanDecision[] {
    return this.#byMission.all({ missionId }).map((r) => ({
      id: r.id,
      missionId: asId<'MissionId'>(r.mission_id) as MissionId,
      policyRef: r.policy_ref,
      basis: r.basis as PlanDecision['basis'],
      profile: JSON.parse(r.profile) as PlanDecision['profile'],
      lane: r.lane as PlanDecision['lane'],
      laneBecause: r.lane_because,
      workflowId: r.workflow_id,
      modules: JSON.parse(r.modules) as string[],
      dropped: JSON.parse(r.dropped) as PlanDecision['dropped'],
      steps: JSON.parse(r.steps) as PlanDecision['steps'],
      approvals: JSON.parse(r.approvals) as PlanDecision['approvals'],
      skipped: JSON.parse(r.skipped) as string[],
      tiebreak: r.tiebreak === null ? null : JSON.parse(r.tiebreak) as PlanDecision['tiebreak'],
      lightenedByPerson: r.lightened_by_person === 1,
      createdAt: r.created_at as Timestamp,
    }));
  }
}

interface MergeDecisionRow {
  id: string; workspace_id: string; mission_id: string; repo: string; pr_number: number; head_sha: string; policy_ref: string;
  verdict: string; score: number; allowed: number | null; would_merge: number; factors: string; reasons: string; facts: string;
  decided_at: string; voided_at: string | null; comment_id: number | null; merged_at: string | null; merged_by: string | null; merge_sha: string | null;
}

const fromMergeRow = (r: MergeDecisionRow): MergeDecisionRecord => ({
  id: r.id,
  workspaceId: asId<'WorkspaceId'>(r.workspace_id) as WorkspaceId,
  missionId: asId<'MissionId'>(r.mission_id) as MissionId,
  repo: r.repo,
  prNumber: r.pr_number,
  headSha: r.head_sha,
  policyRef: r.policy_ref,
  verdict: r.verdict as MergeDecisionRecord['verdict'],
  score: r.score,
  allowed: r.allowed,
  wouldMerge: r.would_merge === 1,
  factors: JSON.parse(r.factors) as MergeDecisionRecord['factors'],
  reasons: JSON.parse(r.reasons) as string[],
  facts: JSON.parse(r.facts) as Record<string, unknown>,
  decidedAt: r.decided_at as Timestamp,
  voidedAt: r.voided_at as Timestamp | null,
  commentId: r.comment_id,
  mergedAt: r.merged_at as Timestamp | null,
  mergedBy: r.merged_by,
  mergeSha: r.merge_sha,
});

export class SqliteMergeDecisionRepository implements MergeDecisionRepositoryPort {
  readonly #insert;
  readonly #one;
  readonly #latestFor;
  readonly #byMission;
  readonly #byWorkspace;
  readonly #update;

  constructor(db: TandemiseDatabase) {
    this.#insert = db.handle.prepare<MergeDecisionRow>(
      `INSERT INTO merge_decisions (id, workspace_id, mission_id, repo, pr_number, head_sha, policy_ref, verdict, score, allowed,
         would_merge, factors, reasons, facts, decided_at, voided_at, comment_id, merged_at, merged_by, merge_sha)
       VALUES (:id, :workspace_id, :mission_id, :repo, :pr_number, :head_sha, :policy_ref, :verdict, :score, :allowed,
         :would_merge, :factors, :reasons, :facts, :decided_at, :voided_at, :comment_id, :merged_at, :merged_by, :merge_sha)`,
    );
    this.#one = db.handle.prepare<{ id: string }, MergeDecisionRow>('SELECT * FROM merge_decisions WHERE id = :id');
    this.#latestFor = db.handle.prepare<{ missionId: string; repo: string }, MergeDecisionRow>(
      'SELECT * FROM merge_decisions WHERE mission_id = :missionId AND repo = :repo ORDER BY decided_at DESC, id DESC LIMIT 1',
    );
    this.#byMission = db.handle.prepare<{ missionId: string }, MergeDecisionRow>(
      'SELECT * FROM merge_decisions WHERE mission_id = :missionId ORDER BY decided_at, id',
    );
    this.#byWorkspace = db.handle.prepare<{ workspaceId: string; since: string }, MergeDecisionRow>(
      'SELECT * FROM merge_decisions WHERE workspace_id = :workspaceId AND decided_at >= :since ORDER BY decided_at, id',
    );
    // Only these five fields ever change: the rest of the row is the decision as made.
    this.#update = db.handle.prepare<{ id: string; voided_at: string | null; comment_id: number | null; merged_at: string | null; merged_by: string | null; merge_sha: string | null }>(
      `UPDATE merge_decisions SET voided_at = :voided_at, comment_id = :comment_id, merged_at = :merged_at,
         merged_by = :merged_by, merge_sha = :merge_sha WHERE id = :id`,
    );
  }

  create(d: MergeDecisionRecord): void {
    this.#insert.run({
      id: d.id, workspace_id: d.workspaceId, mission_id: d.missionId, repo: d.repo, pr_number: d.prNumber, head_sha: d.headSha,
      policy_ref: d.policyRef, verdict: d.verdict, score: d.score, allowed: d.allowed, would_merge: d.wouldMerge ? 1 : 0,
      factors: JSON.stringify(d.factors), reasons: JSON.stringify(d.reasons), facts: JSON.stringify(d.facts),
      decided_at: d.decidedAt, voided_at: d.voidedAt, comment_id: d.commentId, merged_at: d.mergedAt, merged_by: d.mergedBy, merge_sha: d.mergeSha,
    });
  }

  get(id: string): MergeDecisionRecord | undefined {
    const row = this.#one.get({ id });
    return row === undefined ? undefined : fromMergeRow(row);
  }

  latestFor(missionId: MissionId, repo: string): MergeDecisionRecord | undefined {
    const row = this.#latestFor.get({ missionId, repo });
    return row === undefined ? undefined : fromMergeRow(row);
  }

  listByMission(missionId: MissionId): readonly MergeDecisionRecord[] {
    return this.#byMission.all({ missionId }).map(fromMergeRow);
  }

  listByWorkspace(workspaceId: WorkspaceId, sinceIso: string): readonly MergeDecisionRecord[] {
    return this.#byWorkspace.all({ workspaceId, since: sinceIso }).map(fromMergeRow);
  }

  update(id: string, patch: MergeDecisionPatch): void {
    const current = this.get(id);
    if (current === undefined) return;
    this.#update.run({
      id,
      voided_at: patch.voidedAt !== undefined ? patch.voidedAt : current.voidedAt,
      comment_id: patch.commentId !== undefined ? patch.commentId : current.commentId,
      merged_at: patch.mergedAt !== undefined ? patch.mergedAt : current.mergedAt,
      merged_by: patch.mergedBy !== undefined ? patch.mergedBy : current.mergedBy,
      merge_sha: patch.mergeSha !== undefined ? patch.mergeSha : current.mergeSha,
    });
  }
}

export class SqliteOutcomeRepository implements OutcomeRepositoryPort {
  readonly #insert;
  readonly #byWorkspace;

  constructor(db: TandemiseDatabase) {
    this.#insert = db.handle.prepare<{ id: string; workspace_id: string; mission_id: string | null; at: string; body: string }>(
      'INSERT OR IGNORE INTO outcomes (id, workspace_id, mission_id, at, body) VALUES (:id, :workspace_id, :mission_id, :at, :body)',
    );
    this.#byWorkspace = db.handle.prepare<{ workspaceId: string; since: string }, { body: string }>(
      'SELECT body FROM outcomes WHERE workspace_id = :workspaceId AND at >= :since ORDER BY at, id',
    );
  }

  append(o: OutcomeEvent & { readonly workspaceId: WorkspaceId }): void {
    const { workspaceId, ...event } = o;
    this.#insert.run({ id: event.id, workspace_id: workspaceId, mission_id: event.mission, at: event.at, body: JSON.stringify(event) });
  }

  listByWorkspace(workspaceId: WorkspaceId, sinceIso: string): readonly OutcomeEvent[] {
    return this.#byWorkspace.all({ workspaceId, since: sinceIso }).map((r) => JSON.parse(r.body) as OutcomeEvent);
  }
}
