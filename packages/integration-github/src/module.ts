import { defineModule } from '@tandemise/kernel';
import { INTEGRATION_PROVIDERS } from '@tandemise/integrations-core';
import { GitHubIntegrationProvider } from './provider.js';

/**
 * Contributes the GitHub provider. This is the entire wiring cost of an
 * integration: write the adapter, export a module, append it to the composition
 * list (MVP.md §26.1).
 */
export const githubIntegrationModule = defineModule('integration-github', (container) => {
  container.contribute(INTEGRATION_PROVIDERS, () => new GitHubIntegrationProvider(), {
    source: 'integration-github',
  });
});
