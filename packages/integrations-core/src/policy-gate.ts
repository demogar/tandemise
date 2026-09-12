import type { ApprovalId, Clock, WorkerAssignmentId } from '@tandemise/shared';
import { isPathInside } from '@tandemise/shared';
import type { Capability, CapabilityGrant, RiskClass, WorkerAssignment } from '@tandemise/domain';
import { capabilityMatches } from '@tandemise/domain';

export interface ToolPolicyRequest {
  readonly toolName: string;
  readonly capability: Capability;
  /** Path, host, or repository the call targets. Absent means "not resource-scoped". */
  readonly resource?: string;
  readonly assignmentId: WorkerAssignmentId;
  readonly risk: RiskClass;
}

export interface ToolPolicyDecision {
  readonly outcome: 'allow' | 'require_approval' | 'deny';
  readonly reason: string;
  readonly risk: RiskClass;
}

/**
 * The broker's view of the policy engine (MVP.md §19).
 *
 * A port rather than a direct dependency on `@tandemise/policy`: the broker
 * needs exactly one question answered and nothing else, and keeping the surface
 * this small means the engine can grow without the enforcement point changing.
 */
export interface ToolPolicyGate {
  check(request: ToolPolicyRequest): Promise<ToolPolicyDecision>;
}

export interface ToolApprovalRequest {
  readonly toolName: string;
  readonly capability: Capability;
  readonly resource?: string;
  readonly assignmentId: WorkerAssignmentId;
  readonly risk: RiskClass;
  /** Why policy asked for a human, verbatim from the decision. */
  readonly reason: string;
  /** Redacted one-line summary of what the tool was asked to do. */
  readonly inputSummary: string;
}

export interface ToolApprovalDecision {
  readonly approved: boolean;
  readonly reason: string;
  readonly approvalId: ApprovalId | null;
  /**
   * Which option the human picked, when the card offered more than yes/no.
   *
   * An authorization only needs `approved`. A question needs to know *what* was
   * answered, and the answer is the option plus whatever note came with it.
   */
  readonly selectedOptionId?: string | null;
}

/**
 * Blocks on a human (MVP.md §18).
 *
 * `require_approval` has to be able to *wait*, otherwise every ask-mode grant
 * degrades into a failure and the product's whole approval story collapses into
 * "retry and hope". Implementations create an `Approval` and resolve when the
 * user answers or the request expires.
 */
export interface ApprovalGate {
  requestApproval(
    request: ToolApprovalRequest,
    signal: AbortSignal,
  ): Promise<ToolApprovalDecision>;
}

/**
 * The fallback when no approval surface is attached (headless tests, a daemon
 * with no connected client). Denying is the only safe answer: an unanswerable
 * question is not consent.
 */
export const denyingApprovalGate: ApprovalGate = {
  requestApproval: async (request) => ({
    approved: false,
    reason: `No approval surface is attached; '${request.toolName}' cannot be authorized`,
    approvalId: null,
  }),
};

/**
 * A policy gate that consults only the assignment's own grants (MVP.md §27.4).
 *
 * This is the floor, not the ceiling. The real engine in `@tandemise/policy`
 * layers workspace policy, risk escalation and rate limits on top; it is bound
 * over this one at composition. Keeping a working default here means the broker
 * is never accidentally wired to "no gate", which would read as allow-all.
 */
export function grantsPolicyGate(
  lookup: (id: WorkerAssignmentId) => WorkerAssignment | undefined,
  clock: Clock,
): ToolPolicyGate {
  return {
    check: async (request) => {
      const assignment = lookup(request.assignmentId);
      if (!assignment) {
        return deny(request, `No assignment '${request.assignmentId}' is known`);
      }
      const matching = assignment.grants.filter(
        (g) => capabilityMatches(g.capability, request.capability) && !isExpired(g, clock),
      );
      if (matching.length === 0) {
        return deny(request, `No grant covers capability '${request.capability}'`);
      }
      const inScope = matching.filter((g) => resourceInScope(g.resourceScope, request.resource));
      if (inScope.length === 0) {
        return deny(
          request,
          `Grant for '${request.capability}' does not cover resource '${request.resource ?? ''}'`,
        );
      }
      // Most permissive wins: a broad auto grant is not undone by a narrower
      // ask grant that also happens to match.
      if (inScope.some((g) => g.approvalMode === 'auto')) {
        return { outcome: 'allow', reason: `Granted by assignment policy`, risk: request.risk };
      }
      if (inScope.some((g) => g.approvalMode === 'ask')) {
        return {
          outcome: 'require_approval',
          reason: `'${request.capability}' is granted in ask mode`,
          risk: request.risk,
        };
      }
      return deny(request, `'${request.capability}' is explicitly denied by the assignment`);
    },
  };
}

/** Every gate outcome carries the risk of the request, so audit never guesses. */
function deny(request: ToolPolicyRequest, reason: string): ToolPolicyDecision {
  return { outcome: 'deny', reason, risk: request.risk };
}

export function isExpired(grant: CapabilityGrant, clock: Clock): boolean {
  return grant.expiresAt !== null && Date.parse(grant.expiresAt) <= clock.epochMs();
}

/**
 * Whether a grant's `resourceScope` covers a concrete resource.
 *
 * An empty scope is unrestricted - that is what "grant the capability, no
 * narrowing" means. A scope entry matches exactly, as a `*` wildcard, as a
 * `*.suffix` host pattern, or as a containing directory when both sides look
 * like absolute paths.
 */
export function resourceInScope(scope: readonly string[], resource: string | undefined): boolean {
  if (scope.length === 0) return true;
  if (resource === undefined) return true;
  return scope.some((entry) => scopeEntryMatches(entry, resource));
}

function scopeEntryMatches(entry: string, resource: string): boolean {
  if (entry === '*' || entry === resource) return true;
  if (entry.startsWith('*.')) {
    const suffix = entry.slice(1); // ".example.com"
    return resource.endsWith(suffix) || resource === entry.slice(2);
  }
  if (entry.startsWith('/') && resource.startsWith('/')) return isPathInside(entry, resource);
  return false;
}

/**
 * The gate used when no policy engine has been bound.
 *
 * Deliberately not permissive. A missing engine is a composition bug, and the
 * failure mode of an allow-all default is that the bug ships silently as an
 * authorization hole (MVP.md §19.1 - default deny).
 */
export const denyAllPolicyGate: ToolPolicyGate = {
  check: async (request) => ({
    outcome: 'deny',
    reason: 'No policy engine is bound; every tool invocation is denied',
    risk: request.risk,
  }),
};
