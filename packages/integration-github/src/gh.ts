import { TandemiseError } from '@tandemise/shared';
import type { CommandExecutor, ToolExecResult } from '@tandemise/integrations-core';
import type { z } from 'zod';

/** `gh` is chatty on slow networks; a tool call should not outlive a human's patience. */
const DEFAULT_TIMEOUT_MS = 60_000;

export interface GhOptions {
  /** Exit codes that are a *result*, not a failure - `gh pr checks` uses them. */
  readonly tolerateExitCodes?: readonly number[];
  readonly timeoutMs?: number;
}

/**
 * What running `gh` needs: a tool call's context satisfies it, and so does
 * issue sync (P14), which runs outside any agent's tool call.
 */
export interface GhContext {
  readonly exec: CommandExecutor;
  readonly workingDirectory?: string;
  readonly signal?: AbortSignal;
}

/**
 * Runs the `gh` CLI through the injected executor (MVP.md §12.5).
 *
 * Tandemise stores no GitHub credential: `gh` already holds an authenticated
 * session in the user's keychain, and reusing it means there is no token for
 * Tandemise to leak, rotate or mishandle (MVP.md §P8). The cost is that every
 * failure mode is a CLI exit code, so this is where they get translated into
 * something a person can act on.
 */
export async function gh(
  ctx: GhContext,
  args: readonly string[],
  options: GhOptions = {},
): Promise<ToolExecResult> {
  const result = await ctx.exec.run({
    command: 'gh',
    args,
    ...(ctx.workingDirectory === undefined ? {} : { cwd: ctx.workingDirectory }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    // `GH_PROMPT_DISABLED` keeps gh from blocking on a TTY it does not have.
    env: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
  });
  if (result.exitCode === 0) return result;
  if (options.tolerateExitCodes?.includes(result.exitCode)) return result;
  throw describeFailure(result);
}

/** Runs `gh ... --json f1,f2` and validates the response against a schema. */
export async function ghJson<T>(
  ctx: GhContext,
  args: readonly string[],
  schema: z.ZodType<T>,
  options: GhOptions = {},
): Promise<T> {
  const result = await gh(ctx, args, options);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new TandemiseError('INTEGRATION_FAILED',
      `gh returned output that is not JSON: ${result.stdout.slice(0, 200)}`,
      { details: { command: result.command } });
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    // A gh upgrade that renames a field must fail loudly here rather than
    // silently hand an agent an object with holes in it.
    throw new TandemiseError('INTEGRATION_FAILED',
      `Unexpected gh response shape: ${validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      { details: { command: result.command } });
  }
  return validated.data;
}

export function isMissingCli(result: ToolExecResult): boolean {
  return result.exitCode === 127 || /command not found|ENOENT|not found: gh/i.test(result.stderr);
}

export function isUnauthenticated(result: ToolExecResult): boolean {
  return /not logged|authentication required|gh auth login|HTTP 401/i.test(result.stderr);
}

function describeFailure(result: ToolExecResult): TandemiseError {
  const stderr = result.stderr.trim();
  if (result.timedOut) {
    return new TandemiseError('TIMEOUT', `gh timed out after ${result.durationMs}ms`, {
      details: { command: result.command }, retryable: true,
    });
  }
  if (isMissingCli(result)) {
    return new TandemiseError('INTEGRATION_FAILED',
      'The GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com.',
      { details: { command: result.command } });
  }
  if (isUnauthenticated(result)) {
    return new TandemiseError('INTEGRATION_FAILED',
      'The GitHub CLI is not authenticated. Run `gh auth login` and try again.',
      { details: { command: result.command } });
  }
  if (/could not resolve to a Repository|Not Found|HTTP 404/i.test(stderr)) {
    return TandemiseError.notFound('GitHub resource', stderr.slice(0, 200));
  }
  if (/HTTP 403|must have admin|Resource not accessible/i.test(stderr)) {
    return TandemiseError.permissionDenied(
      `GitHub refused the request: ${stderr.slice(0, 200)}`,
      { command: result.command },
    );
  }
  return new TandemiseError('INTEGRATION_FAILED',
    `gh exited ${result.exitCode}: ${stderr.slice(0, 300) || '(no stderr)'}`,
    { details: { command: result.command } });
}
