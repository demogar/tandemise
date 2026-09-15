import type {
  Approval, ApprovalKind, ArtifactManifest, ArtifactType, CheckOutcome, CheckResult, CriterionResult,
  Evaluation, GateFacts, GateValue, RiskClass,
} from '@tandemise/domain';
import { RISK_CLASSES, blockingFindings, criteriaCoveragePercent } from '@tandemise/domain';

/**
 * The complete gate fact vocabulary (MVP.md §17.2).
 *
 * This is a published contract in three directions at once: the UI renders it
 * so a user writing a gate knows what exists, role prompts reference it so an
 * agent knows what it is being measured on, and `GateFactBuilder` is the only
 * thing allowed to produce it. Keeping the descriptions here - rather than in a
 * doc that drifts - is what makes `evaluateGate`'s "fact not measured" message
 * actionable.
 *
 * A fact that is not measured is `undefined`, and `undefined` compares false
 * against everything. A gate never passes because a measurement was missing.
 */
export interface FactDefinition {
  readonly name: string;
  readonly type: 'outcome' | 'boolean' | 'number' | 'verdict' | 'approval';
  readonly description: string;
  /** Written with `<...>` where the name is parameterised. */
  readonly example: string;
}

export const GATE_FACT_VOCABULARY: readonly FactDefinition[] = [
  {
    name: 'checks.install',
    type: 'outcome',
    description: 'Dependency install command exit status. SKIP when the repository configures none.',
    example: 'checks.install == PASS',
  },
  {
    name: 'checks.typecheck',
    type: 'outcome',
    description: 'Type checker exit status.',
    example: 'checks.typecheck == PASS',
  },
  {
    name: 'checks.lint',
    type: 'outcome',
    description: 'Linter exit status.',
    example: 'checks.lint == PASS',
  },
  {
    name: 'checks.tests',
    type: 'outcome',
    description: 'Test command exit status. Plural, unlike the repository field it comes from.',
    example: 'checks.tests == PASS',
  },
  {
    name: 'checks.build',
    type: 'outcome',
    description: 'Build command exit status.',
    example: 'checks.build == PASS',
  },
  {
    name: 'checks.<name>',
    type: 'outcome',
    description: 'Any additional repository check, recorded under its configured name.',
    example: 'checks.a11y == PASS',
  },
  {
    name: 'artifact.<Type>.exists',
    type: 'boolean',
    description: 'True when at least one non-superseded artifact of that type exists for the mission.',
    example: 'artifact.ChangeSet.exists',
  },
  {
    name: 'artifact.<Type>.count',
    type: 'number',
    description: 'How many artifacts of that type the mission has.',
    example: 'artifact.QAReport.count >= 1',
  },
  {
    name: 'review.verdict',
    type: 'verdict',
    description: "Independent reviewer's verdict: pass, needs_changes, or fail.",
    example: 'review.verdict == "pass"',
  },
  {
    name: 'review.blocking_findings',
    type: 'number',
    description: 'Count of reviewer findings with severity `blocking`.',
    example: 'review.blocking_findings == 0',
  },
  {
    name: 'review.major_findings',
    type: 'number',
    description: 'Count of reviewer findings with severity `major`.',
    example: 'review.major_findings <= 2',
  },
  {
    name: 'qa.acceptance_criteria_coverage',
    type: 'number',
    description: 'Percentage (0-100) of scored acceptance criteria that QA marked PASS. SKIP criteria are excluded.',
    example: 'qa.acceptance_criteria_coverage == 100',
  },
  {
    name: 'qa.blocking_defects',
    type: 'number',
    description: 'Count of QA defects that block release.',
    example: 'qa.blocking_defects == 0',
  },
  {
    name: 'qa.verdict',
    type: 'verdict',
    description: "QA role's overall verdict.",
    example: 'qa.verdict == "pass"',
  },
  {
    name: 'security.required_checks',
    type: 'outcome',
    description: 'Aggregate of the checks marked security-required for this workspace.',
    example: 'security.required_checks == PASS',
  },
  {
    name: 'approval.plan',
    type: 'approval',
    description: 'Status of the mission plan approval.',
    example: 'approval.plan == APPROVED',
  },
  {
    name: 'approval.release_candidate',
    type: 'approval',
    description: 'Status of the release approval. PENDING until a human decides.',
    example: 'approval.release_candidate == APPROVED',
  },
  {
    name: 'approval.<kind>',
    type: 'approval',
    description: 'Status of any other approval kind: choice, exception, action, intervention, check.',
    example: 'approval.exception == APPROVED',
  },
  {
    name: 'task.attempt',
    type: 'number',
    description: 'Which attempt at the task this is; 0 before it first runs.',
    example: 'task.attempt >= 2',
  },
  {
    name: 'task.role',
    type: 'verdict',
    description: 'The role the task is staffed under.',
    example: 'task.role == "development"',
  },
  {
    name: 'task.risk',
    type: 'verdict',
    description: "The highest risk class among the task's capabilities: read, write_reversible, external_side_effect, destructive, financial or release.",
    example: 'task.risk == "release"',
  },
  {
    name: 'task.risk_level',
    type: 'number',
    description: 'task.risk as its position in that list, 0 (read) to 5 (release), so a condition can use >=.',
    example: 'task.risk_level >= 2',
  },
  {
    name: 'diff.files_changed',
    type: 'number',
    description: "How many files the task's ChangeSet says it changed. Not measured when it wrote no ChangeSet.",
    example: 'diff.files_changed > 20',
  },
  {
    name: 'git.clean',
    type: 'boolean',
    description: 'True when the working tree has no uncommitted changes.',
    example: 'git.clean',
  },
];

