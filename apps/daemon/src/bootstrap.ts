import { Container, LifecycleHost, compose, token, type Token } from '@tandemise/kernel';
import { createLogger, systemClock, type Clock, type Logger } from '@tandemise/shared';
import type { EventBusPort, ProjectionBusPort } from '@tandemise/domain';

// The composition root is the single place in Tandemise that is allowed to name
// a concrete provider. Everything below this line is an implementation detail
// the rest of the system never learns (MVP.md §6.1, §26.1).
import { persistenceModule } from '@tandemise/persistence';
import * as persistenceTokens from '@tandemise/persistence';
import { createArtifactsModule, ARTIFACT_STORE as ARTIFACTS_STORE_TOKEN, renderArtifactTemplate } from '@tandemise/artifacts';
import { policyModule } from '@tandemise/policy';
import { contextModule } from '@tandemise/context';
import { createEvaluationModule } from '@tandemise/evaluation';
import { runtimesCoreModule } from '@tandemise/runtimes-core';
import { claudeRuntimeModule } from '@tandemise/runtime-claude';
import { genericRuntimeModule } from '@tandemise/runtime-generic';
import { executionCoreModule } from '@tandemise/execution-core';
import { executionLocalModule } from '@tandemise/execution-local';
import { integrationsCoreModule } from '@tandemise/integrations-core';
import { githubIntegrationModule } from '@tandemise/integration-github';
import { browserIntegrationModule } from '@tandemise/browser';
import { applicationModule, createServices, type TandemiseServices } from '@tandemise/application';
import * as applicationTokens from '@tandemise/application';

import type { DaemonConfig } from './config.js';
import { InMemoryEventBus, InMemoryProjectionBus } from './buses.js';

export const CLOCK = token<Clock>('Clock');
export const LOGGER = token<Logger>('Logger');
export const EVENT_BUS = token<EventBusPort>('EventBusPort');
export const PROJECTION_BUS = token<ProjectionBusPort>('ProjectionBusPort');
export const CONFIG = token<DaemonConfig>('DaemonConfig');

export interface Bootstrapped {
  readonly container: Container;
  readonly services: TandemiseServices;
  readonly lifecycle: LifecycleHost;
  readonly events: EventBusPort;
  readonly projections: ProjectionBusPort;
  readonly log: Logger;
}

/**
 * Wires the application.
 *
 * Module order is the dependency order: infrastructure, then contracts, then
 * providers, then the mission engine. `compose` honours each module's declared
 * `requires`, so this list is a readable manifest rather than a fragile
 * sequence - and adding a capability really is one more entry here.
 */
export function bootstrap(config: DaemonConfig): Bootstrapped {
  const log = createLogger({ level: config.logLevel, base: { component: 'daemon' } });
  const container = new Container();
  const events = new InMemoryEventBus();
  const projections = new InMemoryProjectionBus();

  container.bindValue(CONFIG, config, { source: 'bootstrap' });
  container.bindValue(LOGGER, log, { source: 'bootstrap' });
  container.bindValue(CLOCK, systemClock, { source: 'bootstrap' });
  container.bindValue(EVENT_BUS, events, { source: 'bootstrap' });
  container.bindValue(PROJECTION_BUS, projections, { source: 'bootstrap' });

  compose(
    container,
    persistenceModule({ path: config.paths.db, logger: log.child({ component: 'persistence' }) }),
    createArtifactsModule({ paths: config.paths }),
    policyModule,
    contextModule,
    createEvaluationModule(),
    runtimesCoreModule,
    claudeRuntimeModule,
    genericRuntimeModule,
    executionCoreModule,
    executionLocalModule,
    integrationsCoreModule,
    githubIntegrationModule,
    browserIntegrationModule,
    applicationModule,
  );

  aliasPorts(container, log);

  const services = createServices(container);
  const lifecycle = new LifecycleHost(log);

  return { container, services, lifecycle, events, projections, log };
}

/**
 * Binds the application's port tokens to the concrete providers.
 *
 * `@tandemise/application` cannot import `@tandemise/persistence` - that would
 * point a dependency arrow outward - so it declares its own tokens for the ports
 * it needs. Here, where naming providers is allowed, the two are joined. Doing
 * it by name keeps the alias honest: a token added on either side without a
 * counterpart shows up immediately in the diagnostics table rather than as a
 * missing-binding error at the first request.
 */
function aliasPorts(container: Container, log: Logger): void {
  const aliased: string[] = [];
  const missing: string[] = [];

  for (const [name, appToken] of Object.entries(applicationTokens)) {
    if (!isToken(appToken)) continue;
    const provider = (persistenceTokens as Record<string, unknown>)[name];
    if (!isToken(provider) || !container.has(provider)) continue;
    if (container.has(appToken)) continue;
    container.bind(appToken, (r) => r.resolve(provider), { source: `alias:${name}` });
    aliased.push(name);
  }

  // The artifact store and template renderer live in a provider package for the
  // same reason, and have no persistence counterpart to match by name.
  const appArtifactStore = (applicationTokens as Record<string, unknown>).ARTIFACT_STORE;
  if (isToken(appArtifactStore) && !container.has(appArtifactStore)) {
    container.bind(appArtifactStore, (r) => r.resolve(ARTIFACTS_STORE_TOKEN), { source: 'alias:ARTIFACT_STORE' });
    aliased.push('ARTIFACT_STORE');
  }
  const appTemplates = (applicationTokens as Record<string, unknown>).ARTIFACT_TEMPLATES;
  if (isToken(appTemplates) && !container.has(appTemplates)) {
    container.bindValue(appTemplates as Token<unknown>, { render: renderArtifactTemplate }, { source: 'alias:ARTIFACT_TEMPLATES' });
    aliased.push('ARTIFACT_TEMPLATES');
  }

  log.debug('bootstrap.ports_aliased', { aliased, missing });
}

function isToken(value: unknown): value is Token<unknown> {
  return typeof value === 'object' && value !== null && 'description' in value
    && typeof (value as { description: unknown }).description === 'string';
}
