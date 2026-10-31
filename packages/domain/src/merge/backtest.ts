import type { OutcomeEvent } from '../brain/outcomes.js';
import { decideMerge, type MergeFacts } from './decide.js';
import type { MergePolicy } from './policy.js';
import type { MergeDecisionRecord, MergeVerdict } from './types.js';

/**
 * A merge policy judged against what already happened (#53 §9.3): both the
 * current and the candidate policy replayed over the stored facts of past
 * decisions, with auto-merge on, and the PRs whose verdict changes named with
 * whether they were later reverted or broke main. Computed by the daemon from
 * stored facts; whoever proposes a policy never scores it.
 */
export const BACKTEST_WINDOW_DAYS = 90;

export interface BacktestResult {
  readonly window: { readonly from: string; readonly to: string };
  readonly total: number;
  readonly mergedCurrent: number;
  readonly mergedCandidate: number;
  readonly changed: readonly { readonly decisionId: string; readonly pr: string; readonly from: MergeVerdict; readonly to: MergeVerdict; readonly revertedOrBroke: boolean }[];
  readonly changedThenReverted: number;
}

export function backtest(rows: readonly MergeDecisionRecord[], current: MergePolicy, candidate: MergePolicy, outcomes: readonly OutcomeEvent[]): BacktestResult {
  // One verdict per pull request head: the newest decision that wasn't voided.
  const live = rows.filter((r) => r.voidedAt === null);
  const bad = new Set(outcomes.filter((o) => o.kind === 'reverted' || o.kind === 'broke_main').map((o) => o.mission));
  const verdict = (r: MergeDecisionRecord, p: MergePolicy): MergeVerdict => decideMerge(r.facts as unknown as MergeFacts, { ...p, autoMerge: 'on' }).verdict;
  const changed = live
    .map((r) => ({ r, from: verdict(r, current), to: verdict(r, candidate) }))
    .filter((x) => x.from !== x.to)
    .map(({ r, from, to }) => ({ decisionId: r.id, pr: `${r.repo}#${r.prNumber}`, from, to, revertedOrBroke: bad.has(r.missionId) }));
  const times = live.map((r) => r.decidedAt).sort();
  return {
    window: { from: times[0] ?? '', to: times.at(-1) ?? '' },
    total: live.length,
    mergedCurrent: live.filter((r) => verdict(r, current) === 'merge').length,
    mergedCandidate: live.filter((r) => verdict(r, candidate) === 'merge').length,
    changed,
    changedThenReverted: changed.filter((c) => c.revertedOrBroke).length,
  };
}

/** "Over the last 90 days this would have merged 14 of 31 pull requests on its own; none of those 14 were reverted." */
export function backtestSentence(result: BacktestResult, outcomes: readonly OutcomeEvent[], rows: readonly MergeDecisionRecord[], candidate: MergePolicy): string {
  if (result.total === 0) return `There are no decisions from the last ${BACKTEST_WINDOW_DAYS} days to replay yet.`;
  const bad = new Set(outcomes.filter((o) => o.kind === 'reverted' || o.kind === 'broke_main').map((o) => o.mission));
  const merged = rows.filter((r) => r.voidedAt === null && decideMerge(r.facts as unknown as MergeFacts, { ...candidate, autoMerge: 'on' }).verdict === 'merge');
  const reverted = merged.filter((r) => bad.has(r.missionId)).length;
  return `Over the last ${BACKTEST_WINDOW_DAYS} days this would have merged ${result.mergedCandidate} of ${result.total} pull requests on its own; `
    + `${reverted === 0 ? 'none' : String(reverted)} of those ${result.mergedCandidate} ${reverted === 1 ? 'was' : 'were'} reverted.`;
}