/** Fact name each approval kind is published under. */
const APPROVAL_FACT_NAME: Readonly<Record<ApprovalKind, string>> = {
  plan: 'approval.plan',
  choice: 'approval.choice',
  exception: 'approval.exception',
  action: 'approval.action',
  // MVP.md §17.2 names this gate condition `approval.release_candidate`.
  release: 'approval.release_candidate',
  intervention: 'approval.intervention',
  check: 'approval.check',
};

/**
 * Assembles the fact map `evaluateGate` consumes.
 *
 * Built incrementally because the inputs arrive at different times - checks
 * when a run finishes, the review when the evaluator role reports, the approval
 * when a human decides - and a partially built map is a legitimate thing to
 * evaluate against: it is how the UI shows which conditions are still
 * outstanding.
 */
/** FAIL beats SKIP beats PASS: the least reassuring measurement wins. */
function worstOutcome(existing: GateValue, next: CheckOutcome): CheckOutcome {
  if (existing === undefined) return next;
  const rank = (o: GateValue): number => (o === 'FAIL' ? 2 : o === 'SKIP' ? 1 : 0);
  return rank(existing) >= rank(next) ? (existing as CheckOutcome) : next;
}

export class GateFactBuilder {
  readonly #facts: Record<string, GateValue> = {};

  /**
   * Folds check results into facts, worst-outcome-wins per name.
   *
   * The caller passes every task's latest checks for a mission, so the same
   * name arrives more than once. Last-writer-wins let one task's PASS overwrite
   * another task's FAIL purely because of row order - a mission-level
   * `checks.tests` fact that reads PASS while a task's tests were failing. A
   * gate asking "did the tests pass" means all of them, so any FAIL is decisive
   * and SKIP only survives when nothing actually ran.
   */
  withChecks(results: readonly CheckResult[]): this {
    for (const result of results) {
      const existing = this.#facts[result.name];
      this.#facts[result.name] = worstOutcome(existing, result.outcome);
    }
    return this;
  }

