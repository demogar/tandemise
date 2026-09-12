import type { Container } from './container.js';

/**
 * A composable unit of bindings.
 *
 * Every package that can be plugged in exports exactly one module. The
 * composition root does `compose(container, coreModule, claudeRuntimeModule,
 * githubModule, ...)` and nothing else in the system names those packages.
 * Adding a capability is therefore additive: write the adapter, export a
 * module, append it to the composition list.
 */
export interface TandemiseModule {
  readonly name: string;
  /** Modules that must be registered before this one. Purely declarative. */
  readonly requires?: readonly string[];
  register(container: Container): void;
}

export function defineModule(
  name: string,
  register: (container: Container) => void,
  requires: readonly string[] = [],
): TandemiseModule {
  return { name, requires, register };
}

export function compose(container: Container, ...modules: readonly TandemiseModule[]): Container {
  const registered = new Set<string>();
  const byName = new Map(modules.map((m) => [m.name, m]));
  const visiting = new Set<string>();

  const visit = (m: TandemiseModule): void => {
    if (registered.has(m.name)) return;
    if (visiting.has(m.name)) {
      throw new Error(`Module cycle detected at '${m.name}'`);
    }
    visiting.add(m.name);
    for (const dep of m.requires ?? []) {
      const target = byName.get(dep);
      if (!target) throw new Error(`Module '${m.name}' requires '${dep}', which was not provided`);
      visit(target);
    }
    visiting.delete(m.name);
    m.register(container);
    registered.add(m.name);
  };

  for (const m of modules) visit(m);
  return container;
}
