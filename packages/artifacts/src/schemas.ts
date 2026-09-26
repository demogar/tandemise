import type { ArtifactType } from '@tandemise/domain';
import { z } from 'zod';
import { HANDOFF_LIMITS, handoffSchema } from './handoff.js';

/**
 * Front-matter schemas for the structured artifact types (MVP.md §15.2).
 *
 * The guiding rule: front matter carries only what a *machine* needs - the
 * facts gates read, the links the graph needs, the verdicts the inbox shows.
 * Everything a human needs to understand the work stays in the Markdown prose
 * below it. Putting the detail in front matter would produce artifacts that are
 * tedious to author, brittle to validate, and unreadable in a diff.
 *
 * Concretely: a ReviewReport's front matter is a verdict and a findings list
 * with severities, because `review.blocking_findings == 0` is a gate condition.
 * The argument for each finding is prose.
 */
const nonEmpty = (what: string) => z.string().trim().min(1, `${what} must not be empty`);

/**
 * What every artifact carries, whatever its type. The title is capped because
 * it is a short name shown in lists, not a sentence; the handoff is required
 * because it is what a person reads first (P1 spec §1).
 */
const base = <T extends ArtifactType>(type: T) => ({
  type: z.literal(type),
  schemaVersion: z.number().int().positive().default(1),
  title: z.string().trim()
    .min(1, 'title must not be empty')
    .max(HANDOFF_LIMITS.title, `title must be at most ${HANDOFF_LIMITS.title} characters: a short name, not a sentence`),
  // A missing handoff is parsed as an empty one so the issue names the field the
  // author has to write (`handoff.headline`), not just `handoff`: the retry
  // prompt repeats these paths, and "Required at handoff" does not say what is.
  handoff: z.preprocess((value) => value ?? {}, handoffSchema),
});

const FINDING_SEVERITY = z.enum(['blocking', 'major', 'minor', 'nit']);
const CHECK_OUTCOME = z.enum(['PASS', 'FAIL', 'SKIP']);

/**
 * `covers` names the person's Done-when lines (`U1`, `U2`) this criterion
 * proves. The harvester checks it against the mission's ledger: the schema can
 * only say it is a list of ids, not which ids exist.
 */
const acceptanceCriterion = z.object({
  id: nonEmpty('criterion id'),
  statement: nonEmpty('criterion statement'),
  covers: z.array(nonEmpty('covered criterion id')).default([]),
});

export const ProblemBriefFrontMatter = z.object({
  ...base('ProblemBrief'),
  successMetric: nonEmpty('successMetric'),
  /** Ids/links of the evidence the brief rests on, so claims are traceable. */
  evidence: z.array(nonEmpty('evidence reference')).default([]),
});

export const ProductSpecFrontMatter = z.object({
  ...base('ProductSpec'),
  acceptanceCriteria: z.array(acceptanceCriterion).min(1, 'a ProductSpec needs at least one acceptance criterion'),
  nonGoals: z.array(nonEmpty('non-goal')).default([]),
});

export const DesignBriefFrontMatter = z.object({
  ...base('DesignBrief'),
  flows: z.array(nonEmpty('flow name')).min(1, 'a DesignBrief needs at least one flow'),
  accessibility: z.array(nonEmpty('accessibility requirement')).default([]),
  openQuestions: z.array(nonEmpty('open question')).default([]),
});

export const ArchitecturePlanFrontMatter = z.object({
  ...base('ArchitecturePlan'),
  components: z.array(nonEmpty('component')).min(1, 'an ArchitecturePlan needs at least one component'),
  risks: z.array(z.object({
    severity: z.enum(['high', 'medium', 'low']),
    description: nonEmpty('risk description'),
  })).default([]),
  migration: z.string().trim().default(''),
});

export const ImplementationPlanFrontMatter = z.object({
  ...base('ImplementationPlan'),
  steps: z.array(z.object({
    id: nonEmpty('step id'),
    summary: nonEmpty('step summary'),
    files: z.array(nonEmpty('file path')).default([]),
    dependsOn: z.array(nonEmpty('step id')).default([]),
  })).min(1, 'an ImplementationPlan needs at least one step'),
});

export const ChangeSetFrontMatter = z.object({
  ...base('ChangeSet'),
  branch: nonEmpty('branch'),
  commits: z.array(nonEmpty('commit sha')).default([]),
  filesChanged: z.number().int().nonnegative().default(0),
  testsRun: z.array(nonEmpty('test command')).default([]),
  knownLimitations: z.array(nonEmpty('limitation')).default([]),
});

