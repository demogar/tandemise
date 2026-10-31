import { defineModule } from '@tandemise/kernel';
import { TandemiseError } from '@tandemise/shared';
import type { PrimaryTrackerFactory } from '@tandemise/domain';
import { PRIMARY_TRACKER_FACTORIES } from '@tandemise/integrations-core';
import { YouTrackTracker } from './tracker.js';

/**
 * Builds a project's YouTrack tracker from its `tracker` configuration and the
 * person's permanent token from the local secret store (spec §6: the token is
 * never in the brain repo).
 */
export const youtrackTrackerFactory: PrimaryTrackerFactory = {
  kind: 'youtrack',
  create(config, credential) {
    if (config.url === undefined || config.project === undefined) {
      throw new TandemiseError('PRECONDITION_FAILED', "Set this project's YouTrack URL and project first.");
    }
    if (credential === undefined || credential === '') {
      throw new TandemiseError('PRECONDITION_FAILED', "Save a YouTrack permanent token in this project's tracker settings first.");
    }
    return new YouTrackTracker({ url: config.url, project: config.project, token: credential });
  },
};

/**
 * Contributes the YouTrack tracker factory (plan Task 4). Like every
 * integration, the whole wiring cost is this module plus one line in the
 * composition list.
 */
export const youtrackIntegrationModule = defineModule('integration-youtrack', (container) => {
  container.contribute(PRIMARY_TRACKER_FACTORIES, () => youtrackTrackerFactory, { source: 'integration-youtrack' });
});
