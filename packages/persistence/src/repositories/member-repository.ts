import {
  TandemiseError, asId, type Clock, type MemberId, type PersonId, type WorkspaceId,
} from '@tandemise/shared';
import type {
  AccessLevel, Member, MemberKind, MemberRepositoryPort, MemberStatus, OversightMode,
} from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';
import { applyPatch } from '../patch.js';

interface MemberRow {
  id: string;
  workspace_id: string;
  kind: string;
  person_id: string | null;
  name: string;
  title: string | null;
  reports_to: string | null;
  access: string | null;
  oversight: string;
  role_ids: string;
  runtime_profile_ids: string;
  integration_ids: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function toRow(m: Member): MemberRow {
  return {
    id: m.id,
    workspace_id: m.workspaceId,
    kind: m.kind,
    person_id: m.personId,
    name: m.name,
    title: m.title,
    reports_to: m.reportsTo,
    access: m.access,
    oversight: m.oversight,
    role_ids: toJson(m.roleIds),
    runtime_profile_ids: toJson(m.runtimeProfileIds),
    integration_ids: toJson(m.integrationIds),
    status: m.status,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
  };
}

function fromRow(r: MemberRow): Member {
  return {
    id: asId<'MemberId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    kind: r.kind as MemberKind,
    personId: r.person_id === null ? null : asId<'PersonId'>(r.person_id),
    name: r.name,
    title: r.title,
    reportsTo: r.reports_to === null ? null : asId<'MemberId'>(r.reports_to),
    access: r.access as AccessLevel | null,
    oversight: r.oversight as OversightMode,
    roleIds: parseJson<readonly string[]>(r.role_ids, []),
    runtimeProfileIds: parseJson<readonly string[]>(r.runtime_profile_ids, []),
    integrationIds: parseJson<readonly string[]>(r.integration_ids, []),
    status: r.status as MemberStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS = `id, workspace_id, kind, person_id, name, title, reports_to, access, oversight,
  role_ids, runtime_profile_ids, integration_ids, status, created_at, updated_at`;

/**
 * A workspace's team tree. The schema enforces the shape rules it can see in
 * one row (an agent always has an owner); rules that span rows, such as cycles
 * or an agent owned by an agent, belong to `validateTeam` in the domain.
 */
export class SqliteMemberRepository implements MemberRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #clock: Clock;
  readonly #insert;
  readonly #update;
  readonly #selectOne;
  readonly #selectByWorkspace;
  readonly #selectPersonMember;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    this.#insert = db.handle.prepare<MemberRow>(
      `INSERT INTO members (${COLUMNS}) VALUES (
        :id, :workspace_id, :kind, :person_id, :name, :title, :reports_to, :access, :oversight,
        :role_ids, :runtime_profile_ids, :integration_ids, :status, :created_at, :updated_at)`,
    );
    this.#update = db.handle.prepare<MemberRow>(
      `UPDATE members SET
         person_id = :person_id, name = :name, title = :title, reports_to = :reports_to,
         access = :access, oversight = :oversight, role_ids = :role_ids,
         runtime_profile_ids = :runtime_profile_ids, integration_ids = :integration_ids,
         status = :status, updated_at = :updated_at
       WHERE id = :id`,
    );
    this.#selectOne = db.handle.prepare<{ id: string }, MemberRow>(`SELECT ${COLUMNS} FROM members WHERE id = :id`);
    this.#selectByWorkspace = db.handle.prepare<{ workspaceId: string; includeRemoved: 0 | 1 }, MemberRow>(
      `SELECT ${COLUMNS} FROM members
       WHERE workspace_id = :workspaceId AND (:includeRemoved = 1 OR status = 'active')
       ORDER BY created_at, id`,
    );
    this.#selectPersonMember = db.handle.prepare<{ workspaceId: string; personId: string }, MemberRow>(
      `SELECT ${COLUMNS} FROM members WHERE workspace_id = :workspaceId AND person_id = :personId`,
    );
  }

  create(member: Omit<Member, 'createdAt' | 'updatedAt'>): Member {
    const now = this.#clock.now();
    const entity: Member = { ...member, createdAt: now, updatedAt: now };
    this.#insert.run(toRow(entity));
    return entity;
  }

  get(id: MemberId): Member | undefined {
    const row = this.#selectOne.get({ id });
    return row ? fromRow(row) : undefined;
  }

  listByWorkspace(workspaceId: WorkspaceId, options?: { includeRemoved?: boolean }): readonly Member[] {
    return this.#selectByWorkspace
      .all({ workspaceId, includeRemoved: options?.includeRemoved ? 1 : 0 })
      .map(fromRow);
  }

  /** Includes a removed seat, so re-adding a person revives it rather than colliding with the unique index. */
  findPersonMember(workspaceId: WorkspaceId, personId: PersonId): Member | undefined {
    const row = this.#selectPersonMember.get({ workspaceId, personId });
    return row ? fromRow(row) : undefined;
  }

  update(id: MemberId, patch: Partial<Omit<Member, 'id' | 'workspaceId' | 'kind' | 'createdAt'>>): Member {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (!current) throw TandemiseError.notFound('Member', id);
      const next: Member = { ...applyPatch(current, patch), updatedAt: this.#clock.now() };
      this.#update.run(toRow(next));
      return next;
    });
  }
}
