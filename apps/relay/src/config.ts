import { DEFAULT_RETENTION, DEFAULT_STALE_AFTER_MS, type RetentionPolicy } from '@tandemise/coordination';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RelayConfig {
  readonly teamName: string;
  /** Where webhook URLs point. Must be https:// unless the relay only listens on loopback. */
  readonly publicUrl: string;
  readonly port: number;
  readonly host: string;
  readonly dbPath: string;
  readonly staleAfterMs: number;
  readonly retention: RetentionPolicy;
  readonly logLevel: LogLevel;
  readonly insecureHttp: boolean;
  /** Read the client address from X-Forwarded-For: only behind a proxy you run (the `tls` profile). */
  readonly trustProxy: boolean;
  /** `POST /relay/v1/test/advance-clock` exists only with this on. Never in production. */
  readonly testClock: boolean;
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `24h`, `90m`, `14d`, `30s`, `500ms`. */
export function parseDuration(raw: string, name: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(raw.trim());
  if (!m) throw new Error(`${name} must look like 24h, 90m or 14d, not "${raw}".`);
  return Number(m[1]) * UNITS[m[2]!]!;
}

function positiveInt(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a whole number above zero, not "${raw}".`);
  return n;
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.startsWith('127.');
}

/** Reads the relay's configuration from its environment (`.env.example` lists every variable). */
export function loadRelayConfig(env: Record<string, string | undefined> = process.env): RelayConfig {
  const host = env['RELAY_HOST']?.trim() || '0.0.0.0';
  const port = env['RELAY_PORT'] === undefined || env['RELAY_PORT'] === '' ? 8787 : Number(env['RELAY_PORT']);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`RELAY_PORT must be a port number, not "${env['RELAY_PORT']}".`);
  const insecureHttp = env['RELAY_INSECURE_HTTP'] === '1';
  const loopback = isLoopback(host);
  const rawUrl = env['RELAY_PUBLIC_URL']?.trim();
  if (!rawUrl && !loopback) throw new Error('RELAY_PUBLIC_URL is required: the address teammates and webhook sources reach this relay at.');
  const publicUrl = (rawUrl || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new Error(`RELAY_PUBLIC_URL must be a full address like https://relay.example.com, not "${publicUrl}".`);
  }
  if (url.protocol !== 'https:' && !loopback && !insecureHttp) {
    throw new Error('RELAY_PUBLIC_URL must be https:// unless the relay only listens on loopback. Set RELAY_INSECURE_HTTP=1 for a LAN-only setup.');
  }
  const level = (env['RELAY_LOG_LEVEL']?.trim() || 'info') as LogLevel;
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new Error(`RELAY_LOG_LEVEL must be debug, info, warn or error, not "${level}".`);
  const retention: RetentionPolicy = {
    ackedRowMs: env['RELAY_MAILBOX_ACKED_KEEP'] ? parseDuration(env['RELAY_MAILBOX_ACKED_KEEP'], 'RELAY_MAILBOX_ACKED_KEEP') : DEFAULT_RETENTION.ackedRowMs,
    unackedMs: env['RELAY_MAILBOX_UNACKED_KEEP'] ? parseDuration(env['RELAY_MAILBOX_UNACKED_KEEP'], 'RELAY_MAILBOX_UNACKED_KEEP') : DEFAULT_RETENTION.unackedMs,
    maxMessages: env['RELAY_MAILBOX_MAX_MESSAGES'] ? positiveInt(env['RELAY_MAILBOX_MAX_MESSAGES'], 'RELAY_MAILBOX_MAX_MESSAGES') : DEFAULT_RETENTION.maxMessages,
    maxBytes: env['RELAY_MAILBOX_MAX_MB'] ? positiveInt(env['RELAY_MAILBOX_MAX_MB'], 'RELAY_MAILBOX_MAX_MB') * 1_048_576 : DEFAULT_RETENTION.maxBytes,
  };
  return {
    teamName: env['RELAY_TEAM_NAME']?.trim() || 'Team',
    publicUrl,
    port,
    host,
    dbPath: env['RELAY_DB']?.trim() || '/data/relay.db',
    staleAfterMs: env['RELAY_STALE_AFTER'] ? parseDuration(env['RELAY_STALE_AFTER'], 'RELAY_STALE_AFTER') : DEFAULT_STALE_AFTER_MS,
    retention,
    logLevel: level,
    insecureHttp,
    trustProxy: env['RELAY_TRUST_PROXY'] === '1',
    testClock: env['RELAY_TEST_CLOCK'] === '1',
  };
}
