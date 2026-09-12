import { Container, LifecycleHost, compose, token, type Token } from '@tandemise/kernel';
import { createLogger, systemClock, type Clock, type Logger } from '@tandemise/shared';
import type { EventBusPort, ProjectionBusPort } from '@tandemise/domain';

// The composition root is the single place in Tandemise that is allowed to name
// a concrete provider. Everything below this line is an implementation detail
// the rest of the system never learns (MVP.md §6.1, §26.1).
import { persistenceModule } from '@tandemise/persistence';
import * as persistenceTokens from '@tandemise/persistence';
import {
  createArtifactsModule, ARTIFACT_STORE as ARTIFACTS_STORE_TOKEN,
  renderArtifactTemplate, parseArtifact,
} from '@tandemise/artifacts';
import { policyModule } from '@tandemise/policy';
import { contextModule } from '@tandemise/context';
import { createEvaluationModule } from '@tandemise/evaluation';
import { runtimesCoreModule } from '@tandemise/runtimes-core';
import { claudeRuntimeModule } from '@tandemise/runtime-claude';
import { codexRuntimeModule } from '@tandemise/runtime-codex';
import { genericRuntimeModule } from '@tandemise/runtime-generic';
import {
  executionCoreModule,
  CLOCK as EXECUTION_CLOCK, LOGGER as EXECUTION_LOGGER, PATHS as EXECUTION_PATHS,
} from '@tandemise/execution-core';
import { executionLocalModule } from '@tandemise/execution-local';
import { integrationsCoreModule } from '@tandemise/integrations-core';
import { githubIntegrationModule } from '@tandemise/integration-github';
import { browserIntegrationModule } from '@tandemise/browser';
import { applicationModule, createServices, SCHEDULER, type TandemiseServices } from '@tandemise/application';
import * as applicationTokens from '@tandemise/application';

import { SCHEMA_VERSION } from '@tandemise/persistence';
import type { DaemonConfig } from './config.js';
import { InMemoryEventBus, InMemoryProjectionBus } from './buses.js';
import { createSecretStore } from './secrets.js';
import { createSettingsStore, createSystemEnvironment, processLiveness } from './platform.js';

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
    codexRuntimeModule,
    genericRuntimeModule,
    executionCoreModule,
    executionLocalModule,
    integrationsCoreModule,
    githubIntegrationModule,
    browserIntegrationModule,
    applicationModule,
  );

  aliasPorts(container, log);

  // `execution-core` declares its own Clock/Logger/Paths tokens because no
  // lower-layer package owns them. They are distinct token objects from the
  // ones bound above - identity, not description, is what a container keys on -
  // so without these three lines git and the execution targets log into
  // `nullLogger` and resolve paths from `~/.tandemise` instead of this
  // daemon's configured home. Those agree by default and diverge the moment a
  // test or a second instance overrides the home.
  container.bind(EXECUTION_LOGGER, (r) => r.resolve(LOGGER), { source: 'bootstrap' });
  container.bind(EXECUTION_CLOCK, (r) => r.resolve(CLOCK), { source: 'bootstrap' });
  container.bind(EXECUTION_PATHS, (r) => r.resolve(CONFIG).paths, { source: 'bootstrap' });

  const services = createServices(container);

  const lifecycle = new LifecycleHost(log);
  // Without this the tick loop never runs: the scheduler would only advance
  // when an API call happened to wake it, so a mission would climb about one
  // DAG level per request and then sit still. Registering it here is also what
  // gives shutdown its ordering - `stop()` aborts in-flight runs before the
  // database and process supervisor are disposed.
  lifecycle.add(container.resolve(SCHEDULER));

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

  // Both sides are erased to `Token<unknown>` deliberately. The alias is
  // type-safe by construction rather than by declaration: the two tokens carry
  // the same exported name, and the port interface they are parameterised with
  // is literally the same type imported from `@tandemise/domain`. Enumerating
  // fifty pairs explicitly to satisfy the compiler would add fifty places to
  // forget one.
  const appTokens = applicationTokens as Record<string, unknown>;
  const providerTokens = persistenceTokens as Record<string, unknown>;

  for (const name of Object.keys(appTokens)) {
    const appToken = appTokens[name];
    const provider = providerTokens[name];
    if (!isToken(appToken) || !isToken(provider)) continue;
    if (!container.has(provider) || container.has(appToken)) continue;
    container.bind(appToken, (r) => r.resolve(provider), { source: `alias:${name}` });
    aliased.push(name);
  }

  // The remaining ports have no persistence counterpart to match by name, so
  // they are bound explicitly. Each one is a provider the application layer is
  // forbidden to import directly.
  const appArtifactStore = appTokens['ARTIFACT_STORE'];
  if (isToken(appArtifactStore) && !container.has(appArtifactStore)) {
    container.bind(appArtifactStore, (r) => r.resolve(ARTIFACTS_STORE_TOKEN), { source: 'alias:ARTIFACT_STORE' });
    aliased.push('ARTIFACT_STORE');
  }
  const bindDirect = (name: string, factory: (r: import('@tandemise/kernel').Resolver) => unknown): void => {
    const t = appTokens[name];
    if (!isToken(t)) { missing.push(name); return; }
    if (container.has(t)) return;
    container.bind(t as Token<unknown>, factory, { source: `bind:${name}` });
    aliased.push(name);
  };

  bindDirect('ARTIFACT_TEMPLATES', () => ({ render: renderArtifactTemplate }));
  bindDirect('ARTIFACT_PARSER', () => ({ parse: parseArtifact }));
  bindDirect('EVENT_BUS', (r) => r.resolve(EVENT_BUS));
  bindDirect('PROJECTION_BUS', (r) => r.resolve(PROJECTION_BUS));
  bindDirect('SECRET_STORE', (r) => createSecretStore({ home: r.resolve(CONFIG).home, log }));
  bindDirect('SETTINGS_STORE', (r) => createSettingsStore(r.resolve(CONFIG).home, log));
  bindDirect('SYSTEM_ENVIRONMENT', (r) => createSystemEnvironment(r.resolve(CONFIG), SCHEMA_VERSION));
  bindDirect('PROCESS_LIVENESS', () => processLiveness);

  log.debug('bootstrap.ports_bound', { aliased, missing });
}

function isToken(value: unknown): value is Token<unknown> {
  return typeof value === 'object' && value !== null && 'description' in value
    && typeof (value as { description: unknown }).description === 'string';
}
