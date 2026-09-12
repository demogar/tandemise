import type { IncomingMessage, ServerResponse } from 'node:http';
import { API_VERSION_HEADER, AUTH_HEADER } from '@tandemise/api-contract';

/**
 * Cross-origin access for the desktop renderer.
 *
 * The renderer is a browser context, so every call it makes to the daemon is
 * cross-origin: in production it is loaded from `file://` and sends the opaque
 * origin `null`, and in development it is served by Vite from `http://localhost`.
 * Without an explicit grant the browser discards the response before the
 * renderer can read it, which surfaces only as `TypeError: Failed to fetch` -
 * indistinguishable, from the UI, from the daemon being down.
 *
 * The grant is deliberately narrow. It is not `*`: a page on the open web must
 * not be able to read this daemon even for unauthenticated routes like
 * `/v1/health`, which would otherwise leak the fact that Tandemise is running.
 * Only the two origins the desktop can actually be loaded from are allowed -
 * opaque (`file://`) and loopback - and the bearer token is still required on
 * every route regardless (see `HttpServer`).
 */

/** Headers the desktop client sends; anything else is refused at preflight. */
const ALLOWED_REQUEST_HEADERS = [AUTH_HEADER, API_VERSION_HEADER, 'content-type'] as const;

const ALLOWED_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'] as const;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Whether `origin` may read responses from this daemon.
 *
 * `null` is the opaque origin a `file://` document sends - the packaged app.
 * Any loopback http(s) origin is the Vite dev server on whichever port it
 * chose. Everything else, including a real website, is denied.
 */
export function isAllowedOrigin(origin: string): boolean {
  if (origin === 'null') return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Apply the CORS grant for this request, if its origin earns one.
 *
 * Always sets `Vary: Origin` so a cache never serves one origin's grant to
 * another. Safe to call for same-origin requests, which carry no `Origin`.
 */
export function applyCors(req: IncomingMessage, res: ServerResponse): void {
  // Set unconditionally: the response differs by origin even when the answer
  // is "no grant", and a cache that misses that would be a hole.
  res.setHeader('Vary', 'Origin');

  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !isAllowedOrigin(origin)) return;

  res.setHeader('Access-Control-Allow-Origin', origin);

  if (req.method !== 'OPTIONS') return;
  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS.join(', '));
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_REQUEST_HEADERS.join(', '));
  // Without this the browser preflights every single request, doubling the
  // round trips on a UI that polls.
  res.setHeader('Access-Control-Max-Age', '600');
}
