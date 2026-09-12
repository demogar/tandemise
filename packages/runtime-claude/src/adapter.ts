import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type {
  AgentEvent, RuntimeCapability, RuntimeDiscovery, RuntimeHealth, RuntimeProfile,
} from '@tandemise/domain';
import {
  DEFAULT_TERMINATION_GRACE_MS, NormalizingEventSink, relieveBackPressure, superviseProcessStream,
} from '@tandemise/runtimes-core';
import { buildRuntimeEnv, withheldEnvNames } from '@tandemise/runtimes-core';
import type { AgentRuntimeAdapter, RunRequest, SupervisedChild } from '@tandemise/runtimes-core';
import { TandemiseError, systemClock } from '@tandemise/shared';
import type { Clock, RunId } from '@tandemise/shared';
import { buildInvocation } from './cli-args.js';
import { ClaudeEventMapper } from './event-mapper.js';
import { findExecutable, probeVersion, requireExecutable } from './discovery.js';

export const CLAUDE_ADAPTER_ID = 'claude-code';

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

    const sink = new NormalizingEventSink({ log, onInvalid: 'raw' });
    const mapper = new ClaudeEventMapper({
      fileExists: existsSync,
      onQuotaWarning: (detail) => this.#recordQuota(detail),
    });

    const childEnv = buildRuntimeEnv({
      allowedPrefixes: ['ANTHROPIC_', 'CLAUDE_'],
      allowedNames: ['SSH_AUTH_SOCK', 'GIT_ASKPASS', 'COLORTERM'],
    });
    log.debug('spawning claude code', {
      executablePath,
      argc: args.length,
      promptViaStdin: stdin !== null,
      envWithheld: withheldEnvNames(childEnv).length,
    });
    const stream = superviseProcessStream({
      spawn: () => spawn(executablePath, args, {
        cwd,
        // The CLI authenticates from the user's own environment and keychain
        // (MVP.md §10.3), so it needs more than an empty environment - but it
        // needs its OWN credentials, not every credential the daemon happens to
        // have inherited from a developer shell. Profile settings deliberately
        // cannot inject env vars, which would invite secrets into the database
        // (MVP.md §P8).
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
      onExit: (code, killedBy) => {
        // Reached only when the CLI produced no `result` record of its own,
        // which for Claude Code means it died before finishing.
        const how = killedBy === null ? `exit code ${code}` : `signal ${killedBy}`;
        sink.fail('RUNTIME_FAILED', `Claude Code ended without a result (${how})`, false);
      },
    });
    this.#children.set(request.runId, stream.child);

    try {
      for await (const event of sink) {
        relieveBackPressure(stream.child, sink.pending);
        yield event;
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
