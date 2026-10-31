import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CoordinationStore } from '@tandemise/coordination';
import { loadRelayConfig, type RelayConfig } from './config.js';
import { openRelayDb } from './db.js';
import { createLog } from './log.js';
import { FailedAuthLimiter, TokenBuckets } from './rate-limit.js';
import { coreRoutes } from './routes.js';
import { RelayStreamHub } from './stream.js';
import { createRelayServer, listen } from './server.js';
import { ingressHandler, mailboxRoutes } from './ingress.js';
import { startSweep } from './sweep.js';

export { loadRelayConfig } from './config.js';
export type { RelayConfig } from './config.js';

export interface RunningRelay {
  readonly port: number;
  /** The admin invite printed on the first start of an empty database; null afterwards. */
  readonly bootstrapInvite: string | null;
  close(): Promise<void>;
}

/**
 * Starts the relay: one process, one SQLite file, no workers. On the first
 * start of an empty database it creates the team and one admin invite, and
 * prints the code once.
 */
export async function startRelay(config: RelayConfig): Promise<RunningRelay> {
  const log = createLog(config.logLevel);
  if (config.insecureHttp && !config.publicUrl.startsWith('https:')) {
    // Every start, whatever the log level: an unencrypted relay is a choice someone should keep seeing.
    console.warn(`WARNING: RELAY_INSECURE_HTTP=1. This relay serves ${config.publicUrl} unencrypted; device tokens cross the network in the clear. Use it on a trusted LAN only.`);
  }
  let offsetMs = 0;
  const clock = (): Date => new Date(Date.now() + offsetMs);
  const db = openRelayDb(config.dbPath);
  const store = new CoordinationStore(db.handle, clock);
  store.hooksBase = config.publicUrl;
  store.retention = config.retention;

  let bootstrapInvite: string | null = null;
  if (store.team() === null) {
    store.ensureTeam(config.teamName);
    bootstrapInvite = store.createInvite({ role: 'admin', displayName: 'Admin', createdBy: null }).code;
    console.log(`Admin invite: ${bootstrapInvite}`);
    console.log('It works once. Paste it into Tandemise: Settings → Team relay → Connect.');
  }

  const now = (): number => clock().getTime();
  const limiter = new FailedAuthLimiter(now);
  const hub = new RelayStreamHub(store, limiter, log);
  // Per webhook endpoint: 60 a minute, bursts of 120 (spec §The webhook mailbox, "Limits").
  const buckets = new TokenBuckets(now);
  const routes = [
    ...coreRoutes({
      store, hub, staleAfterMs: config.staleAfterMs,
      advanceClock: config.testClock ? (ms) => { offsetMs += ms; } : null,
      onFailedRedeem: (ip) => limiter.fail(ip),
      redeemLocked: (ip) => limiter.locked(ip),
    }),
    ...mailboxRoutes({ store, hub }),
  ];
  const server = createRelayServer({ store, hub, limiter, routes, ingress: ingressHandler({ store, hub, buckets, log }), log });
  const port = await listen(server, config.port, config.host);
  const stopSweep = startSweep(store, config.retention, log);
  log('info', 'relay.listening', { host: config.host, port, publicUrl: config.publicUrl, team: store.team()?.name });

  return {
    port,
    bootstrapInvite,
    close: async () => {
      stopSweep();
      hub.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

function isEntryPoint(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return realpathSync(argv) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    const relay = await startRelay(loadRelayConfig(process.env));
    const stop = (): void => { void relay.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
