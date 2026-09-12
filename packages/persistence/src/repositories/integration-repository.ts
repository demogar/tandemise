import { TandemiseError, asId, type Clock, type IntegrationId, type WorkspaceId } from '@tandemise/shared';
import type {
  Capability, Integration, IntegrationRepositoryPort, IntegrationTransport,
} from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { fromSqlBool, parseJson, toJson, toSqlBool } from '../json.js';
import { applyPatch } from '../patch.js';

interface IntegrationRow {
  id: string;
  workspace_id: string;
  provider_id: string;
  name: string;
  transport: string;
  config: string;
  credential_ref: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function toRow(i: Integration): IntegrationRow {
  return {
    id: i.id,
    workspace_id: i.workspaceId,
    provider_id: i.providerId,
    name: i.name,
    transport: i.transport,
    config: toJson(i.config),
    credential_ref: i.credentialRef,
    enabled: toSqlBool(i.enabled),
    created_at: i.createdAt,
    updated_at: i.updatedAt,
  };
}

function fromRow(r: IntegrationRow, enabledCapabilities: readonly Capability[]): Integration {
  return {
    id: asId<'IntegrationId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    providerId: r.provider_id,
    name: r.name,
    transport: r.transport as IntegrationTransport,
    config: parseJson<Readonly<Record<string, unknown>>>(r.config, {}),
    credentialRef: r.credential_ref,
    enabledCapabilities,
    enabled: fromSqlBool(r.enabled),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS = `id, workspace_id, provider_id, name, transport, config, credential_ref,
  enabled, created_at, updated_at`;

/**
 * `enabledCapabilities` is stored in `integration_grants` rather than as JSON
 * so the policy layer can answer "which integration in this workspace may do
 * `github.pr.create`?" with an index lookup instead of decoding every row.
 */
export class SqliteIntegrationRepository implements IntegrationRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #clock: Clock;
  readonly #insert;
  readonly #update;
  readonly #selectOne;
  readonly #selectByWorkspace;
  readonly #delete;
  readonly #deleteGrants;
  readonly #insertGrant;
  readonly #selectGrants;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    this.#insert = db.handle.prepare<IntegrationRow>(
      `INSERT INTO integrations (${COLUMNS}) VALUES (
        :id, :workspace_id, :provider_id, :name, :transport, :config, :credential_ref,
        :enabled, :created_at, :updated_at)`,
    );
    this.#update = db.handle.prepare<IntegrationRow>(
      `UPDATE integrations SET
         provider_id = :provider_id, name = :name, transport = :transport, config = :config,
         credential_ref = :credential_ref, enabled = :enabled, updated_at = :updated_at
       WHERE id = :id`,
    );
    this.#selectOne = db.handle.prepare<{ id: string }, IntegrationRow>(
      `SELECT ${COLUMNS} FROM integrations WHERE id = :id`,
    );
    this.#selectByWorkspace = db.handle.prepare<{ workspaceId: string }, IntegrationRow>(
      `SELECT ${COLUMNS} FROM integrations WHERE workspace_id = :workspaceId ORDER BY name, id`,
    );
    this.#delete = db.handle.prepare<{ id: string }>('DELETE FROM integrations WHERE id = :id');
    this.#deleteGrants = db.handle.prepare<{ integrationId: string }>(
      'DELETE FROM integration_grants WHERE integration_id = :integrationId',
    );
    this.#insertGrant = db.handle.prepare<{ integrationId: string; capability: string; ordinal: number }>(
      `INSERT INTO integration_grants (integration_id, capability, ordinal)
       VALUES (:integrationId, :capability, :ordinal)`,
    );
    this.#selectGrants = db.handle.prepare<{ ids: string }, { integration_id: string; capability: string }>(
      `SELECT integration_id, capability FROM integration_grants
       WHERE integration_id IN (SELECT value FROM json_each(:ids))
       ORDER BY integration_id, ordinal`,
    );
  }

  create(integration: Integration): Integration {
    return this.#db.transaction(() => {
      this.#insert.run(toRow(integration));
      return this.#writeGrants(integration);
    });
  }

  get(id: IntegrationId): Integration | undefined {
    const row = this.#selectOne.get({ id });
    return row ? fromRow(row, this.#grantsFor([row.id]).get(row.id) ?? []) : undefined;
  }

  listByWorkspace(workspaceId: WorkspaceId): readonly Integration[] {
    const rows = this.#selectByWorkspace.all({ workspaceId });
    if (rows.length === 0) return [];
    const grants = this.#grantsFor(rows.map((r) => r.id));
    return rows.map((r) => fromRow(r, grants.get(r.id) ?? []));
  }

  update(id: IntegrationId, patch: Partial<Omit<Integration, 'id' | 'createdAt'>>): Integration {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (!current) throw TandemiseError.notFound('Integration', id);
      const next: Integration = { ...applyPatch(current, patch), updatedAt: this.#clock.now() };
      this.#update.run(toRow(next));
      return this.#writeGrants(next);
    });
  }

  remove(id: IntegrationId): void {
    this.#delete.run({ id });
  }

  #writeGrants(integration: Integration): Integration {
    this.#deleteGrants.run({ integrationId: integration.id });
    const unique = [...new Set(integration.enabledCapabilities)];
    unique.forEach((capability, ordinal) =>
      this.#insertGrant.run({ integrationId: integration.id, capability, ordinal }),
    );
    return { ...integration, enabledCapabilities: unique };
  }

  #grantsFor(ids: readonly string[]): Map<string, Capability[]> {
    const byIntegration = new Map<string, Capability[]>();
    for (const row of this.#selectGrants.all({ ids: toJson(ids) })) {
      const list = byIntegration.get(row.integration_id);
      if (list) list.push(row.capability);
      else byIntegration.set(row.integration_id, [row.capability]);
    }
    return byIntegration;
  }
}
