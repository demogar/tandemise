/**
 * Cancellation escalation and wall-time budgets (MVP.md §21.1).
 *
 * These helpers live in the core rather than in each adapter because the
 * *policy* - graceful signal first, force after a grace period, timeout is a
 * different outcome from a user cancel - is a Tandemise decision, not a vendor
 * detail. The `node:child_process` types stay out: `Terminable` is the minimum
 * an adapter must hand over, which keeps this package free of provider imports
 * (MVP.md §6.1).
 */

/** Default grace between the graceful signal and the forced kill. */
export const DEFAULT_TERMINATION_GRACE_MS = 5_000;

/** The part of a child process this module needs. */
export interface Terminable {
  kill(signal: NodeJS.Signals): boolean;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}

/**
 * Whether a child has finished.
 *
 * Node leaves `exitCode` null for a process that died from a signal and sets
 * `signalCode` instead, so testing `exitCode !== null` alone reports a
 * signal-killed child as still running. The visible symptom was a redundant
 * SIGKILL and a log line accusing a well-behaved process of ignoring SIGTERM on
 * every clean cancellation.
 */
function hasExited(child: Terminable): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Merges the caller's cancellation with this run's wall-time budget.
 *
 * `AbortSignal.timeout` uses an unref'd timer, so a generous budget on a fast
 * run does not hold the event loop open. A budget of 0 or less means "no
 * budget" - used by the fake runtime; a real assignment always carries one.
 */
export function withWallTimeBudget(signal: AbortSignal, maxWallTimeMs: number): AbortSignal {
  if (maxWallTimeMs <= 0) return signal;
  return AbortSignal.any([signal, AbortSignal.timeout(maxWallTimeMs)]);
}

export interface AbortOutcome {
  readonly code: 'CANCELLED' | 'TIMEOUT';
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * Distinguishes an operator stopping the run and the run exhausting its budget.
 * The scheduler retries one and not the other, so conflating them would
 * silently re-run work a human deliberately halted.
 */
export function classifyAbort(callerSignal: AbortSignal, maxWallTimeMs: number): AbortOutcome {
  if (callerSignal.aborted) {
    return { code: 'CANCELLED', message: 'Run cancelled', retryable: false };
  }
  return { code: 'TIMEOUT', message: `Run exceeded its ${maxWallTimeMs}ms wall-time budget`, retryable: true };
}

/**
 * Terminates `child` when `signal` aborts: SIGTERM, then SIGKILL after
 * `graceMs`. Returns an unsubscribe function.
 *
 * A CLI agent may be mid-write to a file or mid-flush to stdout; SIGTERM gives
 * it the chance to finish, and SIGKILL guarantees we are not left supervising a
 * process that ignored us.
 */
export function escalateTerminationOnAbort(
  child: Terminable,
  signal: AbortSignal,
  graceMs = DEFAULT_TERMINATION_GRACE_MS,
  onForced?: () => void,
): () => void {
  let forceTimer: NodeJS.Timeout | null = null;

  const onAbort = (): void => {
    if (hasExited(child)) return;
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => {
      if (!hasExited(child)) {
        child.kill('SIGKILL');
        onForced?.();
      }
    }, graceMs);
    forceTimer.unref();
  };

  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  return () => {
    signal.removeEventListener('abort', onAbort);
    if (forceTimer !== null) clearTimeout(forceTimer);
  };
}
