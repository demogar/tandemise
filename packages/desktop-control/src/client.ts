import { TandemiseError, errorMessage, nullLogger, type Logger } from '@tandemise/shared';
import { z } from 'zod';
import { LineAssembler, type HelperProcess, type SpawnHelper } from './spawn.js';
import {
  activateResultSchema, clickResultSchema, findResultSchema, helperResponseSchema,
  inspectResultSchema, launchResultSchema, listAppsResultSchema, listInstalledAppsResultSchema,
  permissionsResultSchema, pingResultSchema, requestPermissionsResultSchema, screenshotResultSchema,
  shortcutResultSchema, toErrorCode, typeResultSchema, windowsResultSchema,
  type ActivateResult, type ClickResult, type FindResult, type HelperOp, type InspectResult,
  type LaunchResult, type ListAppsResult, type ListInstalledAppsResult, type PermissionsResult,
  type PingResult, type RequestPermissionsResult, type ScreenshotResult, type ShortcutResult,
  type TypeResult, type WindowsResult,
} from './protocol.js';

export interface MacOSHelperClientOptions {
  /** Absolute path to the `tandemise-helper` binary. */
  readonly binaryPath: string;
  readonly spawn: SpawnHelper;
  readonly logger?: Logger;
  /** Applies to any op without its own entry in `OP_TIMEOUTS`. */
  readonly defaultTimeoutMs?: number;
}

interface Pending {
  readonly op: HelperOp;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Ops whose honest worst case is far longer than a UI query's. Launching a cold
 * app and capturing a 5K display are both seconds, not milliseconds, and a
 * timeout tuned for `find` would abort them mid-flight.
 */
const OP_TIMEOUTS: Partial<Record<HelperOp, number>> = {
  launch: 45_000,
  activate: 20_000,
  screenshot: 45_000,
  inspect: 45_000,
  find: 45_000,
  requestPermissions: 120_000,
};

const DEFAULT_TIMEOUT_MS = 15_000;
/** An exit sooner than this after spawning is a startup failure, not a crash. */
const MIN_HEALTHY_UPTIME_MS = 2_000;
const MAX_CONSECUTIVE_STARTUP_FAILURES = 3;
const STDERR_TAIL_LIMIT = 4_096;

/**
 * Drives `native/macos-helper` over newline-delimited JSON.
 *
 * Three properties are the point of this class:
 *
 *  - **Correlation.** Requests carry an id and resolve independently, so a slow
 *    screenshot never blocks a `permissions` probe queued behind it.
 *  - **Supervision.** The helper is a subprocess on a developer's machine; it
 *    will be killed by a TCC reset, a crash or a logout. It is respawned lazily
 *    on the next call, and a crash loop fails fast with the helper's own stderr
 *    rather than retrying forever.
 *  - **Narrowing.** Every payload is parsed against a schema. Output from
 *    another process is untrusted input (MVP.md §19.3), even when we wrote it.
 */
export class MacOSHelperClient {
  readonly #binaryPath: string;
  readonly #spawn: SpawnHelper;
  readonly #log: Logger;
  readonly #defaultTimeoutMs: number;
  readonly #pending = new Map<string, Pending>();

  #process: HelperProcess | null = null;
  #startedAt = 0;
  #stderrTail = '';
  #consecutiveStartupFailures = 0;
  #stopped = false;
  #sequence = 0;

  constructor(options: MacOSHelperClientOptions) {
    this.#binaryPath = options.binaryPath;
    this.#spawn = options.spawn;
    this.#log = options.logger ?? nullLogger;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get binaryPath(): string {
    return this.#binaryPath;
  }

  isRunning(): boolean {
    return this.#process !== null;
  }

  // MARK: - Typed operations

  ping(): Promise<PingResult> {
    return this.call('ping', {}, pingResultSchema);
  }

  /** Never prompts. Safe to call on every health check. */
  permissions(): Promise<PermissionsResult> {
    return this.call('permissions', {}, permissionsResultSchema);
  }

  /** Prompts the user. Only ever call this from an explicit user action. */
  requestPermissions(
    which: { accessibility?: boolean; screenRecording?: boolean } = {},
  ): Promise<RequestPermissionsResult> {
    return this.call('requestPermissions', which, requestPermissionsResultSchema);
  }

