import type {
  ApprovalRepositoryPort, ArtifactRepositoryPort, CheckResult, Evaluation,
  EvaluationRepositoryPort, GateFacts, GateOutcome, MissionTask, TaskRepositoryPort,
} from '@tandemise/domain';
import { blockingFindings, evaluateGate } from '@tandemise/domain';
import { GateFactBuilder, evaluateNamedGate } from '@tandemise/evaluation';
import type { MissionId } from '@tandemise/shared';

/**
 * Turns everything Tandemise has measured into the fact map a gate reads, and
 * evaluates the gate against it (MVP.md §17.2).
 *
 * Facts are assembled fresh on every call rather than stored. A gate outcome is
 * a *view* of the current evidence: storing it would mean the UI could show a
 * task blocked on a check that has since been re-run and passed. Evaluation is
 * cheap - a handful of indexed reads and a parse of a short expression - so
 * there is nothing to gain by caching it and a real correctness cost.
 *
 * Two assembly rules carry the weight:
 *
 *  - **Scope widens outward, latest wins.** Mission-wide checks form the base
 *    so a QA task's gate can read the implementation task's `checks.tests`;
 *    the task's own results are layered on top so a re-run replaces them.
 *  - **What was looked for is declared.** `expectingArtifactTypes` makes a
 *    missing output read `false` rather than `undefined`, which is the
 *    difference between "the worker did not write it" and "nobody checked".
 */
export class GateService {
  constructor(
    private readonly tasks: TaskRepositoryPort,
    private readonly artifacts: ArtifactRepositoryPort,
    private readonly evaluations: EvaluationRepositoryPort,
    private readonly approvals: ApprovalRepositoryPort,
  ) {}

  factsFor(task: MissionTask): GateFacts {
    const builder = new GateFactBuilder();

    builder.withChecks(sortByTime(this.evaluations.latestChecks(task.missionId)));
    builder.withChecks(sortByTime(this.evaluations.listChecks(task.id)));

    builder.withArtifacts(this.artifacts.listByMission(task.missionId));
    builder.expectingArtifactTypes(task.expectedOutputs);

    const review = this.#latestEvaluation(task.missionId, 'review');
    if (review) builder.withReview(review);

    const qa = this.#latestEvaluation(task.missionId, 'qa');
    if (qa) {
      builder.withQa({
        criteria: qa.criteriaCoverage,
        blockingDefects: blockingFindings(qa).length,
        verdict: qa.verdict,
      });
    }

    builder.withApprovals(this.approvals.list({ missionId: task.missionId }));
    return builder.build();
  }

  /** `null` when the task declares no completion gate - not a pass, an absence. */
  evaluate(task: MissionTask): GateOutcome | null {
    if (task.completionGate === null) return null;
    return evaluateGate(task.completionGate, this.factsFor(task));
  }

  /** One of the named workspace gates (`ready_for_qa`, `ready_to_ship`). */
  evaluateNamed(task: MissionTask, name: string): GateOutcome {
    return evaluateNamedGate(name, this.factsFor(task));
  }

  #latestEvaluation(missionId: MissionId, evaluatorRoleId: string): Evaluation | undefined {
    let latest: Evaluation | undefined;
    for (const task of this.tasks.listByMission(missionId)) {
      for (const evaluation of this.evaluations.listEvaluations(task.id)) {
        if (evaluation.evaluatorRoleId !== evaluatorRoleId) continue;
        if (latest === undefined || evaluation.createdAt >= latest.createdAt) latest = evaluation;
      }
    }
    return latest;
  }
}

/** `GateFactBuilder.withChecks` is last-wins, so order is the whole contract. */
function sortByTime(results: readonly CheckResult[]): readonly CheckResult[] {
  return [...results].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
