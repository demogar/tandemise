import type { Clock } from '@tandemise/shared';
import { TandemiseError } from '@tandemise/shared';
import type { CapabilityGrant, ToolDescriptor, WorkerAssignment } from '@tandemise/domain';
import { capabilityMatches } from '@tandemise/domain';
import type { ToolBroker } from './broker.js';
import { StaticToolCatalog } from './catalog.js';
import { isExpired } from './policy-gate.js';
import type { IntegrationTool, ToolContext, ToolResult } from './tool.js';
import { toolDescriptor } from './tool.js';

/**
 * The tool surface one worker assignment can see (MVP.md §12.4).
 *
 * The important word is *see*. Filtering at the point of invocation would still
 * leave a QA worker able to enumerate the finance and production-write tools
 * and learn that they exist, which is itself information the assignment was not
 * granted. So the gateway narrows the broker's *catalog*: an ungranted tool is
 * absent from the listing, and an invocation of it takes the broker's
 * unknown-tool path - the same answer a genuinely nonexistent tool gets.
 *
 * Visibility is decided by capability alone. Resource scoping ("this grant only
 * covers `cli/cli`") is a per-call question, because the resource is not known
 * until there is an input; the policy gate answers it at `invoke`.
 */
export class RunScopedToolGateway {
  readonly #broker: ToolBroker;

  private constructor(
    readonly assignment: WorkerAssignment,
    broker: ToolBroker,
    readonly tools: readonly IntegrationTool[],
  ) {
    this.#broker = broker.withCatalog(new StaticToolCatalog(tools));
  }

  static for(broker: ToolBroker, assignment: WorkerAssignment, clock: Clock): RunScopedToolGateway {
    const usable = assignment.grants.filter((g) => isUsable(g, clock));
    const visible = broker.tools().filter((tool) =>
      usable.some((g) => capabilityMatches(g.capability, tool.capability)),
    );
    return new RunScopedToolGateway(assignment, broker, visible);
  }

  describe(): readonly ToolDescriptor[] {
    return this.tools.map(toolDescriptor);
  }

  names(): readonly string[] {
    return this.tools.map((t) => t.name);
  }

  async invoke(toolName: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.assignmentId !== this.assignment.id) {
      // A context from another assignment would carry the wrong grants into the
      // policy gate. That is a wiring bug, not a policy decision.
      throw TandemiseError.validation(
        `Tool context belongs to assignment '${ctx.assignmentId}', not '${this.assignment.id}'`,
      );
    }
    return this.#broker.invoke(toolName, input, ctx);
  }
}

/** An expired grant and a deny-mode grant both contribute nothing to visibility. */
function isUsable(grant: CapabilityGrant, clock: Clock): boolean {
  return grant.approvalMode !== 'deny' && !isExpired(grant, clock);
}
