import { execFile, spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { accessSync, appendFileSync, closeSync, constants, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { app } from 'electron';
import type { DaemonConnection, DaemonStatus } from '../shared/bridge.js';
import { LOGIN_PATH_MARKER, bundledDaemonNode, daemonNeedsReplacing, parseLoginShellPath, resolveDaemonNode, type NodeResolution } from './node-runtime.js';

const TANDEMISE_HOME = process.env['TANDEMISE_HOME'] ?? join(homedir(), '.tandemise');
const HANDSHAKE_FILE = join(TANDEMISE_HOME, 'daemon.json');
/** Which Node started the daemon, and anything the daemon said on stderr while starting. */
const LAUNCH_LOG = join(TANDEMISE_HOME, 'logs', 'daemon-launch.log');

/** How long an old daemon gets to shut down cleanly after an update (its own grace is 15s). */
const REPLACE_TIMEOUT_MS = 20_000;

/** How long the update notice stays on screen at least. */
const UPDATE_NOTICE_MIN_MS = 3_000;

/** The words the window shows while an updated app replaces the old daemon. */
export const RESTARTING_AFTER_UPDATE = 'Tandemise was updated; restarting its background service…';

/** Poll budget for a daemon we just spawned. Generous: first start compiles nothing but does open a database. */
const SPAWN_POLL_INTERVAL_MS = 250;
const SPAWN_POLL_TIMEOUT_MS = 15_000;

/** How often a running window checks that its daemon is still the one listening. */
const WATCH_INTERVAL_MS = 3_000;

/**
 * Owns everything the renderer must not touch: the filesystem handshake, the
 * liveness probe, and the decision to start a daemon.
 *
 * The daemon deliberately outlives the window (MVP.md §7.3), so this class
 * never stops a daemon it did not start and never stops one at all outside an
 * explicit Quit - closing the window must not abandon a running mission.
 */
export class DaemonConnector extends EventEmitter {
  #status: DaemonStatus = {
    phase: 'connecting',
    connection: null,
    detail: 'Looking for a running daemon…',
    handshakePath: HANDSHAKE_FILE,
    updatedAt: new Date().toISOString(),
  };

  #inFlight: Promise<DaemonStatus> | null = null;

  get status(): DaemonStatus {
    return this.#status;
  }

  /** Idempotent: concurrent callers share one discovery pass. */
  async refresh(): Promise<DaemonStatus> {
    this.#inFlight ??= this.#discover().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #discover(): Promise<DaemonStatus> {
    /** Set when an update made us replace the daemon; the notice stays up long enough to read. */
    let noticeSince: number | null = null;
    const existing = await readHandshake();
    if (existing && (await isReachable(existing))) {
      const replace = daemonNeedsReplacing({
        packaged: app.isPackaged,
        entryOverride: Boolean(process.env['TANDEMISE_DAEMON_ENTRY']),
        appVersion: app.getVersion(),
        daemonVersion: existing.version,
      });
      if (!replace) return this.#set('connected', connectionOf(existing), `Connected to daemon on ${existing.url}.`);
      this.#set('spawning', null, RESTARTING_AFTER_UPDATE);
      noticeSince = Date.now();
      logLaunch(`replacing the daemon of version ${existing.version ?? '(unknown)'} (pid ${existing.pid}) with this app's ${app.getVersion()}`);
      if (!(await stopDaemon(existing))) {
        return this.#set(
          'unavailable',
          null,
          `Tandemise was updated, but its background service from version ${existing.version ?? 'an older release'} (process ${existing.pid}) did not stop. End that process, then press Retry.`,
        );
      }
    }

    // Either no handshake file, or a stale one pointing at a dead process. Both
    // mean "no daemon"; a stale file is not an error worth showing the user.
    // A packaged app starts the daemon it carries, on its own Node; a checkout
    // starts apps/daemon's build on a system Node (node-runtime.ts).
    const daemon = locateDaemon();
    if (daemon === null) {
      return this.#set(
        'unavailable',
        null,
        app.isPackaged
          ? `This copy of Tandemise is missing its daemon (${bundledDaemonEntry()}). Reinstall it from the GitHub releases page.`
          : 'Its build was not found at apps/daemon/dist/main.js, so there was nothing to start. Run `npm run build` in the repository, then retry.',
      );
    }
    const { entry } = daemon;

    this.#set('spawning', null, 'Starting the Tandemise daemon…');
    const node = daemon.bundled
      ? bundledDaemonNode({ execPath: process.execPath, nodeVersion: process.versions.node })
      : await findDaemonNode();
    if (!node.ok) {
      logLaunch(`no usable Node: ${node.message} Tried: ${describeTried(node)}`);
      return this.#set('unavailable', null, node.message);
    }

    let launch: Launch;
    try {
      launch = await spawnDaemon(entry, node);
    } catch (error) {
      return this.#set('unavailable', null, `Could not start the daemon with Node at ${node.command}: ${messageOf(error)}`);
    }

    const started = await pollForHandshake(launch);
    if (started === 'exited') {
      const why = await lastStartupError();
      return this.#set(
        'unavailable',
        null,
        `The daemon stopped while starting${why ? `: ${why}` : '.'} It ran on Node ${node.version} at ${node.command}. The details are in ${LAUNCH_LOG}.`,
      );
    }
    if (!started) {
      return this.#set(
        'unavailable',
        null,
        `Started the daemon but it did not report a connection within ${SPAWN_POLL_TIMEOUT_MS / 1000}s. Check ${LAUNCH_LOG} and the logs next to it.`,
      );
    }
    // Replacing a daemon takes well under a second, often before the window
    // has even loaded; the person should still see why the app paused.
    if (noticeSince !== null) await delay(Math.max(0, UPDATE_NOTICE_MIN_MS - (Date.now() - noticeSince)));
    return this.#set('connected', started, `Connected to daemon on ${started.url}.`);
  }

  /**
   * Follows the daemon across restarts.
   *
   * The daemon outlives the window, which also means it can be restarted under
   * a running window - a rebuild, a crash, `npm run daemon` in another terminal
   * - and it comes back on a new ephemeral port. Without this the window kept
   * retrying the dead port until someone found the retry button. Only the
   * handshake is re-read here; starting a daemon stays an explicit action, so a
   * developer stopping theirs on purpose is not fought by the window.
   */
  watch(intervalMs = WATCH_INTERVAL_MS): () => void {
    let busy = false;
    const timer = setInterval(() => {
      if (busy || this.#inFlight !== null) return;
      busy = true;
      void this.#follow().finally(() => {
        busy = false;
      });
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async #follow(): Promise<void> {
    const current = this.#status.connection;
    if (current !== null && (await isReachable(current))) return;
    const next = await readHandshake();
    if (next === null || !(await isReachable(next))) {
      if (current !== null) {
        this.#set('unavailable', null, 'The daemon stopped. Waiting for it to come back, or press retry to start one.');
      }
      return;
    }
    if (current?.url === next.url && current.token === next.token && this.#status.phase === 'connected') return;
    this.#set('connected', connectionOf(next), `Connected to daemon on ${next.url}.`);
  }

  #set(phase: DaemonStatus['phase'], connection: DaemonConnection | null, detail: string): DaemonStatus {
    this.#status = { phase, connection, detail, handshakePath: HANDSHAKE_FILE, updatedAt: new Date().toISOString() };
    this.emit('status', this.#status);
    return this.#status;
  }
}

/** The handshake as the daemon wrote it; `version` is null for daemons older than the field. */
interface Handshake extends DaemonConnection {
  readonly version: string | null;
}

function connectionOf(h: Handshake): DaemonConnection {
  return { url: h.url, token: h.token, pid: h.pid, startedAt: h.startedAt };
}

async function readHandshake(): Promise<Handshake | null> {
  let raw: string;
  try {
    raw = await readFile(HANDSHAKE_FILE, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { url, token, pid, startedAt, version } = parsed as Record<string, unknown>;
  if (typeof url !== 'string' || typeof token !== 'string' || typeof pid !== 'number') return null;
  return {
    url, token, pid,
    startedAt: typeof startedAt === 'string' ? startedAt : new Date(0).toISOString(),
    version: typeof version === 'string' ? version : null,
  };
}

/**
 * Stops a daemon cleanly and waits for it to go. It is asked over HTTP
 * (POST /v1/daemon/shutdown), which runs the same coordinated shutdown as
 * SIGTERM and also works on Windows; a daemon too old to have that route gets
 * SIGTERM. True once the process is gone.
 */
async function stopDaemon(daemon: Handshake): Promise<boolean> {
  let asked = false;
  try {
    const response = await fetch(`${daemon.url}/v1/daemon/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${daemon.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    asked = response.ok;
  } catch {
    asked = false;
  }
  if (!asked) {
    try {
      process.kill(daemon.pid, 'SIGTERM');
    } catch {
      // Already gone, or not ours to signal; the wait below tells which.
    }
  }
  const deadline = Date.now() + REPLACE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(daemon.pid)) {
      logLaunch(`the old daemon (pid ${daemon.pid}) stopped`);
      return true;
    }
    await delay(SPAWN_POLL_INTERVAL_MS);
  }
  logLaunch(`the old daemon (pid ${daemon.pid}) did not stop within ${REPLACE_TIMEOUT_MS / 1000}s`);
  return false;
}

/**
 * A live pid is necessary but not sufficient - the pid may have been recycled -
 * so the authoritative probe is the daemon's own health endpoint.
 */
async function isReachable(connection: DaemonConnection): Promise<boolean> {
  if (!isProcessAlive(connection.pid)) return false;
  try {
    const response = await fetch(`${connection.url}/v1/health`, {
      headers: { authorization: `Bearer ${connection.token}` },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user - still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Which daemon to start. `TANDEMISE_DAEMON_ENTRY` wins (and is run like a
 * checkout's, on a system Node); then a packaged app's own copy; then
 * `apps/daemon/dist/main.js` in the checkout the app was started from.
 */
function locateDaemon(): { entry: string; bundled: boolean } | null {
  const override = process.env['TANDEMISE_DAEMON_ENTRY'];
  if (override) return existsSync(override) ? { entry: override, bundled: false } : null;
  if (app.isPackaged) {
    const entry = bundledDaemonEntry();
    return existsSync(entry) ? { entry, bundled: true } : null;
  }
  const entry = checkoutDaemonEntry();
  return entry === null ? null : { entry, bundled: false };
}

/** Staged into `resources/daemon` at packaging time (apps/desktop/scripts/stage-daemon.mjs). */
function bundledDaemonEntry(): string {
  return join(process.resourcesPath, 'daemon', 'dist', 'main.js');
}

/** `apps/daemon/dist/main.js`, relative to the checked-out app. */
function checkoutDaemonEntry(): string | null {
  // In dev, __dirname is apps/desktop/out|dist/main; four levels up is the repo root.
  const candidates = [
    resolve(process.cwd(), 'apps/daemon/dist/main.js'),
    resolve(process.cwd(), '../daemon/dist/main.js'),
    resolve(process.cwd(), '../../apps/daemon/dist/main.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

interface Launch {
  /** Flips to true if the child exits before it publishes a handshake. */
  readonly exited: () => boolean;
}

/**
 * The Node a checkout's daemon runs on: the developer's own Node first, the
 * way `npm run daemon` would run it, Electron's only as a fallback (see
 * node-runtime.ts).
 */
async function findDaemonNode(): Promise<NodeResolution> {
  const env = process.env;
  const needShell = !env['TANDEMISE_NODE'] && env['TANDEMISE_NODE_SEARCH_PATH'] === undefined && process.platform !== 'win32';
  return resolveDaemonNode({
    env,
    platform: process.platform,
    loginShellPath: needShell ? await readLoginShellPath() : null,
    electron: { execPath: process.execPath, nodeVersion: process.versions.node },
    isExecutable: (path) => {
      try {
        accessSync(path, constants.X_OK);
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    versionOf: (path) => {
      const out = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 5_000, env: withoutElectronNode(env), windowsHide: true });
      return out.status === 0 ? out.stdout.trim() : null;
    },
  });
}

/**
 * PATH as the person's login shell builds it. An app opened from Finder or the
 * Dock inherits launchd's minimal PATH, which has no nvm, Homebrew or volta in
 * it; asking the shell is how other macOS apps find the user's tools.
 */
function readLoginShellPath(): Promise<string | null> {
  const shell = process.env['SHELL'] || '/bin/zsh';
  return new Promise((done) => {
    execFile(
      shell,
      ['-ilc', `printf '%s' "${LOGIN_PATH_MARKER}$PATH${LOGIN_PATH_MARKER}"`],
      { timeout: 5_000, encoding: 'utf8', env: withoutElectronNode(process.env), windowsHide: true },
      (_error, stdout) => done(parseLoginShellPath(typeof stdout === 'string' ? stdout : '')),
    );
  });
}

function withoutElectronNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _drop, ...rest } = env;
  return rest;
}

async function spawnDaemon(entry: string, node: Extract<NodeResolution, { ok: true }>): Promise<Launch> {
  logLaunch(`starting ${entry} with Node ${node.version} at ${node.command} (from ${node.source})`);
  console.info(`[tandemise] starting the daemon with Node ${node.version} at ${node.command} (from ${node.source})`);
  // stderr goes to a file, not a pipe: the daemon outlives this window, and a
  // pipe would break under it the moment the window quits.
  const stderr = openLaunchLog();
  let exited = false;
  const child = spawn(node.command, [entry], {
    detached: true,
    // Not the app's working directory: a packaged app may have been started
    // from anywhere, and the daemon outlives it.
    ...(app.isPackaged ? { cwd: homedir() } : {}),
    stdio: ['ignore', 'ignore', stderr ?? 'ignore'],
    // The daemon is a console program to Windows; it must not get a window.
    windowsHide: true,
    // A packaged app's daemon never opens test routes, whatever the environment says.
    env: { ...withoutElectronNode(process.env), ...node.env, ...(app.isPackaged ? { TANDEMISE_PACKAGED: '1', TANDEMISE_TEST_ROUTES: '0' } : {}) },
  });
  if (stderr !== null) closeSync(stderr);
  child.once('exit', () => {
    exited = true;
  });
  child.unref();
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('spawn', () => resolveSpawn());
    child.once('error', rejectSpawn);
  });
  return { exited: () => exited };
}

function openLaunchLog(): number | null {
  try {
    mkdirSync(join(TANDEMISE_HOME, 'logs'), { recursive: true });
    return openSync(LAUNCH_LOG, 'a');
  } catch {
    return null;
  }
}

function logLaunch(line: string): void {
  try {
    mkdirSync(join(TANDEMISE_HOME, 'logs'), { recursive: true });
    appendFileSync(LAUNCH_LOG, `[${new Date().toISOString()}] desktop: ${line}\n`);
  } catch {
    // Logging must never be why the daemon did not start.
  }
}

/** The daemon's own one-line reason ("tandemd failed to start: ..."), never a stack. */
async function lastStartupError(): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(LAUNCH_LOG, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n').filter((l) => l.startsWith('tandemd failed to start: '));
  const last = lines.at(-1);
  return last ? last.slice('tandemd failed to start: '.length).trim() : null;
}

function describeTried(resolution: NodeResolution): string {
  return resolution.tried.map((t) => `${t.path} (${t.source}${t.rejected ? `: ${t.rejected}` : ''})`).join('; ') || 'nothing';
}

async function pollForHandshake(launch: Launch): Promise<DaemonConnection | 'exited' | null> {
  const deadline = Date.now() + SPAWN_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(SPAWN_POLL_INTERVAL_MS);
    const connection = await readHandshake();
    if (connection && (await isReachable(connection))) return connectionOf(connection);
    if (launch.exited()) return 'exited';
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
