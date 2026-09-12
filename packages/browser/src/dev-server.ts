import { TandemiseError, errorMessage, type Logger } from '@tandemise/shared';
import type {
  BackgroundProcess, BackgroundProcessLauncher,
} from '@tandemise/integrations-core';

export interface DevServerSpec {
  readonly command: string;
  readonly args?: readonly string[];
  /** The repository or worktree the server runs in. */
  readonly cwd: string;
  /** Polled until it answers. Usually the app's own root URL. */
  readonly url: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly readyTimeoutMs?: number;
  readonly label?: string;
}

export interface DevServerHandle {
  readonly url: string;
  readonly pid: number;
  readonly startupLog: readonly string[];
  stop(): Promise<void>;
}

const DEFAULT_READY_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 250;
/** Keep enough output to explain a failed start without keeping a whole build log. */
const STARTUP_LOG_LINES = 60;

/**
 * Starts and stops a repository's dev server (MVP.md §13.2).
 *
 * QA against a real UI needs the app actually running, and "run the dev server"
 * is the one step a worker cannot do for itself safely: the process outlives
 * the tool call, so it needs an owner that will stop it. This is that owner.
 *
 * Two failure modes get explicit handling because both are common and both are
 * baffling when reported as a timeout:
 *  - the command exits immediately (a missing script, a port already bound) -
 *    detected by racing the readiness poll against process exit;
 *  - the command runs but never serves - reported with the last lines of its
 *    own output, which is where the reason almost always is.
 */
export class DevServerController {
  readonly #running = new Map<string, { process: BackgroundProcess; url: string }>();

  constructor(
    private readonly launcher: BackgroundProcessLauncher,
    private readonly log: Logger,
  ) {}

  async start(spec: DevServerSpec): Promise<DevServerHandle> {
    const startupLog: string[] = [];
    const child = this.launcher.launch({
      command: spec.command,
      cwd: spec.cwd,
      label: spec.label ?? 'dev server',
      ...(spec.args ? { args: spec.args } : {}),
      ...(spec.env ? { env: spec.env } : {}),
      onOutput: (chunk) => {
        startupLog.push(chunk.trimEnd());
        if (startupLog.length > STARTUP_LOG_LINES) startupLog.shift();
      },
    });

    let exited = false;
    void child.exited.then(() => { exited = true; });

    const deadline = Date.now() + (spec.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (exited) {
        const exit = await child.exited;
        throw new TandemiseError('INTEGRATION_FAILED',
          `Dev server exited with code ${exit.exitCode} before serving ${spec.url}`,
          { details: { command: spec.command, output: startupLog.slice(-15) } });
      }
      if (await responds(spec.url)) {
        const key = spec.url;
        this.#running.set(key, { process: child, url: spec.url });
        this.log.info('dev_server.ready', { url: spec.url, pid: child.pid, cwd: spec.cwd });
        return {
          url: spec.url,
          pid: child.pid,
          startupLog: [...startupLog],
          stop: () => this.stop(key),
        };
      }
      await delay(POLL_INTERVAL_MS);
    }

    await child.stop('dev server did not become ready');
    throw new TandemiseError('TIMEOUT',
      `Dev server did not answer ${spec.url} within ${spec.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS}ms`,
      { details: { command: spec.command, output: startupLog.slice(-15) } });
  }

  async stop(url: string): Promise<void> {
    const entry = this.#running.get(url);
    if (!entry) return;
    this.#running.delete(url);
    await entry.process.stop('dev server no longer needed');
    this.log.info('dev_server.stopped', { url });
  }

  async stopAll(): Promise<void> {
    for (const url of [...this.#running.keys()]) await this.stop(url);
  }

  running(): readonly string[] {
    return [...this.#running.keys()];
  }
}

/**
 * Any HTTP answer means the port is serving. A 404 from a dev server that has
 * not compiled the route yet is still a started dev server, and waiting for a
 * 200 would hang on every app whose root redirects or requires a login.
 */
async function responds(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      await fetch(url, { signal: controller.signal, redirect: 'manual' });
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    // ECONNREFUSED while the server boots is the expected case, not an error.
    if (!/ECONNREFUSED|fetch failed|aborted/i.test(errorMessage(e))) {
      return true;
    }
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
