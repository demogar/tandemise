import { isPathInside } from '@tandemise/shared';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';

/**
 * What kind of thing a grant's `resourceScope` entries name (MVP.md §19.2).
 * The kind decides the matching rule, and the matching rules differ in ways
 * that matter for security - `*.example.com` must not match `evil-example.com`,
 * and `/a/b` must not contain `/a/bc`.
 */
export type ResourceKind = 'path' | 'domain' | 'repo' | 'app' | 'opaque';

export interface ScopeMatch {
  readonly matched: boolean;
  /** The scope entry that matched, for the decision record. */
  readonly entry?: string;
  readonly reason: string;
}

const ANY = '*';

/**
 * True when `resource` falls inside at least one entry of `scope`.
 *
 * An empty scope never covers a named resource. That is deliberate: a grant
 * that forgot to say *where* is a grant that says nowhere. Callers that mean
 * "this capability is not resource-bound" pass no resource at all.
 */
export function matchesScope(kind: ResourceKind, resource: string, scope: readonly string[]): ScopeMatch {
  if (scope.length === 0) {
    return { matched: false, reason: 'grant carries no resource scope' };
  }
  for (const entry of scope) {
    if (entry === ANY) return { matched: true, entry, reason: 'scope entry * covers every resource' };
    if (matchEntry(kind, resource, entry)) {
      return { matched: true, entry, reason: `covered by scope entry '${entry}'` };
    }
  }
  return { matched: false, reason: `'${resource}' is outside every scope entry (${scope.join(', ')})` };
}

function matchEntry(kind: ResourceKind, resource: string, entry: string): boolean {
  switch (kind) {
    case 'path': return pathInScope(entry, resource);
    case 'domain': return domainInScope(entry, resource);
    case 'repo':
    case 'app':
    case 'opaque': return prefixInScope(entry, resource);
  }
}

// -------------------------------------------------------------------- paths

/** Expands `~` and makes the path absolute without consulting `process.cwd()`. */
export function absolutePath(input: string, cwd?: string): string {
  const expanded = input.startsWith('~') ? join(homedir(), input.slice(1)) : input;
  if (isAbsolute(expanded)) return resolve(expanded);
  return resolve(cwd ?? process.cwd(), expanded);
}

function pathInScope(entry: string, resource: string): boolean {
  return isPathInside(absolutePath(entry), absolutePath(resource));
}

// ------------------------------------------------------------------ domains

/**
 * Reduces a URL or host:port to a bare lowercase hostname so that a grant for
 * `api.github.com` covers `https://api.github.com/repos/x` and nothing else.
 */
export function hostOf(resource: string): string {
  let s = resource.trim().toLowerCase();
  const scheme = s.indexOf('://');
  if (scheme !== -1) s = s.slice(scheme + 3);
  const at = s.lastIndexOf('@');
  if (at !== -1) s = s.slice(at + 1);
  const slash = s.indexOf('/');
  if (slash !== -1) s = s.slice(0, slash);
  const colon = s.lastIndexOf(':');
  if (colon !== -1 && /^\d+$/.test(s.slice(colon + 1))) s = s.slice(0, colon);
  return s.replace(/\.$/, '');
}

/**
 * `example.com` matches only itself. `*.example.com` matches any subdomain, at
 * any depth, and never the apex.
 *
 * The subdomain check compares against `.example.com` rather than doing a
 * suffix test on `example.com`, because the naive suffix test lets
 * `evil-example.com` through - the single most common way domain allowlists are
 * defeated.
 */
function domainInScope(entry: string, resource: string): boolean {
  const host = hostOf(resource);
  const pattern = hostOf(entry.startsWith('*.') ? entry.slice(2) : entry);
  if (!host || !pattern) return false;
  if (entry.startsWith('*.')) return host.endsWith(`.${pattern}`);
  return host === pattern;
}

// ------------------------------------------------------- repos, apps, opaque

/**
 * Exact match, or a prefix when the entry ends in `*`. Implicit prefixes are
 * not supported: `acme/repo` must not silently cover `acme/repo-secrets`.
 */
function prefixInScope(entry: string, resource: string): boolean {
  if (entry.endsWith(ANY)) return resource.startsWith(entry.slice(0, -1));
  return entry === resource;
}

/** Best-effort kind inference for callers that only have a resource string. */
export function inferResourceKind(capability: string, resource: string): ResourceKind {
  if (resource.startsWith('/') || resource.startsWith('~') || resource.startsWith('.')) return 'path';
  if (/^(browser|web|http)/.test(capability)) return 'domain';
  if (/^(github|gitlab|repository)/.test(capability)) return 'repo';
  if (/^(desktop|app)/.test(capability)) return 'app';
  return 'opaque';
}
