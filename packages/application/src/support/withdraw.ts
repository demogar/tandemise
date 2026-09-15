import type { Approval, ApprovalRepositoryPort } from '@tandemise/domain';
import type { Clock } from '@tandemise/shared';
import type { EventRecorder } from './event-recorder.js';

export interface WithdrawDeps {
  readonly approvals: ApprovalRepositoryPort;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
}

/**
 * Closes a card nothing is waiting on any more: a question or a tool request
 * whose run ended, or one a restarted daemon can no longer deliver an answer
 * to.
 *
 * One path for all of them, so every withdrawn card is closed the same way.
 * `escalateAt` is cleared with it: an inbox item nobody waits for must never
 * climb the team tree and interrupt someone more senior for nothing.
 */
export function withdrawApproval(
  deps: WithdrawDeps,
  approval: Pick<Approval, 'id' | 'missionId'>,
  note: string,
  status: 'CANCELLED' | 'EXPIRED' = 'CANCELLED',
): void {
  deps.approvals.update(approval.id, { status, decisionNote: note, decidedAt: deps.clock.now(), escalateAt: null });
  deps.recorder.invalidate('approvals', approval.missionId ?? undefined);
}
