import { TandemiseError, asId, type Clock, type PersonId } from '@tandemise/shared';
import type { Person, PersonRepositoryPort } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';
import { applyPatch } from '../patch.js';

interface PersonRow {
  id: string;
  display_name: string;
  handles: string;
  account_id: string | null;
  created_at: string;
  removed_at: string | null;
}

function toRow(p: Person): PersonRow {
  return {
    id: p.id,
    display_name: p.displayName,
    handles: toJson(p.handles),
    account_id: p.accountId,
    created_at: p.createdAt,
    removed_at: p.removedAt,
  };
}

function fromRow(r: PersonRow): Person {
  return {
    id: asId<'PersonId'>(r.id),
    displayName: r.display_name,
    handles: parseJson<Readonly<Record<string, string>>>(r.handles, {}),
    accountId: r.account_id,
    createdAt: r.created_at,
    removedAt: r.removed_at,
  };
}

const COLUMNS = 'id, display_name, handles, account_id, created_at, removed_at';

/**
 * People are never deleted: a removed person still has to be named on the work
 * and decisions they left behind, so removal is a timestamp.
 */
export class SqlitePersonRepository implements PersonRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #clock: Clock;
  readonly #insert;
  readonly #update;
  readonly #selectOne;
  readonly #selectList;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    this.#insert = db.handle.prepare<PersonRow>(
      `INSERT INTO people (${COLUMNS}) VALUES (:id, :display_name, :handles, :account_id, :created_at, :removed_at)`,
    );
    this.#update = db.handle.prepare<PersonRow>(
      `UPDATE people SET
         display_name = :display_name, handles = :handles, account_id = :account_id, removed_at = :removed_at
       WHERE id = :id`,
    );
    this.#selectOne = db.handle.prepare<{ id: string }, PersonRow>(`SELECT ${COLUMNS} FROM people WHERE id = :id`);
    this.#selectList = db.handle.prepare<{ includeRemoved: 0 | 1 }, PersonRow>(
      `SELECT ${COLUMNS} FROM people
       WHERE (:includeRemoved = 1 OR removed_at IS NULL)
       ORDER BY created_at, id`,
    );
  }

  create(person: Omit<Person, 'createdAt' | 'removedAt'>): Person {
    const entity: Person = { ...person, createdAt: this.#clock.now(), removedAt: null };
    this.#insert.run(toRow(entity));
    return entity;
  }

  get(id: PersonId): Person | undefined {
    const row = this.#selectOne.get({ id });
    return row ? fromRow(row) : undefined;
  }

  list(options?: { includeRemoved?: boolean }): readonly Person[] {
    return this.#selectList.all({ includeRemoved: options?.includeRemoved ? 1 : 0 }).map(fromRow);
  }

  update(
    id: PersonId,
    patch: Partial<Pick<Person, 'displayName' | 'handles' | 'accountId' | 'removedAt'>>,
  ): Person {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (!current) throw TandemiseError.notFound('Person', id);
      const next = applyPatch(current, patch);
      this.#update.run(toRow(next));
      return next;
    });
  }
}
