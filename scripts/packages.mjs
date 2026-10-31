// Single source of truth for the monorepo package graph and its allowed
// dependency direction. `scripts/check-boundaries.mjs` enforces it mechanically
// (MVP.md §26.1 - dependency direction).
export const LAYERS = {
  // The design system (tokens, theme, logo, icons). A leaf like shared, but
  // the only package the desktop renderer may import at runtime: it has no
  // imports at all, so nothing Node-only can reach the browser bundle.
  design: 0,
  shared: 0,
  kernel: 1,
  domain: 1,
  policy: 2,
  'api-contract': 2,
  artifacts: 2,
  persistence: 2,
  'runtimes-core': 3,
  'execution-core': 3,
  'integrations-core': 3,
  context: 3,
  evaluation: 3,
  coordination: 3,
  'runtime-claude': 4,
  'runtime-codex': 4,
  'runtime-generic': 4,
  'execution-local': 4,
  terminal: 4,
  'integration-github': 4,
  'integration-youtrack': 4,
  'intake-runners': 4,
  'integration-mcp': 4,
  browser: 4,
  'desktop-control': 4,
  'coordination-relay': 4,
  application: 5,
};

/** Packages that may reference a concrete third-party provider/SDK. */
export const PROVIDER_PACKAGES = new Set([
  'runtime-claude', 'runtime-codex', 'runtime-generic',
  'execution-local', 'terminal', 'integration-github', 'integration-mcp', 'browser', 'desktop-control',
  'persistence', 'artifacts', 'integration-youtrack', 'intake-runners', 'coordination-relay',
]);

export const PACKAGES = {
  shared: { deps: [], ext: { zod: '^3.24.1' } },
  kernel: { deps: ['shared'], ext: {} },
  domain: { deps: ['shared'], ext: { zod: '^3.24.1' } },
  'api-contract': { deps: ['shared', 'domain'], ext: { zod: '^3.24.1' } },
  policy: { deps: ['shared', 'kernel', 'domain'], ext: {} },
  artifacts: { deps: ['shared', 'kernel', 'domain'], ext: { zod: '^3.24.1' } },
  persistence: { deps: ['shared', 'kernel', 'domain'], ext: { 'better-sqlite3': '^11.7.0' }, dev: { '@types/better-sqlite3': '^7.6.12' } },
  'runtimes-core': { deps: ['shared', 'domain', 'kernel'], ext: {} },
  'execution-core': { deps: ['shared', 'domain', 'kernel'], ext: {} },
  'integrations-core': { deps: ['shared', 'domain', 'kernel', 'policy'], ext: { zod: '^3.24.1' } },
  context: { deps: ['shared', 'kernel', 'domain', 'policy'], ext: {} },
  evaluation: { deps: ['shared', 'kernel', 'domain'], ext: {} },
  coordination: { deps: ['api-contract'], ext: { zod: '^3.24.1' } },
  'runtime-claude': { deps: ['shared', 'domain', 'runtimes-core'], ext: {} },
  'runtime-codex': { deps: ['shared', 'kernel', 'domain', 'runtimes-core'], ext: {} },
  'runtime-generic': { deps: ['shared', 'domain', 'runtimes-core'], ext: {} },
  'execution-local': { deps: ['shared', 'domain', 'kernel', 'execution-core'], ext: {} },
  terminal: { deps: ['shared', 'domain', 'kernel'], ext: { 'node-pty': '1.1.0' } },
  'integration-github': { deps: ['shared', 'kernel', 'domain', 'integrations-core', 'execution-core'], ext: {} },
  'integration-youtrack': { deps: ['shared', 'kernel', 'domain', 'integrations-core'], ext: { zod: '^3.24.1' } },
  'intake-runners': { deps: ['shared', 'kernel', 'domain', 'integrations-core'], ext: {} },
  'integration-mcp': { deps: ['shared', 'kernel', 'domain', 'integrations-core'], ext: { zod: '^3.24.1' } },
  browser: { deps: ['shared', 'kernel', 'domain', 'integrations-core'], ext: { playwright: '^1.49.1', zod: '^3.24.1' } },
  'desktop-control': { deps: ['shared', 'domain', 'kernel', 'integrations-core'], ext: {} },
  // The daemon's relay client (relay spec): a provider, so only bootstrap names it.
  'coordination-relay': { deps: ['api-contract', 'coordination'], ext: { ws: '^8.18.0' }, dev: { '@types/ws': '^8.5.13' } },
  application: {
    deps: ['shared', 'kernel', 'domain', 'api-contract', 'policy', 'runtimes-core', 'execution-core', 'integrations-core', 'context', 'evaluation', 'coordination'],
    ext: { zod: '^3.24.1', yaml: '^2.9.1' },
  },
};

/**
 * Packages built for the UI rather than the daemon, and published on their own
 * (`@tandemise/design`). They depend on nothing - no `@tandemise/*`, no
 * third-party module, no `node:*` - which check-boundaries enforces, and the
 * desktop renderer may value-import them. Not in PACKAGES, so the daemon's
 * dependency list and the scaffold leave them alone.
 */
export const UI_PACKAGES = {
  design: { deps: [], ext: {} },
};

export const APPS = {
  // The optional team relay (docs/superpowers/specs/2026-10-30-relay-design.md). check-boundaries holds
  // apps/relay/src to the two internal modules below plus ws, better-sqlite3, zod and node:*.
  relay: {
    deps: ['api-contract', 'coordination'],
    ext: { ws: '^8.18.0', 'better-sqlite3': '^11.7.0', zod: '^3.24.1' },
    dev: { '@types/ws': '^8.5.13', '@types/better-sqlite3': '^7.6.12' },
  },
  daemon: {
    deps: Object.keys(PACKAGES),
    ext: { zod: '^3.24.1', ws: '^8.18.0' },
    dev: { '@types/ws': '^8.5.13' },
  },
};
