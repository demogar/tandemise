import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type {
  AgentEvent, RuntimeCapability, RuntimeDiscovery, RuntimeHealth, RuntimeProfile,
} from '@tandemise/domain';
import {
  DEFAULT_TERMINATION_GRACE_MS, NormalizingEventSink, SESSION_NOT_FOUND,
  relieveBackPressure, superviseProcessStream,
} from '@tandemise/runtimes-core';
import { buildRuntimeEnv, withheldEnvNames } from '@tandemise/runtimes-core';
import { CLAUDE_SETTINGS_SCHEMA, PARENT_SESSION_ENV, resolveConfigDir } from './settings.js';
import type { AgentRuntimeAdapter, RunRequest, SupervisedChild } from '@tandemise/runtimes-core';
import { TandemiseError, systemClock } from '@tandemise/shared';
import type { Clock, RunId } from '@tandemise/shared';
import { buildInvocation } from './cli-args.js';
import { ClaudeEventMapper } from './event-mapper.js';
import { findExecutable, probeVersion, requireExecutable } from './discovery.js';

export const CLAUDE_ADAPTER_ID = 'claude-code';

/**
 * How Claude Code says it has forgotten the session we asked it to continue.
 *
 * It reports this on stderr and then exits with the generic
 * `error_during_execution` result, so the code alone is indistinguishable from
 * a model that crashed halfway through real work. Matching the sentence is the
 * only way to tell the two apart, and getting it wrong is expensive: an
 * unrecognised stale handle failed the task rather than restarting it.
 */
const SESSION_MISSING = /no conversation found with session id/i;

/**
 * What Claude Code can do, before any policy is applied (MVP.md §10.5). These
 * are descriptive: routing reads them, enforcement reads the assignment's
 * grants. `browser` and `computer_use` are absent because Claude Code drives
 * neither natively - those come from an execution target or an MCP server.
 */
export const CLAUDE_CAPABILITIES: readonly RuntimeCapability[] = [
  'reasoning', 'vision', 'shell', 'filesystem', 'git', 'web',
  'mcp', 'structured_output', 'session_resume', 'tool_calling',
];

/** A quota observation older than this no longer describes the current state. */
const QUOTA_WARNING_TTL_MS = 15 * 60_000;

interface QuotaObservation {
  readonly detail: string;
  readonly blocking: boolean;
  readonly observedAtMs: number;
}

export interface ClaudeCodeAdapterOptions {
  readonly clock?: Clock;
  readonly terminationGraceMs?: number;
}

/**
 * Runs the locally installed Claude Code CLI in headless streaming mode and
 * normalizes its output (MVP.md §10.2).
 *
 * Authentication is deliberately not this adapter's business: the CLI is
 * launched under the user's own environment and uses whatever subscription or
 * key it is already configured with, so Tandemise never holds a credential it
 * would then have to protect (MVP.md §10.3).
 */
export class ClaudeCodeAdapter implements AgentRuntimeAdapter {
  readonly id = CLAUDE_ADAPTER_ID;
  readonly displayName = 'Claude Code';
  readonly baseCapabilities = CLAUDE_CAPABILITIES;

  readonly #children = new Map<RunId, SupervisedChild>();
  readonly #clock: Clock;
  readonly #graceMs: number;
  #quota: QuotaObservation | null = null;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#graceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  }

  readonly settingsSchema = CLAUDE_SETTINGS_SCHEMA;

  validateSettings(settings: Readonly<Record<string, unknown>>): void {
    // Throws a validation error the desktop renders inline on the field.
    resolveConfigDir(settings);
  }

  async discover(): Promise<RuntimeDiscovery> {
    const executablePath = findExecutable(null);
    if (executablePath === null) {
      return {
        adapterId: this.id,
        displayName: this.displayName,
        detected: false,
        executablePath: null,
        version: null,
        capabilities: [],
        detail: 'No `claude` executable on PATH, in ~/.local/bin, ~/.claude/local, or an nvm bin directory.',
        suggestedSettings: {},
        settingsSchema: CLAUDE_SETTINGS_SCHEMA,
      };
    }
    const { version, detail } = await probeVersion(executablePath);
    return {
      adapterId: this.id,
      displayName: this.displayName,
      detected: version !== null,
      executablePath,
      version,
      capabilities: version === null ? [] : CLAUDE_CAPABILITIES,
      detail,
      suggestedSettings: { permissionMode: 'default' },
      settingsSchema: CLAUDE_SETTINGS_SCHEMA,
    };
  }

