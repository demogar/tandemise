import { mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { errorMessage } from '@tandemise/shared';
import { API_VERSION } from '@tandemise/api-contract';
import { loadConfig } from './config.js';
import { bootstrap } from './bootstrap.js';
import { buildRouter } from './routes.js';
import { HttpServer } from './http/server.js';
import { StreamServer } from './http/stream.js';
import {
  InstanceLock, loadOrCreateToken, removeConnectionFile, writeConnectionFile,
} from './http/identity.js';
import { installShutdownHandlers } from './lifecycle.js';
import { adoptGitName, gitUserName } from './local-person.js';
import { EVAL_RUNNER, RECOVERY_SERVICE } from '@tandemise/application';
import type { Container } from '@tandemise/kernel';

/**
 * tandemd.
 *
 * Startup order is load-bearing (MVP.md §21.2): take the instance lock before
 * touching the database, finish recovery before the scheduler can dispatch
 * anything, and only then publish the connection file - because the moment that
 * file exists, the desktop will start making requests.
 */
export async function startDaemon(overrides: Parameters<typeof loadConfig>[0] = {}): Promise<{
  url: string;
  stop: () => Promise<void>;
  /** The DI container, so a check can resolve a repository directly rather than only through the HTTP API. */
  container: Container;
}> {
  const config = loadConfig(overrides);
  mkdirSync(config.home, { recursive: true });
  mkdirSync(config.paths.logs, { recursive: true });

  const lock = new InstanceLock(config.home);
  lock.acquire();

  const gitName = gitUserName();
  const { container, services, lifecycle, events, projections, log, testClock } = bootstrap(config, { localPersonName: gitName });
  if (testClock !== null) log.warn('daemon.test_clock', { offsetMs: testClock.offsetMs() });
  log.info('daemon.starting', { version: config.version, build: config.build, apiVersion: API_VERSION, home: config.home });
  adoptGitName(services, gitName, log);

  // Recovery reconciles whatever the last daemon left behind, and must complete
  // before the scheduler can dispatch anything (MVP.md §21.2).
  await container.resolve(RECOVERY_SERVICE).run();
  // An eval run the last daemon stopped mid-way is failed, never resumed, and its trial cleaned up (P3b).
  await container.resolve(EVAL_RUNNER).recoverInterrupted();

  // Before anything is planned or dispatched: a task is granted from its role,
  // so a stale built-in would withhold capabilities the shipped role now has.
  const workspaceIds = services.workspaces.list().map((view) => view.workspace.id);
  const refreshedRoles = services.roles.refreshBuiltIns(workspaceIds);
  if (refreshedRoles > 0) log.info('roles.built_ins_refreshed', { count: refreshedRoles });

  // An MCP server's tools are learned by checking its health, and that list
  // lives in memory. Until something asked - usually someone opening the
  // Integrations screen - every connected server published nothing after a
  // restart, and the first design task after one ran without Open Design.
  // Checked before the scheduler starts, bounded so a slow server cannot hold
  // the daemon hostage.
  const warmed = await Promise.race([
    services.integrations.list().then((views) => views.length),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), INTEGRATION_WARM_TIMEOUT_MS).unref()),
  ]).catch((e: unknown) => {
    log.warn('integrations.warm_failed', { error: e instanceof Error ? e.message : String(e) });
    return null;
  });
  log.info('integrations.warmed', { integrations: warmed, timedOut: warmed === null });

  await lifecycle.start();
  // After the lifecycle, so a re-plan has the runtimes and targets it needs.
  const replanned = services.planning.resumeInterrupted();
  if (replanned.length > 0) log.info('planning.resumed', { missions: replanned });

  const token = loadOrCreateToken(config.home);
  const router = buildRouter(services, { testClock });

  let stream: StreamServer | undefined;
  const http = new HttpServer({
    token,
    router,
    log,
    // P0 has one token and one person: every request acts as the local person.
    identityResolver: () => ({ personId: services.identity.localPerson().id }),
    port: config.port,
    onUpgrade: (req, socket, head) => stream?.handleUpgrade(req, socket, head),
  });

  const url = await http.listen();
  stream = new StreamServer({
    server: http.httpServer,
    log,
    daemonVersion: config.version,
    events,
    projections,
  });

  writeConnectionFile(config.home, {
    url,
    token,
    pid: process.pid,
    apiVersion: API_VERSION,
    startedAt: new Date().toISOString(),
  });

  log.info('daemon.ready', { url, routes: router.routeTable().length });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    stream?.close();
    await http.close();
    await lifecycle.stop();
    await container.dispose();
    removeConnectionFile(config.home, log);
    lock.release();
  };

  installShutdownHandlers({ log, shutdown: stop });
  return { url, stop, container };
}

/** The longest startup waits for connected servers to report their tools. */
const INTEGRATION_WARM_TIMEOUT_MS = 20_000;

/** True when this module is the process entry point rather than an import. */
function isEntryPoint(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return realpathSync(argv) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Tests and the desktop's spawner import `startDaemon` directly; only a direct
// `node main.js` should start a daemon, or they would race a second instance.
if (isEntryPoint()) {
  startDaemon().catch((e) => {
    process.stderr.write(`tandemd failed to start: ${errorMessage(e)}\n`);
    process.exit(1);
  });
}
