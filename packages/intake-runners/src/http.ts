import { timingSafeEqual } from 'node:crypto';
import type { ClosureResult } from '@tandemise/domain';
import { TandemiseError, errorMessage } from '@tandemise/shared';

const DEFAULT_TIMEOUT_MS = 30_000;

/** Plan Task 11: what a source answering 401 says, in the source's name. */
export function tokenRefused(label: string): string {
  return `${label} refused the token. Save a new one in Settings → Intake.`;
}

/** The sentence for a source whose secret was never saved on this machine. */
export function secretMissing(label: string, what: string): string {
  return `Save the ${label} ${what} for this source in Settings → Intake first.`;
}

export interface SourceHttpOptions {
  /** The source's name in sentences ("Sentry", "PostHog"). */
  readonly label: string;
  /** The API's base URL: the source's `api` override, or the vendor's own. */
  readonly base: string;
  /** Sent on every request, as a bearer unless `scheme` says otherwise. */
  readonly token: string;
  /** The `Authorization` scheme: `Bearer` (default), or `Bot` for Discord (plan Task 12). */
  readonly scheme?: 'Bearer' | 'Bot';
  /** The runner's stop signal: a stopped runner abandons its requests. */
  readonly signal?: AbortSignal;
  /** Per request; 30 s unless set. */
  readonly timeoutMs?: number;
  /** For tests only; the global `fetch` otherwise. */
  readonly fetch?: typeof fetch;
}

type Query = Readonly<Record<string, string | undefined>>;

/**
 * JSON over Node's built-in `fetch` for the shipped runners (plan Task 11):
 * a bearer token on every request, a 30 s timeout, and failures as
 * `TandemiseError`s in plain words. A 401 is the token, and the person can fix
 * that in Settings → Intake; a 404 is `NOT_FOUND`; a 429 or 5xx is retryable.
 * The answer is returned unparsed (`unknown`): each runner reads only the
 * fields it maps, and anything it can't read is left out, never trusted.
 */
export class SourceHttp {
  readonly base: string;
  readonly #options: SourceHttpOptions;

  constructor(options: SourceHttpOptions) {
    this.base = options.base.replace(/\/+$/, '');
    this.#options = options;
  }

  async getJson(path: string, query: Query = {}): Promise<unknown> {
    return (await this.#request('GET', path, query, undefined)).body;
  }

  /**
   * One page of a list, and the cursor of the next one when the answer's
   * `Link` header names one with results (Sentry's pagination, Ruling 25).
   */
  async getPage(path: string, query: Query = {}): Promise<{ readonly body: unknown; readonly next: string | undefined }> {
    const { body, link } = await this.#request('GET', path, query, undefined);
    return { body, next: nextCursor(link) };
  }

  /** An undefined body sends none (Discord's reaction PUT). */
  async sendJson(method: 'POST' | 'PUT' | 'PATCH', path: string, body: unknown): Promise<unknown> {
    return (await this.#request(method, path, {}, body === undefined ? undefined : JSON.stringify(body))).body;
  }

  async #request(method: string, path: string, query: Query, body: string | undefined): Promise<{ body: unknown; link: string | null }> {
    const { label } = this.#options;
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Authorization: `${this.#options.scheme ?? 'Bearer'} ${this.#options.token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const timeoutMs = this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = this.#options.signal === undefined ? timeout : AbortSignal.any([timeout, this.#options.signal]);

    let res: Response;
    try {
      res = await (this.#options.fetch ?? fetch)(url, { method, headers, body, signal });
    } catch (e) {
      const timedOut = timeout.aborted;
      throw new TandemiseError(
        'INTEGRATION_FAILED',
        timedOut ? `${label} did not answer within ${Math.round(timeoutMs / 1000)} s.` : `Tandemise could not reach ${label} at ${this.base}.`,
        { retryable: true, cause: e, details: { method, path } },
      );
    }
    const text = await res.text().catch(() => '');
    if (res.status === 401) {
      throw new TandemiseError('INTEGRATION_FAILED', tokenRefused(label), { retryable: false, details: { method, path, status: 401 } });
    }
    if (res.status === 404) {
      throw new TandemiseError('NOT_FOUND', `${label} has nothing at ${path}.`, { details: { method, path, status: 404 } });
    }
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new TandemiseError('INTEGRATION_FAILED', `${label} answered ${res.status} to ${method} ${path}.`, {
        retryable, details: { method, path, status: res.status },
      });
    }
    try {
      return { body: text === '' ? null : (JSON.parse(text) as unknown), link: res.headers.get('link') };
    } catch (e) {
      throw new TandemiseError('INTEGRATION_FAILED', `${label} answered ${method} ${path} with something that is not JSON.`, { cause: e });
    }
  }
}

/**
 * The next page's cursor from a `Link` header, Sentry's way:
 * `<…>; rel="next"; results="true"; cursor="0:100:0"`. Undefined when there
 * is no next link, it says `results="false"` (Sentry always sends one), or it
 * names no cursor.
 */
export function nextCursor(link: string | null): string | undefined {
  if (link === null) return undefined;
  for (const part of link.split(/,\s*(?=<)/)) {
    const params = new Map<string, string>();
    for (const m of part.matchAll(/;\s*([a-z]+)="([^"]*)"/gi)) params.set(m[1]!.toLowerCase(), m[2]!);
    if (params.get('rel') !== 'next') continue;
    if (params.get('results') === 'false') return undefined;
    const cursor = params.get('cursor');
    return cursor === undefined || cursor === '' ? undefined : cursor;
  }
  return undefined;
}

// ------------------------------------------------------------------ reading answers

/** A plain object's fields, or an empty record for anything else. */
export function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A non-empty string, else undefined. Numbers are written out (Sentry ids may come as either). */
export function text(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A non-negative whole number from a number or a numeric string (Sentry's `count` is a string). */
export function count(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** An ISO 8601 time the contract accepts, normalised; undefined when it doesn't parse. */
export function isoTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** The contract's limits (`INTAKE_MAX_TEXT`, `INTAKE_MAX_DESCRIPTION`): longer text is cut with `…`, never rejected. */
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 20_000;

export function cut(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** A header by name, whatever its case (the mailbox keeps them as received). */
export function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === wanted) return v;
  return undefined;
}

/** A delivery's body as JSON, or a refusal in the source's words. */
export function parseBody(body: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new TandemiseError('VALIDATION', `This ${label} delivery is not JSON.`);
  }
}

/**
 * A closure that failed, as the closure feed records it: a source that has no
 * such issue, or that is set up wrong, is not tried again; a refused token
 * waits for the person (not retryable either); a network failure, a timeout,
 * a 429 or a 5xx is tried again.
 */
export function closureFailure(e: unknown): ClosureResult {
  const retryable = e instanceof TandemiseError
    ? e.code !== 'NOT_FOUND' && e.code !== 'PRECONDITION_FAILED' && e.retryable
    : true;
  return { ok: false, error: errorMessage(e), retryable };
}

/** Compares in constant time, so a forged signature or secret learns nothing from how long the refusal took. */
export function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
