import { Container, LifecycleHost, compose, token, type Token } from '@tandemise/kernel';
import { adjustableClock, createLogger, systemClock, type AdjustableClock, type Clock, type Logger } from '@tandemise/shared';
import type { EventBusPort, ProjectionBusPort } from '@tandemise/domain';

// The composition root is the single place in Tandemise that is allowed to name
// a concrete provider. Everything below this line is an implementation detail
// the rest of the system never learns (MVP.md §6.1, §26.1).
import { persistenceModule } from '@tandemise/persistence';
import * as persistenceTokens from '@tandemise/persistence';
import {
  createArtifactsModule, ARTIFACT_STORE as ARTIFACTS_STORE_TOKEN,
  renderArtifactTemplate, parseArtifact, measureArtifact, deriveHandoff, splitAppendix,
} from '@tandemise/artifacts';
import { policyModule } from '@tandemise/policy';
import { contextModule } from '@tandemise/context';
import { createEvaluationModule } from '@tandemise/evaluation';
import { runtimesCoreModule } from '@tandemise/runtimes-core';
import { claudeRuntimeModule } from '@tandemise/runtime-claude';
import { codexRuntimeModule } from '@tandemise/runtime-codex';
import { genericRuntimeModule } from '@tandemise/runtime-generic';
import {
  executionCoreModule, PROCESS_SUPERVISOR,
  CLOCK as EXECUTION_CLOCK, LOGGER as EXECUTION_LOGGER, PATHS as EXECUTION_PATHS,
} from '@tandemise/execution-core';
import { executionLocalModule } from '@tandemise/execution-local';
import {
  integrationsCoreModule,
  BACKGROUND_PROCESS_LAUNCHER, COMMAND_EXECUTOR as TOOL_COMMAND_EXECUTOR,
} from '@tandemise/integrations-core';
import { GhIssueTracker, GhPullRequestSnapshots, githubIntegrationModule } from '@tandemise/integration-github';
import { mcpIntegrationModule } from '@tandemise/integration-mcp';
import { browserIntegrationModule } from '@tandemise/browser';
import { createApplicationModule, createServices, SCHEDULER, type TandemiseServices,
  WORKFLOW_SOURCE,
  SKILL_FILES,
  ISSUE_TRACKER,
  PULL_REQUEST_SNAPSHOTS,
  SETUP_FOLDER,
} from '@tandemise/application';
import * as applicationTokens from '@tandemise/application';

