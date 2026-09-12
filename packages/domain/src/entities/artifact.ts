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
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export function isArtifactType(v: string): v is ArtifactType {
  return (ARTIFACT_TYPES as readonly string[]).includes(v);
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
