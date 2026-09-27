/**
 * Which Node runs the daemon the desktop starts.
 *
 * The daemon is a plain Node program with a native SQLite module
 * (better-sqlite3). `npm install` compiles that module for the Node that ran
 * the install, and the root `package.json` pins that Node at 22 or newer.
 * Electron's bundled Node is a different runtime with a different native ABI
 * (Electron 33 ships Node 20.18, ABI 130, against Node 22's 127), so a daemon
 * started with `process.execPath` + `ELECTRON_RUN_AS_NODE` failed on its first
 * `new Database()` with "Cannot open database". The fix is to start the daemon
 * with the same kind of Node it was installed with.
 *
 * Order, first usable wins:
 *   1. `TANDEMISE_NODE` - an explicit path. If it is set and unusable, that is
 *      the answer: silently running a different Node would hide the typo.
 *   2. `node` on the search path: the login shell's PATH (a Finder-launched app
 *      inherits launchd's bare PATH, not the one nvm/Homebrew/volta set up),
 *      then this process's PATH, then the usual install directories.
 *   3. Electron's own Node, as a last resort, only if it meets the version
 *      floor. With Electron 33 it does not, so the person gets a clear message
 *      instead of a database error.
 *
 * This module is pure: every filesystem lookup and process probe is passed in,
 * so `scratch/daemon-node-check.mjs` can drive it with a fake world. It has no
 * runtime imports for the same reason.
 */

/** From the root `package.json` `engines.node` (">=22.0.0"). */
export const MIN_NODE_MAJOR = 22;

/** Well-known places `node` lives when no PATH mentions them. */
const WELL_KNOWN_DIRS: Record<string, readonly string[]> = {
  darwin: ['/opt/homebrew/bin', '/usr/local/bin'],
  linux: ['/usr/local/bin', '/usr/bin'],
};

export type NodeSource = 'TANDEMISE_NODE' | 'PATH' | 'electron';

export interface NodeCandidateReport {
  readonly path: string;
  readonly source: NodeSource;
  /** Why it was not used; absent on the one that was picked. */
  readonly rejected?: string;
  /** Set when it ran but was older than the floor. */
  readonly version?: string;
}

export type NodeResolution =
  | {
      readonly ok: true;
      readonly command: string;
      readonly version: string;
      readonly source: NodeSource;
      /** Extra environment the child needs (Electron's Node must be told to act as Node). */
      readonly env: Readonly<Record<string, string>>;
      readonly tried: readonly NodeCandidateReport[];
    }
  | {
      readonly ok: false;
      /** Plain sentence for the not-running screen: what is missing and how to fix it. */
      readonly message: string;
      readonly tried: readonly NodeCandidateReport[];
    };

export interface NodeWorld {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  /** PATH as the person's login shell sets it, or null when it could not be read. */
  readonly loginShellPath: string | null;
  /** Electron's executable and the Node version it embeds. */
  readonly electron: { readonly execPath: string; readonly nodeVersion: string };
  /** True when `path` is an existing, executable regular file. */
  isExecutable(path: string): boolean;
  /** `path --version` (e.g. "v22.11.0"), or null when it did not run. */
  versionOf(path: string): string | null;
}

