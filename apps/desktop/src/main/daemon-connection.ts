import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import type { DaemonConnection, DaemonStatus } from '../shared/bridge.js';

const HANDSHAKE_FILE = join(process.env['TANDEMISE_HOME'] ?? join(homedir(), '.tandemise'), 'daemon.json');

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
    const existing = await readHandshake();
    if (existing && (await isReachable(existing))) {
      return this.#set('connected', existing, `Connected to daemon on ${existing.url}.`);
    }

    // Either no handshake file, or a stale one pointing at a dead process. Both
    // mean "no daemon"; a stale file is not an error worth showing the user.
    const entry = daemonEntryPoint();
    if (!entry) {
      return this.#set(
        'unavailable',
        null,
        'Its build was not found at apps/daemon/dist/main.js, so there was nothing to start. Run `npm run build` in the repository, then retry.',
      );
    }

    this.#set('spawning', null, 'Starting the Tandemise daemon…');
    try {
      await spawnDaemon(entry);
    } catch (error) {
      return this.#set('unavailable', null, `Could not start the daemon: ${messageOf(error)}`);
    }

    const started = await pollForHandshake();
    if (!started) {
      return this.#set(
        'unavailable',
        null,
        `Started the daemon but it did not report a connection within ${SPAWN_POLL_TIMEOUT_MS / 1000}s. Check its log in ~/.tandemise/logs.`,
      );
    }
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
    this.#set('connected', next, `Connected to daemon on ${next.url}.`);
  }

  #set(phase: DaemonStatus['phase'], connection: DaemonConnection | null, detail: string): DaemonStatus {
    this.#status = { phase, connection, detail, handshakePath: HANDSHAKE_FILE, updatedAt: new Date().toISOString() };
    this.emit('status', this.#status);
    return this.#status;
  }
}

async function readHandshake(): Promise<DaemonConnection | null> {
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
  const { url, token, pid, startedAt } = parsed as Record<string, unknown>;
  if (typeof url !== 'string' || typeof token !== 'string' || typeof pid !== 'number') return null;
  return { url, token, pid, startedAt: typeof startedAt === 'string' ? startedAt : new Date(0).toISOString() };
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

/** `apps/daemon/dist/main.js`, relative to the packaged or checked-out app. */
function daemonEntryPoint(): string | null {
  const override = process.env['TANDEMISE_DAEMON_ENTRY'];
  if (override) return existsSync(override) ? override : null;
  // In dev, __dirname is apps/desktop/out|dist/main; four levels up is the repo root.
  const candidates = [
    resolve(process.cwd(), 'apps/daemon/dist/main.js'),
    resolve(process.cwd(), '../daemon/dist/main.js'),
    resolve(process.cwd(), '../../apps/daemon/dist/main.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function spawnDaemon(entry: string): Promise<void> {
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    // Electron's bundled Node refuses to run a plain script without this.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('spawn', () => resolveSpawn());
    child.once('error', rejectSpawn);
  });
}

async function pollForHandshake(): Promise<DaemonConnection | null> {
  const deadline = Date.now() + SPAWN_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(SPAWN_POLL_INTERVAL_MS);
    const connection = await readHandshake();
    if (connection && (await isReachable(connection))) return connection;
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
