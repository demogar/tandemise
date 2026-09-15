import type { Member, MemberRepositoryPort, Person, PersonRepositoryPort } from '@tandemise/domain';
import type { MemberId, PersonId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId, ids } from '@tandemise/shared';

/** The person a request is made by. Workspace-independent; the member is resolved per workspace. */
export interface Caller {
  readonly personId: PersonId;
}

/** P4 replaces this with account-backed resolution. */
export interface IdentityPort {
  localPerson(): Person;
}

/** Used when the composition root has no better name, e.g. from git config. */
export const DEFAULT_LOCAL_PERSON_NAME = 'You';

/**
 * The single person every request acts as until accounts exist.
 *
 * Migration 008 creates this person, but only on a database that existed
 * before it ran with no people yet; a store that has somehow lost its people
 * still needs someone to own the workspaces it creates, so one is created here.
 */
export class LocalIdentity implements IdentityPort {
  constructor(
    private readonly people: PersonRepositoryPort,
    private readonly displayName: string = DEFAULT_LOCAL_PERSON_NAME,
  ) {}

  localPerson(): Person {
    // The earliest person ever created, removed ones included, so adding or
    // removing teammates can never hand the daemon's identity to someone else.
    const first = this.people.list({ includeRemoved: true })[0];
    const person = first ?? this.people.create({ id: ids.person(), displayName: this.displayName, handles: {}, accountId: null });
    if (person.removedAt !== null) {
      // Picking another person, or minting a new one, would silently
      // re-attribute everything done from here on.
      throw new TandemiseError('PRECONDITION_FAILED', `The local person '${person.displayName}' has been removed; restore them to keep using this installation.`, {
        details: { personId: person.id },
      });
    }
    return person;
  }
}

/**
 * The caller's active seat in the workspace, or PERMISSION_DENIED.
 *
 * Access levels are not enforced until accounts exist (P4), but a seat is:
 * someone who is not on a workspace's team does not change its team, its
 * staffing or its work. P4 builds its checks on this guard.
 */
export function requireSeat(
  deps: { readonly members: MemberRepositoryPort },
  workspaceId: WorkspaceId,
  caller: Caller,
): Member {
  const seat = deps.members.findPersonMember(workspaceId, caller.personId);
  if (seat === undefined || seat.status !== 'active') {
    throw TandemiseError.permissionDenied('You are not a member of this workspace.', {
      workspaceId, personId: caller.personId,
    });
  }
  return seat;
}

/**
 * The member acting in a workspace for this caller, honouring `onBehalfOf`.
 *
 * The principal must hold an active seat. Access levels are stored but not
 * enforced until accounts exist (P4), so a guest may act too. `onBehalfOf`
 * must be an active person, because
 * an agent's answers are its owner's to give and a record claiming an agent
 * approved something would hide who actually did.
 */
export function actorFor(
  deps: { readonly members: MemberRepositoryPort },
  workspaceId: WorkspaceId,
  caller: Caller,
  onBehalfOf?: string,
): { readonly actorId: MemberId; readonly recordedBy: MemberId } {
  const principal = requireSeat(deps, workspaceId, caller);
  if (onBehalfOf === undefined || onBehalfOf === principal.id) {
    return { actorId: principal.id, recordedBy: principal.id };
  }
  const subject: Member | undefined = deps.members.get(asId<'MemberId'>(onBehalfOf));
  if (subject === undefined || subject.workspaceId !== workspaceId || subject.kind !== 'person' || subject.status !== 'active') {
    throw TandemiseError.validation(
      `onBehalfOf: '${onBehalfOf}' must be an active person member of this workspace.`,
      { onBehalfOf, workspaceId },
    );
  }
  return { actorId: subject.id, recordedBy: principal.id };
}