  listApps(): Promise<ListAppsResult> {
    return this.call('listApps', {}, listAppsResultSchema);
  }

  listInstalledApps(): Promise<ListInstalledAppsResult> {
    return this.call('listInstalledApps', {}, listInstalledAppsResultSchema);
  }

  launch(target: {
    bundleId?: string; appName?: string; path?: string; activate?: boolean; timeoutMs?: number;
  }): Promise<LaunchResult> {
    return this.call('launch', target, launchResultSchema);
  }

  activate(target: { bundleId?: string; appName?: string; pid?: number }): Promise<ActivateResult> {
    return this.call('activate', target, activateResultSchema);
  }

  windows(target: { bundleId?: string; appName?: string; pid?: number }): Promise<WindowsResult> {
    return this.call('windows', target, windowsResultSchema);
  }

  inspect(request: {
    bundleId?: string; appName?: string; pid?: number;
    window?: string; windowIndex?: number; maxDepth?: number; maxNodes?: number;
  }): Promise<InspectResult> {
    return this.call('inspect', request, inspectResultSchema);
  }

  find(request: {
    bundleId?: string; appName?: string; pid?: number;
    window?: string; windowIndex?: number;
    role?: string; subrole?: string; label?: string; identifier?: string; titleContains?: string;
    limit?: number; maxDepth?: number;
  }): Promise<FindResult> {
    return this.call('find', request, findResultSchema);
  }

  click(request: {
    bundleId?: string; appName?: string; pid?: number;
    window?: string; windowIndex?: number;
    role?: string; subrole?: string; label?: string; identifier?: string; titleContains?: string;
    path?: string; action?: string;
    x?: number; y?: number; allowCoordinates?: boolean; button?: string; clickCount?: number;
  }): Promise<ClickResult> {
    return this.call('click', request, clickResultSchema);
  }

  type(request: { text: string; delayMs?: number }): Promise<TypeResult> {
    return this.call('type', request, typeResultSchema);
  }

  shortcut(request: { keys: readonly string[]; delayMs?: number }): Promise<ShortcutResult> {
    return this.call('shortcut', request, shortcutResultSchema);
  }

  screenshot(request: {
    bundleId?: string; appName?: string; pid?: number; windowId?: number; displayId?: number;
    timeoutMs?: number;
  }): Promise<ScreenshotResult> {
    return this.call('screenshot', request, screenshotResultSchema);
  }

  // MARK: - Lifecycle

