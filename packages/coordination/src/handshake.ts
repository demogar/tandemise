import type { Handshake } from '@tandemise/api-contract/relay';
import { hashSecret, safeEqualHex } from './secrets.js';

export interface HandshakeAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

/**
 * The synchronous answers some webhook sources need before they send anything
 * (spec §The webhook mailbox, "Handshakes"). The list is fixed: adding one is a
 * code change here with a check, never configuration. Returns null when the
 * request is not a handshake, so it is stored like any other.
 */
export function handshakeResponse(
  endpoint: { readonly handshake: Handshake; readonly handshakeSecret: string | null },
  req: { readonly method: string; readonly query: URLSearchParams; readonly contentType: string | null; readonly body: Buffer },
): HandshakeAnswer | null {
  if (endpoint.handshake === 'meta_hub') {
    if (req.method !== 'GET' || req.query.get('hub.mode') !== 'subscribe') return null;
    const token = req.query.get('hub.verify_token') ?? '';
    const secret = endpoint.handshakeSecret ?? '';
    if (secret && safeEqualHex(hashSecret(token), hashSecret(secret))) {
      return { status: 200, contentType: 'text/plain; charset=utf-8', body: req.query.get('hub.challenge') ?? '' };
    }
    return { status: 403, contentType: 'text/plain; charset=utf-8', body: '' };
  }
  if (endpoint.handshake === 'echo_challenge') {
    if (req.method === 'GET' || req.body.length === 0 || req.body.length > 65_536) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body.toString('utf8'));
    } catch {
      return null;
    }
    const o = parsed as { type?: unknown; challenge?: unknown } | null;
    if (o && typeof o === 'object' && o.type === 'url_verification' && typeof o.challenge === 'string') {
      return { status: 200, contentType: 'text/plain; charset=utf-8', body: o.challenge };
    }
    return null;
  }
  return null;
}
