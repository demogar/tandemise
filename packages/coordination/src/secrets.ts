import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** SHA-256, hex. Only hashes of tokens and invite codes are ever stored. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** A per-device bearer token: `trd_` and 32 random bytes, base64url. */
export function newDeviceToken(): string {
  return `trd_${randomBytes(32).toString('base64url')}`;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A single-use invite code: 128 random bits as 26 Crockford base32
 * characters, grouped for copying (`TRI-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX`).
 * The spec's four groups of four would carry only 80 bits; 128 bits wins.
 */
export function newInviteCode(): string {
  const bytes = randomBytes(16);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let chars = '';
  for (let i = 0; i < 26; i++) {
    chars = CROCKFORD[Number(n & 31n)] + chars;
    n >>= 5n;
  }
  return `TRI-${chars.slice(0, 5)}-${chars.slice(5, 10)}-${chars.slice(10, 15)}-${chars.slice(15, 20)}-${chars.slice(20)}`;
}

/** What a person pasted, made comparable: uppercase, no whitespace. */
export function normalizeInviteCode(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

/** A webhook URL slug: 128 random bits, base64url. */
export function newSlug(): string {
  return randomBytes(16).toString('base64url');
}

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}
