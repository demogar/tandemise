import type { ArtifactId, MissionId, RunId, TaskId, Timestamp, WorkspaceId } from '@tandemise/shared';

/**
 * The typed hand-off contract between organizational stages (MVP.md §15).
 * A downstream role consumes artifacts, never an upstream transcript - that is
 * what makes reviewer and QA independent rather than agreeable.
 */
export const ARTIFACT_TYPES = [
  'ProblemBrief', 'ProductSpec', 'DesignBrief', 'ArchitecturePlan', 'ImplementationPlan',
  'ChangeSet', 'ReviewReport', 'QAPlan', 'QAReport', 'ReleaseCandidate',
  'DecisionRecord', 'FinanceReport',
  /** Supporting evidence: screenshots, logs, videos, test output. */
  'Evidence',
  /** The mission plan itself, so plan approval has something to point at. */
  'MissionPlan',
  /** What refining a rough request proposed: criteria to accept and questions to answer (P6). */
  'Refinement',
  /** A status report rendered from facts alone (P10). */
  'StatusReport',
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export function isArtifactType(v: string): v is ArtifactType {
  return (ARTIFACT_TYPES as readonly string[]).includes(v);
}

/**
 * What a person calls the types a stage can be covered by or continued
 * elsewhere as. Named one by one rather than derived: the last word of the
 * type name reads wrongly for half of them ("Brief" for a design, "Plan" for
 * an implementation plan, "Set" for a change).
 */
const OUTPUT_TYPE_LABELS: Partial<Record<ArtifactType, string>> = {
  ProductSpec: 'Spec',
  ProblemBrief: 'Brief',
  DesignBrief: 'Design',
  ImplementationPlan: 'Implementation plan',
  ChangeSet: 'Change',
};

/**
 * A short, human name for an artifact type, for a place with room for a word
 * or two: a spec covered by an upload is "Spec", not "ProductSpec". A type
 * without a name of its own is its CamelCase split into words, capitalised
 * only at the start ("ReviewReport" reads "Review report").
 */
export function outputTypeLabel(type: ArtifactType): string {
  const named = OUTPUT_TYPE_LABELS[type];
  if (named !== undefined) return named;
  const words = type.match(/[A-Z][a-z0-9]*/g);
  if (words === null || words.length === 0) return type;
  return [words[0] as string, ...words.slice(1).map((w) => w.toLowerCase())].join(' ');
}

/** Where a handoff link points, so a card can say "open preview" rather than a bare URL. */
export const HANDOFF_LINK_KINDS = ['workspace', 'preview', 'pr', 'doc', 'other'] as const;
export type HandoffLinkKind = (typeof HANDOFF_LINK_KINDS)[number];

/**
 * One link on a handoff card (spec A5). Every kind but `workspace` must be a
 * full http(s) URL, so a click always leaves the desktop; only `workspace`
 * may instead (or also) carry a `path` into the repository or artifact root,
 * which the daemon resolves rather than opening in a browser.
 */
export interface HandoffLink {
  readonly label: string;
  readonly url?: string;
  readonly path?: string;
  readonly kind: HandoffLinkKind;
}

/**
 * What a busy owner reads first, and often the only thing they read: a
 * headline, at most three points, what is needed from them, what changed and
 * where the real thing lives. The artifact's zod schema enforces the limits;
 * this is the normalised shape, so optional parts are `null` or empty rather
 * than missing.
 */
export interface ArtifactHandoff {
  readonly headline: string;
  readonly points: readonly string[];
  readonly needs: string | null;
  readonly changed: readonly { readonly what: string; readonly feedback: string | null }[];
  readonly links: readonly HandoffLink[];
}

/** A pointer to truth that lives in another system (MVP.md §15.3). */
export interface ExternalRef {
  readonly kind: 'git.commit' | 'git.branch' | 'github.pr' | 'github.issue' | 'url' | 'file';
  readonly value: string;
  readonly label?: string;
}

export interface ArtifactManifest {
  readonly id: ArtifactId;
  readonly workspaceId: WorkspaceId;
  readonly missionId: MissionId;
  readonly taskId: TaskId | null;
  readonly createdByRunId: RunId | null;
  readonly type: ArtifactType;
  readonly title: string;
  /**
   * Path relative to the workspace artifact root, or a `sha256:<hex>` reference
   * for content-addressed blobs. Never an absolute path - that would not survive
   * moving the Tandemise home directory.
   */
  readonly contentRef: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly schemaVersion: number;
  readonly sourceRefs: readonly ExternalRef[];
  readonly supersedes: ArtifactId | null;
  readonly summary: string | null;
  readonly createdAt: Timestamp;
  /** Who made it: an agent or person member, or a system actor. */
  readonly authorId?: string | null;
  /** The person who answers for it. */
  readonly responsibleId?: string | null;
  /** Who put it on record, which differs from the author when a person uploads for an agent. */
  readonly recordedBy?: string | null;
  /**
   * The handoff read from the front matter. Optional so manifests built before
   * the contract existed still type-check; legacy rows have none and show
   * their summary as the headline instead.
   */
  readonly handoff?: ArtifactHandoff | null;
  /** Words in the main body, before `## Appendix`; null when never measured. */
  readonly wordCount?: number | null;
  /** True when the body stayed over its type's word budget after the tighten pass. */
  readonly overBudget?: boolean;
  /** The task round this artifact was produced in; null before migration 010. */
  readonly round?: number | null;
  /**
   * When the output was set aside because its pass was overtaken before it
   * was judged (a Redo reset the task); null for everything else. Lists leave
   * such an artifact out; only a direct read by id returns it.
   */
  readonly withdrawnAt?: Timestamp | null;
}

export interface ArtifactWriteRequest {
  readonly workspaceId: WorkspaceId;
  readonly missionId: MissionId;
  readonly taskId?: TaskId | null;
  readonly createdByRunId?: RunId | null;
  readonly type: ArtifactType;
  readonly title: string;
  readonly body: string | Uint8Array;
  readonly mediaType?: string;
  readonly sourceRefs?: readonly ExternalRef[];
  readonly supersedes?: ArtifactId | null;
  readonly summary?: string | null;
}

/** Artifact plus its decoded body, for consumers that need the content. */
export interface LoadedArtifact {
  readonly manifest: ArtifactManifest;
  readonly body: string;
}

/** Default media type per artifact type - most are structured Markdown. */
export function defaultMediaTypeFor(type: ArtifactType): string {
  return type === 'Evidence' ? 'application/octet-stream' : 'text/markdown';
}
