import type { GateExpression, GateFacts, GateOutcome } from '@tandemise/domain';
import { evaluateGate, gateDependencies } from '@tandemise/domain';
import { TandemiseError } from '@tandemise/shared';

/**
 * The named quality gates of MVP.md §17.2, as data.
 *
 * They are data rather than code for the same reason the gate language is not
 * arbitrary code: a user must be able to read a gate, understand why their
 * mission is blocked, and edit it. Encoding `ready_to_ship` as a function would
 * make the reason a mission is stuck unexplainable in the UI.
 */
export interface QualityGate {
  readonly name: string;
  readonly description: string;
  readonly expression: GateExpression;
}

export const QUALITY_GATES = {
  ready_for_qa: {
    name: 'ready_for_qa',
    description:
      'The change is complete enough for QA to test it: a ChangeSet exists, the deterministic '
      + 'checks pass, and independent review found nothing blocking.',
    expression:
      'artifact.ChangeSet.exists && checks.typecheck == PASS && checks.tests == PASS && review.blocking_findings == 0',
  },
  ready_to_ship: {
    name: 'ready_to_ship',
    description:
      'The change may be released: every acceptance criterion is covered and passing, no blocking '
      + 'defects remain, security checks pass, and a human has approved the release candidate.',
    expression:
      'qa.acceptance_criteria_coverage == 100 && qa.blocking_defects == 0 '
      + '&& security.required_checks == PASS && approval.release_candidate == APPROVED',
  },
} as const satisfies Readonly<Record<string, QualityGate>>;

export type QualityGateName = keyof typeof QUALITY_GATES;

export function isQualityGateName(name: string): name is QualityGateName {
  return name in QUALITY_GATES;
}

export function evaluateNamedGate(name: QualityGateName | string, facts: GateFacts): GateOutcome {
  if (!isQualityGateName(name)) {
    throw TandemiseError.notFound('Quality gate', name);
  }
  return evaluateGate(QUALITY_GATES[name].expression, facts);
}

/** Every fact a named gate reads, so the engine knows what to measure first. */
export function factsRequiredBy(name: QualityGateName): readonly string[] {
  return gateDependencies(QUALITY_GATES[name].expression);
}
