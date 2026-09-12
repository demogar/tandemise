import { defineModule } from '@tandemise/kernel';
import { RUNTIME_ADAPTERS } from './adapter.js';
import { RuntimeManager, RUNTIME_MANAGER } from './manager.js';
import { RuntimeRegistry, RUNTIME_REGISTRY } from './registry.js';

/**
 * Binds the runtime core. It resolves `RUNTIME_ADAPTERS` lazily inside the
 * factory, so adapter modules may be composed in any order relative to this
 * one - the registry is built the first time something asks for it, by which
 * point every contribution is in.
 */
export const runtimesCoreModule = defineModule('runtimes-core', (container) => {
  container.bind(RUNTIME_REGISTRY, (r) => new RuntimeRegistry(r.resolveAll(RUNTIME_ADAPTERS)), {
    source: 'runtimes-core',
  });
  container.bind(RUNTIME_MANAGER, (r) => new RuntimeManager({ registry: r.resolve(RUNTIME_REGISTRY) }), {
    source: 'runtimes-core',
  });
});
