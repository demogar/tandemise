import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import {
  RELAY_API_VERSION, claimRequest, createInviteRequest, redeemInviteRequest, releaseClaimRequest, takeOverRequest,
  type ClaimView, type RelaySnapshot,
} from '@tandemise/api-contract/relay';
import { CoordError, claimForViewer, heldBy, type CoordinationStore } from '@tandemise/coordination';
import type { Principal } from './auth.js';
import { RelayError, readJson } from './http.js';
import type { RelayStreamHub } from './stream.js';

export type Auth = 'none' | 'device' | 'admin';

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly ip: string;
  /** Null only on `auth: 'none'` routes. */
  readonly principal: Principal | null;
  body<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T>;
}

/** What a handler answers: a status and a JSON body, or `HANDLED` when it wrote the response itself. */
export type Answer = { readonly status: number; readonly body?: unknown } | typeof HANDLED;
export const HANDLED = Symbol('handled');

export interface Route {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly segments: readonly string[];
  readonly auth: Auth;
  readonly handler: (ctx: RouteContext) => Answer | Promise<Answer>;
  /** The JSON body cap; 1 MiB unless the route says otherwise (import). */
  readonly maxBytes?: number;
}

export interface RouteDeps {
  readonly store: CoordinationStore;
  readonly hub: RelayStreamHub;
  readonly staleAfterMs: number;
  /** Present only with `RELAY_TEST_CLOCK=1`. */
  readonly advanceClock: ((ms: number) => void) | null;
  readonly onFailedRedeem: (ip: string) => void;
  readonly redeemLocked: (ip: string) => boolean;
}

export function route(method: Route['method'], pattern: string, auth: Auth, handler: Route['handler'], opts: { maxBytes?: number } = {}): Route {
  return { method, segments: pattern.split('/').filter(Boolean), auth, handler, ...(opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }) };
}

export function matchRoute(routes: readonly Route[], method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  const parts = pathname.split('/').filter(Boolean);
  let pathMatched = false;
  for (const r of routes) {
    if (r.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const seg = r.segments[i]!;
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]!);
      else if (seg !== parts[i]) { ok = false; break; }
    }
    if (!ok) continue;
    pathMatched = true;
    if (r.method === method) return { route: r, params };
  }
  if (pathMatched) throw new RelayError(405, 'VALIDATION', `${method} is not allowed here.`);
  return null;
}

export async function parseBody<T>(req: IncomingMessage, schema: z.ZodType<T, z.ZodTypeDef, unknown>, maxBytes?: number): Promise<T> {
  const raw = await readJson(req, maxBytes);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new RelayError(400, 'VALIDATION', parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '));
  }
  return parsed.data;
}

const me = (ctx: RouteContext): Principal => {
  if (ctx.principal === null) throw new RelayError(401, 'PERMISSION_DENIED', 'This computer is not on the team.');
  return ctx.principal;
};

