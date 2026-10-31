import type { MergeDecision } from './types.js';
import type { MergeFacts } from './decide.js';

/**
 * The merge decision in words (#53 §8.6): the one PR comment, edited in place
 * per decision, and the squash commit's trailers. Built from the decision and
 * measured facts only.
 */
export interface DecisionWordsContext {
  readonly headSha: string;
  readonly policyRef: string;
}

const short = (sha: string): string => sha.slice(0, 7);

export function decisionComment(decision: MergeDecision, facts: MergeFacts, ctx: DecisionWordsContext): string {
  const lines = facts.linesAdded + facts.linesRemoved;
  const sensitive = facts.areas.filter((a) => a.sensitivity !== 'none').map((a) => a.name);
  const touched = facts.changedPaths.slice(0, 3).map((p) => `\`${p}\``).join(', ') + (facts.changedPaths.length > 3 ? ` and ${facts.changedPaths.length - 3} more` : '');
  const what = `Touched ${touched || 'nothing'} (${sensitive.length === 0 ? 'no sensitive areas' : `sensitive: ${sensitive.join(', ')}`}), ${lines} ${lines === 1 ? 'line' : 'lines'}, ${facts.testsTouched > 0 ? 'tests changed' : 'no tests changed'}, CI ${facts.ci.state === 'PASS' ? 'green' : facts.ci.state === 'NONE' ? 'absent' : 'not green'} on \`${short(ctx.headSha)}\`.`;
  const policy = `Policy: ${ctx.policyRef}.`;
  if (decision.verdict === 'merge') {
    return `Tandemise merged this on its own: risk score ${decision.score} of ${decision.allowed ?? 0} allowed. ${what} ${policy}`;
  }
  const would = decision.allowed === null ? ''
    : ` With auto-merge on it ${decision.wouldMerge ? 'would have merged' : 'would still ask'}: score ${decision.score} of ${decision.allowed}.`;
  return `Tandemise asks for a review: ${decision.reasons.map((r) => r.replace(/\.$/, '')).join('; ')}. ${what}${would} ${policy}`;
}

/** "would have merged: score 0 of 2", for the ship card. */
export function wouldHaveLine(decision: Pick<MergeDecision, 'wouldMerge' | 'score' | 'allowed'>): string | null {
  if (decision.allowed === null) return null;
  return `${decision.wouldMerge ? 'would have merged' : 'would still ask'}: score ${decision.score} of ${decision.allowed}`;
}

export function squashTrailers(decision: Pick<MergeDecision, 'score' | 'allowed'>, ctx: { readonly policyRef: string; readonly mission: string; readonly by: 'auto' | 'person' }): string {
  return [
    `Tandemise-Merge: ${ctx.by}; score ${decision.score}/${decision.allowed ?? 0}`,
    `Tandemise-Policy: ${ctx.policyRef}`,
    `Tandemise-Mission: ${ctx.mission}`,
  ].join('\n');
}
