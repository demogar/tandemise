import type { IncomingMessage } from 'node:http';
import { RELAY_API_HEADER, RELAY_API_VERSION, RELAY_SUPPORTED_API_VERSIONS, type RelayRole } from '@tandemise/api-contract/relay';
import type { CoordinationStore, DeviceAuth } from '@tandemise/coordination';
import { RelayError } from './http.js';
import type { FailedAuthLimiter } from './rate-limit.js';

export interface Principal {
  readonly device: DeviceAuth;
  readonly role: RelayRole;
  readonly memberId: string;
}

/** Refuses a request whose `X-Tandemise-Relay-Api` this relay doesn't speak, in the daemon's wording style. */
export function assertVersion(req: IncomingMessage): void {
  const raw = req.headers[RELAY_API_HEADER];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v !== undefined && (RELAY_SUPPORTED_API_VERSIONS as readonly string[]).includes(v)) return;
  throw RelayError.reason(412, 'PRECONDITION_FAILED', 'version_mismatch',
    `This daemon speaks relay API ${v ?? 'none'}; this relay speaks ${RELAY_API_VERSION}. Update Tandemise or the relay so they match.`);
}

export function tooMany(): RelayError {
  return new RelayError(429, 'PERMISSION_DENIED', 'Too many failed attempts from this address. Try again in ten minutes.', { reason: 'rate_limited' }, true);
}

/**
 * `Authorization: Bearer trd_…` only: no query fallback, because a daemon can
 * set headers. Looks the device up by its token's hash and confirms it in
 * constant time. A failure counts against the address.
 */
export function authenticate(req: IncomingMessage, store: CoordinationStore, limiter: FailedAuthLimiter, ip: string): Principal {
  if (limiter.locked(ip)) throw tooMany();
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  const device = token ? store.deviceByToken(token) : null;
  if (device === null) {
    limiter.fail(ip);
    throw new RelayError(401, 'PERMISSION_DENIED', 'This computer is not on the team. Ask an admin for an invite.', { reason: 'unauthenticated' });
  }
  if (device.revokedAt !== null || device.memberStatus !== 'active') {
    throw RelayError.reason(401, 'PERMISSION_DENIED', 'device_revoked', 'This computer was removed from the team relay. Ask an admin for a new invite.');
  }
  store.touchDevice(device.id);
  return { device, role: device.role, memberId: device.memberId };
}

export function requireAdmin(p: Principal): void {
  if (p.role !== 'admin') throw RelayError.reason(403, 'PERMISSION_DENIED', 'admin_only', 'Only a team admin can do that.');
}