  async healthCheck(profile: RuntimeProfile): Promise<RuntimeHealth> {
    const executablePath = findExecutable(profile.executablePath);
    if (executablePath === null) {
      return this.#health(profile, 'unavailable', null, 'Claude Code executable not found');
    }
    const { version, detail } = await probeVersion(executablePath);
    if (version === null) return this.#health(profile, 'unavailable', null, detail);
    const quota = this.#currentQuota();
    return this.#health(profile, quota?.blocking === true ? 'degraded' : 'healthy', version, detail);
  }

  capabilities(_profile: RuntimeProfile): readonly RuntimeCapability[] {
    return CLAUDE_CAPABILITIES;
  }

  start(request: RunRequest): AsyncIterable<AgentEvent> {
    return this.#run(request, null);
  }

  resume(sessionRef: string, request: RunRequest): AsyncIterable<AgentEvent> {
    return this.#run(request, sessionRef);
  }

  pid(runId: RunId): number | null {
    return this.#children.get(runId)?.pid ?? null;
  }

  /**
   * Out-of-band cancellation (MVP.md §21.1). `start`'s AbortSignal is the
   * primary path; this exists for the supervisor cancelling a run it is not
   * currently iterating.
   */
  async cancel(runId: RunId): Promise<void> {
    const child = this.#children.get(runId);
    if (child === undefined || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await this.#waitForExit(child, this.#graceMs);
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  async *#run(request: RunRequest, resumeSessionRef: string | null): AsyncIterable<AgentEvent> {
    const log = request.log.child({ runId: request.runId, runtime: this.id });
    const executablePath = requireExecutable(request.profile.executablePath);
    const { args, stdin } = buildInvocation(request, resumeSessionRef);
    const cwd = absoluteWorkingDirectory(request.workingDirectory);

    let sessionMissing = false;
    const sink = new NormalizingEventSink({ log, onInvalid: 'raw' });
    const mapper = new ClaudeEventMapper({
      // Probed against the run's working directory: a relative `file_path`
      // resolved against the daemon's cwd would answer about the wrong file,
      // flipping add/edit and emitting a path the UI cannot open.
      fileExists: (path: string) => existsSync(isAbsolute(path) ? path : resolve(cwd, path)),
      onQuotaWarning: (detail) => this.#recordQuota(detail),
    });

    // A profile may select the config directory it runs under, which is what
    // makes two Claude profiles two independent workers rather than one account
    // wearing two names. It is an override, so it wins over anything inherited.
    const configDir = resolveConfigDir(request.profile.settings);
    const childEnv = buildRuntimeEnv({
      allowedPrefixes: ['ANTHROPIC_', 'CLAUDE_'],
      allowedNames: ['SSH_AUTH_SOCK', 'GIT_ASKPASS', 'COLORTERM'],
      deniedNames: PARENT_SESSION_ENV,
      overrides: {
        ...(configDir === null ? {} : { CLAUDE_CONFIG_DIR: configDir }),
        // A tool call may legitimately block for as long as the run may live:
        // `ask_human` waits on a person. Claude Code's own MCP tool timeout is
        // an undocumented default we should not bet a worker's question on, so
        // it is pinned to the run's wall-time backstop. Verified that Claude
        // Code honours a blocking call across minutes, not only seconds.
        ...(request.maxWallTimeMs > 0 ? { MCP_TOOL_TIMEOUT: String(request.maxWallTimeMs) } : {}),
      },
    });
    log.debug('spawning claude code', {
      executablePath,
      argc: args.length,
      promptViaStdin: stdin !== null,
      envWithheld: withheldEnvNames(childEnv).length,
      configDir: configDir ?? '(inherited)',
    });
    const stream = superviseProcessStream({
      spawn: () => spawn(executablePath, args, {
        cwd,
        // The CLI authenticates from the user's own environment and keychain
        // (MVP.md §10.3), so it needs more than an empty environment - but it
        // needs its OWN credentials, not every credential the daemon happens to
        // have inherited from a developer shell. Profile settings deliberately
        // cannot inject arbitrary env vars, which would invite secrets into the
        // database (MVP.md §P8) - `configDir` is the one typed exception, and a
        // path is not a credential.
        env: childEnv,
        stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }),
      describe: executablePath,
      stdin,
      signal: request.signal,
      maxWallTimeMs: request.maxWallTimeMs,
      graceMs: this.#graceMs,
      sink,
      log,
      onStdoutLine: (line) => this.#handleLine(line, sink, mapper),
      // Guarded on `resumeSessionRef`: a fresh start has no session to lose, so
      // the same sentence arriving there means something else entirely.
      onStderrLine: (line) => {
        if (resumeSessionRef !== null && SESSION_MISSING.test(line)) sessionMissing = true;
      },
      onExit: (code, killedBy) => {
        // Reached only when the CLI produced no `result` record of its own,
        // which for Claude Code means it died before finishing.
        const how = killedBy === null ? `exit code ${code}` : `signal ${killedBy}`;
        sink.fail('RUNTIME_FAILED', `Claude Code ended without a result (${how})`, false);
      },
    });
    this.#children.set(request.runId, stream.child);

    try {
      // A failure on a resume is held back until the process has closed. The CLI
      // explains itself on stderr and gives its verdict on stdout; those are
      // separate pipes, so the verdict can arrive first. The sink ends only on
      // `close`, after both pipes have ended, so by then the explanation is in.
      let heldFailure: Extract<AgentEvent, { type: 'failed' }> | null = null;
      for await (const event of sink) {
        relieveBackPressure(stream.child, sink.pending);
        if (resumeSessionRef !== null && event.type === 'failed') {
          heldFailure = event;
          continue;
        }
        yield event;
      }
      if (heldFailure !== null) {
        // Never over a cancellation or timeout: that verdict is about this run,
        // and restarting a run someone just stopped would be the wrong answer.
        // The raw stderr line stays in the log either way.
        yield sessionMissing && !request.signal.aborted
          ? {
              type: 'failed',
              code: SESSION_NOT_FOUND,
              message: `Claude Code no longer has session ${resumeSessionRef}.`,
              retryable: true,
            }
          : heldFailure;
      }
    } finally {
      this.#children.delete(request.runId);
      stream.dispose();
    }
  }

  #handleLine(line: string, sink: NormalizingEventSink, mapper: ClaudeEventMapper): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not every stdout line is protocol: a wrapper script's banner, or an
      // npm warning, arrives here. Keep it for the raw log rather than failing.
      sink.raw('stdout', line);
      return;
    }
    for (const event of mapper.map(parsed)) sink.push(event);
  }

  #recordQuota(detail: string): void {
    this.#quota = {
      detail,
      blocking: /rejected|exceeded/i.test(detail),
      observedAtMs: this.#clock.epochMs(),
    };
  }

  #currentQuota(): QuotaObservation | null {
    if (this.#quota === null) return null;
    if (this.#clock.epochMs() - this.#quota.observedAtMs > QUOTA_WARNING_TTL_MS) {
      this.#quota = null;
    }
    return this.#quota;
  }

  #health(
    profile: RuntimeProfile,
    state: RuntimeHealth['state'],
    version: string | null,
    detail: string,
  ): RuntimeHealth {
    return {
      profileId: profile.id,
      state,
      version,
      detail,
      checkedAt: this.#clock.now(),
      quotaWarning: this.#currentQuota()?.detail ?? null,
    };
  }

  #waitForExit(child: SupervisedChild, timeoutMs: number): Promise<void> {
    return new Promise((done) => {
      const timer = setTimeout(done, timeoutMs);
      timer.unref();
      child.once('close', () => {
        clearTimeout(timer);
        done();
      });
    });
  }
}

function absoluteWorkingDirectory(dir: string): string {
  if (!isAbsolute(dir)) {
    throw TandemiseError.validation('RunRequest.workingDirectory must be absolute', { workingDirectory: dir });
  }
  return resolve(dir);
}
