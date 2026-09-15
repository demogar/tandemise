import type { ArtifactType, CriterionResult, MissionStatus, TandemiseEventBody } from '@tandemise/domain';

/**
 * The handful of *runtime* values the renderer needs from the domain.
 *
 * Types are imported directly from `@tandemise/domain` everywhere else and cost
 * nothing, but its runtime entry point reaches `@tandemise/shared`, which
 * imports `node:path` and `node:os`. The renderer is sandboxed and has no Node
 * (MVP.md §7.1), so pulling that in would either break the bundle or, worse,
 * ship a shimmed copy of it into a browser context.
 *
 * Every table below is keyed by a domain union, so adding a case in
 * `@tandemise/domain` fails this file at compile time rather than silently
 * drifting.
 */

const TERMINAL: Readonly<Record<MissionStatus, boolean>> = {
  DRAFT: false,
  PLANNING: false,
  AWAITING_PLAN_APPROVAL: false,
  EXECUTING: false,
  REVIEWING: false,
  QA: false,
  READY_TO_SHIP: false,
  RELEASED: false,
  OBSERVING: false,
  COMPLETE: true,
  BLOCKED: false,
  PAUSED: false,
  FAILED: true,
  CANCELLED: true,
};

export function isTerminalMissionStatus(status: MissionStatus): boolean {
  return TERMINAL[status] ?? false;
}

/**
 * Which event types belong in the semantic timeline (MVP.md §23.3). The false
 * entries are the ones the raw log exists for.
 */
const SEMANTIC: Readonly<Record<TandemiseEventBody['type'], boolean>> = {
  message: true,
  thinking_summary: false,
  'tool.started': true,
  'tool.completed': false,
  'file.changed': true,
  'artifact.created': true,
  'approval.requested': true,
  usage: false,
  checkpoint: false,
  completed: true,
  failed: true,
  raw: false,
  'mission.status': true,
  'task.status': true,
  'run.started': true,
  'run.finished': true,
  'check.result': true,
  'gate.evaluated': true,
  'approval.resolved': true,
  'policy.denied': true,
  'approval.escalated': true,
  'review.skipped': true,
  'review.required': true,
  'task.attention': true,
  'artifact.tighten_requested': true,
  'artifact.over_budget': true,
  'feedback.given': true,
  'feedback.addressed': true,
  'feedback.dismissed': true,
  'task.round_started': true,
  note: true,
};

export function isSemanticEvent(body: TandemiseEventBody): boolean {
  return SEMANTIC[body.type] ?? false;
}

const ARTIFACT_TYPE_SET: Readonly<Record<ArtifactType, true>> = {
  ProblemBrief: true,
  ProductSpec: true,
  DesignBrief: true,
  ArchitecturePlan: true,
  ImplementationPlan: true,
  ChangeSet: true,
  ReviewReport: true,
  QAPlan: true,
  QAReport: true,
  ReleaseCandidate: true,
  DecisionRecord: true,
  FinanceReport: true,
  Evidence: true,
  MissionPlan: true,
};

export const ARTIFACT_TYPES = Object.keys(ARTIFACT_TYPE_SET) as readonly ArtifactType[];

export function criteriaCoveragePercent(results: readonly CriterionResult[]): number {
  const scored = results.filter((result) => result.outcome !== 'SKIP');
  if (scored.length === 0) return 0;
  return Math.round((scored.filter((result) => result.outcome === 'PASS').length / scored.length) * 100);
}

/** Mirrors `REJECT_OPTION` in `@tandemise/domain`: the option that declines an approval or a question. */
export const REJECT_OPTION = 'reject';

/** Mirrors `REQUEST_CHANGES_OPTION` in `@tandemise/domain`: an output card's "send it back as the next round, with this note". */
export const REQUEST_CHANGES_OPTION = 'request_changes';

/** Mirrors `NEEDS_CHANGES_OPTION` in `@tandemise/domain`: a check's "needs changes", which with a note is feedback. */
export const NEEDS_CHANGES_OPTION = 'needs_changes';

/** MVP.md §7.2. Mirrors `@tandemise/api-contract`, for the same reason as above. */
export const API_VERSION = 'v1';
export const API_VERSION_HEADER = 'x-tandemise-api-version';
export const STREAM_PATH = '/v1/stream';
