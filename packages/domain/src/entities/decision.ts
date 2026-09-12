import type { ArtifactId, DecisionId, MissionId, Timestamp, WorkspaceId } from '@tandemise/shared';

/**
 * A first-class decision record (MVP.md §14.4). Downstream roles receive
 * approved decisions automatically, which is how an architecture choice made in
 * task 3 still constrains task 9 without anyone re-explaining it.
 */
export interface Decision {
  readonly id: DecisionId;
  readonly workspaceId: WorkspaceId;
  readonly missionId: MissionId | null;
  readonly title: string;
  readonly context: string;
  readonly decision: string;
  readonly rationale: string;
  readonly alternatives: readonly DecisionAlternative[];
  readonly consequences: readonly string[];
  readonly status: 'proposed' | 'accepted' | 'rejected' | 'superseded';
  readonly owner: string;
  readonly relatedArtifacts: readonly ArtifactId[];
  readonly supersedes: DecisionId | null;
  readonly createdAt: Timestamp;
  readonly decidedAt: Timestamp | null;
}

export interface DecisionAlternative {
  readonly title: string;
  readonly summary: string;
  readonly rejectedBecause?: string;
}
