import { execFile } from 'node:child_process';
import { accessSync, constants, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { TandemiseError, errorMessage } from '@tandemise/shared';

const run = promisify(execFile);

export const CLAUDE_EXECUTABLE = 'claude';
/** A `--version` probe that has not answered in this long is not healthy. */
export const VERSION_PROBE_TIMEOUT_MS = 10_000;

/**
 * Where a Claude Code install plausibly lives, in preference order.
 *
 * `PATH` is searched directly rather than shelling out to `which`: the daemon's
 * environment is not the user's interactive shell, and `which` under a login
 * shell would happily resolve an *alias*, which is not something we can spawn.
 */
function candidateDirectories(): string[] {
  const home = homedir();
  const fromPath = (process.env['PATH'] ?? '').split(delimiter).filter((d) => d.length > 0);
  const wellKnown = [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  return [...fromPath, ...wellKnown, ...nvmBinDirectories(home)];
}

/** nvm installs are per-node-version, so the binary is not on a stable path. */
function nvmBinDirectories(home: string): string[] {
  const versionsRoot = join(home, '.nvm', 'versions', 'node');
  try {
    // Newest node version first: an nvm user's current install is usually the latest.
    return readdirSync(versionsRoot).sort().reverse().map((v) => join(versionsRoot, v, 'bin'));
  } catch {
    return [];
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First executable `claude` on disk, or null. */
export function findExecutable(preferred?: string | null): string | null {
  if (preferred !== undefined && preferred !== null && preferred.length > 0) {
    return isExecutable(preferred) ? preferred : null;
  }
  for (const dir of candidateDirectories()) {
    const candidate = join(dir, CLAUDE_EXECUTABLE);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** `claude --version` prints `2.1.269 (Claude Code)`. */
export function parseVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(output)?.[1] ?? null;
}

export interface VersionProbe {
  readonly version: string | null;
  readonly detail: string;
}

export async function probeVersion(executablePath: string): Promise<VersionProbe> {
  try {
    const { stdout, stderr } = await run(executablePath, ['--version'], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const output = `${stdout}${stderr}`.trim();
    const version = parseVersion(output);
    return version === null
      ? { version: null, detail: `Could not parse a version from '${output}'` }
      : { version, detail: `${executablePath} (${version})` };
  } catch (e) {
    return { version: null, detail: `'${executablePath} --version' failed: ${errorMessage(e)}` };
  }
}

/** Resolves the executable for a profile, or explains why it cannot be run. */
export function requireExecutable(preferred: string | null): string {
  const found = findExecutable(preferred);
  if (found === null) {
    throw new TandemiseError('RUNTIME_UNAVAILABLE', 'Claude Code executable not found', {
      details: { preferred, searched: candidateDirectories().length },
    });
  }
  return found;
}
