import type { Timestamp, WorkspaceId } from '@tandemise/shared';
import type { Capability } from '../capability.js';
import type { ArtifactType } from './artifact.js';
import type { IsolationMode } from './task.js';

/**
 * A role is an organizational responsibility, not a runtime and not a persona.
 * It declares what it produces, what it needs, and what it may touch; the
 * scheduler binds it to whichever runtime can satisfy that (MVP.md §16).
 */
export interface RoleTemplate {
  readonly id: string;
  readonly workspaceId: WorkspaceId | null;
  readonly name: string;
  readonly summary: string;
  /** Trusted system instructions. Never sourced from external content. */
  readonly instructions: string;
  readonly defaultCapabilities: readonly Capability[];
  readonly producesArtifacts: readonly ArtifactType[];
  readonly consumesArtifacts: readonly ArtifactType[];
  readonly defaultIsolation: IsolationMode;
  /** Quality bar the evaluator checks this role's output against. */
  readonly outputContract: string;
  readonly builtIn: boolean;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export const BUILT_IN_ROLE_IDS = [
  'product', 'design', 'architecture', 'development', 'review', 'qa', 'release', 'finance',
] as const;
export type BuiltInRoleId = (typeof BUILT_IN_ROLE_IDS)[number];
