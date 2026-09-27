/**
 * The About section's facts, the version check and the "Copy diagnostics"
 * text, in one place.
 *
 * This file has no imports on purpose. The desktop renderer is a sandboxed
 * browser context and every `@tandemise/*` package entry reaches Node
 * built-ins, so it reads this through the `@tandemise/api-contract/about`
 * subpath, which `scripts/check-boundaries.mjs` allowlists only while it stays
 * import-free. The offline check (`scratch/about-check.mjs`) imports the same
 * functions, so what it proves about the copied text is what the app copies.
 *
 * The diagnostics text is built from named fields only. It never serialises a
 * whole object, so a token that sits next to a version (the daemon handshake
 * carries one) cannot reach the clipboard by being passed along.
 */

export const TANDEMISE_REPOSITORY_URL = 'https://github.com/demogar/tandemise';
export const TANDEMISE_DOCS_URL = 'https://github.com/demogar/tandemise/tree/main/docs';
export const TANDEMISE_NEW_ISSUE_URL = 'https://github.com/demogar/tandemise/issues/new?template=bug_report.yml';

/** What the desktop app knows about itself (the main process answers it). */
export interface AppAboutFacts {
  readonly version: string;
  /** Short git commit the app was built from, or `dev`. */
  readonly build: string;
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
  /** For example `macOS 15.0 (arm64)`. */
  readonly os: string;
  /** The person's home folder, replaced by `~` in the copied text. */
  readonly userHome: string;
}

/** What the daemon reports about itself (`GET /v1/system`). */
export interface DaemonAboutFacts {
  readonly daemonVersion: string;
  readonly daemonBuild: string;
  readonly apiVersion: string;
  readonly schemaVersion: number;
  readonly startedAt: string;
  readonly pid: number;
  readonly home: string;
  readonly platform: string;
  readonly nodeVersion: string;
}

export type VersionMismatch =
  | { readonly kind: 'version'; readonly app: string; readonly daemon: string }
  | { readonly kind: 'build'; readonly app: string; readonly daemon: string };

/**
 * Whether the app and the daemon it talks to came from different code.
 *
 * Versions decide first. Equal versions with two known, different commits
 * still mean a stale daemon (a rebuild the daemon never picked up), which is
 * the usual way a developer running from a checkout ends up debugging the
 * wrong code. `dev` means "not known", never a mismatch.
 */
export function versionMismatch(app: Pick<AppAboutFacts, 'version' | 'build'>, daemon: Pick<DaemonAboutFacts, 'daemonVersion' | 'daemonBuild'>): VersionMismatch | null {
  if (app.version !== daemon.daemonVersion) return { kind: 'version', app: app.version, daemon: daemon.daemonVersion };
  const known = (build: string): boolean => build !== '' && build !== 'dev';
  if (known(app.build) && known(daemon.daemonBuild) && app.build !== daemon.daemonBuild) {
    return { kind: 'build', app: app.build, daemon: daemon.daemonBuild };
  }
  return null;
}

/**
 * The sentence under the warning: what happened and what to do next.
 *
 * "Start it by hand" rather than "press Retry": the app's own auto-start runs
 * the daemon under Electron's bundled Node, which cannot open the database, so
 * Retry alone does not bring a daemon back. The window follows a daemon that
 * comes back on its own (it re-reads the handshake every few seconds).
 */
export function mismatchAdvice(mismatch: VersionMismatch, daemonPid: number | null): string {
  const stop = daemonPid === null ? 'stop the daemon' : `run \`kill ${daemonPid}\` in a terminal`;
  const restart = `${stop}, then \`npm run daemon\` in the repository. The window reconnects by itself.`;
  return mismatch.kind === 'version'
    ? `The app is ${mismatch.app} but the daemon is ${mismatch.daemon}. Restart the daemon: ${restart}`
    : `The app was built from commit ${mismatch.app} but the daemon from ${mismatch.daemon}. Run \`npm run build\`, then restart the daemon: ${restart}`;
}

/** `2d 4h`, `3h 12m`, `5m`, `under a minute`. */
export function uptimeText(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return 'unknown';
  const minutes = Math.floor(Math.max(0, now - started) / 60_000);
  if (minutes < 1) return 'under a minute';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** `0.5.0 (a1b2c3d)`, or just the version when the build is unknown. */
export function versionWithBuild(version: string, build: string): string {
  return build && build !== 'dev' ? `${version} (${build})` : `${version} (dev build)`;
}

export interface DiagnosticsInput {
  readonly app: AppAboutFacts | null;
  readonly daemon: DaemonAboutFacts | null;
  /** `Running`, `Not connected`, … as the section shows it. */
  readonly daemonState: string;
  readonly now: number;
}

/**
 * The plain-text block "Copy diagnostics" puts on the clipboard, for pasting
 * into an issue. Named fields only, one per line, no tokens, no settings, no
 * environment: see the header comment.
 */
export function diagnosticsText(input: DiagnosticsInput): string {
  const { app, daemon } = input;
  const tilde = (path: string): string =>
    app && app.userHome.length > 1 && (path === app.userHome || path.startsWith(`${app.userHome}/`))
      ? `~${path.slice(app.userHome.length)}`
      : path;
  const one = (value: string | number): string => String(value).replace(/[\r\n]+/g, ' ').trim();
  const lines: string[] = ['Tandemise diagnostics', `Generated: ${new Date(input.now).toISOString()}`, ''];

  lines.push('App');
  if (app) {
    lines.push(`  Version: ${one(versionWithBuild(app.version, app.build))}`);
    lines.push(`  Electron: ${one(app.electron)}`);
    lines.push(`  Chromium: ${one(app.chrome)}`);
    lines.push(`  Node (app): ${one(app.node)}`);
    lines.push(`  OS: ${one(app.os)}`);
  } else {
    lines.push('  (not available)');
  }

  lines.push('', 'Daemon');
  lines.push(`  Status: ${one(input.daemonState)}`);
  if (daemon) {
    lines.push(`  Version: ${one(versionWithBuild(daemon.daemonVersion, daemon.daemonBuild))}`);
    lines.push(`  API: ${one(daemon.apiVersion)}`);
    lines.push(`  Database schema: ${one(daemon.schemaVersion)}`);
    lines.push(`  Uptime: ${one(uptimeText(daemon.startedAt, input.now))} (since ${one(daemon.startedAt)})`);
    lines.push(`  Process id: ${one(daemon.pid)}`);
    lines.push(`  Node (daemon): ${one(daemon.nodeVersion)}`);
    lines.push(`  Platform: ${one(daemon.platform)}`);
    lines.push(`  Data folder: ${one(tilde(daemon.home))}`);
  } else {
    lines.push('  (not connected, so its version, schema and data folder are unknown)');
  }

  if (app && daemon) {
    const mismatch = versionMismatch(app, daemon);
    lines.push('', mismatch ? `Mismatch: ${mismatch.kind} (app ${one(mismatch.app)}, daemon ${one(mismatch.daemon)})` : 'Mismatch: none');
  }
  return `${lines.join('\n')}\n`;
}
