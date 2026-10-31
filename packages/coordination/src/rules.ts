import type { PresenceView, RelayRole } from '@tandemise/api-contract/relay';
import { itemKey } from './item-ref.js';

/** A claim is stale once none of its holder's devices has been seen for this long. */
export const DEFAULT_STALE_AFTER_MS = 86_400_000;
export const INVITE_TTL_DAYS = 7;

/** Never seen counts as stale: nothing says the holder is still around. */
export function isStale(holderLastSeenAt: string | null, now: Date, staleAfterMs: number): boolean {
  if (holderLastSeenAt === null) return true;
  return now.getTime() - Date.parse(holderLastSeenAt) >= staleAfterMs;
}

function durationWords(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours >= 1 && ms % 3_600_000 === 0) return hours === 1 ? '1 hour' : `${hours} hours`;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * Why `actor` may not take over a claim, or null when they may (spec §Roles):
 * anyone may take over a stale claim, only an admin a fresh one, and nobody
 * their own.
 */
export function takeOverRefusal(input: {
  readonly actor: { readonly memberId: string; readonly role: RelayRole };
  readonly holderMemberId: string;
  readonly holderName: string;
  readonly itemRef: string;
  readonly holderLastSeenAt: string | null;
  readonly now: Date;
  readonly staleAfterMs: number;
}): string | null {
  if (input.actor.memberId === input.holderMemberId) return 'This is already yours.';
  if (input.actor.role === 'admin') return null;
  if (isStale(input.holderLastSeenAt, input.now, input.staleAfterMs)) return null;
  const key = itemKey(input.itemRef);
  return `Only an admin can take over ${key} while ${input.holderName} is around. Anyone can once ${input.holderName} has been away for ${durationWords(input.staleAfterMs)}.`;
}

/** `10:42`, in the given time zone (the machine's by default). */
export function clockTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

/** The refusal a person reads when an item is already held. */
export function heldBySentence(input: {
  readonly holderName: string;
  readonly itemRef: string;
  readonly startedAt: string;
  readonly self: boolean;
  readonly deviceLabel: string;
  readonly timeZone?: string;
}): string {
  if (input.self) return `You're already working on this on ${input.deviceLabel || 'another computer'}.`;
  return `${input.holderName} is working on ${itemKey(input.itemRef)} since ${clockTime(input.startedAt, input.timeZone)}.`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "last seen 5 minutes ago", "last seen yesterday", "never seen". */
export function lastSeenLabel(lastSeenAt: string | null, now: Date): string {
  if (lastSeenAt === null) return 'never seen';
  const then = new Date(lastSeenAt);
  const ms = Math.max(0, now.getTime() - then.getTime());
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
  if (days <= 0) {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) return 'last seen just now';
    if (minutes < 60) return `last seen ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.floor(minutes / 60);
    return `last seen ${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  if (days === 1) return 'last seen yesterday';
  return `last seen ${days} days ago`;
}

const RANK = { online: 2, away: 1 } as const;

/** A member is as present as their most present device. */
export function presenceOf(devices: readonly PresenceView[], memberId: string): 'online' | 'away' | 'offline' {
  let best: 'online' | 'away' | 'offline' = 'offline';
  for (const d of devices) {
    if (d.memberId !== memberId) continue;
    if (best === 'offline' || RANK[d.status] > RANK[best]) best = d.status;
  }
  return best;
}
