import type { Clock, Logger } from '@tandemise/shared';
import { TandemiseError, errorMessage, summarize } from '@tandemise/shared';
import type { ToolDescriptor } from '@tandemise/domain';
import type { ToolCatalog } from './catalog.js';
import type { ToolAuditSink } from './audit.js';
import type {
  ApprovalGate, ToolApprovalDecision, ToolPolicyDecision, ToolPolicyGate,
} from './policy-gate.js';
import type { IntegrationTool, ToolContext, ToolExecution, ToolResult } from './tool.js';
import { toolDescriptor } from './tool.js';

export interface ToolBrokerDeps {
  readonly catalog: ToolCatalog;
  readonly policy: ToolPolicyGate;
  readonly approvals: ApprovalGate;
  readonly audit: ToolAuditSink;
  readonly clock: Clock;
  readonly log: Logger;
}

/**
 * The single enforcement point for tool use (MVP.md §12, §19).
 *
 * Every path an agent has to an integration goes through `invoke`, which is
 * what makes validation, policy, approval and audit properties of the *system*
 * rather than habits of whichever adapter was written last. Three rules make
 * that hold:
 *
 *  - **Default deny.** An unknown tool, a policy gate that throws, and a gate
 *    that answers with something unrecognised all deny. There is no path where
 *    the absence of a decision reads as permission.
 *  - **Validate before deciding.** Policy is asked about a *parsed* input, so
 *    the resource a scoped grant is checked against is the resource that will
 *    actually be used.
 *  - **Audit unconditionally.** Denials and validation failures are recorded
 *    exactly like successes; a trail with only successes cannot explain a stall.
 *
 * `invoke` does not throw for expected failures. A denial is an answer the
 * agent needs to read and act on, and an exception crossing the MCP boundary
 * would arrive as an opaque transport error instead.
 */
export class ToolBroker {
  constructor(private readonly deps: ToolBrokerDeps) {}

  /** A broker over a narrowed catalog. The basis of run-scoped tool views. */
  withCatalog(catalog: ToolCatalog): ToolBroker {
    return new ToolBroker({ ...this.deps, catalog });
  }

  tools(): readonly IntegrationTool[] {
    return this.deps.catalog.list();
  }

  describe(): readonly ToolDescriptor[] {
    return this.tools().map(toolDescriptor);
  }

