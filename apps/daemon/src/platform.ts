import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { SettingsStorePort, SystemEnvironmentPort, ProcessLivenessPort } from '@tandemise/application';
import type { Logger, Timestamp } from '@tandemise/shared';
import { isProcessAlive } from './http/identity.js';
import type { DaemonConfig } from './config.js';

/**
 * Small platform adapters the application layer depends on through ports.
 *
 * None of these is interesting on its own; the point is that the mission engine
 * never calls `process.kill` or `fs.writeFile` directly, which is what keeps it
 * testable without a filesystem and keeps the OS-specific behaviour in one
 * reviewable place.
 */

export function createSystemEnvironment(config: DaemonConfig, schemaVersion: number): SystemEnvironmentPort {
  const startedAt = new Date().toISOString() as Timestamp;
  return {
    daemonVersion: config.version,
    daemonBuild: config.build,
    schemaVersion,
    home: config.home,
    startedAt,
    pid: process.pid,
    platform: `${process.platform}-${process.arch}`,
    nodeVersion: process.version,
  };
}

/**
 * Liveness by signal 0. `EPERM` means the pid exists but belongs to another
 * user - which still counts as alive, and getting that wrong would make
 * recovery reap a lease whose holder is genuinely still running.
 */
export const processLiveness: ProcessLivenessPort = {
  isAlive: (pid) => isProcessAlive(pid),
};

/**
 * User settings as a single JSON document.
 *
 * Deliberately not a table: these are a handful of preferences read at startup
 * and written by one screen. A schema migration for "the user changed their
 * theme" would be all cost and no benefit.
 */
export function createSettingsStore(home: string, log: Logger): SettingsStorePort {
  const path = join(home, 'settings.json');

  const read = (): Record<string, unknown> => {
    if (!existsSync(path)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch (e) {
      // A corrupt settings file must not stop the daemon from starting; the
      // user loses preferences, not their missions.
      log.warn('settings.unreadable', { path, error: String(e) });
      return {};
    }
  };

  return {
    read,
    write(patch) {
      const next = { ...read(), ...patch };
      mkdirSync(dirname(path), { recursive: true });
      // Write-then-rename: rename is atomic within a filesystem, so a crash
      // mid-write leaves the previous settings intact rather than a truncated
      // file that would read as "{}" on the next start.
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
      renameSync(tmp, path);
      return next;
    },
  };
}