import { SCHEMA_VERSION } from '@tandemise/persistence';
import type { DaemonConfig } from './config.js';
import { InMemoryEventBus, InMemoryProjectionBus } from './buses.js';
import { createSecretStore } from './secrets.js';
import { createSettingsStore, createSystemEnvironment, processLiveness } from './platform.js';
import { createBackgroundProcessLauncher, createToolCommandExecutor } from './tool-exec.js';
import { oauthCallbacks } from './oauth-callback.js';
import { FileSetupFolder } from './setup-folder.js';
import { FileWorkflowSource } from './workflow-source.js';
import { DaemonSkillFiles } from './skill-files.js';

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
  /** The test clock, only when TANDEMISE_CLOCK_OFFSET_MS is set; null otherwise. */
  readonly testClock: AdjustableClock | null;
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
export function bootstrap(config: DaemonConfig, options: { readonly localPersonName?: string } = {}): Bootstrapped {
  const log = createLogger({ level: config.logLevel, base: { component: 'daemon' } });
  const container = new Container();
  const events = new InMemoryEventBus();
  const projections = new InMemoryProjectionBus();

  container.bindValue(CONFIG, config, { source: 'bootstrap' });
  container.bindValue(LOGGER, log, { source: 'bootstrap' });
  // One clock for everything that reads time; shifted only under the test knob.
  const testClock = config.clockOffsetMs === null ? null : adjustableClock(config.clockOffsetMs);
  const clock: Clock = testClock ?? systemClock;
  container.bindValue(CLOCK, clock, { source: 'bootstrap' });
  container.bindValue(EVENT_BUS, events, { source: 'bootstrap' });
  container.bindValue(PROJECTION_BUS, projections, { source: 'bootstrap' });

  compose(
    container,
    persistenceModule({ path: config.paths.db, logger: log.child({ component: 'persistence' }), clock }),
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
    mcpIntegrationModule,
    browserIntegrationModule,
    // The name reaches a fresh database's first person; this layer may run git, the application may not.
    createApplicationModule({
      ...(options.localPersonName === undefined ? {} : { localPersonName: options.localPersonName }),
      quietAfterMs: config.quietMs,
    }),
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

  // `integrations-core` is a core package and cannot spawn a process itself, so
  // it declares these ports and gets them here. Routing tool execution through
  // the same supervisor a worker run uses is what gives every tool call an
  // allowlisted environment, a tracked pid, and no orphan on shutdown - and it
  // is what lets an integration report real health instead of `unknown`.
  container.bind(TOOL_COMMAND_EXECUTOR, (r) =>
    createToolCommandExecutor(r.resolve(PROCESS_SUPERVISOR), r.resolve(LOGGER).child({ component: 'tool-exec' })),
    { source: 'bootstrap' });
  container.bind(BACKGROUND_PROCESS_LAUNCHER, (r) =>
    createBackgroundProcessLauncher(r.resolve(PROCESS_SUPERVISOR)), { source: 'bootstrap' });

  // Workflows are files in the user's own repositories, so reading them is an
  // adapter concern and belongs here rather than in the engine.
  // Rebound rather than bound: the application module ships a source that finds
  // nothing, so a container without a filesystem still resolves.
  container.rebind(WORKFLOW_SOURCE, (r) =>
    new FileWorkflowSource(r.resolve(LOGGER).child({ component: 'workflows' })), { source: 'bootstrap' });
  // The project's setup as files (P15): the same reasoning, for `.tandemise/`.
  container.rebind(SETUP_FOLDER, (r) =>
    new FileSetupFolder(r.resolve(LOGGER).child({ component: 'setup' })), { source: 'bootstrap' });

  // Skills (P13) are the person's folders and git repositories, read by the
  // daemon; the application only ever sees bytes and hashes.
  container.rebind(SKILL_FILES, (r) =>
    new DaemonSkillFiles(config.paths.skills, config.skillsDiscoverRoot, r.resolve(LOGGER).child({ component: 'skills' })), { source: 'bootstrap' });

  // GitHub issues (P14) go through the same `gh` and command executor as the
  // GitHub tools, so `gh` is found on the daemon's own PATH.
  container.rebind(ISSUE_TRACKER, (r) => new GhIssueTracker(r.resolve(TOOL_COMMAND_EXECUTOR)), { source: 'bootstrap' });
  // A handed-back pull request (P3) is read the same way.
  container.rebind(PULL_REQUEST_SNAPSHOTS, (r) => new GhPullRequestSnapshots(r.resolve(TOOL_COMMAND_EXECUTOR)), { source: 'bootstrap' });

  const services = createServices(container);

  const lifecycle = new LifecycleHost(log);
  // Without this the tick loop never runs: the scheduler would only advance
  // when an API call happened to wake it, so a mission would climb about one
  // DAG level per request and then sit still. Registering it here is also what
  // gives shutdown its ordering - `stop()` aborts in-flight runs before the
  // database and process supervisor are disposed.
  lifecycle.add(container.resolve(SCHEDULER));

  return { container, services, lifecycle, events, projections, log, testClock };
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
  bindDirect('ARTIFACT_MEASURE', () => ({ measure: measureArtifact, deriveHandoff, splitAppendix }));
  bindDirect('EVENT_BUS', (r) => r.resolve(EVENT_BUS));
  bindDirect('PROJECTION_BUS', (r) => r.resolve(PROJECTION_BUS));
  bindDirect('SECRET_STORE', (r) => createSecretStore({ home: r.resolve(CONFIG).home, log }));
  bindDirect('SETTINGS_STORE', (r) => createSettingsStore(r.resolve(CONFIG).home, log));
  bindDirect('SYSTEM_ENVIRONMENT', (r) => createSystemEnvironment(r.resolve(CONFIG), SCHEMA_VERSION));
  bindDirect('PROCESS_LIVENESS', () => processLiveness);
  bindDirect('OAUTH_CALLBACK', () => oauthCallbacks);

  log.debug('bootstrap.ports_bound', { aliased, missing });
}

function isToken(value: unknown): value is Token<unknown> {
  return typeof value === 'object' && value !== null && 'description' in value
    && typeof (value as { description: unknown }).description === 'string';
}
