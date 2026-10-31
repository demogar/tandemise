import { slugify } from '@tandemise/shared';

/**
 * Who appended a ledger line (#51 spec §3). `<member-handle>-<6 hex>`: the
 * handle is the local person's name, the hex comes from a random install id
 * generated once per machine. It names this daemon's ledger files the way a
 * git author names a commit; nothing else about the person is stored.
 */
export type WriterId = string & { readonly __brand: 'WriterId' };

export const WRITER_ID_PATTERN = /^[a-z0-9-]+-[0-9a-f]{6}$/;

export function makeWriterId(handle: string, installId: string): WriterId {
  return `${slugify(handle, 24)}-${installId.slice(0, 6).toLowerCase()}` as WriterId;
}

export function isWriterId(value: string): value is WriterId {
  return WRITER_ID_PATTERN.test(value);
}
