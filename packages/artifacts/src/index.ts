export { parseFrontMatter, parseFrontMatterDocument } from './front-matter.js';
export type { FrontMatterDocument } from './front-matter.js';

export {
  ARTIFACT_SCHEMAS, ArchitecturePlanFrontMatter, ChangeSetFrontMatter, DecisionRecordFrontMatter,
  DesignBriefFrontMatter, EvidenceFrontMatter, FinanceReportFrontMatter, hasSchema, MissionPlanFrontMatter, ImplementationPlanFrontMatter, ProblemBriefFrontMatter,
  ProductSpecFrontMatter, QAPlanFrontMatter, QAReportFrontMatter, ReleaseCandidateFrontMatter,
  ReviewReportFrontMatter,
} from './schemas.js';
export type { FrontMatterFor, SchemaBackedArtifactType } from './schemas.js';

export { deriveHandoff, HANDOFF_LIMITS, handoffSchema } from './handoff.js';
export { budgetFor, measureArtifact, measureBody, overBudget, splitAppendix, WORD_BUDGETS } from './budget.js';
export type { ArtifactMeasure, BodyMeasure } from './budget.js';
export { stripFrontMatter } from './strip-front-matter.js';

export { formatIssues, parseArtifact } from './parse.js';
export type { ArtifactIssue, ParsedArtifact } from './parse.js';

export { artifactSkeleton, ARTIFACT_TEMPLATE_RULES, renderArtifactTemplate } from './templates.js';

export { createFilesystemArtifactStore } from './store.js';
export type { ArtifactStoreOptions } from './store.js';

export { ARTIFACT_PATHS, ARTIFACT_STORE, artifactsModule, createArtifactsModule } from './module.js';
export type { ArtifactsModuleOptions } from './module.js';
