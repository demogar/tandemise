import { sweep, type CoordinationStore, type RetentionPolicy } from '@tandemise/coordination';
import type { Log } from './log.js';

const EVERY_MS = 10 * 60_000;

/** The retention sweep, inside the relay process: once at start, then every ten minutes. No separate worker. */
export function startSweep(store: CoordinationStore, policy: RetentionPolicy, log: Log): () => void {
  const run = (): void => {
    try {
      const r = sweep(store, policy);
      if (r.deletedAcked > 0 || r.expiredUnacked > 0) log('info', 'mailbox.swept', r);
    } catch (e) {
      log('warn', 'mailbox.sweep_failed', { error: e instanceof Error ? e.message : String(e) });
    }
  };
  run();
  const timer = setInterval(run, EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
