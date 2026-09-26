import { createPaths, defaultRoot, type LogLevel, type TandemisePaths } from '@tandemise/shared';

/**
 * Daemon configuration, resolved once at startup.
 *
 * Everything is overridable by environment variable so that a test run, a
 * second instance for development, and the packaged app can coexist without
 * sharing a database or a worktree root.
 */
export interface DaemonConfig {
  readonly home: string;
  readonly paths: TandemisePaths;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly version: string;
  /** Disables spawning real agent runtimes. Used by smoke tests. */
  readonly offline: boolean;
  /** Scheduler tick interval. Short enough to feel live, long enough to idle. */
  readonly tickIntervalMs: number;
  /** A run is quiet after this long without an agent event (P9); silent later. Never stops it. */
  readonly quietMs: number;
  /**
   * Test knob (P11): when set, the daemon's one Clock reads real time plus this
   * offset and `POST /v1/test/clock` may move it forward, so a real-app suite
   * reaches a routine's next run without waiting. Null (unset) in normal use.
   */
  readonly clockOffsetMs: number | null;
}

export function loadConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const home = overrides.home ?? defaultRoot();
  return {
    home,
    paths: createPaths(home),
    port: overrides.port ?? Number(process.env.TANDEMISE_PORT ?? 0),
    logLevel: overrides.logLevel ?? ((process.env.TANDEMISE_LOG_LEVEL as LogLevel) ?? 'info'),
    version: overrides.version ?? '0.5.0', // x-release-please-version
    offline: overrides.offline ?? process.env.TANDEMISE_OFFLINE === '1',
    tickIntervalMs: overrides.tickIntervalMs ?? Number(process.env.TANDEMISE_TICK_MS ?? 1500),
    quietMs: overrides.quietMs ?? Number(process.env.TANDEMISE_QUIET_MS ?? 600_000),
    clockOffsetMs: overrides.clockOffsetMs !== undefined ? overrides.clockOffsetMs : clockOffsetFromEnv(),
  };
}

function clockOffsetFromEnv(): number | null {
  const raw = process.env.TANDEMISE_CLOCK_OFFSET_MS;
  if (raw === undefined || raw.trim() === '') return null;
  const offset = Number(raw);
  return Number.isFinite(offset) ? offset : null;
}
