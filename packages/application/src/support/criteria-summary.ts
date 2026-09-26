import type { CriteriaTrace } from '@tandemise/domain';

/**
 * A mission row's "1 of 3 verified" (P10): the counted rows of the Done-when
 * trace, the same numbers the feed's checklist and the gates read. Null when
 * nothing counts yet, so a row with no criteria says nothing rather than "0 of 0".
 */
export function criteriaSummary(trace: CriteriaTrace): { readonly verified: number; readonly counted: number } | null {
  return trace.counted === 0 ? null : { verified: trace.verified, counted: trace.counted };
}
