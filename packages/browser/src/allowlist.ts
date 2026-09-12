import type { CapabilityGrant, WorkerAssignment } from '@tandemise/domain';
import { capabilityMatches } from '@tandemise/domain';

/**
 * Hosts that mean "this machine". Allowlisting `localhost` has to cover all of
 * them or a dev server that happens to bind `127.0.0.1` is unreachable for
 * reasons no user would guess (MVP.md §13.2).
 */
const LOOPBACK_ALIASES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/** Schemes that never touch the network and so are never a policy question. */
const ALWAYS_ALLOWED_URLS = new Set(['about:blank', 'about:srcdoc']);

/**
 * Which hosts one worker assignment's browser may reach (MVP.md §13.2).
 *
 * The allowlist is derived from the assignment's own `browser*` grants, so
 * there is no second place to configure it and no way for the two to disagree.
 *
 * Entry forms:
 *   - `localhost`        - the loopback family, any port
 *   - `example.com`      - that host exactly
 *   - `*.example.com`    - that host and any subdomain
 *   - `https://a.b/c`    - a URL; only its host is used
 *   - `data:` / `file:`  - a whole scheme, for fixtures and local artifacts
 *   - `*`                - everything (see `unrestricted`)
 */
export class DomainAllowlist {
  readonly #hosts: ReadonlySet<string>;
  readonly #suffixes: readonly string[];
  readonly #schemes: ReadonlySet<string>;
  readonly #loopback: boolean;

  constructor(entries: readonly string[]) {
    const hosts = new Set<string>();
    const suffixes: string[] = [];
    const schemes = new Set<string>();
    let loopback = false;
    let all = false;

    for (const raw of entries) {
      const entry = raw.trim().toLowerCase();
      if (entry.length === 0) continue;
      if (entry === '*') { all = true; continue; }
      if (/^[a-z][a-z0-9+.-]*:$/.test(entry)) { schemes.add(entry.slice(0, -1)); continue; }
      if (entry.startsWith('*.')) { suffixes.push(entry.slice(1)); hosts.add(entry.slice(2)); continue; }
      const host = hostOf(entry);
      if (!host) continue;
      if (LOOPBACK_ALIASES.has(host)) { loopback = true; continue; }
      hosts.add(host);
    }

    this.unrestricted = all;
    this.#hosts = hosts;
    this.#suffixes = suffixes;
    this.#schemes = schemes;
    this.#loopback = loopback;
  }

  /**
   * True when the assignment's browser grant named no scope at all.
   *
   * The grant model reads an empty `resourceScope` as "not narrowed", and this
   * follows it rather than inventing a second rule. Callers are expected to say
   * so loudly: an unrestricted browser is a decision someone made, and it
   * should look like one in the log.
   */
  readonly unrestricted: boolean;

  /** Derives the allowlist from every `browser*` grant on the assignment. */
  static forAssignment(assignment: WorkerAssignment): DomainAllowlist {
    const browserGrants = assignment.grants.filter((g) => isBrowserGrant(g));
    if (browserGrants.length === 0) return new DomainAllowlist([]);
    // A grant that names no scope widens the union to everything, which is the
    // same reading `resourceInScope` gives an empty scope elsewhere.
    if (browserGrants.some((g) => g.resourceScope.length === 0)) return new DomainAllowlist(['*']);
    return new DomainAllowlist(browserGrants.flatMap((g) => [...g.resourceScope]));
  }

  allows(url: string): boolean {
    if (ALWAYS_ALLOWED_URLS.has(url)) return true;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const scheme = parsed.protocol.replace(/:$/, '');
    if (this.#schemes.has(scheme)) return true;
    if (this.unrestricted) return scheme === 'http' || scheme === 'https';
    if (scheme !== 'http' && scheme !== 'https') return false;

    const host = parsed.hostname.toLowerCase();
    if (LOOPBACK_ALIASES.has(host)) return this.#loopback;
    if (this.#hosts.has(host)) return true;
    return this.#suffixes.some((suffix) => host.endsWith(suffix));
  }

  /** For error messages and for the run's audit trail. */
  describe(): string {
    if (this.unrestricted) return '(unrestricted)';
    const parts = [
      ...(this.#loopback ? ['localhost'] : []),
      ...[...this.#hosts],
      ...this.#suffixes.map((s) => `*${s}`),
      ...[...this.#schemes].map((s) => `${s}:`),
    ];
    return parts.length > 0 ? parts.sort().join(', ') : '(nothing)';
  }
}

function isBrowserGrant(grant: CapabilityGrant): boolean {
  return capabilityMatches(grant.capability, 'browser')
    || capabilityMatches('browser', grant.capability);
}

function hostOf(entry: string): string | undefined {
  if (entry.includes('://')) {
    try {
      return new URL(entry).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }
  // Bare `host` or `host:port`; the port is irrelevant to a domain allowlist.
  const [host] = entry.split('/');
  return host?.split(':')[0]?.toLowerCase() || undefined;
}
