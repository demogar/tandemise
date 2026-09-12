import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { TandemiseError, type Logger } from '@tandemise/shared';
import { API_VERSION, API_VERSION_HEADER, AUTH_HEADER, STREAM_PATH } from '@tandemise/api-contract';
import { HANDLED, Router, makeContext, sendError, sendJson } from './router.js';
import { verifyBearer } from './identity.js';

export interface HttpServerOptions {
  readonly token: string;
  readonly router: Router;
  readonly log: Logger;
  /** Invoked for an authenticated upgrade request on the stream path. */
  readonly onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** 0 lets the OS pick, which is what MVP.md §7.2 asks for. */
  readonly port?: number;
}

/**
 * The daemon's HTTP surface.
 *
 * Three security properties are enforced here and nowhere else, so they are
 * worth stating plainly (MVP.md §7.2):
 *
 *  1. **Loopback only.** The listener binds 127.0.0.1. There is no configuration
 *     that binds 0.0.0.0 - if remote access is ever wanted, it should arrive as
 *     an authenticated tunnel, not as a flag someone can flip by accident.
 *  2. **Every request is authenticated**, including the WebSocket upgrade. The
 *     only exception is `GET /v1/health`, which returns no data and exists so the
 *     desktop can tell "daemon starting" from "daemon wedged".
 *  3. **API version is explicit.** A client sending a different version is
 *     refused rather than served a shape it may not understand.
 */
export class HttpServer {
  readonly #server: Server;
  readonly #opts: HttpServerOptions;
  #url: string | null = null;

  constructor(opts: HttpServerOptions) {
    this.#opts = opts;
    this.#server = createServer((req, res) => void this.#handle(req, res));
    this.#server.on('upgrade', (req, socket, head) => this.#handleUpgrade(req, socket, head));
    this.#server.on('clientError', (_err, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    // Keep sockets from lingering after a desktop crash.
    this.#server.keepAliveTimeout = 30_000;
    this.#server.headersTimeout = 35_000;
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#opts.port ?? 0, '127.0.0.1', () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
    const addr = this.#server.address() as AddressInfo;
    this.#url = `http://127.0.0.1:${addr.port}`;
    this.#opts.log.info('daemon.listening', { url: this.#url });
    return this.#url;
  }

  get url(): string {
    if (!this.#url) throw new TandemiseError('INTERNAL', 'Server is not listening yet.');
    return this.#url;
  }

  get httpServer(): Server {
    return this.#server;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    this.#server.closeAllConnections?.();
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const log = this.#opts.log.child({ method: req.method, path: url.pathname });

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }

      // Health is the one unauthenticated route: it proves liveness and nothing
      // more, so the desktop can distinguish "starting" from "wrong token".
      if (url.pathname === '/v1/health') {
        sendJson(res, 200, { ok: true, apiVersion: API_VERSION });
        return;
      }

      if (!verifyBearer(req.headers[AUTH_HEADER] as string | undefined, this.#opts.token)) {
        log.warn('daemon.unauthenticated_request');
        sendError(res, TandemiseError.permissionDenied('Missing or invalid daemon token.'), log);
        return;
      }

      const clientVersion = req.headers[API_VERSION_HEADER];
      if (typeof clientVersion === 'string' && clientVersion !== API_VERSION) {
        sendError(res, new TandemiseError('PRECONDITION_FAILED',
          `Client speaks API ${clientVersion}; this daemon speaks ${API_VERSION}. Restart Tandemise to update.`), log);
        return;
      }

      const matched = this.#opts.router.match(req.method ?? 'GET', url.pathname);
      if (!matched) {
        sendError(res, TandemiseError.notFound('Route', `${req.method} ${url.pathname}`), log);
        return;
      }

      const ctx = makeContext(req, matched.params, url.searchParams, log);
      const result = await matched.route.handler(ctx);
      if (result === HANDLED) return;
      sendJson(res, result === undefined ? 204 : 200, result);
    } catch (e) {
      sendError(res, e, log);
    } finally {
      log.debug('http.request', { ms: Date.now() - started, status: res.statusCode });
    }
  }

  #handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // Browsers cannot set headers on a WebSocket handshake, so the token may
    // also arrive as a query parameter. Both paths are constant-time compared,
    // and the socket is loopback-only either way.
    const headerToken = req.headers[AUTH_HEADER] as string | undefined;
    const queryToken = url.searchParams.get('token') ?? undefined;
    const authorized =
      verifyBearer(headerToken, this.#opts.token) || verifyBearer(queryToken, this.#opts.token);

    if (url.pathname !== STREAM_PATH || !authorized) {
      this.#opts.log.warn('daemon.rejected_upgrade', { path: url.pathname, authorized });
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.#opts.onUpgrade(req, socket, head);
  }
}
