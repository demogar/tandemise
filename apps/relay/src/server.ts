import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HOOKS_PATH_PREFIX, RELAY_BASE_PATH, RELAY_STREAM_PATH } from '@tandemise/api-contract/relay';
import type { CoordinationStore } from '@tandemise/coordination';
import { assertVersion, authenticate, requireAdmin, tooMany } from './auth.js';
import { RelayError, clientIp, sendError, sendJson } from './http.js';
import type { Log } from './log.js';
import type { FailedAuthLimiter } from './rate-limit.js';
import { HANDLED, matchRoute, parseBody, type Route } from './routes.js';
import type { RelayStreamHub } from './stream.js';

export interface RelayServerDeps {
  readonly store: CoordinationStore;
  readonly hub: RelayStreamHub;
  readonly limiter: FailedAuthLimiter;
  readonly routes: readonly Route[];
  /** `POST|PUT|GET /hooks/:slug`, unauthenticated (ingress.ts). */
  readonly ingress: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, slug: string) => Promise<void>;
  readonly log: Log;
  readonly trustProxy: boolean;
}

/**
 * The relay's HTTP surface, on `node:http` only: a dozen routes under
 * `/relay/v1`, the stream upgrade, and the webhook ingress. No CORS headers,
 * ever: only daemons talk to a relay.
 */
export function createRelayServer(d: RelayServerDeps): Server {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://relay.invalid');
      const ip = clientIp(req, d.trustProxy);
      try {
        if (url.pathname.startsWith(HOOKS_PATH_PREFIX)) {
          const slug = url.pathname.slice(HOOKS_PATH_PREFIX.length);
          if (!slug || slug.includes('/')) throw new RelayError(404, 'NOT_FOUND', 'Not found');
          await d.ingress(req, res, slug);
          return;
        }
        if (!url.pathname.startsWith(`${RELAY_BASE_PATH}/`)) throw new RelayError(404, 'NOT_FOUND', 'Not found');
        const matched = matchRoute(d.routes, req.method ?? 'GET', url.pathname);
        if (matched === null) throw new RelayError(404, 'NOT_FOUND', 'Not found');
        const { route, params } = matched;
        // Health proves liveness and nothing else; every other route speaks a version.
        if (route.auth !== 'none' || url.pathname !== `${RELAY_BASE_PATH}/health`) assertVersion(req);
        let principal = null;
        if (route.auth !== 'none') {
          principal = authenticate(req, d.store, d.limiter, ip);
          if (route.auth === 'admin') requireAdmin(principal);
        } else if (d.limiter.locked(ip) && url.pathname !== `${RELAY_BASE_PATH}/health`) {
          throw tooMany();
        }
        const answer = await route.handler({
          req, res, params, query: url.searchParams, ip, principal,
          body: (schema) => parseBody(req, schema, route.maxBytes),
        });
        if (answer === HANDLED) return;
        sendJson(res, answer.status, answer.status === 204 ? undefined : answer.body);
      } catch (e) {
        if (!res.headersSent) sendError(res, e, (level, msg, f) => d.log(level, msg, f));
        else res.destroy();
      }
    })();
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://relay.invalid');
    if (url.pathname !== RELAY_STREAM_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    d.hub.handleUpgrade(req, socket, head);
  });
  server.on('clientError', (_e, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  return server;
}

export function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}