export const ReviewReportFrontMatter = z.object({
  ...base('ReviewReport'),
  verdict: z.enum(['pass', 'needs_changes', 'fail']),
  reviewedRef: z.string().trim().default(''),
  findings: z.array(z.object({
    severity: FINDING_SEVERITY,
    title: nonEmpty('finding title'),
    location: z.string().trim().default(''),
  })).default([]),
});

export const QAPlanFrontMatter = z.object({
  ...base('QAPlan'),
  cases: z.array(z.object({
    id: nonEmpty('case id'),
    criterion: nonEmpty('criterion'),
    method: z.enum(['manual', 'automated', 'browser', 'accessibility', 'performance']),
  })).min(1, 'a QAPlan needs at least one test case'),
});

/**
 * A result names the criterion it verified by its ledger id. `criterion` is
 * the pre-ledger field, still accepted so a report written from an older
 * template is read rather than refused; the harvester then requires its text
 * to be a ledger id.
 */
const qaResult = z.object({
  criterionId: z.string().trim().min(1, 'criterionId must not be empty').optional(),
  criterion: z.string().trim().min(1, 'criterion must not be empty').optional(),
  outcome: CHECK_OUTCOME,
  evidence: z.string().trim().default(''),
}).refine((r) => r.criterionId !== undefined || r.criterion !== undefined, {
  message: 'each result needs criterionId: the ledger id it verifies (AC1, U2)',
  path: ['criterionId'],
});

export const QAReportFrontMatter = z.object({
  ...base('QAReport'),
  results: z.array(qaResult).min(1, 'a QAReport needs a result for at least one criterion'),
  blockingDefects: z.number().int().nonnegative().default(0),
});

export const ReleaseCandidateFrontMatter = z.object({
  ...base('ReleaseCandidate'),
  ref: nonEmpty('ref (tag or commit)'),
  checks: z.array(z.object({
    name: nonEmpty('check name'),
    outcome: CHECK_OUTCOME,
  })).default([]),
  unresolvedRisks: z.array(nonEmpty('risk')).default([]),
  rollback: nonEmpty('rollback'),
});

export const DecisionRecordFrontMatter = z.object({
  ...base('DecisionRecord'),
  status: z.enum(['proposed', 'accepted', 'rejected', 'superseded']),
  decision: nonEmpty('decision'),
  owner: nonEmpty('owner'),
  supersedes: z.string().trim().default(''),
});

/*
 * Evidence, FinanceReport and MissionPlan have no machine-read facts of their
 * own, so their contract is only the common part: a title and a handoff. Other
 * keys an author adds are kept rather than dropped, because before these
 * schemas existed their front matter was passed through as written.
 */
export const FinanceReportFrontMatter = z.object(base('FinanceReport')).passthrough();
export const EvidenceFrontMatter = z.object(base('Evidence')).passthrough();
export const MissionPlanFrontMatter = z.object(base('MissionPlan')).passthrough();

/** Every artifact type's validated front-matter contract. */
export const ARTIFACT_SCHEMAS = {
  ProblemBrief: ProblemBriefFrontMatter,
  ProductSpec: ProductSpecFrontMatter,
  DesignBrief: DesignBriefFrontMatter,
  ArchitecturePlan: ArchitecturePlanFrontMatter,
  ImplementationPlan: ImplementationPlanFrontMatter,
  ChangeSet: ChangeSetFrontMatter,
  ReviewReport: ReviewReportFrontMatter,
  QAPlan: QAPlanFrontMatter,
  QAReport: QAReportFrontMatter,
  ReleaseCandidate: ReleaseCandidateFrontMatter,
  DecisionRecord: DecisionRecordFrontMatter,
  FinanceReport: FinanceReportFrontMatter,
  Evidence: EvidenceFrontMatter,
  MissionPlan: MissionPlanFrontMatter,
} as const satisfies Record<ArtifactType, z.ZodTypeAny>;

export type SchemaBackedArtifactType = keyof typeof ARTIFACT_SCHEMAS;

/**
 * True for every artifact type since the handoff became part of every
 * contract. Kept so callers written when only some types had schemas keep
 * compiling, and so an unknown string from outside is still refused.
 */
export function hasSchema(type: ArtifactType): type is SchemaBackedArtifactType {
  return Object.prototype.hasOwnProperty.call(ARTIFACT_SCHEMAS, type);
}

export type FrontMatterFor<T extends SchemaBackedArtifactType> = z.infer<(typeof ARTIFACT_SCHEMAS)[T]>;
