import { asId, type WorkspaceId } from '@tandemise/shared';
import type {
  ArtifactType, Capability, IsolationMode, RoleModels, RoleRepositoryPort, RoleTemplate,
} from '@tandemise/domain';
import { hasRoleModels, normalizeRoleModels, normalizeRoleSkills } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { fromSqlBool, parseJson, toJson, toSqlBool } from '../json.js';

interface RoleRow {
  id: string;
  workspace_id: string | null;
  name: string;
  summary: string;
  instructions: string;
  default_capabilities: string;
  produces_artifacts: string;
  consumes_artifacts: string;
  default_isolation: string;
  output_contract: string;
  built_in: number;
  models: string | null;
  skills: string | null;
  created_at: string;
  updated_at: string;
}

function toRow(r: RoleTemplate): RoleRow {
  return {
    id: r.id,
    workspace_id: r.workspaceId,
    name: r.name,
    summary: r.summary,
    instructions: r.instructions,
    default_capabilities: toJson(r.defaultCapabilities),
    produces_artifacts: toJson(r.producesArtifacts),
    consumes_artifacts: toJson(r.consumesArtifacts),
    default_isolation: r.defaultIsolation,
    output_contract: r.outputContract,
    built_in: toSqlBool(r.builtIn),
    models: hasRoleModels(r.models) ? toJson(r.models) : null,
    skills: r.skills === null || r.skills === undefined || r.skills.length === 0 ? null : toJson(r.skills),
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

function fromRow(r: RoleRow): RoleTemplate {
  return {
    id: r.id,
    workspaceId: r.workspace_id === null ? null : asId<'WorkspaceId'>(r.workspace_id),
    name: r.name,
    summary: r.summary,
    instructions: r.instructions,
    defaultCapabilities: parseJson<readonly Capability[]>(r.default_capabilities, []),
    producesArtifacts: parseJson<readonly ArtifactType[]>(r.produces_artifacts, []),
    consumesArtifacts: parseJson<readonly ArtifactType[]>(r.consumes_artifacts, []),
    defaultIsolation: r.default_isolation as IsolationMode,
    outputContract: r.output_contract,
    builtIn: fromSqlBool(r.built_in),
    models: r.models === null ? null : normalizeRoleModels(parseJson<Partial<RoleModels>>(r.models, {})),
    skills: r.skills === null ? null : normalizeRoleSkills(parseJson<unknown>(r.skills, [])),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS = `id, workspace_id, name, summary, instructions, default_capabilities,
  produces_artifacts, consumes_artifacts, default_isolation, output_contract, built_in, models, skills,
  created_at, updated_at`;

/**
 * Role storage is scoped: a role either belongs to a workspace or is global
 * (`workspace_id IS NULL`, the built-ins). A workspace may store a role with
 * the same id as a built-in, which *shadows* it - that is how a team adjusts
 * the review role's instructions without forking the product's role catalogue.
 *
 * `IS` rather than `=` throughout, because the global scope is a NULL and `=`
 * never matches NULL.
 */
export class SqliteRoleRepository implements RoleRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #insert;
  readonly #update;
  readonly #selectExact;
  readonly #selectResolved;
  readonly #selectScope;
  readonly #delete;

  constructor(db: TandemiseDatabase) {
    this.#db = db;
    this.#insert = db.handle.prepare<RoleRow>(
      `INSERT INTO role_templates (${COLUMNS}) VALUES (
        :id, :workspace_id, :name, :summary, :instructions, :default_capabilities,
        :produces_artifacts, :consumes_artifacts, :default_isolation, :output_contract,
        :built_in, :models, :skills, :created_at, :updated_at)`,
    );
    this.#update = db.handle.prepare<RoleRow>(
      `UPDATE role_templates SET
         name = :name, summary = :summary, instructions = :instructions,
         default_capabilities = :default_capabilities, produces_artifacts = :produces_artifacts,
         consumes_artifacts = :consumes_artifacts, default_isolation = :default_isolation,
         output_contract = :output_contract, built_in = :built_in, models = :models, skills = :skills, created_at = :created_at,
         updated_at = :updated_at
       WHERE id = :id AND workspace_id IS :workspace_id`,
    );
    this.#selectExact = db.handle.prepare<{ id: string; workspaceId: string | null }, RoleRow>(
      `SELECT ${COLUMNS} FROM role_templates WHERE id = :id AND workspace_id IS :workspaceId`,
    );
    // `workspace_id IS NULL` sorts 0 for a scoped row and 1 for a global one,
    // so the workspace override is always first.
    this.#selectResolved = db.handle.prepare<{ id: string; workspaceId: string | null }, RoleRow>(
      `SELECT ${COLUMNS} FROM role_templates
       WHERE id = :id AND (workspace_id IS :workspaceId OR workspace_id IS NULL)
       ORDER BY workspace_id IS NULL
       LIMIT 1`,
    );
    this.#selectScope = db.handle.prepare<{ workspaceId: string | null }, RoleRow>(
      `SELECT ${COLUMNS} FROM role_templates
       WHERE workspace_id IS :workspaceId OR workspace_id IS NULL
       ORDER BY id, workspace_id IS NULL`,
    );
    this.#delete = db.handle.prepare<{ id: string; workspaceId: string }>(
      'DELETE FROM role_templates WHERE id = :id AND workspace_id = :workspaceId',
    );
  }

  upsert(role: RoleTemplate): RoleTemplate {
    return this.#db.transaction(() => {
      const row = toRow(role);
      const exists = this.#selectExact.get({ id: role.id, workspaceId: role.workspaceId });
      if (exists) this.#update.run(row);
      else this.#insert.run(row);
      return role;
    });
  }

  /** The workspace's override if it has one, otherwise the global role. */
  get(id: string, workspaceId: WorkspaceId | null): RoleTemplate | undefined {
    const row = this.#selectResolved.get({ id, workspaceId });
    return row ? fromRow(row) : undefined;
  }

  /** Globals plus the workspace's own roles, with overrides shadowing globals. */
  list(workspaceId: WorkspaceId | null): readonly RoleTemplate[] {
    const resolved = new Map<string, RoleTemplate>();
    for (const row of this.#selectScope.all({ workspaceId })) {
      if (!resolved.has(row.id)) resolved.set(row.id, fromRow(row));
    }
    return [...resolved.values()];
  }

  /** Removes a workspace's override. Global built-ins are not deletable. */
  remove(id: string, workspaceId: WorkspaceId): void {
    this.#delete.run({ id, workspaceId });
  }
}
