import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebhookMailboxPort } from '@tandemise/domain';
import type { Logger } from '@tandemise/shared';
import { errorMessage } from '@tandemise/shared';

/** Plan Task 11: a delivery is at most 1 MiB. */
export const WEBHOOK_MAX_BYTES = 1024 * 1024;
/** Past this the socket is cut instead of read to the end for a polite 413. */
const DRAIN_LIMIT_BYTES = 16 * WEBHOOK_MAX_BYTES;
/** The only path served: a source id as the configuration spells it (`INTAKE_SOURCE_ID_PATTERN`). */
const HOOK_PATH = /^\/hooks\/([a-z0-9][a-z0-9-]{0,62})\/?$/;

export interface WebhookListener {
  /** The port it listens on (the one asked for, or the one the OS gave for 0). */
  readonly port: number;
  close(): Promise<void>;
}

/**
 * The opt-in webhook listener (spec §2 "Webhook-only sources", plan Task 11).
 *
 * A separate `node:http` server on `127.0.0.1:<port>`, sharing nothing with
 * the API listener, so the person's own tunnel (cloudflared, ngrok) exposes
 * only this. It serves exactly one thing, `POST /hooks/:sourceId` with a body
 * of at most 1 MiB: it puts the request's headers and exact body bytes in the
 * webhook mailbox and answers `202 {}`. It never parses or verifies the body:
 * the source's runner does that when the host drains the mailbox, with the
 * secret only this machine holds. Anything else is a 404 with no body, and a
 * body over the limit a 413.
 */
export function startWebhookListener(options: {
  readonly port: number;
  readonly mailbox: Pick<WebhookMailboxPort, 'put'>;
  readonly log: Logger;
}): Promise<WebhookListener> {
  const { mailbox, log } = options;
  const server: Server = createServer((req, res) => handle(req, res, mailbox, log));
  // A slow or stalled sender never holds a socket for long.
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      const port = (server.address() as AddressInfo).port;
      log.info('intake.webhook_listener_started', { url: `http://127.0.0.1:${port}/hooks/<source>` });
      resolve({
        port,
        close: () => new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

function handle(req: IncomingMessage, res: ServerResponse, mailbox: Pick<WebhookMailboxPort, 'put'>, log: Logger): void {
  const path = new URL(req.url ?? '/', 'http://listener').pathname;
  const match = HOOK_PATH.exec(path);
  if (req.method !== 'POST' || match === null) {
    req.resume();
    res.writeHead(404, { 'content-length': '0' }).end();
    return;
  }
  const sourceId = match[1]!;
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > DRAIN_LIMIT_BYTES) {
    res.writeHead(413, { 'content-length': '0', connection: 'close' }).end();
    req.destroy();
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > DRAIN_LIMIT_BYTES) { req.destroy(); return; }
    if (size > WEBHOOK_MAX_BYTES) { tooBig = true; chunks.length = 0; return; }
    if (!tooBig) chunks.push(chunk);
  });
  req.on('error', () => { /* the sender went away; nothing was put */ });
  req.on('end', () => {
    if (tooBig) {
      // Read to the end before answering, so the sender sees the 413 rather than a reset.
      res.writeHead(413, { 'content-length': '0', connection: 'close' }).end();
      return;
    }
    try {
      mailbox.put({ sourceId, headers: flatHeaders(req), body: new Uint8Array(Buffer.concat(chunks)) });
    } catch (e) {
      log.error('intake.webhook_put_failed', { sourceId, error: errorMessage(e) });
      res.writeHead(500, { 'content-length': '0' }).end();
      return;
    }
    const body = '{}';
    res.writeHead(202, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }).end(body);
  });
}

/** Header names lowercased, repeats joined as HTTP joins them, so a runner reads them by name. */
function flatHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}
