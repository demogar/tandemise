import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { TandemiseError, errorMessage, isTandemiseError, redactSecrets, type Logger } from '@tandemise/shared';
import { API_PREFIX, API_VERSION, API_VERSION_HEADER, HTTP_STATUS_BY_CODE, type ApiErrorBody } from '@tandemise/api-contract';
import { z } from 'zod';
import type { Caller } from '@tandemise/application';

/**
 * A small, explicit HTTP router.
 *
 * Express would work, but it brings middleware ordering, a large dependency
 * surface in a process that supervises the user's machine, and `any`-typed
 * handlers. Roughly 150 lines of node:http gives typed handlers, exhaustive
 * error mapping, and nothing to audit.
 */

export interface RequestContext {
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly log: Logger;
  readonly raw: IncomingMessage;
  /** Who the request acts as, resolved from its bearer token. */
  readonly caller: Caller;
  body<T>(schema: z.ZodType<T>): Promise<T>;
}

export type Handler = (ctx: RequestContext) => Promise<unknown> | unknown;
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * Per-route overrides for the body reader. Almost every route wants the
 * global cap and its generic message; the handful that accept a contribution
 * (spec A1) want a larger cap and a message that names the limit a person
 * can act on, rather than a byte count meant for a log.
 */
export interface RouteOptions {
  readonly maxBodyBytes?: number;
  readonly overflowMessage?: string;
}

interface Route {
  readonly method: Method;
  readonly segments: readonly string[];
  readonly handler: Handler;
  readonly pattern: string;
  readonly maxBodyBytes: number;
  readonly overflowMessage?: string;
}

/** Marks a response as already-written (used for file/blob streaming). */
export const HANDLED = Symbol('handled');

export class Router {
  readonly #routes: Route[] = [];

  get(p: string, h: Handler): this { return this.#add('GET', p, h); }
  post(p: string, h: Handler, options?: RouteOptions): this { return this.#add('POST', p, h, options); }
  patch(p: string, h: Handler, options?: RouteOptions): this { return this.#add('PATCH', p, h, options); }
  put(p: string, h: Handler, options?: RouteOptions): this { return this.#add('PUT', p, h, options); }
  delete(p: string, h: Handler): this { return this.#add('DELETE', p, h); }

  #add(method: Method, pattern: string, handler: Handler, options: RouteOptions = {}): this {
    this.#routes.push({
      method, pattern, handler, segments: pattern.split('/').filter(Boolean),
      maxBodyBytes: options.maxBodyBytes ?? MAX_BODY_BYTES,
      overflowMessage: options.overflowMessage,
    });
    return this;
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | undefined {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!;
        const part = parts[i]!;
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(part);
        else if (seg !== part) { ok = false; break; }
      }
      if (ok) return { route, params };
    }
    return undefined;
  }

  routeTable(): readonly string[] {
    return this.#routes.map((r) => `${r.method} ${r.pattern}`).sort();
  }
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * The three routes that accept a contribution's bytes (mission uploads, a
 * feedback attachment, a hand-back) declare this in place of the global cap
 * (spec A1). 32 MiB is the base64 length of a file at the 24 MB decoded cap
 * (`ceil(bytes/3)*4`), so this is the line that actually turns away an
 * oversized upload over HTTP; the message names the limit a person can act
 * on, the same one `ContributionError('too_large', …)` uses when a caller
 * pins bytes directly rather than over HTTP.
 */
export const CONTRIBUTION_BODY: RouteOptions = {
  maxBodyBytes: 32 * 1024 * 1024,
  overflowMessage: 'That file is larger than 24 MB.',
};

export async function readJsonBody(req: IncomingMessage, maxBodyBytes = MAX_BODY_BYTES, overflowMessage?: string): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBodyBytes) {
      throw TandemiseError.validation(overflowMessage ?? `Request body exceeds ${maxBodyBytes} bytes.`);
    }
    chunks.push(buf);
  }
  if (total === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw TandemiseError.validation('Request body is not valid JSON.');
  }
}

export function makeContext(
  req: IncomingMessage,
  params: Record<string, string>,
  query: URLSearchParams,
  log: Logger,
  resolveCaller: () => Caller,
  bodyOptions: RouteOptions = {},
): RequestContext {
  let cached: unknown;
  let read = false;
  let caller: Caller | undefined;
  return {
    params, query, log, raw: req,
    // Resolved on first use, so a route that acts as nobody still answers when
    // the principal cannot be resolved (e.g. the local person was removed).
    get caller(): Caller {
      caller ??= resolveCaller();
      return caller;
    },
    async body<T>(schema: z.ZodType<T>): Promise<T> {
      if (!read) { cached = await readJsonBody(req, bodyOptions.maxBodyBytes, bodyOptions.overflowMessage); read = true; }
      // Only an absent body means "empty object"; an explicit JSON null is a value.
      const parsed = schema.safeParse(cached === undefined ? {} : cached);
      if (!parsed.success) {
        throw TandemiseError.validation(formatZodIssues(parsed.error), { issues: parsed.error.issues });
      }
      return parsed.data;
    },
  };
}

/** One readable line, rather than a nested zod tree the UI has to interpret. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.join('.');
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join('; ');
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    [API_VERSION_HEADER]: API_VERSION,
    // The renderer is the only client and it is same-process; nothing here
    // should ever be embedded or framed.
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

export function sendError(res: ServerResponse, error: unknown, log: Logger): void {
  const e = isTandemiseError(error)
    ? error
    : new TandemiseError('INTERNAL', errorMessage(error), { cause: error });
  const status = HTTP_STATUS_BY_CODE[e.code] ?? 500;

  if (status >= 500) {
    // An unexpected error's message is arbitrary text from somewhere in the
    // process - a failed connect naming a key path, a CLI echoing a token. It
    // is logged (redacted) but never returned: the client gets a correlation id
    // to quote instead. Deliberate 4xx errors are authored by us and carry
    // information the user needs to act on, so they are returned as written.
    const correlationId = randomUUID();
    log.error('http.error', {
      correlationId,
      code: e.code,
      message: redactSecrets(e.message),
      stack: e.stack ? redactSecrets(e.stack) : undefined,
    });
    sendJson(res, status, {
      error: {
        code: e.code,
        message: `An internal error occurred. Quote reference ${correlationId} when reporting it; the details are in the daemon log.`,
        details: { correlationId },
        retryable: e.retryable,
      },
    } satisfies ApiErrorBody);
    return;
  }

  log.debug('http.rejected', { code: e.code, message: redactSecrets(e.message) });
  const json = e.toJSON();
  const body: ApiErrorBody = { error: { ...json, message: redactSecrets(json.message) } };
  sendJson(res, status, body);
}

export { API_PREFIX };
