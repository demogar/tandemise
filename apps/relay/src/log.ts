import type { LogLevel } from './config.js';

export type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * One JSON line per event. Webhook bodies and headers are never logged: the
 * ingress records an endpoint id, a size and a status, and nothing else.
 */
export function createLog(min: LogLevel): Log {
  return (level, msg, fields = {}) => {
    if (RANK[level] < RANK[min]) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
    if (level === 'warn' || level === 'error') console.warn(line);
    else console.log(line);
  };
}
