import { defineModule } from '@tandemise/kernel';
import { INTEGRATION_CREDENTIALS, INTEGRATION_PROVIDERS } from '@tandemise/integrations-core';
import { McpIntegrationProvider } from './provider.js';

/**
 * Contributes the MCP provider. Nothing in the core names it, and removing this
 * module removes the capability cleanly (MVP.md §26.1).
 *
 * The credential source is resolved lazily, per request: it is bound by the
 * application, which is composed after this module, and a daemon without one
 * still runs local servers that need no account.
 */
export const mcpIntegrationModule = defineModule('integration-mcp', (container) => {
  container.contribute(
    INTEGRATION_PROVIDERS,
    (r) => new McpIntegrationProvider({ credentials: () => r.tryResolve(INTEGRATION_CREDENTIALS) ?? null }),
    { source: 'integration-mcp' },
  );
});
