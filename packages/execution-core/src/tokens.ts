import { multiToken, token } from '@tandemise/kernel';
import type { Clock, Logger, TandemisePaths } from '@tandemise/shared';
import type { ProcessSupervisor } from './process-supervisor.js';
import type { ExecutionTargetFactory, ExecutionTargetManager } from './target-factory.js';

/**
 * Cross-cutting tokens.
 *
 * These three are not execution-specific and belong in `@tandemise/kernel` once
 * it grows a home for them; they live here for now because execution-core is
 * the lowest layer that needs to resolve them. Consumers should import them
 * from one place, so they are re-exported rather than redeclared elsewhere.
 */
export const LOGGER = token<Logger>('tandemise/logger');
export const CLOCK = token<Clock>('tandemise/clock');
export const PATHS = token<TandemisePaths>('tandemise/paths');

export const PROCESS_SUPERVISOR = token<ProcessSupervisor>('execution/process-supervisor');
export const EXECUTION_TARGET_MANAGER = token<ExecutionTargetManager>('execution/target-manager');

/** The plugin seam for target kinds: every factory contributes here. */
export const EXECUTION_TARGET_FACTORIES = multiToken<ExecutionTargetFactory>('execution/target-factory');
