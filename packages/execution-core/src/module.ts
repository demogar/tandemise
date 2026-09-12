import { defineModule } from '@tandemise/kernel';
import { nullLogger } from '@tandemise/shared';
import { EXECUTION_TARGET_FACTORIES, EXECUTION_TARGET_MANAGER, LOGGER } from './tokens.js';
import { ExecutionTargetManager } from './target-factory.js';

/**
 * Binds the kind-agnostic half of execution. It deliberately does not bind a
 * ProcessSupervisor: spawning is provider work, so the implementation arrives
 * from a provider module (`executionLocalModule`).
 */
export const executionCoreModule = defineModule('execution-core', (c) => {
  c.bind(
    EXECUTION_TARGET_MANAGER,
    (r) =>
      new ExecutionTargetManager(
        r.resolveAll(EXECUTION_TARGET_FACTORIES),
        (r.tryResolve(LOGGER) ?? nullLogger).child({ component: 'targets' }),
      ),
    { source: 'execution-core', dispose: (m) => m.disposeAll() },
  );
});
