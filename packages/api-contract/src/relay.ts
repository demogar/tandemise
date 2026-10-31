/**
 * The relay wire contract (docs/superpowers/specs/2026-10-30-relay-design.md,
 * §Protocol): what a daemon and an optional, self-hosted team relay say to
 * each other.
 *
 * This file imports only `zod` at runtime, on purpose. The relay server
 * (`apps/relay`) loads it through the `@tandemise/api-contract/relay` subpath
 * and nothing else from this package, so splitting the relay into its own
 * repository later stays mechanical. `scripts/check-boundaries.mjs` holds it to
 * type-only imports plus `zod`.
 */
import { z } from 'zod';
import type { ApiErrorBody } from './errors.js';

// ---- constants

/** The relay's own API version, separate from the daemon's `API_VERSION`. */
export const RELAY_API_VERSION = '1';
/** Versions this build accepts: the current one, and the previous one once there is one. */
export const RELAY_SUPPORTED_API_VERSIONS = ['1'] as const;
/** Every relay request carries this header (lowercase, as Node exposes it). */
export const RELAY_API_HEADER = 'x-tandemise-relay-api';
export const RELAY_BASE_PATH = '/relay/v1';
export const RELAY_STREAM_PATH = '/relay/v1/stream';
export const HOOKS_PATH_PREFIX = '/hooks/';

/** Relay-specific causes, carried in `ApiErrorBody.error.details.reason`. */
export type RelayErrorReason =
  | 'claim_held'
  | 'take_over_refused'
  | 'not_holder'
  | 'invite_invalid'
  | 'invite_used'
  | 'invite_expired'
  | 'lease_not_held'
  | 'relay_not_empty'
  | 'version_mismatch'
  | 'device_revoked'
  | 'admin_only'
  | 'import_invalid'
  | 'last_admin';

export type RelayErrorBody = ApiErrorBody;

export const RELAY_ROLES = ['admin', 'member'] as const;
export type RelayRole = (typeof RELAY_ROLES)[number];
export const CLAIM_END_REASONS = ['done', 'released', 'taken_over', 'removed'] as const;
export type ClaimEndReason = (typeof CLAIM_END_REASONS)[number];
export const HANDSHAKES = ['none', 'meta_hub', 'echo_challenge'] as const;
export type Handshake = (typeof HANDSHAKES)[number];

// ---- views

export interface ClaimView {
  readonly id: string;
  readonly projectKey: string;
  readonly itemRef: string;
  readonly itemTitle: string;
  readonly itemUrl: string | null;
  readonly memberId: string;
  readonly memberName: string;
  readonly deviceId: string;
  readonly deviceLabel: string;
  /** Only on the holder's own claims; opaque to everyone else. */
  readonly localRef: string | null;
  readonly state: 'active' | 'ended';
  readonly endedReason: ClaimEndReason | null;
  readonly endedBy: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly seq: number;
}

export interface CoordMemberView {
  readonly id: string;
  readonly displayName: string;
  readonly role: RelayRole;
  readonly status: 'active' | 'removed';
  readonly presence: 'online' | 'away' | 'offline';
  readonly lastSeenAt: string | null;
}

export interface CoordDeviceView {
  readonly id: string;
  readonly memberId: string;
  readonly label: string;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  readonly revokedAt: string | null;
}

export interface PresenceView {
  readonly deviceId: string;
  readonly memberId: string;
  readonly status: 'online' | 'away';
  readonly lastSeenAt: string;
}

export interface EndpointView {
  readonly id: string;
  readonly projectKey: string;
  readonly slug: string;
  readonly url: string;
  readonly name: string;
  readonly source: string;
  readonly handshake: Handshake;
  readonly createdAt: string;
  readonly disabledAt: string | null;
  readonly lastReceivedAt: string | null;
  readonly pending: number;
  readonly parked: number;
  readonly droppedCount: number;
  readonly dropFlag: boolean;
}

export interface MailboxMessage {
  readonly id: string;
  readonly endpointId: string;
  readonly projectKey: string;
  readonly receivedAt: string;
  readonly method: string;
  readonly query: string;
  readonly headers: Record<string, string>;
  readonly contentType: string | null;
  readonly bodyBase64: string;
  readonly attempts: number;
}

