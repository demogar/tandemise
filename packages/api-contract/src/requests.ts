import { z } from 'zod';
import {
  ACCESS_LEVELS, ARTIFACT_TYPES, AUTONOMY_LEVELS, MISSION_STATUSES, OVERSIGHT_MODES, RUNTIME_CAPABILITIES,
  staffingPatchSchema,
} from '@tandemise/domain';

/**
 * Who a person is recording a decision or result for. The stored actor is this
 * member and the principal becomes `recordedBy`, so a lead can enter what a
 * teammate said without the record claiming the lead said it.
 */
const onBehalfOf = z.string().min(1).optional();

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

/** Per role; `null` removes that role's staffing, any other role is left alone. */
export const roleStaffingPatchRequest = z.record(z.string().min(1), staffingPatchSchema.nullable());
export type RoleStaffingPatchRequest = z.infer<typeof roleStaffingPatchRequest>;

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
  onBehalfOf,
  /**
   * The mission's staffing per role, the same shape its staffing PATCH takes.
   * Stored with the mission, before planning starts, so no task can become
   * READY - and snapshot its staffing - ahead of it.
   */
  staffing: roleStaffingPatchRequest.optional(),
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
  onBehalfOf,
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
   * Capabilities this profile has on top of what the adapter reports.
   *
   * An adapter's `discover()` is a guess about a tool it did not write, and the
   * user frequently knows better - that this Claude Code install has
   * `computer_use`, or that a generic CLI can drive a browser. Without this the
   * capability router has no way to be corrected: a role requiring `browser`
   * would be permanently unroutable even though the runtime can do it.
   *
   * They are added to the adapter's own capabilities (F5 ruling), never used to
   * take one away. A list equal to the adapter's defaults, in any order, means
   * "no override", so a profile saved with the defaults still follows what its
   * settings declare. Omitted also means "trust the adapter".
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
  onBehalfOf,
});
export type CompleteTaskRequest = z.infer<typeof completeTaskRequest>;

/** Taking an unassigned pool task, for yourself or for the member named. */
export const claimTaskRequest = z.object({ onBehalfOf });
export type ClaimTaskRequest = z.infer<typeof claimTaskRequest>;

// ------------------------------------------------------------ people and team

export const createPersonRequest = z.object({
  displayName: z.string().trim().min(1).max(120),
  handles: z.record(z.string(), z.string()).optional(),
});
export type CreatePersonRequest = z.infer<typeof createPersonRequest>;

export const updatePersonRequest = createPersonRequest.partial();
export type UpdatePersonRequest = z.infer<typeof updatePersonRequest>;

const memberTitle = z.string().max(120).nullable().optional();

export const addMemberRequest = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('person'),
    personId: z.string().min(1),
    reportsTo: z.string().min(1).nullable().optional(),
    access: z.enum(ACCESS_LEVELS).optional(),
    oversight: z.enum(OVERSIGHT_MODES).optional(),
    title: memberTitle,
    roleIds: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    kind: z.literal('agent'),
    name: z.string().trim().min(1).max(120),
    // An agent acts on its owner's authority, so it cannot be added without one.
    reportsTo: z.string().min(1),
    roleIds: z.array(z.string().min(1)).min(1),
    runtimeProfileIds: z.array(z.string().min(1)).optional(),
    integrationIds: z.array(z.string().min(1)).optional(),
    title: memberTitle,
  }),
]);
export type AddMemberRequest = z.infer<typeof addMemberRequest>;

/** Removal has its own endpoint; `status` here only brings a removed member back. */
export const updateMemberRequest = z.object({
  name: z.string().trim().min(1).max(120),
  reportsTo: z.string().min(1).nullable(),
  access: z.enum(ACCESS_LEVELS),
  oversight: z.enum(OVERSIGHT_MODES),
  title: z.string().max(120).nullable(),
  roleIds: z.array(z.string().min(1)),
  runtimeProfileIds: z.array(z.string().min(1)),
  integrationIds: z.array(z.string().min(1)),
  status: z.literal('active'),
}).partial();
export type UpdateMemberRequest = z.infer<typeof updateMemberRequest>;

/** `null` clears the task's own override. */
export const taskStaffingPatchRequest = staffingPatchSchema.nullable();
export type TaskStaffingPatchRequest = z.infer<typeof taskStaffingPatchRequest>;

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

export const missionFeedQuery = z.object({
  /** How many done cards to return; the rest are counted in `doneTotal`. */
  doneLimit: z.coerce.number().int().min(0).max(500).optional(),
});

export const missionArtifactsQuery = z.object({
  // An enum, not `z.coerce.boolean()`: that reads the string 'false' as true.
  includeSuperseded: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

/** `GET /v1/artifacts`: search stays on current versions unless older ones are asked for. */
export const artifactSearchQuery = z.object({
  workspaceId: z.string().optional(),
  q: z.string().optional(),
  includeSuperseded: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

export const retryTaskRequest = z.object({
  /** Override the runtime for this attempt - the manual fallback escape hatch. */
  runtimeProfileId: z.string().optional(),
  /** Stored as a feedback item and started as a round, so it takes a note's full length. */
  note: z.string().max(4000).optional(),
  /**
   * Capabilities to add before retrying. Still narrowed to the role's own
   * defaults when grants are built, so this widens a task within what its role
   * may do - never beyond it.
   */
  addCapabilities: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
});

// ------------------------------------------------------------ feedback and rounds

/** A note on a task's output (spec §2); what it does depends on the task's state. */
export const giveFeedbackRequest = z.object({
  text: z.string().trim().min(1).max(4000),
  /** Feedback about one output of the task; omitted for the whole task. */
  artifactId: z.string().min(1).optional(),
  onBehalfOf,
});
export type GiveFeedbackRequest = z.infer<typeof giveFeedbackRequest>;

/** Confirms a round that waited on the downstream choice (spec §3). */
export const startRoundRequest = z.object({
  feedbackIds: z.array(z.string().min(1)).min(1).max(50),
  // "none" says the caller saw nothing downstream; if work used the output since, the round is refused rather than kept silently.
  downstream: z.enum(['redo', 'keep', 'none']),
  redoTaskIds: z.array(z.string().min(1)).max(200).optional(),
  onBehalfOf,
});
export type StartRoundRequest = z.infer<typeof startRoundRequest>;

export const dismissFeedbackRequest = z.object({ onBehalfOf });
export type DismissFeedbackRequest = z.infer<typeof dismissFeedbackRequest>;

export const cancelMissionRequest = z.object({
  reason: z.string().max(500).optional(),
});
