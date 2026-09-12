import type { ProcessLivenessPort, SettingsStorePort, SystemEnvironmentPort } from '../ports.js';
import { systemClock } from '@tandemise/shared';

/**
 * Fallback implementations for the small ports whose real owner is the
 * composition root.
 *
 * They exist so the mission engine can be composed on its own - in a test, in a
 * scratch harness, in a CLI - without the caller having to wire three
 * uninteresting tokens. The daemon rebinds every one of them with the real
 * thing.
 */

/** Settings held for the lifetime of the process only. */
export function createMemorySettingsStore(initial: Record<string, unknown> = {}): SettingsStorePort {
  let state: Record<string, unknown> = { ...initial };
  return {
    read: () => ({ ...state }),
    write(patch) {
      state = { ...state, ...patch };
      return { ...state };
    },
  };
}

/**
 * `kill(pid, 0)` sends no signal; it only reports whether the process exists
 * and is signalable. `EPERM` means it exists and belongs to someone else, which
 * still counts as alive - treating it as dead is how recovery would restart
 * work that is still running.
 */
export const osProcessLiveness: ProcessLivenessPort = {
  isAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
};

export interface EnvironmentOverrides {
  readonly daemonVersion?: string;
  readonly schemaVersion?: number;
  readonly home?: string;
}

export function describeEnvironment(overrides: EnvironmentOverrides = {}): SystemEnvironmentPort {
  return {
    daemonVersion: overrides.daemonVersion ?? '0.0.0-dev',
    schemaVersion: overrides.schemaVersion ?? 0,
    home: overrides.home ?? '',
    startedAt: systemClock.now(),
    pid: process.pid,
    platform: process.platform,
    nodeVersion: process.version,
  };
}
