import type { Lane, RiskLevel, TaskSize, TaskType } from '../planner/types.js';

/**
 * What happened to a mission's work after the fact (#53 §9.1): the `outcome`
 * op of the brain's ledger, verbatim. Until the brain lands (#51) these rows
 * live in the local `outcomes` table; Task 20 appends them to the ledger.
 */
export const OUTCOME_KINDS = [
  'merged_clean', 'merged_by_person', 'merged', 'reverted', 'broke_main', 'changes_requested',
  'held', 'closed_unmerged', 'step_result',
] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export interface OutcomeEvent {
  readonly op: 'outcome';
  readonly id: string;
  readonly at: string;
  readonly by: string;
  readonly mission: string;
  readonly tracker?: string;
  readonly lane: Lane;
  readonly profile: { readonly type: TaskType; readonly size: TaskSize; readonly risk: RiskLevel; readonly areas: readonly string[] };
  readonly kind: OutcomeKind;
  readonly step?: {
    readonly class: string;
    readonly model: string | null;
    readonly attempt: number;
    readonly gatePassed: boolean;
    readonly costUsd: number | null;
    readonly wallTimeMs: number | null;
    /** The task the outcome is about, so later outcomes (a hold, a revert) find its step result. */
    readonly taskKey?: string;
  };
  readonly merge?: { readonly verdict: 'merge' | 'ask'; readonly score: number; readonly pr: string };
}
