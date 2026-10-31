import type { EvalRunId, MissionId, TaskId, Timestamp, WorkspaceId } from '@tandemise/shared';
import type { WriterId } from '../brain/writer.js';
import type { RunUsage } from './run.js';

/**
 * A project's link to its brain on this machine (#51 spec §3). Per machine on
 * purpose: two people link the same brain to their own project rows.
 */
export interface WorkspaceBrain {
  readonly workspaceId: WorkspaceId;
  /** `github.com/<owner>/<name>`, a URL or path; null for a brain kept on this machine. */
  readonly remote: string | null;
  readonly defaultBranch: string;
  readonly clonePath: string;
  readonly writerId: WriterId;
  readonly lastPulledSha: string | null;
  readonly lastPushedSha: string | null;
  readonly lastSyncAt: Timestamp | null;
  readonly lastSyncError: string | null;
  /** `tandemise/ledger/<writerId>` when the default branch is protected. */
  readonly fallbackBranch: string | null;
  readonly linkedAt: Timestamp;
}

/** What one run knew from the brain (#51 spec §11): `runs.brain`. */
export interface RunBrain {
  readonly sha: string;
  readonly rules: readonly string[];
  readonly loaded: readonly { readonly id: string; readonly net: number }[];
  readonly indexed: number;
  readonly fetched: readonly string[];
  readonly proposed: readonly string[];
}

export type BrainPassId = string;

/** A reflector or promoter model pass; its spend counts toward P8 limits. */
export interface BrainPass {
  readonly id: BrainPassId;
  readonly workspaceId: WorkspaceId;
  readonly missionId: MissionId | null;
  readonly taskId: TaskId | null;
  readonly kind: 'reflect' | 'promote';
  readonly signal: string;
  readonly runtimeProfileId: string | null;
  readonly model: string | null;
  readonly status: 'ok' | 'failed' | 'skipped';
  readonly reason: string | null;
  /** Null when the runtime reported nothing; never zero for "unknown". */
  readonly usage: RunUsage | null;
  readonly createdAt: Timestamp;
}

export type BrainProposalState =
  | 'evaluating' | 'open' | 'draft' | 'applied' | 'merged' | 'closed' | 'accepted' | 'declined' | 'reverted';

/** A promotion of lessons to a rule (#51 spec §8). */
export interface BrainProposal {
  /** The promotion id: derived from its lessons' ids, so two daemons agree. */
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly lessonIds: readonly string[];
  readonly targets: readonly string[];
  readonly classification: 'small' | 'structural';
  readonly reasons: readonly string[];
  readonly branch: string;
  readonly state: BrainProposalState;
  readonly evalRunId: EvalRunId | null;
  readonly verdict: 'passed' | 'failed' | 'not_evaluated' | null;
  readonly prUrl: string | null;
  readonly appliedSha: string | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}
