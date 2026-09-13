import { z } from 'zod';
import { ARTIFACT_TYPES, AUTONOMY_LEVELS, MISSION_STATUSES, RUNTIME_CAPABILITIES } from '@tandemise/domain';

/**
 * Request schemas.
 *
 * The daemon validates every request body against these before it reaches a
 * service. Parsing at the edge means the application layer can trust its
 * inputs, and it means a bad request produces one precise error rather than a
 * type error three frames deep.
 */

export const createWorkspaceRequest = z.object({
  name: z.string().min(1).max(120),
  repositoryPath: z.string().min(1).optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequest>;

export const updateWorkspaceRequest = z.object({
  name: z.string().min(1).max(120).optional(),
  defaultRepositoryId: z.string().nullable().optional(),
  autonomy: z.object({
    planApproval: z.enum(['ask', 'auto']),
    localCodeChanges: z.enum(['auto', 'ask']),
    externalWrites: z.enum(['auto', 'policy', 'ask', 'deny']),
    productionRelease: z.enum(['ask', 'deny']),
    financialActions: z.literal('deny'),
  }).optional(),
  concurrency: z.object({
    maxTotalWorkers: z.number().int().min(1).max(16),
    perRuntime: z.record(z.string(), z.number().int().min(0).max(16)),
  }).optional(),
  routing: z.record(z.string(), z.array(z.string())).optional(),
  knowledge: z.object({
    productVision: z.string().nullable(),
    architecturePrinciples: z.string().nullable(),
    codingStandards: z.string().nullable(),
    designSystem: z.string().nullable(),
    glossary: z.string().nullable(),
  }).partial().optional(),
});
export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceRequest>;

export const addRepositoryRequest = z.object({
  path: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  checks: z.object({
    install: z.string().nullable(), typecheck: z.string().nullable(),
    lint: z.string().nullable(), test: z.string().nullable(),
    build: z.string().nullable(), devServer: z.string().nullable(),
    devServerUrl: z.string().nullable(),
  }).partial().optional(),
});
export type AddRepositoryRequest = z.infer<typeof addRepositoryRequest>;

export const probeRepositoryRequest = z.object({ path: z.string().min(1) });

export const createMissionRequest = z.object({
  workspaceId: z.string().min(1),
  repositoryId: z.string().min(1).nullable().optional(),
  /** The single natural-language sentence the whole product is built around. */
  goal: z.string().min(3).max(8000),
  title: z.string().min(1).max(200).optional(),
  constraints: z.array(z.string()).max(50).optional(),
  successCriteria: z.array(z.string()).max(50).optional(),
  autonomy: z.enum(AUTONOMY_LEVELS).optional(),
  /** Workflow id: one of the project's own files, or a built-in preset. */
  workflowPreset: z.string().optional(),
  /** Values for the workflow's declared inputs, e.g. `{ issue: '42' }`. */
  workflowInputs: z.record(z.string(), z.string()).optional(),
  baseBranch: z.string().nullable().optional(),
  /** Plan immediately after creation. The common path from the UI. */
  planNow: z.boolean().optional(),
});
export type CreateMissionRequest = z.infer<typeof createMissionRequest>;

export const listMissionsQuery = z.object({
  workspaceId: z.string().optional(),
  status: z.enum(MISSION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const decideApprovalRequest = z.object({
  optionId: z.string().min(1),
  note: z.string().max(4000).optional(),
  /** For plan approvals: an edited plan to use instead of the proposed one. */
  editedPlan: z.unknown().optional(),
});
export type DecideApprovalRequest = z.infer<typeof decideApprovalRequest>;

export const createRuntimeProfileRequest = z.object({
  adapterId: z.string().min(1),
  name: z.string().min(1).max(120),
  workspaceId: z.string().nullable().optional(),
  executablePath: z.string().nullable().optional(),
  args: z.array(z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  maxConcurrent: z.number().int().min(1).max(8).optional(),
  enabled: z.boolean().optional(),
  /**
   * Overrides what the adapter reports it can do.
   *
   * An adapter's `discover()` is a guess about a tool it did not write, and the
   * user frequently knows better - that this Claude Code install has
   * `computer_use`, or that a generic CLI can drive a browser. Without this the
   * capability router has no way to be corrected: a role requiring `browser`
   * would be permanently unroutable even though the runtime can do it.
   * Omitted means "trust the adapter".
   */
  capabilities: z.array(z.enum(RUNTIME_CAPABILITIES)).optional(),
});
export type CreateRuntimeProfileRequest = z.infer<typeof createRuntimeProfileRequest>;

export const updateRuntimeProfileRequest = createRuntimeProfileRequest.partial().omit({ adapterId: true });

/**
 * A person reporting that they have done a `human` task.
 *
 * `result` is whatever they bring back - a Figma URL, the id of the account
 * they created, a paragraph describing what they changed in a console. It is
 * stored as the artifact the step declared it would produce, so the tasks
 * downstream read it exactly as they would read an agent's output; nothing in
 * the rest of the pipeline needs to know a person wrote it.
 */
export const completeTaskRequest = z.object({
  result: z.string().trim().min(1).max(20_000),
  note: z.string().trim().max(2_000).optional(),
});
export type CompleteTaskRequest = z.infer<typeof completeTaskRequest>;

export const createIntegrationRequest = z.object({
  workspaceId: z.string().min(1),
  providerId: z.string().min(1),
  name: z.string().min(1).max(120),
  config: z.record(z.string(), z.unknown()).optional(),
  enabledCapabilities: z.array(z.string()).optional(),
  /** Raw secret; the daemon stores it in the OS credential store and keeps a ref. */
  secret: z.string().optional(),
});
export type CreateIntegrationRequest = z.infer<typeof createIntegrationRequest>;

export const updateIntegrationRequest = createIntegrationRequest.partial().omit({ workspaceId: true, providerId: true })
  // Switching an integration off withdraws its tools from every worker. The
  // desktop has always sent this; the schema used to strip it, so the switch
  // flipped back on the next refresh and nothing was ever withdrawn.
  .extend({ enabled: z.boolean().optional() });

/**
 * Connect an account through its consent screen.
 *
 * Name a curated connector (`figma`), or give a provider and configuration for
 * a server that is not in the catalog. Name an existing integration to
 * reconnect it - an account whose refresh token was revoked keeps its row, its
 * name and every mission reference to it.
 */
export const connectIntegrationRequest = z.object({
  workspaceId: z.string().min(1),
  connectorId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  name: z.string().min(1).max(120).optional(),
  integrationId: z.string().min(1).optional(),
}).refine((r) => r.connectorId !== undefined || r.integrationId !== undefined
  || (r.providerId !== undefined && r.config !== undefined), {
  message: 'Name a connector, an integration to reconnect, or a provider with its configuration.',
});
export type ConnectIntegrationRequest = z.infer<typeof connectIntegrationRequest>;

export const upsertRoleRequest = z.object({
  workspaceId: z.string().min(1),
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  summary: z.string().max(500),
  instructions: z.string().max(20000),
  defaultCapabilities: z.array(z.string()),
  producesArtifacts: z.array(z.enum(ARTIFACT_TYPES)),
  consumesArtifacts: z.array(z.enum(ARTIFACT_TYPES)),
  defaultIsolation: z.enum(['none', 'worktree', 'docker', 'browser']),
  outputContract: z.string().max(8000),
});
export type UpsertRoleRequest = z.infer<typeof upsertRoleRequest>;

export const missionEventsQuery = z.object({
  afterSequence: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  semanticOnly: z.coerce.boolean().optional(),
});

export const retryTaskRequest = z.object({
  /** Override the runtime for this attempt - the manual fallback escape hatch. */
  runtimeProfileId: z.string().optional(),
  note: z.string().max(2000).optional(),
  /**
   * Capabilities to add before retrying. Still narrowed to the role's own
   * defaults when grants are built, so this widens a task within what its role
   * may do - never beyond it.
   */
  addCapabilities: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
});

export const cancelMissionRequest = z.object({
  reason: z.string().max(500).optional(),
});
