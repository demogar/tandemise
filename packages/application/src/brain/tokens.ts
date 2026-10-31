import { token } from '@tandemise/kernel';
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
