import { defineModule } from '@tandemise/kernel';
import type { TandemiseModule } from '@tandemise/kernel';
import { RUNTIME_ADAPTERS } from './adapter.js';
import type { AgentRuntimeAdapter } from './adapter.js';
import { RuntimeManager, RUNTIME_MANAGER } from './manager.js';
import { RuntimeRegistry, RUNTIME_REGISTRY } from './registry.js';

export const RUNTIMES_CORE_MODULE_NAME = 'runtimes-core';

/**
 * Binds the runtime core. It resolves `RUNTIME_ADAPTERS` lazily inside the
 * factory, so adapter modules may be composed in any order relative to this
 * one - the registry is built the first time something asks for it, by which
 * point every contribution is in.
 */
export const runtimesCoreModule = defineModule(RUNTIMES_CORE_MODULE_NAME, (container) => {
  container.bind(RUNTIME_REGISTRY, (r) => new RuntimeRegistry(r.resolveAll(RUNTIME_ADAPTERS)), {
    source: RUNTIMES_CORE_MODULE_NAME,
  });
  container.bind(RUNTIME_MANAGER, (r) => new RuntimeManager({ registry: r.resolve(RUNTIME_REGISTRY) }), {
    source: RUNTIMES_CORE_MODULE_NAME,
  });
});

/**
 * The whole of a runtime plugin's wiring, in one call.
 *
 * Adapter packages sit below `@tandemise/kernel` in the dependency graph and so
 * cannot reach `defineModule` themselves. Handing them this instead of the
 * kernel keeps the plugin contract narrow: a runtime package contributes
 * adapters and nothing else, which is exactly the constraint that makes
 * "adding a runtime" a purely additive change (MVP.md §26.1).
 */
export function defineRuntimeModule(
  name: string,
  ...adapters: ReadonlyArray<() => AgentRuntimeAdapter>
): TandemiseModule {
  return defineModule(name, (container) => {
    for (const factory of adapters) {
      container.contribute(RUNTIME_ADAPTERS, factory, { source: name });
    }
  }, [RUNTIMES_CORE_MODULE_NAME]);
}
