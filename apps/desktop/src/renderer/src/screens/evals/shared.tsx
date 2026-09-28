import { useQueryClient } from '@tanstack/react-query';
import type { EvalRunStatus } from '@tandemise/domain';
import type { DaemonClient } from '../../lib/daemon.js';
import { describeError } from '../../lib/daemon.js';
import { useDaemonMutation } from '../../lib/queries.js';
import type { Tone } from '../../lib/format.js';

/**
 * A mutation on suites, cases or runs. No stream topic carries evals yet, so
 * a change refreshes every eval query itself rather than naming a topic.
 */
export function useEvalMutation<TArgs, TResult>(run: (daemon: DaemonClient, args: TArgs) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useDaemonMutation(async (daemon, args: TArgs) => {
    const result = await run(daemon, args);
    void queryClient.invalidateQueries({ queryKey: ['evals'] });
    return result;
  }, []);
}

/** A refused request, in the daemon's own words: it already says what to do about it. */
export function Refusal({ error }: { error: unknown }): JSX.Element {
  return (
    <p className="field__error" role="alert" style={{ margin: 0 }}>
      {describeError(error).detail}
    </p>
  );
}

export const RUN_TONES: Readonly<Record<EvalRunStatus, Tone>> = {
  queued: 'pending',
  running: 'running',
  completed: 'succeeded',
  cancelled: 'pending',
  stopped_at_cap: 'blocked',
  failed: 'failed',
};

/** Still going: its detail is polled, and it can be cancelled. */
export function isLive(status: EvalRunStatus): boolean {
  return status === 'queued' || status === 'running';
}

/** Copy the global constraints fix verbatim (spec B5, Ruling 9). */
export const UNMEASURED_COST = "This runtime doesn't report cost, so your cap can't stop this run.";

/**
 * Dollars for a trial's cost. A single trial often costs well under a cent,
 * which `money()` would round to $0.00 and so read as free; below a cent it
 * keeps four decimals.
 */
export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'not reported';
  const small = value !== 0 && Math.abs(value) < 0.01;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: small ? 4 : 2,
  }).format(value);
}

export function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}
