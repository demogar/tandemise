import { defineModule } from '@tandemise/kernel';
import { COMMAND_EXECUTOR, INTEGRATION_PROVIDERS, PRIMARY_TRACKER_FACTORIES } from '@tandemise/integrations-core';
import { GitHubIntegrationProvider } from './provider.js';
import { githubTrackerFactory } from './primary-tracker.js';

/**
 * Contributes the GitHub provider. This is the entire wiring cost of an
 * integration: write the adapter, export a module, append it to the composition
 * list (MVP.md §26.1).
 */
export const githubIntegrationModule = defineModule('integration-github', (container) => {
  container.contribute(INTEGRATION_PROVIDERS, () => new GitHubIntegrationProvider(), {
    source: 'integration-github',
  });
  // GitHub Issues as a project's primary tracker (intake plan Task 5). The
  // executor is resolved when a tracker is built, not when the module composes.
  container.contribute(PRIMARY_TRACKER_FACTORIES, (r) => githubTrackerFactory(() => r.resolve(COMMAND_EXECUTOR)), {
    source: 'integration-github',
  });
});