  /**
   * `security.required_checks` is FAIL if any named check failed, SKIP if none
   * ran, PASS otherwise - "no security checks configured" must not read as PASS.
   */
  withSecurityChecks(results: readonly CheckResult[], requiredNames: readonly string[]): this {
    const relevant = results.filter((r) => requiredNames.includes(r.name));
    const ran = relevant.filter((r) => r.outcome !== 'SKIP');
    this.#facts['security.required_checks'] =
      relevant.some((r) => r.outcome === 'FAIL') ? 'FAIL' : ran.length === 0 ? 'SKIP' : 'PASS';
    return this;
  }

  withArtifacts(manifests: readonly ArtifactManifest[]): this {
    const counts = new Map<ArtifactType, number>();
    for (const m of manifests) counts.set(m.type, (counts.get(m.type) ?? 0) + 1);
    for (const [type, count] of counts) {
      this.#facts[`artifact.${type}.exists`] = count > 0;
      this.#facts[`artifact.${type}.count`] = count;
    }
    return this;
  }

  /** Declares which types were looked for, so a missing one reads `false` not `undefined`. */
  expectingArtifactTypes(types: readonly ArtifactType[]): this {
    for (const type of types) {
      this.#facts[`artifact.${type}.exists`] ??= false;
      this.#facts[`artifact.${type}.count`] ??= 0;
    }
    return this;
  }

  withReview(evaluation: Evaluation): this {
    this.#facts['review.verdict'] = evaluation.verdict;
    this.#facts['review.blocking_findings'] = blockingFindings(evaluation).length;
    this.#facts['review.major_findings'] = evaluation.findings.filter((f) => f.severity === 'major').length;
    return this;
  }

  withQa(input: { readonly criteria: readonly CriterionResult[]; readonly blockingDefects: number; readonly verdict?: string }): this {
    this.#facts['qa.acceptance_criteria_coverage'] = criteriaCoveragePercent(input.criteria);
    this.#facts['qa.blocking_defects'] = input.blockingDefects;
    if (input.verdict !== undefined) this.#facts['qa.verdict'] = input.verdict;
    return this;
  }

  /**
   * A pending approval dominates an approved one of the same kind: if anything
   * is still waiting on a human, the gate must not report APPROVED.
   */
  withApprovals(approvals: readonly Approval[]): this {
    const byName = new Map<string, Approval[]>();
    for (const approval of approvals) {
      const name = APPROVAL_FACT_NAME[approval.kind];
      byName.set(name, [...(byName.get(name) ?? []), approval]);
    }
    for (const [name, group] of byName) {
      // Ordered from least to most reassuring, so the result never depends on
      // which row the database returned first. `group[0]` made
      // [APPROVED, EXPIRED] read APPROVED and the reverse read EXPIRED for the
      // same set of facts.
      this.#facts[name] = group.some((a) => a.status === 'PENDING') ? 'PENDING'
        : group.some((a) => a.status === 'REJECTED') ? 'REJECTED'
        : group.some((a) => a.status === 'EXPIRED') ? 'EXPIRED'
        : group.some((a) => a.status === 'CANCELLED') ? 'CANCELLED'
        : group.every((a) => a.status === 'APPROVED') ? 'APPROVED'
        : 'PENDING';
    }
    return this;
  }

  /**
   * Facts about the task itself, for conditions such as "a second opinion on
   * anything that ships". The caller classifies the risk: this package knows
   * the order of the classes, not which capability falls in which.
   */
  withTask(input: { readonly attempt: number; readonly roleId: string; readonly risk: RiskClass }): this {
    this.#facts['task.attempt'] = input.attempt;
    this.#facts['task.role'] = input.roleId;
    this.#facts['task.risk'] = input.risk;
    this.#facts['task.risk_level'] = RISK_CLASSES.indexOf(input.risk);
    return this;
  }

  withDiff(input: { readonly filesChanged: number }): this {
    this.#facts['diff.files_changed'] = input.filesChanged;
    return this;
  }

  withFact(name: string, value: GateValue): this {
    this.#facts[name] = value;
    return this;
  }

  build(): GateFacts {
    return { ...this.#facts };
  }
}

export function approvalFactName(kind: ApprovalKind): string {
  return APPROVAL_FACT_NAME[kind];
}
