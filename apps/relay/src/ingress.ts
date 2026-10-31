import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createEndpointRequest, importRequest, mailboxAckRequest, mailboxPullRequest,
} from '@tandemise/api-contract/relay';
import {
  MAX_BODY_BYTES, filterWebhookHeaders, handshakeResponse, importLines, parkedMessages, type CoordinationStore,
} from '@tandemise/coordination';
import { RelayError, readBody } from './http.js';
import type { Log } from './log.js';
import type { TokenBuckets } from './rate-limit.js';
import { route, type Route, type RouteContext } from './routes.js';
import type { RelayStreamHub } from './stream.js';

/** One body for both: an unknown slug and a disabled one must be indistinguishable. */
const NOT_FOUND = 'Not found';

function answer(res: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body), 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
  res.end(body);
}

/**
 * `POST|PUT|GET /hooks/:slug` (spec §The webhook mailbox). Unauthenticated: a
 * webhook source can't hold a device token. The relay stores the request as
 * received and never parses or runs it; a local runner verifies the
 * signature. Logs carry the endpoint id, a size and a status, never a body or
 * a header.
 */
export function ingressHandler(d: { store: CoordinationStore; hub: RelayStreamHub; buckets: TokenBuckets; log: Log }) {
  return async (req: IncomingMessage, res: ServerResponse, slug: string): Promise<void> => {
    const method = req.method ?? 'GET';
    if (method !== 'POST' && method !== 'PUT' && method !== 'GET') return answer(res, 404, NOT_FOUND);
    const endpoint = d.store.endpointBySlug(slug);
    if (endpoint === null) {
      req.resume();
      return answer(res, 404, NOT_FOUND);
    }
    let body: Buffer;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (e) {
      if (e instanceof RelayError && e.status === 413) {
        d.log('info', 'hook.rejected', { endpointId: endpoint.id, status: 413 });
        res.setHeader('connection', 'close');
        return answer(res, 413, 'Too large');
      }
      throw e;
    }
    const url = new URL(req.url ?? '/', 'http://relay.invalid');
    const contentType = (req.headers['content-type'] as string | undefined) ?? null;
    const hs = handshakeResponse({ handshake: endpoint.handshake, handshakeSecret: endpoint.handshake_secret }, { method, query: url.searchParams, contentType, body });
    if (hs !== null) {
      d.log('info', 'hook.handshake', { endpointId: endpoint.id, status: hs.status });
      return answer(res, hs.status, hs.body, hs.contentType);
    }
    if (method === 'GET') return answer(res, 405, 'Method not allowed');
    if (!d.buckets.take(endpoint.id)) {
      d.log('info', 'hook.rejected', { endpointId: endpoint.id, bytes: body.length, status: 429 });
      return answer(res, 429, 'Too many requests');
    }
    d.store.storeRequest(endpoint.id, {
      method, query: url.searchParams.toString(), headers: filterWebhookHeaders(req.headers), contentType, body,
    });
    d.log('info', 'hook.stored', { endpointId: endpoint.id, bytes: body.length, status: 202 });
    answer(res, 202, '');
    d.hub.mailboxHint(endpoint.project_key, d.store.pendingCount(endpoint.project_key));
  };
}

const principalOf = (ctx: RouteContext) => {
  if (ctx.principal === null) throw new RelayError(401, 'PERMISSION_DENIED', 'This computer is not on the team.');
  return ctx.principal;
};

/** Endpoints (admin), pull and ack (any device), parked messages (admin) and the one-shot import (admin). */
export function mailboxRoutes(d: { store: CoordinationStore; hub: RelayStreamHub }): Route[] {
  const { store, hub } = d;
  return [
    route('POST', '/relay/v1/endpoints', 'admin', async (ctx) => {
      const p = principalOf(ctx);
      const body = await ctx.body(createEndpointRequest);
      if (body.handshake === 'meta_hub' && !body.handshakeSecret) throw new RelayError(400, 'VALIDATION', 'A Meta endpoint needs a verify token.');
      return { status: 200, body: store.createEndpoint({ ...body, createdBy: p.memberId }) };
    }),
    route('GET', '/relay/v1/endpoints', 'admin', () => ({ status: 200, body: store.endpoints() })),
    route('POST', '/relay/v1/endpoints/:id/disable', 'admin', (ctx) => {
      if (store.endpoint(ctx.params['id']!) === null) throw new RelayError(404, 'NOT_FOUND', 'That webhook address does not exist.');
      store.disableEndpoint(ctx.params['id']!);
      hub.broadcastMembers();
      return { status: 204 };
    }),
    route('POST', '/relay/v1/mailbox/pull', 'device', async (ctx) => {
      const p = principalOf(ctx);
      const body = await ctx.body(mailboxPullRequest);
      return { status: 200, body: store.pull(body.project, p.device.id, body.max, body.leaseSeconds) };
    }),
    route('POST', '/relay/v1/mailbox/ack', 'device', async (ctx) => {
      const p = principalOf(ctx);
      const body = await ctx.body(mailboxAckRequest);
      return { status: 200, body: store.ack(body.ids, p.device.id) };
    }),
    route('GET', '/relay/v1/mailbox/parked', 'admin', () => ({ status: 200, body: parkedMessages(store) })),
    route('POST', '/relay/v1/mailbox/:id/retry', 'admin', (ctx) => {
      store.retryParked(ctx.params['id']!);
      return { status: 204 };
    }),
    route('POST', '/relay/v1/mailbox/:id/drop', 'admin', (ctx) => {
      store.dropParked(ctx.params['id']!);
      return { status: 204 };
    }),
    route('POST', '/relay/v1/import', 'admin', async (ctx) => {
      const p = principalOf(ctx);
      const { lines } = await ctx.body(importRequest);
      const report = importLines(store, lines, 'empty', { memberId: p.memberId, deviceId: p.device.id });
      for (const c of store.activeClaims()) hub.broadcastClaim(c);
      hub.broadcastMembers();
      return { status: 200, body: report };
    }),
  ];
}
