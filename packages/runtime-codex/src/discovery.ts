import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { errorMessage } from '@tandemise/shared';
import { CODEX_INSTALL_HINT } from './settings.js';

const run = promisify(execFile);

export const CODEX_EXECUTABLE = 'codex';
export const VERSION_PROBE_TIMEOUT_MS = 10_000;

/** Where Codex's own sign-in state lives. Its absence is a distinct failure. */
export function codexAuthPath(): string {
  return join(homedir(), '.codex', 'auth.json');
}

export function isSignedIn(): boolean {
  return existsSync(codexAuthPath());
}

/**
 * Search order for the Codex binary.
 *
 * `PATH` is scanned directly rather than shelling out to `which`: the daemon's
 * environment is not an interactive shell, and `which` under a login shell can
 * resolve an *alias*, which is not something we can spawn. Scanning answers the
 * same question without that hazard.
 */
function candidateDirectories(): string[] {
  const home = homedir();
  const fromPath = (process.env['PATH'] ?? '').split(delimiter).filter((d) => d.length > 0);
  const wellKnown = [
    join(home, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  return [...fromPath, ...wellKnown, ...nvmBinDirectories(home)];
}

/** Codex ships as an npm global, so an nvm user's copy is per-node-version. */
function nvmBinDirectories(home: string): string[] {
  const versionsRoot = join(home, '.nvm', 'versions', 'node');
  try {
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

export function findExecutable(preferred?: string | null): string | null {
  if (preferred !== undefined && preferred !== null && preferred.length > 0) {
    return isExecutable(preferred) ? preferred : null;
  }
  for (const dir of candidateDirectories()) {
    const candidate = join(dir, CODEX_EXECUTABLE);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** The message shown when the binary is absent. Always tells the user what to do. */
export function notInstalledDetail(): string {
  const signedIn = isSignedIn();
  const found = signedIn
    ? ` A Codex sign-in was found at ${codexAuthPath()}, so the CLI itself is what is missing.`
    : '';
  return `Codex CLI not found on PATH, in ~/.local/bin, /usr/local/bin, /opt/homebrew/bin, or an nvm bin directory. ${CODEX_INSTALL_HINT}${found}`;
}

export function parseVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(output)?.[1] ?? null;
}

export interface VersionProbe {
  readonly version: string | null;
  readonly detail: string;
}

export async function probeVersion(
  executablePath: string,
  versionArgs: readonly string[],
): Promise<VersionProbe> {
  if (versionArgs.length === 0) {
    return { version: null, detail: `No versionArgs configured for ${executablePath}` };
  }
  try {
    const { stdout, stderr } = await run(executablePath, [...versionArgs], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const output = `${stdout}${stderr}`.trim();
    const version = parseVersion(output);
    return version === null
      ? { version: null, detail: `Could not parse a version from '${output}'` }
      : { version, detail: `${executablePath} (${version})` };
  } catch (e) {
    return { version: null, detail: `'${executablePath} ${versionArgs.join(' ')}' failed: ${errorMessage(e)}` };
  }
}
