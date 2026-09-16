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
}

export function loadConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const home = overrides.home ?? defaultRoot();
  return {
    home,
    paths: createPaths(home),
    port: overrides.port ?? Number(process.env.TANDEMISE_PORT ?? 0),
    logLevel: overrides.logLevel ?? ((process.env.TANDEMISE_LOG_LEVEL as LogLevel) ?? 'info'),
    version: overrides.version ?? '0.3.1', // x-release-please-version
    offline: overrides.offline ?? process.env.TANDEMISE_OFFLINE === '1',
    tickIntervalMs: overrides.tickIntervalMs ?? Number(process.env.TANDEMISE_TICK_MS ?? 1500),
  };
}