/** The core routes (spec §Protocol): joining, the snapshot, claims, membership. The mailbox's are in ingress.ts. */
export function coreRoutes(d: RouteDeps): Route[] {
  const { store, hub } = d;
  const view = (c: ClaimView, p: Principal) => claimForViewer(c, p.memberId);
  return [
    route('GET', '/relay/v1/health', 'none', () => ({ status: 200, body: { ok: true, apiVersion: RELAY_API_VERSION } })),

    route('POST', '/relay/v1/invites/redeem', 'none', async (ctx) => {
      const body = await ctx.body(redeemInviteRequest);
      try {
        const joined = store.redeemInvite(body);
        hub.broadcastMembers();
        return { status: 200, body: joined };
      } catch (e) {
        if (e instanceof CoordError) d.onFailedRedeem(ctx.ip);
        throw e;
      }
    }),

    route('GET', '/relay/v1/snapshot', 'device', (ctx) => {
      const p = me(ctx);
      const projects = ctx.query.get('projects');
      const keys = projects ? projects.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const team = store.team()!;
      const snapshot: RelaySnapshot = {
        seq: store.seq(),
        team,
        you: { memberId: p.memberId, deviceId: p.device.id, role: p.role },
        members: store.members(),
        devices: p.role === 'admin' ? store.devices() : store.devices(p.memberId),
        presence: store.presence(),
        claims: store.activeClaims(keys).map((c) => view(c, p)),
        endpoints: p.role === 'admin' ? store.endpoints(keys) : [],
        serverTime: store.now(),
        staleAfterMs: d.staleAfterMs,
      };
      return { status: 200, body: snapshot };
    }),

    route('POST', '/relay/v1/claims', 'device', async (ctx) => {
      const p = me(ctx);
      const body = await ctx.body(claimRequest);
      const out = store.claim({ ...body, memberId: p.memberId, deviceId: p.device.id });
      if (out.kind === 'claimed') {
        if (out.claim.seq === store.seq()) hub.broadcastClaim(out.claim);
        return { status: 201, body: view(out.claim, p) };
      }
      const held = heldBy(store, out.claim, out.self, { memberId: p.memberId, role: p.role }, d.staleAfterMs);
      if (held.kind !== 'held_by') throw new Error('unreachable');
      throw RelayError.reason(409, 'CONFLICT', 'claim_held', held.sentence, { claim: view(out.claim, p), self: out.self, takeOver: held.mayTakeOver });
    }),

    route('POST', '/relay/v1/claims/:id/release', 'device', async (ctx) => {
      const p = me(ctx);
      const { reason } = await ctx.body(releaseClaimRequest);
      const before = store.claimById(ctx.params['id']!);
      const ended = store.release(ctx.params['id']!, reason, { memberId: p.memberId, role: p.role });
      if (before?.state === 'active') hub.broadcastClaim(ended);
      return { status: 200, body: view(ended, p) };
    }),

    route('POST', '/relay/v1/claims/:id/take-over', 'device', async (ctx) => {
      const p = me(ctx);
      const { localRef } = await ctx.body(takeOverRequest);
      const claim = store.takeOver(ctx.params['id']!, { memberId: p.memberId, deviceId: p.device.id, role: p.role, localRef: localRef ?? '' }, d.staleAfterMs);
      const old = store.claimById(ctx.params['id']!);
      if (old) hub.broadcastClaim(old);
      hub.broadcastClaim(claim);
      return { status: 200, body: view(claim, p) };
    }),

    route('GET', '/relay/v1/claims', 'device', (ctx) => {
      const p = me(ctx);
      const project = ctx.query.get('project');
      const item = ctx.query.get('item');
      if (!project || !item) throw new RelayError(400, 'VALIDATION', 'Say which project and item: ?project=&item=.');
      return { status: 200, body: store.claimHistory(project, item).map((c) => view(c, p)) };
    }),

    route('POST', '/relay/v1/invites', 'admin', async (ctx) => {
      const p = me(ctx);
      const body = await ctx.body(createInviteRequest);
      return { status: 200, body: store.createInvite({ ...body, createdBy: p.memberId }) };
    }),

    route('DELETE', '/relay/v1/members/:id', 'admin', (ctx) => {
      const p = me(ctx);
      const id = ctx.params['id']!;
      const devices = store.devices(id);
      const ended = store.removeMember(id, p.memberId);
      for (const dev of devices) hub.closeDevice(dev.id);
      for (const c of ended) hub.broadcastClaim(c);
      hub.broadcastMembers();
      return { status: 204 };
    }),

    route('DELETE', '/relay/v1/devices/:id', 'admin', (ctx) => {
      store.revokeDevice(ctx.params['id']!);
      hub.closeDevice(ctx.params['id']!);
      hub.broadcastMembers();
      return { status: 204 };
    }),

    // Only with RELAY_TEST_CLOCK=1: otherwise the route does not exist (404).
    ...(d.advanceClock === null ? [] : [route('POST', '/relay/v1/test/advance-clock', 'admin', async (ctx) => {
      const body = (await readJson(ctx.req)) as { ms?: unknown };
      const ms = Number(body.ms);
      if (!Number.isFinite(ms) || ms < 0) throw new RelayError(400, 'VALIDATION', 'ms must be a number of milliseconds.');
      d.advanceClock!(ms);
      return { status: 200, body: { now: store.now() } };
    })]),
  ];
}
