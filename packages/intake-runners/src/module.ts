import { defineModule } from '@tandemise/kernel';
import { INTAKE_RUNNERS } from '@tandemise/integrations-core';
import { PostHogRunner } from './posthog.js';
import { SentryRunner } from './sentry.js';

const SOURCE = 'intake-runners';

/**
 * Contributes the shipped intake runners that talk to a vendor's HTTP API
 * (spec §2, plan Tasks 11 and 12). The application names none of them: the
 * host reads `INTAKE_RUNNERS` and matches each configured source by `kind`.
 * One line per runner; Slack and Discord join here.
 */
export const intakeRunnersModule = defineModule('intake-runners', (container) => {
  container.contribute(INTAKE_RUNNERS, () => new SentryRunner(), { source: SOURCE });
  container.contribute(INTAKE_RUNNERS, () => new PostHogRunner(), { source: SOURCE });
});
