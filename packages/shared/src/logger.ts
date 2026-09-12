import { redactSecrets } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Correlation fields. The named ones are the trace hierarchy of MVP.md §22.1 and
 * exist so that an IDE autocompletes the right spelling rather than letting
 * `runid` and `run_id` both appear in the log stream. They accept `null`
 * because most call sites hold a nullable id and forcing `?? undefined` at
 * every one of them buys nothing.
 */
export interface LogFields {
  workspaceId?: string | null;
  missionId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  role?: string | null;
  runtime?: string | null;
  component?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LogSink {
  write(line: string): void;
}

const stdoutSink: LogSink = { write: (line) => process.stdout.write(line + '\n') };

/**
 * Structured JSON logger with correlation fields (MVP.md §22.3). Every value is
 * passed through secret redaction before it reaches a sink - logs are the most
 * common accidental credential leak in a process supervisor.
 */
export function createLogger(
  opts: { level?: LogLevel; base?: LogFields; sink?: LogSink } = {},
): Logger {
  const level = opts.level ?? (process.env.TANDEMISE_LOG_LEVEL as LogLevel) ?? 'info';
  const base = opts.base ?? {};
  const sink = opts.sink ?? stdoutSink;

  const emit = (lvl: LogLevel, msg: string, fields?: LogFields): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    const record = { ts: new Date().toISOString(), level: lvl, msg, ...base, ...fields };
    try {
      sink.write(redactSecrets(JSON.stringify(record)));
    } catch {
      sink.write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg }));
    }
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ level, base: { ...base, ...fields }, sink }),
  };
}

export const nullLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => nullLogger,
};