  async invoke(toolName: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const startedAt = this.deps.clock.epochMs();
    const inputSummary = summarize(input, 300);
    const tool = this.deps.catalog.find(toolName);

    if (!tool) {
      // Not NOT_FOUND: from the caller's position an ungranted tool and a
      // nonexistent one are the same thing, and distinguishing them would leak
      // the existence of tools this assignment is not allowed to discover.
      this.#audit(null, ctx, {
        toolName,
        decision: 'deny',
        decisionReason: 'No such tool is available to this assignment',
        approved: null,
        outcome: 'denied',
        resource: null,
        inputSummary,
        outputSummary: '',
        startedAt,
      });
      return this.#failed(toolName, 'denied', 'PERMISSION_DENIED',
        `Tool '${toolName}' is not available to this assignment`, startedAt);
    }

    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      this.#audit(tool, ctx, {
        toolName,
        decision: 'deny',
        decisionReason: `Invalid input: ${detail}`,
        approved: null,
        outcome: 'error',
        resource: null,
        inputSummary,
        outputSummary: '',
        startedAt,
      });
      return this.#failed(toolName, 'error', 'VALIDATION',
        `Invalid input for '${toolName}': ${detail}`, startedAt);
    }
    const value = parsed.data;
    const resource = this.#resourceOf(tool, value);

    const decision = await this.#decide(tool, ctx, resource);
    if (decision.outcome === 'deny') {
      this.#audit(tool, ctx, {
        toolName, decision: 'deny', decisionReason: decision.reason, approved: null,
        outcome: 'denied', resource: resource ?? null, inputSummary, outputSummary: '', startedAt,
      });
      return this.#failed(toolName, 'denied', 'PERMISSION_DENIED',
        `'${toolName}' denied: ${decision.reason}`, startedAt);
    }

    let approval: ToolApprovalDecision | null = null;
    if (decision.outcome === 'require_approval') {
      approval = await this.#askApproval(tool, ctx, decision, resource, inputSummary);
      if (!approval.approved) {
        this.#audit(tool, ctx, {
          toolName, decision: 'require_approval', decisionReason: decision.reason,
          approved: false, outcome: 'denied', resource: resource ?? null,
          inputSummary, outputSummary: '', startedAt,
        });
        return this.#failed(toolName, 'denied', 'PERMISSION_DENIED',
          `'${toolName}' was not approved: ${approval.reason}`, startedAt);
      }
    }

    const auditBase = {
      toolName,
      decision: decision.outcome,
      decisionReason: decision.reason,
      approved: approval ? approval.approved : null,
      resource: resource ?? null,
      inputSummary,
      startedAt,
    } as const;

    try {
      const execution = await tool.execute(ctx, value);
      const result = this.#succeeded(tool, execution, startedAt);
      this.#audit(tool, ctx, { ...auditBase, outcome: result.outcome, outputSummary: result.summary });
      return result;
    } catch (e) {
      const message = errorMessage(e);
      const code = e instanceof TandemiseError ? e.code : 'INTEGRATION_FAILED';
      // A tool may refuse on grounds the policy gate cannot see - an
      // integration-level opt-in, a target that is out of bounds for reasons
      // only the tool knows. That is still a refusal, and it should read as one
      // to the caller and in the audit trail rather than as a malfunction.
      const outcome = code === 'PERMISSION_DENIED' ? 'denied' : 'error';
      this.#audit(tool, ctx, { ...auditBase, outcome, outputSummary: summarize(message, 200) });
      return this.#failed(toolName, outcome, code, message, startedAt);
    }
  }

  /** A gate that throws or answers with an unknown outcome must deny, not pass. */
  async #decide(
    tool: IntegrationTool,
    ctx: ToolContext,
    resource: string | undefined,
  ): Promise<ToolPolicyDecision> {
    try {
      const decision = await this.deps.policy.check({
        toolName: tool.name,
        capability: tool.capability,
        assignmentId: ctx.assignmentId,
        risk: tool.risk,
        ...(resource !== undefined ? { resource } : {}),
      });
      if (decision.outcome === 'allow' || decision.outcome === 'require_approval'
        || decision.outcome === 'deny') {
        return decision;
      }
      return { outcome: 'deny', reason: 'Policy gate returned no usable decision', risk: tool.risk };
    } catch (e) {
      this.deps.log.error('tool.policy_gate_failed', { tool: tool.name, error: errorMessage(e) });
      return { outcome: 'deny', reason: `Policy gate failed: ${errorMessage(e)}`, risk: tool.risk };
    }
  }

  async #askApproval(
    tool: IntegrationTool,
    ctx: ToolContext,
    decision: ToolPolicyDecision,
    resource: string | undefined,
    inputSummary: string,
  ): Promise<ToolApprovalDecision> {
    try {
      return await this.deps.approvals.requestApproval({
        toolName: tool.name,
        capability: tool.capability,
        assignmentId: ctx.assignmentId,
        risk: decision.risk,
        reason: decision.reason,
        inputSummary,
        ...(resource !== undefined ? { resource } : {}),
      }, ctx.signal);
    } catch (e) {
      return { approved: false, reason: `Approval failed: ${errorMessage(e)}`, approvalId: null };
    }
  }

  /**
   * A `resource` extractor is tool-authored code running on agent-supplied
   * input. If it throws, the honest reading is "this call targets something we
   * cannot name", and no scoped grant covers that.
   */
  #resourceOf(tool: IntegrationTool, input: unknown): string | undefined {
    if (!tool.resource) return undefined;
    try {
      return tool.resource(input);
    } catch (e) {
      this.deps.log.warn('tool.resource_extraction_failed', {
        tool: tool.name, error: errorMessage(e),
      });
      return UNRESOLVABLE_RESOURCE;
    }
  }

  #succeeded(tool: IntegrationTool, execution: ToolExecution, startedAt: number): ToolResult {
    if (tool.outputSchema) {
      const parsed = tool.outputSchema.safeParse(execution.output);
      if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return this.#failed(tool.name, 'error', 'INTERNAL',
          `Tool '${tool.name}' produced output that violates its own schema: ${detail}`, startedAt);
      }
    }
    return {
      tool: tool.name,
      outcome: 'ok',
      output: execution.output,
      summary: execution.summary ?? summarize(execution.output, 300),
      error: null,
      evidence: execution.evidence ?? [],
      externalRefs: execution.externalRefs ?? [],
      durationMs: this.deps.clock.epochMs() - startedAt,
    };
  }

  #failed(
    tool: string,
    outcome: 'denied' | 'error',
    code: string,
    message: string,
    startedAt: number,
  ): ToolResult {
    return {
      tool,
      outcome,
      output: undefined,
      summary: message,
      error: { code, message },
      evidence: [],
      externalRefs: [],
      durationMs: this.deps.clock.epochMs() - startedAt,
    };
  }

  #audit(
    tool: IntegrationTool | null,
    ctx: ToolContext,
    fields: {
      toolName: string;
      decision: 'allow' | 'require_approval' | 'deny';
      decisionReason: string;
      approved: boolean | null;
      outcome: 'ok' | 'denied' | 'error';
      resource: string | null;
      inputSummary: string;
      outputSummary: string;
      startedAt: number;
    },
  ): void {
    try {
      this.deps.audit.record({
        toolName: fields.toolName,
        integrationId: tool?.integrationId ?? null,
        capability: tool?.capability ?? 'unknown',
        risk: tool?.risk ?? 'read',
        assignmentId: ctx.assignmentId,
        runId: ctx.runId,
        resource: fields.resource,
        decision: fields.decision,
        decisionReason: fields.decisionReason,
        approved: fields.approved,
        outcome: fields.outcome,
        inputSummary: fields.inputSummary,
        outputSummary: fields.outputSummary,
        durationMs: this.deps.clock.epochMs() - fields.startedAt,
        at: this.deps.clock.now(),
      });
    } catch (e) {
      // A broken audit sink must not become a way to block tool use, but it has
      // to be loud: the trail is a compliance surface, not a convenience.
      this.deps.log.error('tool.audit_failed', { tool: fields.toolName, error: errorMessage(e) });
    }
  }
}

/**
 * Stands in for a resource whose extractor failed. Chosen so that it cannot be
 * produced by a real path, host or repository name, and therefore matches no
 * scope entry.
 */
const UNRESOLVABLE_RESOURCE = ' unresolvable';

/** For callers that prefer exceptions - Tandemise's own internal call sites. */
export function unwrapToolResult<O>(result: ToolResult<O>): O {
  if (result.outcome === 'ok') return result.output as O;
  const code = result.error?.code;
  throw new TandemiseError(
    code === 'PERMISSION_DENIED' ? 'PERMISSION_DENIED'
      : code === 'VALIDATION' ? 'VALIDATION' : 'INTEGRATION_FAILED',
    result.error?.message ?? `Tool '${result.tool}' failed`,
    { details: { tool: result.tool } },
  );
}
