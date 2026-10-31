import { token } from '@tandemise/kernel';
import type { BrainRecordRepositoryPort, WorkspaceBrainRepositoryPort } from '@tandemise/domain';

/**
 * The brain's tokens (#51). They live here, not in `../tokens.ts`, which other
 * work edits in parallel. `aliasPorts` in the daemon binds every application
 * token to the persistence token of the same exported name, so these two
 * resolve to SQLite without a line of wiring.
 */
export const WORKSPACE_BRAIN_REPOSITORY = token<WorkspaceBrainRepositoryPort>('port.WorkspaceBrainRepository');
export const BRAIN_RECORD_REPOSITORY = token<BrainRecordRepositoryPort>('port.BrainRecordRepository');