export interface RelayTeam {
  readonly id: string;
  readonly name: string;
}

export interface RelaySnapshot {
  readonly seq: number;
  readonly team: RelayTeam;
  /** Who is asking: lets a client tell its own claims and role apart. */
  readonly you: { readonly memberId: string; readonly deviceId: string; readonly role: RelayRole };
  readonly members: readonly CoordMemberView[];
  /** The caller's own devices; every device for an admin. */
  readonly devices: readonly CoordDeviceView[];
  readonly presence: readonly PresenceView[];
  readonly claims: readonly ClaimView[];
  /** Admins only; `[]` for members. */
  readonly endpoints: readonly EndpointView[];
  /** The relay's clock, so a daemon judges "stale" by the relay's time, not its own. */
  readonly serverTime: string;
  readonly staleAfterMs: number;
}

export interface ImportReport {
  readonly claims: readonly { readonly itemRef: string; readonly result: 'claimed' | 'held'; readonly holderName?: string }[];
  readonly endpoints: number;
  readonly messages: number;
}

// ---- requests

const trimmed = (max: number) => z.string().trim().min(1).max(max);

export const redeemInviteRequest = z.object({
  code: trimmed(64),
  displayName: trimmed(120),
  deviceLabel: trimmed(120),
});
export type RedeemInviteRequest = z.infer<typeof redeemInviteRequest>;
export interface RedeemInviteResponse {
  readonly memberId: string;
  readonly deviceId: string;
  readonly deviceToken: string;
  readonly team: RelayTeam;
}

export const createInviteRequest = z.object({
  role: z.enum(RELAY_ROLES),
  displayName: trimmed(120),
  expiresInDays: z.number().int().min(1).max(30).optional(),
  /** A "new device" invite for an existing member. */
  memberId: z.string().min(1).optional(),
});
export type CreateInviteRequest = z.infer<typeof createInviteRequest>;
export interface CreateInviteResponse {
  readonly code: string;
  readonly expiresAt: string;
}

export const claimRequest = z.object({
  projectKey: trimmed(400),
  itemRef: trimmed(400),
  itemTitle: z.string().max(400),
  itemUrl: z.string().max(2000).nullable(),
  localRef: z.string().max(200),
});
export type ClaimRequest = z.infer<typeof claimRequest>;

export const releaseClaimRequest = z.object({ reason: z.enum(['done', 'released']) });
export type ReleaseClaimRequest = z.infer<typeof releaseClaimRequest>;

export const takeOverRequest = z.object({ localRef: z.string().max(200).default('') });
export type TakeOverRequest = z.infer<typeof takeOverRequest>;

/**
 * `POST /relay/v1/leases` (intake spec §3, Ruling 22): take or renew a short
 * lease, so one daemon of the team runs a source at a time. `scope` is the
 * kind of thing leased (`source`, keyed by the source's id in the project).
 */
export const leaseRequest = z.object({
  projectKey: trimmed(400),
  scope: z.enum(['source']),
  key: trimmed(200),
  ttlSeconds: z.number().int().min(10).max(600),
});
export type LeaseRequest = z.infer<typeof leaseRequest>;

/** A lease's answer: granted until `expiresAt`, or held by someone else until then. */
export interface LeaseView {
  readonly granted: boolean;
  readonly expiresAt: string;
  readonly holderName: string | null;
  readonly deviceLabel: string | null;
}

export const createEndpointRequest = z.object({
  projectKey: trimmed(400),
  name: trimmed(120),
  source: trimmed(60),
  handshake: z.enum(HANDSHAKES),
  handshakeSecret: z.string().min(1).max(400).optional(),
});
export type CreateEndpointRequest = z.infer<typeof createEndpointRequest>;

export const mailboxPullRequest = z.object({
  project: trimmed(400),
  max: z.number().int().min(1).max(50),
  leaseSeconds: z.number().int().min(1).max(300),
});
export type MailboxPullRequest = z.infer<typeof mailboxPullRequest>;

