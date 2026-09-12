import { errorMessage, type Logger } from '@tandemise/shared';

/**
 * Coordinated shutdown (MVP.md §7.3).
 *
 * "Quit Tandemise" must not mean "kill the process and hope". Active runs get a
 * chance to be cancelled, events get flushed, leases get released, and the
 * connection file is removed so the desktop does not try to reconnect to a dead
 * port. A second signal forces immediate exit - a user pressing Ctrl-C twice
 * means it.
 */
export function installShutdownHandlers(opts: {
  log: Logger;
  shutdown: () => Promise<void>;
  graceMs?: number;
}): void {
  const graceMs = opts.graceMs ?? 15_000;
  let shuttingDown = false;

  const run = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      opts.log.warn('daemon.force_exit', { signal });
      process.exit(130);
    }
    shuttingDown = true;
    opts.log.info('daemon.shutting_down', { signal });

    const timer = setTimeout(() => {
      opts.log.error('daemon.shutdown_timeout', { graceMs });
      process.exit(1);
    }, graceMs);
    timer.unref();

    try {
      await opts.shutdown();
      opts.log.info('daemon.stopped');
      process.exit(0);
    } catch (e) {
      opts.log.error('daemon.shutdown_failed', { error: errorMessage(e) });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void run('SIGINT'));
  process.on('SIGTERM', () => void run('SIGTERM'));

  // An unhandled rejection in a supervisor usually means a run's event stream
  // died silently. Log it loudly rather than letting Node's default kill us
  // mid-write to SQLite.
  process.on('unhandledRejection', (reason) => {
    opts.log.error('daemon.unhandled_rejection', { error: errorMessage(reason) });
  });
  process.on('uncaughtException', (error) => {
    opts.log.error('daemon.uncaught_exception', { error: errorMessage(error), stack: error.stack });
    void run('uncaughtException');
  });
}
