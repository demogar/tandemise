/**
 * The daemon API version (MVP.md §7.2 - "use an explicit API version from the
 * beginning"). The desktop sends it on every request; the daemon refuses a
 * mismatch rather than guessing, so a partially-updated install fails loudly
 * instead of corrupting state.
 */
export const API_VERSION = 'v1' as const;
export const API_PREFIX = `/${API_VERSION}` as const;

/** Header carrying the per-installation bearer token (MVP.md §7.2). */
export const AUTH_HEADER = 'authorization';
export const API_VERSION_HEADER = 'x-tandemise-api-version';
