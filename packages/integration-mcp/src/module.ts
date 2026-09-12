import { defineModule } from '@tandemise/kernel';
import { INTEGRATION_PROVIDERS } from '@tandemise/integrations-core';
import { McpIntegrationProvider } from './provider.js';

/**
 * Contributes the MCP provider. Nothing in the core names it, and removing this
 * module removes the capability cleanly (MVP.md §26.1).
 */
export const mcpIntegrationModule = defineModule('integration-mcp', (container) => {
  container.contribute(
    INTEGRATION_PROVIDERS,
    () => new McpIntegrationProvider(),
    { source: 'integration-mcp' },
  );
});
