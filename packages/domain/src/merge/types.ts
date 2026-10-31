import type { MissionId, Timestamp, WorkspaceId } from '@tandemise/shared';

/**
 * The merge decision's audit row (#53 §8.6). Append-only except the five
 * fields `MergeDecisionRepositoryPort.update` may set afterwards.
 */
export type MergeVerdict = 'merge' | 'ask';

export interface MergeFactor {
  /** The rule as written (`ci.state == PASS`, `never: **\/migrations/**`) or a hard rule's name. */
  readonly rule: string;
  readonly kind: 'hard' | 'never' | 'requires' | 'score';
  readonly matched: boolean;
  readonly points: number;
  /** Facts the rule read that were not measured. */
  readonly unmeasured: readonly string[];
  /** Changed paths that matched it, for a path rule. */
  readonly paths: readonly string[];
  /** The rule's own words, for a score line. */
  readonly why?: string;
}

export interface MergeDecision {
  readonly verdict: MergeVerdict;
  readonly score: number;
  /** `autoMergeAtMost`, or null when the policy can't be read. */
  readonly allowed: number | null;
  /** What the policy would decide with auto-merge on: "what would have happened". */
  readonly wouldMerge: boolean;
  readonly factors: readonly MergeFactor[];
  /** Sentences, in order, for an ask. Empty for a merge. */
  readonly reasons: readonly string[];
}

export interface MergeDecisionRecord {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly missionId: MissionId;
  /** `owner/name`. */
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly policyRef: string;
  readonly verdict: MergeVerdict;
  readonly score: number;
  readonly allowed: number | null;
  readonly wouldMerge: boolean;
  readonly factors: readonly MergeFactor[];
  readonly reasons: readonly string[];
  /** Every input fact, as measured, so a backtest can replay it. */
  readonly facts: Readonly<Record<string, unknown>>;
  readonly decidedAt: Timestamp;
  readonly voidedAt: Timestamp | null;
  readonly commentId: number | null;
  readonly mergedAt: Timestamp | null;
  readonly mergedBy: string | null;
  readonly mergeSha: string | null;
}

export type MergeDecisionPatch = Pick<Partial<MergeDecisionRecord>, 'voidedAt' | 'commentId' | 'mergedAt' | 'mergedBy' | 'mergeSha'>;
