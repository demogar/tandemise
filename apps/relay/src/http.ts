import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RelayErrorBody, RelayErrorReason } from '@tandemise/api-contract/relay';
import { CoordError } from '@tandemise/coordination';

type ErrorCode = RelayErrorBody['error']['code'];

const STATUS: Readonly<Record<string, number>> = {
  NOT_FOUND: 404, CONFLICT: 409, VALIDATION: 400, PERMISSION_DENIED: 403, PRECONDITION_FAILED: 412, INTERNAL: 500,
};

/** A deliberate refusal, in the daemon's error envelope (`ApiErrorBody`), with the relay's reason in `details.reason`. */
export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'RelayError';
  }

  static reason(status: number, code: ErrorCode, reason: RelayErrorReason | string, message: string, details: Record<string, unknown> = {}): RelayError {
    return new RelayError(status, code, message, { ...details, reason });
  }
}

const REASON_STATUS: Readonly<Record<string, [number, ErrorCode]>> = {
  claim_held: [409, 'CONFLICT'],
  relay_not_empty: [409, 'CONFLICT'],
  take_over_refused: [403, 'PERMISSION_DENIED'],
  not_holder: [403, 'PERMISSION_DENIED'],
  admin_only: [403, 'PERMISSION_DENIED'],
  lease_not_held: [403, 'PERMISSION_DENIED'],
  invite_invalid: [400, 'VALIDATION'],
  import_invalid: [400, 'VALIDATION'],
  last_admin: [409, 'CONFLICT'],
  invite_used: [400, 'VALIDATION'],
  invite_expired: [400, 'VALIDATION'],
  device_revoked: [401, 'PERMISSION_DENIED'],
  version_mismatch: [412, 'PRECONDITION_FAILED'],
};

export function fromCoordError(e: CoordError): RelayError {
  const [status, code] = REASON_STATUS[e.reason] ?? [400, 'VALIDATION'];
  return new RelayError(status, code, e.message, { ...e.details, reason: e.reason });
}

/** JSON out, with no CORS headers at all: only daemons talk to a relay, and a browser page can't read it. */
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    ...(body ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function sendError(res: ServerResponse, error: unknown, log: (level: 'error', msg: string, f: Record<string, unknown>) => void): void {
  const e = error instanceof RelayError ? error
    : error instanceof CoordError ? fromCoordError(error)
      : null;
  if (e === null) {
    log('error', 'relay.internal_error', { error: error instanceof Error ? error.message : String(error) });
    sendJson(res, 500, { error: { code: 'INTERNAL', message: 'The relay hit an internal error. It is in the relay log.', details: {}, retryable: true } } satisfies RelayErrorBody);
    return;
  }
  sendJson(res, e.status, { error: { code: e.code, message: e.message, details: e.details, retryable: e.retryable } } satisfies RelayErrorBody);
}

export function statusOf(code: ErrorCode): number {
  return STATUS[code] ?? 400;
}

/** Reads a body with a hard cap; past it, a 413. */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new RelayError(413, 'VALIDATION', `The body is larger than ${maxBytes} bytes.`, { reason: 'too_large' });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  const body = await readBody(req, maxBytes);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new RelayError(400, 'VALIDATION', 'The request body is not valid JSON.');
  }
}

/**
 * The client's address, for rate limits. `X-Forwarded-For` is anyone's to
 * send, so it is read only with `RELAY_TRUST_PROXY=1` (behind the `tls`
 * profile's Caddy, which sets it); otherwise the socket's own address.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || 'unknown';
}
