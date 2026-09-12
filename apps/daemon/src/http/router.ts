import type { IncomingMessage, ServerResponse } from 'node:http';
import { TandemiseError, errorMessage, isTandemiseError, type Logger } from '@tandemise/shared';
import { API_PREFIX, API_VERSION, API_VERSION_HEADER, HTTP_STATUS_BY_CODE, type ApiErrorBody } from '@tandemise/api-contract';
import { z } from 'zod';

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
  body<T>(schema: z.ZodType<T>): Promise<T>;
}

export type Handler = (ctx: RequestContext) => Promise<unknown> | unknown;
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface Route {
  readonly method: Method;
  readonly segments: readonly string[];
  readonly handler: Handler;
  readonly pattern: string;
}

/** Marks a response as already-written (used for file/blob streaming). */
export const HANDLED = Symbol('handled');

export class Router {
  readonly #routes: Route[] = [];

  get(p: string, h: Handler): this { return this.#add('GET', p, h); }
  post(p: string, h: Handler): this { return this.#add('POST', p, h); }
  patch(p: string, h: Handler): this { return this.#add('PATCH', p, h); }
  put(p: string, h: Handler): this { return this.#add('PUT', p, h); }
  delete(p: string, h: Handler): this { return this.#add('DELETE', p, h); }

  #add(method: Method, pattern: string, handler: Handler): this {
    this.#routes.push({ method, pattern, handler, segments: pattern.split('/').filter(Boolean) });
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

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw TandemiseError.validation(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
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
): RequestContext {
  let cached: unknown;
  let read = false;
  return {
    params, query, log, raw: req,
    async body<T>(schema: z.ZodType<T>): Promise<T> {
      if (!read) { cached = await readJsonBody(req); read = true; }
      const parsed = schema.safeParse(cached ?? {});
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
    log.error('http.error', { code: e.code, message: e.message, stack: e.stack });
  } else {
    log.debug('http.rejected', { code: e.code, message: e.message });
  }
  const body: ApiErrorBody = { error: e.toJSON() };
  sendJson(res, status, body);
}

export { API_PREFIX };
