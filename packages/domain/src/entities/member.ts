import type { MemberId, PersonId, Timestamp, WorkspaceId } from '@tandemise/shared';

/**
 * A workspace's staffing tiers, from full control to read-only. `guest` has no
 * write access at all - it exists so an external stakeholder can be added to a
 * mission's notify list without being handed the keys.
 */
export const ACCESS_LEVELS = ['owner', 'admin', 'member', 'guest'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/**
 * How closely a person's agents are watched. `both_sign_off` means the
 * person's own work also needs their manager's sign-off, not just their
 * agents' - used for a new lead who is still being trusted with delegation.
 */
export const OVERSIGHT_MODES = ['delegate_owns', 'both_sign_off'] as const;
export type OversightMode = (typeof OVERSIGHT_MODES)[number];

export const MEMBER_KINDS = ['person', 'agent'] as const;
export type MemberKind = (typeof MEMBER_KINDS)[number];

export const MEMBER_STATUSES = ['active', 'removed'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/** Actions the orchestrator itself takes, outside any member's authority. */
export const SYSTEM_ACTOR = 'system';
/** Actions a runtime takes before it has been bound to a specific agent member. */
export const RUNTIME_ACTOR = 'system:runtime';
/** A MemberId, SYSTEM_ACTOR or RUNTIME_ACTOR - whoever or whatever did something. */
export type ActorId = string;

/**
 * A human, workspace-independent. One Person can be a Member of several
 * workspaces (e.g. an agency contractor), which is why identity and
 * membership are separate entities.
 */
export interface Person {
  readonly id: PersonId;
  readonly displayName: string;
  /** External identities, e.g. `{ github: 'demogar', slack: 'U123' }'. */
  readonly handles: Readonly<Record<string, string>>;
  readonly accountId: string | null;
  readonly createdAt: Timestamp;
  readonly removedAt: Timestamp | null;
}

/**
 * A seat in one workspace's org chart: a person, or an agent owned by one.
 * Agents get `access: null` because an agent has no authority of its own - it
 * acts on its owner's authority, following Buzz's NIP-AA model. That is also
 * why an agent's `personId` is always null: it is not a person, even when it
 * has a name and a place in the tree.
 */
export interface Member {
  readonly id: MemberId;
  readonly workspaceId: WorkspaceId;
  readonly kind: MemberKind;
  readonly personId: PersonId | null;
  readonly name: string;
  readonly title: string | null;
  /** The member's manager: a person for anyone, or an agent's owning person. */
  readonly reportsTo: MemberId | null;
  readonly access: AccessLevel | null;
  readonly oversight: OversightMode;
  readonly roleIds: readonly string[];
  readonly runtimeProfileIds: readonly string[];
  readonly integrationIds: readonly string[];
  readonly status: MemberStatus;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}