  /**
   * Asks the helper to exit, then stops the process for good.
   *
   * The client is unusable afterwards by design: `stop` is called on daemon
   * shutdown, and a stray tool call that silently resurrected a subprocess
   * during teardown would leak a process past the daemon's own exit.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (!this.#process) return;
    try {
      await this.call('shutdown', {}, z.object({ stopping: z.boolean() }), 2_000);
    } catch {
      // A helper that will not answer `shutdown` gets killed below; that is the
      // entire contingency, and it is not worth surfacing.
    }
    this.#teardown('client stopped');
  }

  // MARK: - Transport

  async call<T>(
    op: HelperOp,
    params: Readonly<Record<string, unknown>>,
    schema: z.ZodType<T>,
    timeoutMs?: number,
  ): Promise<T> {
    const raw = await this.#send(op, params, timeoutMs ?? OP_TIMEOUTS[op] ?? this.#defaultTimeoutMs);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new TandemiseError(
        'INTEGRATION_FAILED',
        `The macOS helper returned an unexpected shape for '${op}': ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
        { details: { op } },
      );
    }
    return parsed.data;
  }

  #send(op: HelperOp, params: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<unknown> {
    if (this.#stopped) {
      throw new TandemiseError('RUNTIME_UNAVAILABLE', 'The macOS helper client has been stopped');
    }
    const process = this.#ensureProcess();
    const stdin = process.stdin;
    if (!stdin) {
      this.#teardown('the helper process has no stdin');
      throw new TandemiseError('RUNTIME_UNAVAILABLE', 'The macOS helper was spawned without a usable stdin');
    }

    const id = String(++this.#sequence);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // The helper answers strictly in order, so a timed-out request means it
        // is wedged and everything behind it is stuck too. Tearing it down is
        // what makes the *next* call work instead of inheriting the jam.
        this.#teardown(`'${op}' timed out after ${timeoutMs}ms`);
        reject(new TandemiseError('TIMEOUT', `The macOS helper did not answer '${op}' within ${timeoutMs}ms`, {
          details: { op, timeoutMs },
        }));
      }, timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();

      this.#pending.set(id, { op, resolve, reject, timer });
      try {
        stdin.write(`${JSON.stringify({ id, op, params })}\n`);
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        this.#teardown(`writing '${op}' failed: ${errorMessage(e)}`);
        reject(new TandemiseError('RUNTIME_UNAVAILABLE',
          `Could not send '${op}' to the macOS helper: ${errorMessage(e)}`, { cause: e }));
      }
    });
  }

  #ensureProcess(): HelperProcess {
    if (this.#process) return this.#process;
    if (this.#consecutiveStartupFailures >= MAX_CONSECUTIVE_STARTUP_FAILURES) {
      throw new TandemiseError(
        'RUNTIME_UNAVAILABLE',
        `The macOS helper at ${this.#binaryPath} failed to start ${this.#consecutiveStartupFailures} times in a row. `
          + `Last output: ${this.#stderrTail.trim() || '(none)'}`,
        { details: { binaryPath: this.#binaryPath } },
      );
    }

    let child: HelperProcess;
    try {
      child = this.#spawn(this.#binaryPath, []);
    } catch (e) {
      this.#consecutiveStartupFailures += 1;
      throw new TandemiseError('RUNTIME_UNAVAILABLE',
        `Could not start the macOS helper at ${this.#binaryPath}: ${errorMessage(e)}`, { cause: e });
    }

    this.#process = child;
    this.#startedAt = Date.now();
    this.#stderrTail = '';
    this.#attach(child);
    this.#log.debug('desktop.helper_started', { pid: child.pid, binaryPath: this.#binaryPath });
    return child;
  }

  #attach(child: HelperProcess): void {
    const assembler = new LineAssembler();
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');

    child.stdout?.on('data', (chunk) => {
      for (const line of assembler.push(chunk)) this.#receive(line);
    });

    child.stderr?.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      this.#stderrTail = (this.#stderrTail + text).slice(-STDERR_TAIL_LIMIT);
    });

    child.on('error', (error) => {
      this.#failStartup();
      this.#teardown(`the helper process errored: ${error.message}`);
    });

    child.on('exit', (code, signal) => {
      if (Date.now() - this.#startedAt < MIN_HEALTHY_UPTIME_MS) this.#failStartup();
      this.#teardown(`the helper exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`);
    });
  }

  #receive(line: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      this.#log.warn('desktop.helper_bad_line', { line: line.slice(0, 200) });
      return;
    }

    const envelope = helperResponseSchema.safeParse(payload);
    if (!envelope.success) {
      this.#log.warn('desktop.helper_bad_response', { line: line.slice(0, 200) });
      return;
    }

    const { id, ok, result, error } = envelope.data;
    const pending = this.#pending.get(id);
    if (!pending) {
      // Most likely a response to a request we already timed out.
      this.#log.debug('desktop.helper_unmatched_response', { responseId: id });
      return;
    }
    this.#pending.delete(id);
    clearTimeout(pending.timer);

    // The helper's uptime is only proven by a real answer, not by not-crashing.
    this.#consecutiveStartupFailures = 0;

    if (ok) {
      pending.resolve(result);
      return;
    }
    const code = error?.code ?? 'INTERNAL';
    pending.reject(new TandemiseError(
      toErrorCode(code),
      error?.message ?? `The macOS helper failed '${pending.op}' without a message`,
      { details: { op: pending.op, helperCode: code, ...(error?.details ?? {}) } },
    ));
  }

  #failStartup(): void {
    this.#consecutiveStartupFailures += 1;
  }

  /** Drop the process and fail everything still waiting on it. */
  #teardown(reason: string): void {
    const child = this.#process;
    this.#process = null;
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone; nothing to clean up.
      }
    }

    if (this.#pending.size > 0) {
      this.#log.warn('desktop.helper_lost', { reason, pending: this.#pending.size });
    }
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new TandemiseError('RUNTIME_UNAVAILABLE',
        `The macOS helper became unavailable while running '${pending.op}': ${reason}`,
        { details: { op: pending.op, stderr: this.#stderrTail.trim().slice(-500) } }));
    }
  }
}