export const mailboxAckRequest = z.object({ ids: z.array(z.string().min(1)).min(1).max(50) });
export type MailboxAckRequest = z.infer<typeof mailboxAckRequest>;
export interface MailboxAckResponse {
  readonly acked: readonly string[];
  readonly ignored: readonly string[];
}

export const importRequest = z.object({ lines: z.array(z.string()).max(200_000) });
export type ImportRequest = z.infer<typeof importRequest>;

// ---- export lines (JSONL)

export type CoordinationExportLine =
  | { readonly kind: 'meta'; readonly schemaVersion: number; readonly teamName: string }
  | {
      readonly kind: 'member'; readonly id: string; readonly displayName: string; readonly handles: Record<string, string>;
      readonly role: RelayRole; readonly status: 'active' | 'removed'; readonly createdAt: string;
    }
  | {
      readonly kind: 'claim'; readonly id: string; readonly projectKey: string; readonly itemRef: string; readonly itemTitle: string;
      readonly itemUrl: string | null; readonly memberId: string; readonly memberName: string; readonly localRef: string | null; readonly startedAt: string;
    }
  | {
      readonly kind: 'endpoint'; readonly id: string; readonly projectKey: string; readonly slug: string; readonly name: string;
      readonly source: string; readonly handshake: Handshake; readonly handshakeSecret: string | null; readonly createdAt: string;
      readonly disabledAt: string | null;
    }
  | {
      readonly kind: 'message'; readonly id: string; readonly endpointId: string; readonly receivedAt: string; readonly method: string;
      readonly query: string; readonly headers: Record<string, string>; readonly contentType: string | null; readonly bodyBase64: string;
      readonly attempts: number;
    };

/** One export line, validated: an import of a malformed file is refused line by line, never half-read. */
const iso = z.string().min(1).max(64);
const handshakeEnum = z.enum(HANDSHAKES);
export const coordinationExportLine = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('meta'), schemaVersion: z.number().int().min(1), teamName: z.string().max(200) }),
  z.object({
    kind: z.literal('member'), id: z.string().min(1).max(200), displayName: z.string().max(200), handles: z.record(z.string()),
    role: z.enum(RELAY_ROLES), status: z.enum(['active', 'removed']), createdAt: iso,
  }),
  z.object({
    kind: z.literal('claim'), id: z.string().min(1).max(200), projectKey: z.string().min(1).max(400), itemRef: z.string().min(1).max(400),
    itemTitle: z.string().max(400), itemUrl: z.string().max(2000).nullable(), memberId: z.string().min(1).max(200), memberName: z.string().max(200),
    localRef: z.string().max(200).nullable(), startedAt: iso,
  }),
  z.object({
    kind: z.literal('endpoint'), id: z.string().min(1).max(200), projectKey: z.string().min(1).max(400), slug: z.string().min(1).max(200),
    name: z.string().max(200), source: z.string().max(200), handshake: handshakeEnum, handshakeSecret: z.string().max(400).nullable(),
    createdAt: iso, disabledAt: iso.nullable(),
  }),
  z.object({
    kind: z.literal('message'), id: z.string().min(1).max(200), endpointId: z.string().min(1).max(200), receivedAt: iso, method: z.string().max(16),
    query: z.string().max(8192), headers: z.record(z.string()), contentType: z.string().max(400).nullable(), bodyBase64: z.string(),
    attempts: z.number().int().min(0),
  }),
]);

// ---- stream frames

export type RelayServerFrame =
  | { readonly type: 'hello'; readonly apiVersion: string; readonly seq: number; readonly serverTime: string }
  | { readonly type: 'claim'; readonly seq: number; readonly claim: ClaimView }
  | { readonly type: 'presence'; readonly seq: number; readonly presence: PresenceView }
  | { readonly type: 'members'; readonly seq: number }
  | { readonly type: 'mailbox'; readonly project: string; readonly pending: number }
  | { readonly type: 'pong'; readonly t: number };

export const relayClientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('watch'), projects: z.array(z.string().max(400)).max(100) }),
  z.object({ type: z.literal('presence'), status: z.enum(['online', 'away']) }),
  z.object({ type: z.literal('ping'), t: z.number() }),
]);
export type RelayClientFrame = z.infer<typeof relayClientFrame>;
