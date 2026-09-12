// Single source of truth for the monorepo package graph and its allowed
// dependency direction. `scripts/check-boundaries.mjs` enforces it mechanically
// (MVP.md §26.1 - dependency direction).
export const LAYERS = {
  shared: 0,
  kernel: 1,
  domain: 1,
  policy: 2,
  artifacts: 2,
  persistence: 2,
  'runtimes-core': 3,
  'execution-core': 3,
  'integrations-core': 3,
  context: 3,
  evaluation: 3,
  'runtime-claude': 4,
  'runtime-codex': 4,
  'runtime-generic': 4,
  'execution-local': 4,
  'integration-github': 4,
  browser: 4,
  application: 5,
};

/** Packages that may reference a concrete third-party provider/SDK. */
export const PROVIDER_PACKAGES = new Set([
  'runtime-claude', 'runtime-codex', 'runtime-generic',
  'execution-local', 'integration-github', 'browser',
  'persistence', 'artifacts',
]);

export const PACKAGES = {
  shared: { deps: [], ext: { zod: '^3.24.1' } },
  kernel: { deps: ['shared'], ext: {} },
  domain: { deps: ['shared'], ext: { zod: '^3.24.1' } },
  policy: { deps: ['shared', 'domain'], ext: {} },
  artifacts: { deps: ['shared', 'domain'], ext: {} },
  persistence: { deps: ['shared', 'domain'], ext: { 'better-sqlite3': '^11.7.0' }, dev: { '@types/better-sqlite3': '^7.6.12' } },
  'runtimes-core': { deps: ['shared', 'domain', 'kernel'], ext: {} },
  'execution-core': { deps: ['shared', 'domain', 'kernel'], ext: {} },
  'integrations-core': { deps: ['shared', 'domain', 'kernel', 'policy'], ext: { zod: '^3.24.1' } },
  context: { deps: ['shared', 'domain'], ext: {} },
  evaluation: { deps: ['shared', 'domain'], ext: {} },
  'runtime-claude': { deps: ['shared', 'domain', 'runtimes-core'], ext: {} },
  'runtime-codex': { deps: ['shared', 'domain', 'runtimes-core'], ext: {} },
  'runtime-generic': { deps: ['shared', 'domain', 'runtimes-core'], ext: {} },
  'execution-local': { deps: ['shared', 'domain', 'execution-core'], ext: {} },
  'integration-github': { deps: ['shared', 'domain', 'integrations-core', 'execution-core'], ext: {} },
  browser: { deps: ['shared', 'domain', 'integrations-core'], ext: { playwright: '^1.49.1' } },
  application: {
    deps: ['shared', 'kernel', 'domain', 'policy', 'runtimes-core', 'execution-core', 'integrations-core', 'context', 'evaluation'],
    ext: { zod: '^3.24.1' },
  },
};

export const APPS = {
  daemon: {
    deps: Object.keys(PACKAGES),
    ext: { zod: '^3.24.1', ws: '^8.18.0' },
    dev: { '@types/ws': '^8.5.13' },
  },
};
