import type { ArtifactType } from '@tandemise/domain';
import { z } from 'zod';

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

const base = <T extends ArtifactType>(type: T) => ({
  type: z.literal(type),
  schemaVersion: z.number().int().positive().default(1),
  title: nonEmpty('title'),
});

const FINDING_SEVERITY = z.enum(['blocking', 'major', 'minor', 'nit']);
const CHECK_OUTCOME = z.enum(['PASS', 'FAIL', 'SKIP']);

const acceptanceCriterion = z.object({
  id: nonEmpty('criterion id'),
  statement: nonEmpty('criterion statement'),
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

export const QAReportFrontMatter = z.object({
  ...base('QAReport'),
  results: z.array(z.object({
    criterion: nonEmpty('criterion'),
    outcome: CHECK_OUTCOME,
    evidence: z.string().trim().default(''),
  })).min(1, 'a QAReport needs a result for at least one criterion'),
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

/** The artifact types that carry a validated front-matter contract. */
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
} as const;

export type SchemaBackedArtifactType = keyof typeof ARTIFACT_SCHEMAS;

export function hasSchema(type: ArtifactType): type is SchemaBackedArtifactType {
  return type in ARTIFACT_SCHEMAS;
}

export type FrontMatterFor<T extends SchemaBackedArtifactType> = z.infer<(typeof ARTIFACT_SCHEMAS)[T]>;
