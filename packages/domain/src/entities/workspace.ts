import type { RepositoryId, Timestamp, WorkspaceId } from '@tandemise/shared';
import type { AutonomyLevel } from './mission.js';
import type { RoleStaffing } from '../staffing.js';

/**
 * Autonomy is expressed per action class rather than as one global dial, so a
 * user can let local code changes run freely while still gating anything that
 * escapes the machine (MVP.md Appendix A).
 */
export interface AutonomySettings {
  readonly planApproval: 'ask' | 'auto';
  readonly localCodeChanges: 'auto' | 'ask';
  readonly externalWrites: 'auto' | 'policy' | 'ask' | 'deny';
  readonly productionRelease: 'ask' | 'deny';
  readonly financialActions: 'deny';
}

export const DEFAULT_AUTONOMY: AutonomySettings = {
  planApproval: 'ask',
  localCodeChanges: 'auto',
  externalWrites: 'policy',
  productionRelease: 'ask',
  financialActions: 'deny',
};

export interface ConcurrencySettings {
  readonly maxTotalWorkers: number;
  /** Per runtime-profile ceilings, keyed by profile id. */
  readonly perRuntime: Readonly<Record<string, number>>;
}

export const DEFAULT_CONCURRENCY: ConcurrencySettings = { maxTotalWorkers: 3, perRuntime: {} };

/**
 * Ordered runtime preferences per role. The scheduler walks the list and takes
 * the first healthy, capability-satisfying, non-saturated runtime - which is how
 * fallback works without any role knowing a vendor name (MVP.md §P2).
 */
export type RoleRouting = Readonly<Record<string, readonly string[]>>;

export interface Workspace {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly defaultRepositoryId: RepositoryId | null;
  readonly autonomy: AutonomySettings;
  readonly concurrency: ConcurrencySettings;
  readonly routing: RoleRouting;
  readonly defaultAutonomyLevel: AutonomyLevel;
  /** Workspace knowledge injected by the context compiler (MVP.md §14.2). */
  readonly knowledge: WorkspaceKnowledge;
  /**
   * Who does each role's work in this workspace, as per-role patches over the
   * built-in staffing. Optional so a workspace built without it still
   * typechecks; read back as `{}`.
   */
  readonly staffing?: RoleStaffing;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface WorkspaceKnowledge {
  readonly productVision: string | null;
  readonly architecturePrinciples: string | null;
  readonly codingStandards: string | null;
  readonly designSystem: string | null;
  readonly glossary: string | null;
}

export const EMPTY_KNOWLEDGE: WorkspaceKnowledge = {
  productVision: null, architecturePrinciples: null, codingStandards: null,
  designSystem: null, glossary: null,
};

export interface Repository {
  readonly id: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  /** Absolute path to the user's real checkout. Never modified directly. */
  readonly path: string;
  readonly defaultBranch: string;
  readonly remoteUrl: string | null;
  /** Commands discovered or configured for deterministic gates (MVP.md §17.1). */
  readonly checks: RepositoryChecks;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface RepositoryChecks {
  readonly install: string | null;
  readonly typecheck: string | null;
  readonly lint: string | null;
  readonly test: string | null;
  readonly build: string | null;
  /** Command that serves the app for browser QA, plus the URL it listens on. */
  readonly devServer: string | null;
  readonly devServerUrl: string | null;
}

export const NO_CHECKS: RepositoryChecks = {
  install: null, typecheck: null, lint: null, test: null, build: null,
  devServer: null, devServerUrl: null,
};
