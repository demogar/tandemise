import type {
  Member, MemberRepositoryPort, PersonRepositoryPort, UnitOfWork, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { indexTeam, isActiveMember, validateTeam } from '@tandemise/domain';
import type {
  AddMemberRequest, CreatePersonRequest, MeView, MemberView, PersonView, TeamView, UpdateMemberRequest,
  UpdatePersonRequest,
} from '@tandemise/api-contract';
import type { Clock, MemberId, PersonId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId, ids } from '@tandemise/shared';
import type { TeamService } from '../services.js';
import { requireSeat, type Caller } from '../support/identity.js';
import { assertTeam } from '../support/staffing-edit.js';

export interface TeamServiceDeps {
  readonly people: PersonRepositoryPort;
  readonly members: MemberRepositoryPort;
  readonly workspaces: WorkspaceRepositoryPort;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/**
 * People, and their seats in each workspace's team tree.
 *
 * Every mutation checks the tree as it would be afterwards, inside the same
 * transaction that writes it, so a rejected change leaves nothing behind and
 * two rules that each pass alone cannot combine into a broken tree.
 *
 * Changing a workspace's team takes a seat on it. Access levels beyond that
 * are stored now and enforced once accounts exist (P4). People are global to
 * the installation, so creating or renaming one needs no seat anywhere.
 */
export class TeamServiceImpl implements TeamService {
  constructor(private readonly deps: TeamServiceDeps) {}

  me(caller: Caller): MeView {
    const person = this.#requirePerson(caller.personId);
    const memberships = this.deps.workspaces.list().flatMap((w) => {
      const seat = this.deps.members.findPersonMember(w.id, person.id);
      return seat === undefined || seat.status !== 'active'
        ? []
        : [{ workspaceId: w.id as string, memberId: seat.id as string, access: seat.access ?? 'member' }];
    });
    return { person, memberships };
  }

  listPeople(): readonly PersonView[] {
    return this.deps.people.list();
  }

  createPerson(_caller: Caller, request: CreatePersonRequest): PersonView {
    return this.deps.people.create({
      id: ids.person(), displayName: request.displayName, handles: request.handles ?? {}, accountId: null,
    });
  }

  updatePerson(_caller: Caller, id: PersonId, request: UpdatePersonRequest): PersonView {
    return this.deps.unitOfWork.transaction(() => {
      this.#requirePerson(id);
      const person = this.deps.people.update(id, {
        ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
        ...(request.handles === undefined ? {} : { handles: request.handles }),
      });
      // A person member's name is the person's, copied so history reads without a join.
      if (request.displayName !== undefined) {
        for (const seat of this.#seatsOf(id)) this.deps.members.update(seat.id, { name: request.displayName });
      }
      return person;
    });
  }

  removePerson(caller: Caller, id: PersonId): void {
    if (id === caller.personId) {
      throw new TandemiseError('CONFLICT', 'You cannot remove yourself. Ask another owner to remove you.', {
        details: { personId: id },
      });
    }
    this.deps.unitOfWork.transaction(() => {
      const person = this.#requirePerson(id);
      if (person.removedAt !== null) return;
      for (const seat of this.#seatsOf(id).filter((m) => m.status === 'active')) this.#removeSeat(seat);
      this.deps.people.update(id, { removedAt: this.deps.clock.now() });
    });
  }

  team(workspaceId: WorkspaceId): TeamView {
    this.#requireWorkspace(workspaceId);
    const members = this.#all(workspaceId);
    const team = indexTeam(members);
    const views = members.map((m): MemberView => ({
      ...m,
      ownerName: m.kind === 'agent' && m.reportsTo !== null ? team.byId.get(m.reportsTo)?.name ?? null : null,
      active: isActiveMember(team, m.id),
    }));
    // A member whose manager has left is shown at the top rather than hidden
    // under a removed node, so orphaned agents stay visible and fixable.
    const roots = members
      .filter((m) => m.status === 'active')
      .filter((m) => m.reportsTo === null || team.byId.get(m.reportsTo)?.status !== 'active')
      .map((m) => m.id as string);
    return { workspaceId, members: views, roots, issues: validateTeam(members) };
  }

  addMember(caller: Caller, workspaceId: WorkspaceId, request: AddMemberRequest): MemberView {
    return this.deps.unitOfWork.transaction(() => {
      this.#requireWorkspace(workspaceId);
      requireSeat(this.deps, workspaceId, caller);
      const members = this.#all(workspaceId);
      this.#requireManager(members, request.reportsTo ?? null);

      if (request.kind === 'person') {
        const person = this.#requirePerson(asId<'PersonId'>(request.personId));
        if (person.removedAt !== null) {
          throw TandemiseError.validation(`${person.displayName} has been removed and cannot be added.`, { personId: person.id });
        }
        const fields = {
          name: person.displayName,
          title: request.title ?? null,
          reportsTo: request.reportsTo === undefined || request.reportsTo === null ? null : asId<'MemberId'>(request.reportsTo),
          access: request.access ?? 'member',
          oversight: request.oversight ?? 'delegate_owns',
          roleIds: request.roleIds ?? [],
          status: 'active' as const,
        };
        const existing = this.deps.members.findPersonMember(workspaceId, person.id);
        if (existing?.status === 'active') {
          throw new TandemiseError('CONFLICT', `${person.displayName} is already a member of this workspace.`, {
            details: { memberId: existing.id },
          });
        }
        if (existing !== undefined) {
          // The unique seat per person is revived rather than duplicated, so
          // their earlier work still points at the same member.
          assertTeam(members.map((m) => (m.id === existing.id ? { ...m, ...fields } : m)));
          return this.#view(workspaceId, this.deps.members.update(existing.id, fields).id);
        }
        const candidate = this.#draft(workspaceId, { kind: 'person', personId: person.id, runtimeProfileIds: [], integrationIds: [], ...fields });
        assertTeam([...members, candidate]);
        return this.#view(workspaceId, this.deps.members.create(candidate).id);
      }

      const candidate = this.#draft(workspaceId, {
        kind: 'agent', personId: null, name: request.name, title: request.title ?? null,
        reportsTo: asId<'MemberId'>(request.reportsTo), access: null, oversight: 'delegate_owns',
        roleIds: request.roleIds, runtimeProfileIds: request.runtimeProfileIds ?? [],
        integrationIds: request.integrationIds ?? [], status: 'active',
      });
      assertTeam([...members, candidate]);
      return this.#view(workspaceId, this.deps.members.create(candidate).id);
    });
  }

  updateMember(caller: Caller, id: MemberId, request: UpdateMemberRequest): MemberView {
    return this.deps.unitOfWork.transaction(() => {
      const current = this.#requireMember(id);
      requireSeat(this.deps, current.workspaceId, caller);
      const members = this.#all(current.workspaceId);
      if (request.reportsTo === id) {
        throw TandemiseError.validation(`reportsTo: ${current.name} cannot report to themselves.`, { id, reportsTo: request.reportsTo });
      }
      if (request.reportsTo !== undefined) this.#requireManager(members, request.reportsTo);
      // Bringing a seat back is adding the person again, and a removed person cannot be added.
      if (request.status === 'active' && current.kind === 'person' && current.personId !== null) {
        const person = this.#requirePerson(current.personId);
        if (person.removedAt !== null) {
          throw TandemiseError.validation(`${person.displayName} has been removed and cannot be brought back.`, { personId: person.id, memberId: id });
        }
      }
      if (current.kind === 'agent' && request.access !== undefined) {
        throw TandemiseError.validation('access: an agent acts on its owner\'s authority and has no access level.', { id });
      }
      const patch: Partial<Member> = {
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.title === undefined ? {} : { title: request.title }),
        ...(request.reportsTo === undefined ? {} : { reportsTo: request.reportsTo === null ? null : asId<'MemberId'>(request.reportsTo) }),
        ...(request.access === undefined ? {} : { access: request.access }),
        ...(request.oversight === undefined ? {} : { oversight: request.oversight }),
        ...(request.roleIds === undefined ? {} : { roleIds: request.roleIds }),
        ...(request.runtimeProfileIds === undefined ? {} : { runtimeProfileIds: request.runtimeProfileIds }),
        ...(request.integrationIds === undefined ? {} : { integrationIds: request.integrationIds }),
        ...(request.status === undefined ? {} : { status: request.status }),
      };
      const next = { ...current, ...patch } as Member;
      if (isOwnerSeat(current) && !isOwnerSeat(next)) this.#refuseLastOwner(members, current);
      assertTeam(members.map((m) => (m.id === id ? next : m)));
      return this.#view(current.workspaceId, this.deps.members.update(id, patch).id);
    });
  }

  removeMember(caller: Caller, id: MemberId): void {
    this.deps.unitOfWork.transaction(() => {
      const member = this.#requireMember(id);
      const seat = requireSeat(this.deps, member.workspaceId, caller);
      if (member.status === 'removed') return;
      // As with removing a person: leaving is something another member does
      // for you, so nobody locks themselves out of a workspace by a misclick.
      if (member.id === seat.id) {
        throw new TandemiseError('CONFLICT', 'You cannot remove your own seat. Ask another member to remove you.', {
          details: { memberId: id, workspaceId: member.workspaceId },
        });
      }
      this.#removeSeat(member);
    });
  }

  // ------------------------------------------------------------------ internals

  /**
   * The seat is marked removed, never deleted. Their agents stay as they are
   * and simply stop being active through their owner, so re-adding the person
   * brings their agents back with them.
   */
  #removeSeat(member: Member): void {
    const members = this.#all(member.workspaceId);
    // Checked before the tree rules so the caller gets the specific answer,
    // not "the workspace needs at least one active owner" as a generic 400.
    if (isOwnerSeat(member)) this.#refuseLastOwner(members, member);
    const removed: Member = { ...member, status: 'removed' };
    assertTeam(members.map((m) => (m.id === member.id ? removed : m)));
    this.deps.members.update(member.id, { status: 'removed' });
  }

  #refuseLastOwner(members: readonly Member[], leaving: Member): void {
    const others = members.filter((m) => m.id !== leaving.id && isOwnerSeat(m));
    if (others.length === 0) {
      throw new TandemiseError('CONFLICT', 'A workspace needs at least one owner. Make someone else an owner first.', {
        details: { memberId: leaving.id, workspaceId: leaving.workspaceId },
      });
    }
  }

  #requireManager(members: readonly Member[], reportsTo: string | null): void {
    if (reportsTo === null) return;
    if (!members.some((m) => m.id === reportsTo)) {
      throw TandemiseError.validation(`reportsTo: '${reportsTo}' is not a member of this workspace.`, { reportsTo });
    }
  }

  #draft(workspaceId: WorkspaceId, fields: Omit<Member, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt'>): Member {
    const now = this.deps.clock.now();
    return { id: ids.member(), workspaceId, ...fields, createdAt: now, updatedAt: now };
  }

  #view(workspaceId: WorkspaceId, id: MemberId): MemberView {
    const view = this.team(workspaceId).members.find((m) => m.id === id);
    if (view === undefined) throw TandemiseError.notFound('Member', id);
    return view;
  }

  #all(workspaceId: WorkspaceId): readonly Member[] {
    return this.deps.members.listByWorkspace(workspaceId, { includeRemoved: true });
  }

  #seatsOf(personId: PersonId): readonly Member[] {
    return this.deps.workspaces.list()
      .map((w) => this.deps.members.findPersonMember(w.id, personId))
      .filter((m): m is Member => m !== undefined);
  }

  #requirePerson(id: PersonId) {
    const person = this.deps.people.get(id);
    if (person === undefined) throw TandemiseError.notFound('Person', id);
    return person;
  }

  #requireMember(id: MemberId): Member {
    const member = this.deps.members.get(id);
    if (member === undefined) throw TandemiseError.notFound('Member', id);
    return member;
  }

  #requireWorkspace(id: WorkspaceId): void {
    if (this.deps.workspaces.get(id) === undefined) throw TandemiseError.notFound('Workspace', id);
  }
}

function isOwnerSeat(m: Member): boolean {
  return m.kind === 'person' && m.status === 'active' && m.access === 'owner';
}
