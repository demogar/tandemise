import type { MissionCriteriaRepositoryPort, MissionQuestionRepositoryPort, Readiness, ReadinessCounts } from '@tandemise/domain';
import { READY_TO_PLAN_GATE, evaluateReadiness, notReadyMessage } from '@tandemise/domain';
import { TandemiseError, type MissionId } from '@tandemise/shared';

export interface ReadinessDeps {
  readonly criteria: Pick<MissionCriteriaRepositoryPort, 'listActive' | 'listProposed'>;
  readonly questions: Pick<MissionQuestionRepositoryPort, 'listByMission'>;
}

/**
 * The Definition of Ready, measured (P6 spec §1).
 *
 * One place counts what the readiness gate reads, so the Plan button, the
 * refused plan and the inbox row can never disagree. The counts come from the
 * ledger and the questions table - what the person decided - and never from
 * what a refinement pass said about itself.
 */
export class ReadinessService {
  constructor(private readonly deps: ReadinessDeps) {}

  counts(missionId: MissionId): ReadinessCounts {
    return {
      // The person's criteria only: before planning there is no spec, and a
      // spec criterion is the agent's answer to them, not part of the request.
      criteria: this.deps.criteria.listActive(missionId).filter((c) => c.source === 'user').length,
      openQuestions: this.deps.questions.listByMission(missionId).filter((q) => q.status === 'open').length,
      proposedPending: this.deps.criteria.listProposed(missionId).length,
    };
  }

  evaluate(missionId: MissionId): Readiness {
    return evaluateReadiness(this.counts(missionId));
  }

  /** Refuses with the gate's own words when the mission is not ready to plan. */
  assertReady(missionId: MissionId): void {
    assertReadiness(missionId, this.evaluate(missionId));
  }
}

export function assertReadiness(missionId: MissionId | null, readiness: Readiness): void {
  if (readiness.ready) return;
  throw new TandemiseError('PRECONDITION_FAILED', notReadyMessage(readiness), {
    details: { missionId, gate: READY_TO_PLAN_GATE, facts: readiness.outcome.facts },
  });
}
