/**
 * The environment an agent runtime's child process is given.
 *
 * Agent CLIs are subscription-authenticated: they find their credentials in the
 * user's own environment, keychain, or config directory, and Tandemise
 * deliberately never copies those into its database (MVP.md §10.3, §P8). So the
 * child cannot be given an empty environment.
 *
 * But "it needs *its* credentials" is not a reason to hand it *every*
 * credential. A daemon started from a developer shell routinely carries
 * GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, STRIPE_KEY and more, none of which any
 * agent runtime needs, and all of which would then be readable by a worker that
 * MVP.md §19.1 explicitly assumes may be prompt-injected or compromised.
 *
 * So: an allowlist. Base process variables, plus the vendor-namespaced
 * variables a runtime legitimately needs, plus whatever the adapter names
 * explicitly. Everything else stays in the daemon.
 */

/** Variables any child process needs to function at all. */
export const BASE_RUNTIME_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TMPDIR', 'TEMP', 'TMP', 'TZ', 'TERM', 'PWD',
  // Node-based CLIs resolve their own toolchain through these.
  'NODE_OPTIONS', 'NODE_PATH', 'NVM_DIR', 'NVM_BIN',
  // XDG paths are where several CLIs keep their config and session state.
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  // Corporate egress. Omitting these breaks the runtime on a proxied network.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
] as const;

export interface RuntimeEnvOptions {
  /**
   * Vendor prefixes whose variables the runtime owns, e.g. `['ANTHROPIC_',
   * 'CLAUDE_']`. Matched case-sensitively against the start of the name.
   */
  readonly allowedPrefixes?: readonly string[];
  /** Additional exact variable names to pass through. */
  readonly allowedNames?: readonly string[];
  /** Variables Tandemise sets itself. Applied last, so they win. */
  readonly overrides?: Readonly<Record<string, string>>;
  /** Source environment. Defaults to the daemon's own. */
  readonly source?: NodeJS.ProcessEnv;
}

export function buildRuntimeEnv(options: RuntimeEnvOptions = {}): NodeJS.ProcessEnv {
  const source = options.source ?? process.env;
  const allowedNames = new Set<string>([...BASE_RUNTIME_ENV, ...(options.allowedNames ?? [])]);
  const prefixes = options.allowedPrefixes ?? [];

  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (allowedNames.has(name) || prefixes.some((p) => name.startsWith(p))) {
      env[name] = value;
    }
  }
  return { ...env, ...(options.overrides ?? {}) };
}

/** Variable names present in `source` that the allowlist would withhold. */
export function withheldEnvNames(env: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv = process.env): readonly string[] {
  return Object.keys(source).filter((name) => !(name in env));
}
