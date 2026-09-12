import type { IntegrationId, Logger, RunId, WorkerAssignmentId } from '@tandemise/shared';
import type {
  Capability, ExternalRef, RiskClass, ToolDescriptor, WorkerAssignment,
} from '@tandemise/domain';
import type { z } from 'zod';
import type { CommandExecutor } from './exec.js';
import { toJsonSchema } from './json-schema.js';

/**
 * Everything a tool is allowed to know about the work it is running inside
 * (MVP.md §12.3).
 *
 * Note what is absent: no credentials, no repository handle, no container. A
 * tool that needs to run a command receives an `exec` it did not create, which
 * is what keeps `child_process` out of every package above the execution layer
 * and makes every tool trivially testable with a fake executor.
 */
export interface ToolContext {
  readonly assignment: WorkerAssignment;
  /** Always `assignment.id`; carried separately because audit and policy want it. */
  readonly assignmentId: WorkerAssignmentId;
  readonly runId: RunId | null;
  readonly workingDirectory: string;
  readonly logger: Logger;
  readonly exec: CommandExecutor;
  /** Aborting must abandon in-flight work, not merely stop reporting it. */
  readonly signal: AbortSignal;
}

/**
 * Bytes a tool produced that the caller may want to persist as an `Evidence`
 * artifact - a screenshot, a HAR, a console dump.
 *
 * Tools return bytes and a suggested filename and stop there. Writing an
 * artifact needs a mission, a workspace and an artifact store, all of which
 * live in the application layer; a tool that wrote its own artifacts would have
 * to reach up a layer to get them (MVP.md §15).
 */
export interface ToolEvidence {
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly title: string;
}

/** What a tool's `execute` returns. The broker turns this into a `ToolResult`. */
export interface ToolExecution<O = unknown> {
  readonly output: O;
  /** One line for the timeline. Omitted means "the broker summarises output". */
  readonly summary?: string;
  readonly evidence?: readonly ToolEvidence[];
  readonly externalRefs?: readonly ExternalRef[];
}

export type ToolOutcome = 'ok' | 'denied' | 'error';

/** The normalized record of one invocation, returned to every caller. */
export interface ToolResult<O = unknown> {
  readonly tool: string;
  readonly outcome: ToolOutcome;
  /** Present only when `outcome === 'ok'`. */
  readonly output: O | undefined;
  readonly summary: string;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly evidence: readonly ToolEvidence[];
  readonly externalRefs: readonly ExternalRef[];
  readonly durationMs: number;
}

/**
 * A single invocable action (MVP.md §12.3).
 *
 * `inputSchema` is zod rather than the raw JSON Schema of §12.3 because the
 * broker must validate agent-supplied input before anything runs; the JSON
 * Schema the wire needs is derived from it (`toolDescriptor`). One source of
 * truth, two representations.
 */
export interface IntegrationTool<I = unknown, O = unknown> {
  readonly name: string;
  /** Null for built-in tools that are not backed by a configured integration. */
  readonly integrationId: IntegrationId | null;
  readonly capability: Capability;
  readonly risk: RiskClass;
  readonly description: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema?: z.ZodType<O>;
  /**
   * The concrete thing this call touches - a path, a host, a repository - so a
   * grant scoped to `cli/cli` can be enforced without the policy layer knowing
   * what a GitHub tool's arguments look like.
   */
  resource?(input: I): string | undefined;
  execute(ctx: ToolContext, input: I): Promise<ToolExecution<O>>;
}

/** The serialisable view of a tool, for the API, the UI and the MCP gateway. */
export function toolDescriptor(tool: IntegrationTool): ToolDescriptor {
  const descriptor: ToolDescriptor = {
    name: tool.name,
    integrationId: tool.integrationId,
    capability: tool.capability,
    risk: tool.risk,
    description: tool.description,
    inputSchema: toJsonSchema(tool.inputSchema as z.ZodTypeAny),
  };
  if (!tool.outputSchema) return descriptor;
  return { ...descriptor, outputSchema: toJsonSchema(tool.outputSchema as z.ZodTypeAny) };
}

/**
 * Authoring helper that fixes the input/output types from the schemas, so a
 * tool body gets a typed `input` without the author restating the type.
 */
export function defineTool<I, O>(
  spec: {
    name: string;
    integrationId?: IntegrationId | null;
    capability: Capability;
    risk: RiskClass;
    description: string;
    inputSchema: z.ZodType<I>;
    outputSchema?: z.ZodType<O>;
    resource?: (input: I) => string | undefined;
    execute: (ctx: ToolContext, input: I) => Promise<ToolExecution<O>>;
  },
): IntegrationTool<I, O> {
  return {
    name: spec.name,
    integrationId: spec.integrationId ?? null,
    capability: spec.capability,
    risk: spec.risk,
    description: spec.description,
    inputSchema: spec.inputSchema,
    ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
    ...(spec.resource ? { resource: spec.resource } : {}),
    execute: spec.execute,
  };
}
