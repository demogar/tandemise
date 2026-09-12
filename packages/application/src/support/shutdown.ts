/**
 * The abort reason the scheduler uses when the daemon itself is stopping.
 *
 * A stop and a cancel abort a run the same way, but they mean opposite things:
 * a cancel is a person ending the work, a stop is the machine pausing it. The
 * work of a stopped run belongs to the next daemon, which resumes it. Treating
 * the two alike marked every in-flight task CANCELLED on a restart - blocking
 * everything downstream of it - which is the one outcome a daemon designed to
 * outlive its window must never produce.
 */
export class DaemonStopping extends Error {
  constructor() {
    super('Tandemise is stopping; this run will be resumed when it starts again.');
    this.name = 'DaemonStopping';
  }
}

export function isDaemonStopping(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof DaemonStopping;
}