export function resolveDaemonNode(world: NodeWorld): NodeResolution {
  const tried: NodeCandidateReport[] = [];
  const win = world.platform === 'win32';
  const sep = win ? ';' : ':';
  const join = (dir: string, name: string): string => (dir.endsWith('/') || dir.endsWith('\\') ? dir + name : `${dir}${win ? '\\' : '/'}${name}`);

  const judge = (version: string | null): string | null => {
    if (version === null) return 'it did not run';
    const major = majorOf(version);
    if (major === null) return `it reported an unreadable version "${version}"`;
    if (major < MIN_NODE_MAJOR) return `it is Node ${stripV(version)}, and the daemon needs Node ${MIN_NODE_MAJOR} or newer`;
    return null;
  };

  // 1. Explicit override.
  const explicit = world.env['TANDEMISE_NODE']?.trim();
  if (explicit) {
    const version = world.isExecutable(explicit) ? world.versionOf(explicit) : null;
    const reason = world.isExecutable(explicit) ? judge(version) : 'there is no runnable file there';
    if (reason === null && version !== null) {
      return { ok: true, command: explicit, version: stripV(version), source: 'TANDEMISE_NODE', env: {}, tried: [...tried, { path: explicit, source: 'TANDEMISE_NODE' }] };
    }
    tried.push({ path: explicit, source: 'TANDEMISE_NODE', rejected: reason ?? 'it did not run' });
    return {
      ok: false,
      message: `TANDEMISE_NODE is set to ${explicit}, but ${reason}. Point it at a Node ${MIN_NODE_MAJOR}+ binary (run which node in a terminal to find one), or unset it, then press Retry.`,
      tried,
    };
  }

  // 2. `node` on the search path. TANDEMISE_NODE_SEARCH_PATH replaces every
  // PATH source; it exists so the acceptance suite can simulate a machine with
  // no Node at all.
  const override = world.env['TANDEMISE_NODE_SEARCH_PATH'];
  const dirs = override !== undefined
    ? splitPath(override, sep)
    : [
        ...splitPath(world.loginShellPath ?? '', sep),
        ...splitPath(world.env['PATH'] ?? '', sep),
        ...(WELL_KNOWN_DIRS[world.platform] ?? []),
      ];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const candidate = join(dir, win ? 'node.exe' : 'node');
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!world.isExecutable(candidate)) continue;
    const version = world.versionOf(candidate);
    const reason = judge(version);
    if (reason === null && version !== null) {
      return { ok: true, command: candidate, version: stripV(version), source: 'PATH', env: {}, tried: [...tried, { path: candidate, source: 'PATH' }] };
    }
    const major = version === null ? null : majorOf(version);
    tried.push({
      path: candidate,
      source: 'PATH',
      rejected: reason ?? 'it did not run',
      ...(version !== null && major !== null && major < MIN_NODE_MAJOR ? { version: stripV(version) } : {}),
    });
  }

  // 3. Electron's Node, last.
  const electronReason = judge(world.electron.nodeVersion);
  if (electronReason === null) {
    return {
      ok: true,
      command: world.electron.execPath,
      version: stripV(world.electron.nodeVersion),
      source: 'electron',
      // Electron's binary refuses to run a plain script without this.
      env: { ELECTRON_RUN_AS_NODE: '1' },
      tried: [...tried, { path: world.electron.execPath, source: 'electron' }],
    };
  }
  tried.push({ path: world.electron.execPath, source: 'electron', rejected: electronReason });

  // A Node that exists but is too old is worth naming: the fix is an upgrade.
  const tooOld = tried
    .filter((t) => t.source === 'PATH' && t.version !== undefined)
    .map((t) => `Node ${t.version} at ${t.path}`);
  const found = tooOld.length > 0 ? ` Found ${tooOld.join(' and ')}, which is too old.` : '';
  return {
    ok: false,
    message: `Tandemise needs Node.js ${MIN_NODE_MAJOR} or newer to run its daemon, and none was found.${found} Install it from nodejs.org or with Homebrew (brew install node), or set TANDEMISE_NODE to the path of a Node ${MIN_NODE_MAJOR}+ binary, then press Retry.`,
    tried,
  };
}

function splitPath(value: string, sep: string): string[] {
  return value.split(sep).map((d) => d.trim()).filter((d) => d.length > 0);
}

function stripV(version: string): string {
  return version.trim().replace(/^v/, '');
}

function majorOf(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Reads PATH out of a shell's stdout, between markers, so whatever an
 * interactive profile prints around it (banners, nvm notices) is ignored.
 */
export const LOGIN_PATH_MARKER = '__TANDEMISE_PATH__';
export function parseLoginShellPath(stdout: string): string | null {
  const start = stdout.indexOf(LOGIN_PATH_MARKER);
  if (start < 0) return null;
  const end = stdout.indexOf(LOGIN_PATH_MARKER, start + LOGIN_PATH_MARKER.length);
  if (end < 0) return null;
  const value = stdout.slice(start + LOGIN_PATH_MARKER.length, end).trim();
  return value.length > 0 ? value : null;
}
