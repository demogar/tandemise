import type { EvaluationId, MissionId, RunId, TaskId, Timestamp } from '@tandemise/shared';

export const CHECK_OUTCOMES = ['PASS', 'FAIL', 'SKIP'] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

/**
 * A deterministic check result (MVP.md §17.1 level 1). These are measurements,
 * not opinions - `tests.pass` means a test command exited zero on this machine,
 * which is why gates are allowed to depend on them.
 */
export interface CheckResult {
  readonly id: string;
  readonly missionId: MissionId;
  readonly taskId: TaskId;
  readonly runId: RunId | null;
  /** Dotted fact name the gate language reads, e.g. `checks.typecheck`. */
  readonly name: string;
  readonly outcome: CheckOutcome;
  readonly detail: string;
  readonly command: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly outputRef: string | null;
  readonly createdAt: Timestamp;
}

/** Structured output of an evaluator role (MVP.md §17.1 level 3). */
export interface Evaluation {
  readonly id: EvaluationId;
  readonly missionId: MissionId;
  readonly taskId: TaskId;
  readonly runId: RunId | null;
  readonly evaluatorRoleId: string;
  readonly verdict: 'pass' | 'fail' | 'needs_changes';
  readonly summary: string;
  readonly findings: readonly Finding[];
  readonly criteriaCoverage: readonly CriterionResult[];
  readonly createdAt: Timestamp;
}

export const FINDING_SEVERITIES = ['blocking', 'major', 'minor', 'nit'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export interface Finding {
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly detail: string;
  readonly location: string | null;
  readonly suggestedFix: string | null;
}

/** Maps one acceptance criterion to the evidence that it holds. */
export interface CriterionResult {
  readonly criterion: string;
  readonly outcome: CheckOutcome;
  readonly evidence: string;
}

export function blockingFindings(evaluation: Evaluation): readonly Finding[] {
  return evaluation.findings.filter((f) => f.severity === 'blocking');
}

export function criteriaCoveragePercent(results: readonly CriterionResult[]): number {
  const scored = results.filter((r) => r.outcome !== 'SKIP');
  if (scored.length === 0) return 0;
  return Math.round((scored.filter((r) => r.outcome === 'PASS').length / scored.length) * 100);
}
