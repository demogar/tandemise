import { TandemiseError } from '@tandemise/shared';
import { RateGate, retryAfterMs } from '@tandemise/integrations-core';
import type { z } from 'zod';

/** Plan Task 4: a 401 or 403 means the token, and the person can fix that. */
export const YOUTRACK_TOKEN_REFUSED =
  "YouTrack refused the token. Make a new permanent token and save it in the project's tracker settings.";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface YouTrackClientOptions {
  /** The instance's base URL, e.g. `https://acme.youtrack.cloud`; the REST API is under `/api`. */
  readonly url: string;
  /** A permanent token (`perm:…`) from the local secret store. */
  readonly token: string;
  /** Per request; 30 s unless set. */
  readonly timeoutMs?: number;
  /** For tests only; the global `fetch` otherwise. */
  readonly fetch?: typeof fetch;
  /** For tests only; `Date.now` otherwise. The clock `Retry-After` waits are measured on. */
  readonly now?: () => number;
}

/** A 429 without `Retry-After` waits this long (Ruling 26). */
const DEFAULT_RATE_WAIT_MS = 60_000;

type Query = Readonly<Record<string, string | number | undefined>>;

/**
 * YouTrack's REST API over Node's built-in `fetch` (spec §6: REST, not the MCP
 * server, so the adapter is deterministic and testable against a fake HTTP
 * server). Every request sends the token as a bearer and asks for JSON, and
 * gives up after the timeout. Failures become `TandemiseError`s the UI can show
 * as they are.
 */
export class YouTrackClient {
  readonly base: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  /** YouTrack's "slow down" (a 429), honoured by every request of this client (Ruling 26). */
  readonly #gate: RateGate;

  constructor(options: YouTrackClientOptions) {
    this.base = options.url.replace(/\/+$/, '');
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#gate = new RateGate('YouTrack', this.#now);
  }

  get<T>(path: string, query: Query, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    return this.#request('GET', path, query, undefined, schema);
  }

  post<T>(path: string, query: Query, body: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    return this.#request('POST', path, query, JSON.stringify(body), schema);
  }

  /** Multipart, for attachments: `fetch` sets the boundary itself. */
  postForm<T>(path: string, query: Query, form: FormData, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    return this.#request('POST', path, query, form, schema);
  }

  async #request<T>(
    method: 'GET' | 'POST',
    path: string,
    query: Query,
    body: string | FormData | undefined,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#token}`, Accept: 'application/json' };
    if (typeof body === 'string') headers['Content-Type'] = 'application/json';

    // Still inside a wait YouTrack asked for: refused here, not sent.
    this.#gate.check();
    let res: Response;
    try {
      res = await this.#fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new TandemiseError(
        'INTEGRATION_FAILED',
        timedOut
          ? `YouTrack at ${this.base} did not answer within ${Math.round(this.#timeoutMs / 1000)} s.`
          : `Tandemise could not reach YouTrack at ${this.base}.`,
        { retryable: true, cause: e, details: { method, path } },
      );
    }

    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new TandemiseError('INTEGRATION_FAILED', YOUTRACK_TOKEN_REFUSED, { retryable: false, details: { method, path, status: res.status } });
    }
    if (res.status === 429) {
      const wait = retryAfterMs(res.headers.get('retry-after'), this.#now()) ?? DEFAULT_RATE_WAIT_MS;
      throw this.#gate.wait(wait);
    }
    if (res.status === 404) {
      throw new TandemiseError('NOT_FOUND', `YouTrack has nothing at ${path}.`, { details: { method, path, status: 404 } });
    }
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new TandemiseError(
        'INTEGRATION_FAILED',
        `YouTrack answered ${res.status} to ${method} ${path}${describeError(text)}`,
        { retryable, details: { method, path, status: res.status } },
      );
    }
    let json: unknown;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch (e) {
      throw new TandemiseError('INTEGRATION_FAILED', `YouTrack answered ${method} ${path} with something that is not JSON.`, { cause: e });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new TandemiseError('INTEGRATION_FAILED', `YouTrack answered ${method} ${path} in a shape Tandemise does not know.`, {
        details: { issues: parsed.error.issues.slice(0, 5) },
      });
    }
    return parsed.data;
  }
}

/** YouTrack's own words for a refusal, when it gave any. */
function describeError(text: string): string {
  try {
    const body = JSON.parse(text) as { error_description?: unknown; error?: unknown };
    const said = typeof body.error_description === 'string' ? body.error_description : typeof body.error === 'string' ? body.error : '';
    return said === '' ? '.' : `: ${said.replace(/\.$/, '')}.`;
  } catch {
    return '.';
  }
}
