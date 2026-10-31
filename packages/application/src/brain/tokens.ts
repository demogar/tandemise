import { token } from '@tandemise/kernel';
import type { BrainService } from './brain-service.js';
import type { BrainSyncLoop } from './sync-loop.js';
import type { BrainContextSupply } from './context-supply.js';
import type { BrainSignals, WorktreeDiff } from './signals.js';
import type { BrainHostPort, BrainRecordRepositoryPort, BrainRepoPort, WorkspaceBrainRepositoryPort } from '@tandemise/domain';

/**
 * The brain's tokens (#51). They live here, not in `../tokens.ts`, which other
 * work edits in parallel. `aliasPorts` in the daemon binds every application
 * token to the persistence token of the same exported name, so these two
 * resolve to SQLite without a line of wiring.
 */
export const WORKSPACE_BRAIN_REPOSITORY = token<WorkspaceBrainRepositoryPort>('port.WorkspaceBrainRepository');
export const BRAIN_RECORD_REPOSITORY = token<BrainRecordRepositoryPort>('port.BrainRecordRepository');

/** Git for the brain clone; the daemon rebinds it to `GitBrainRepo`. */
export const BRAIN_REPO = token<BrainRepoPort>('port.BrainRepo');
/** The brain's host (`gh`): repository creation and pull requests; the daemon rebinds it. */
export const BRAIN_HOST = token<BrainHostPort>('port.BrainHost');

export const BRAIN_SERVICE = token<BrainService>('application.BrainService');
/** Pulls linked brains at start and in the background; the daemon adds it to the lifecycle. */
export const BRAIN_SYNC_LOOP = token<BrainSyncLoop>('application.BrainSyncLoop');
/** What each attempt reads from the brain; the executor's optional `brain` dep. */
export const BRAIN_CONTEXT_SUPPLY = token<BrainContextSupply>('application.BrainContextSupply');
/** Holds, rejections and gates become lessons; the daemon adds it to the lifecycle. */
export const BRAIN_SIGNALS = token<BrainSignals>('application.BrainSignals');
/** A diff of a task's working directory, for the reflector's evidence; bound by the daemon. */
export const BRAIN_WORKTREE_DIFF = token<WorktreeDiff>('port.BrainWorktreeDiff');
