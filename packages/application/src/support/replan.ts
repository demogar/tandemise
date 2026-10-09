import type { ApprovalRepositoryPort } from '@tandemise/domain';
import type { ApprovalId } from '@tandemise/shared';

/**
 * Opens a decided plan-fit card again (replan spec). "Plan the rest again"
 * decides the card; when that replan is rejected or cannot be planned, the
 * steps the card held must stay held, and the hold reads exactly one thing:
 * whether the card is still pending.
 */
export function reopenCard(approvals: Pick<ApprovalRepositoryPort, 'get' | 'update'>, id: ApprovalId): void {
  const card = approvals.get(id);
  if (card === undefined || card.status === 'PENDING') return;
  approvals.update(id, { status: 'PENDING', selectedOptionId: null, decidedBy: null, decisionNote: null, decidedAt: null });
}

/** Ends `text` as a sentence: one that already ends one keeps its own mark instead of gaining a period. */
export function sentence(text: string): string {
  return /[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}
