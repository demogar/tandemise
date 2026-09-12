import type {
  AutonomySettings, Capability, CapabilityGrant, RiskClass, WorkerAssignment,
} from '@tandemise/domain';
import { anyCapabilityMatches, capabilityMatches } from '@tandemise/domain';
import type { Clock, Timestamp } from '@tandemise/shared';
import { systemClock } from '@tandemise/shared';
import { createRiskClassifier, type RiskAssessment, type RiskClassifier } from './risk.js';
import { inferResourceKind, matchesScope, type ResourceKind } from './scope.js';
import type { ShellContext } from './shell.js';

/**
 * The permission decision point (MVP.md §19.2: "Default deny: no tool, path,
 * domain, app, or integration action is available without a grant").
 *
 * Every question this engine answers has the same shape: *this assignment*
 * wants to use *this capability* against *this resource*, right now. Nothing
 * else - no conversation history, no model claim about its own intentions, and
 * emphatically nothing returned by a tool - may influence the answer
 * (MVP.md §19.3).
 */
export type PolicyOutcome = 'allow' | 'require_approval' | 'deny';

export interface PolicyRequest {
  readonly capability: Capability;
  /** Path, domain/URL, repository, or app id the action targets. */
  readonly resource?: string;
  /** Override when the caller knows the kind; inferred otherwise. */
  readonly resourceKind?: ResourceKind;
  /** The shell command text, when `capability` is a shell execution. */
  readonly command?: string;
  readonly shell?: ShellContext;
  readonly grants: readonly CapabilityGrant[];
  readonly autonomy: AutonomySettings;
  /** Carried through to the decision so the event log can attribute it. */
  readonly assignmentId?: WorkerAssignment['id'];
}

export interface PolicyDecision {
  readonly outcome: PolicyOutcome;
  readonly risk: RiskClass;
  /** One sentence, written to be shown to the user verbatim. */
  readonly reason: string;
  readonly matchedGrant?: CapabilityGrant;
  readonly assessment: RiskAssessment;
}

export interface PolicyEngine {
  evaluate(request: PolicyRequest): PolicyDecision;
  /** Risk only, for UI preview before anything is attempted. */
  classify(request: PolicyRequest): RiskAssessment;
}

export interface PolicyEngineOptions {
  readonly clock?: Clock;
  readonly classifier?: RiskClassifier;
}

/** allow < require_approval < deny. Combining two constraints takes the max. */
const SEVERITY: Readonly<Record<PolicyOutcome, number>> = { allow: 0, require_approval: 1, deny: 2 };

function stricter(a: PolicyOutcome, b: PolicyOutcome): PolicyOutcome {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export function createPolicyEngine(options: PolicyEngineOptions = {}): PolicyEngine {
  const clock = options.clock ?? systemClock;
  const classifier = options.classifier ?? createRiskClassifier();

  const classify = (request: PolicyRequest): RiskAssessment =>
    classifier.classify({
      capability: request.capability,
      ...(request.command !== undefined ? { command: request.command } : {}),
      ...(request.shell !== undefined ? { shell: request.shell } : {}),
    });

  return {
    classify,
    evaluate(request: PolicyRequest): PolicyDecision {
      const assessment = classify(request);
      const risk = assessment.risk;
      const deny = (reason: string, matchedGrant?: CapabilityGrant): PolicyDecision =>
        ({ outcome: 'deny', risk, reason, assessment, ...(matchedGrant ? { matchedGrant } : {}) });

      // Financial actions are excluded from v0.1 outright (MVP.md §18.2). This
      // check precedes grant matching on purpose: no grant, and no autonomy
      // setting, may re-enable it.
      if (risk === 'financial') {
        return deny(`Financial actions are disallowed in this version (capability '${request.capability}').`);
      }

      if (!anyCapabilityMatches(request.grants.map((g) => g.capability), request.capability)) {
        return deny(`No grant covers capability '${request.capability}'.`);
      }

      const now = clock.now();
      const byCapability = request.grants.filter((g) => capabilityMatches(g.capability, request.capability));
      const live = byCapability.filter((g) => !isExpired(g, now));
      if (live.length === 0) {
        return deny(`Every grant for '${request.capability}' has expired.`, byCapability[0]);
      }

      const inScope: CapabilityGrant[] = [];
      const scopeReasons: string[] = [];
      for (const g of live) {
        if (request.resource === undefined) { inScope.push(g); continue; }
        const kind = request.resourceKind ?? inferResourceKind(request.capability, request.resource);
        const match = matchesScope(kind, request.resource, g.resourceScope);
        if (match.matched) inScope.push(g);
        else scopeReasons.push(`'${g.capability}': ${match.reason}`);
      }
      if (inScope.length === 0) {
        return deny(
          `Capability '${request.capability}' is granted but not for '${request.resource}' (${scopeReasons.join('; ')}).`,
          live[0],
        );
      }

      // An explicit `deny` on any matching grant wins - it is the only way a
      // user can carve a hole out of a broader grant, so it must not be
      // overridable by a more permissive sibling.
      const explicitDeny = inScope.find((g) => g.approvalMode === 'deny');
      if (explicitDeny) {
        return deny(
          `Grant for '${explicitDeny.capability}' explicitly denies this action${explicitDeny.reason ? `: ${explicitDeny.reason}` : '.'}`,
          explicitDeny,
        );
      }

      const matchedGrant = inScope.find((g) => g.approvalMode === 'auto') ?? inScope[0]!;
      const grantFloor: PolicyOutcome = matchedGrant.approvalMode === 'auto' ? 'allow' : 'require_approval';
      const { outcome: riskFloor, reason: riskReason } = floorForRisk(risk, request.autonomy);
      const outcome = stricter(grantFloor, riskFloor);

      const reason = outcome === 'allow'
        ? `Allowed: '${request.capability}' is granted${request.resource ? ` for '${request.resource}'` : ''} and classified ${risk}.`
        : outcome === 'require_approval'
          ? `Approval required: ${grantFloor === 'require_approval' && riskFloor !== 'require_approval'
              ? `the grant for '${matchedGrant.capability}' is set to ask.`
              : riskReason} (${assessment.reason})`
          : `Denied: ${riskReason}`;

      return { outcome, risk, reason, matchedGrant, assessment };
    },
  };
}

function isExpired(grant: CapabilityGrant, now: Timestamp): boolean {
  return grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.parse(now);
}

/**
 * The floor the risk class imposes regardless of what the grant says, read off
 * the workspace autonomy dials (MVP.md §18.2 and Appendix A).
 */
function floorForRisk(risk: RiskClass, autonomy: AutonomySettings): { outcome: PolicyOutcome; reason: string } {
  switch (risk) {
    case 'read':
      return { outcome: 'allow', reason: 'reads are auto-allowed within granted scope' };
    case 'write_reversible':
      return autonomy.localCodeChanges === 'ask'
        ? { outcome: 'require_approval', reason: 'this workspace asks before local changes' }
        : { outcome: 'allow', reason: 'reversible local changes are auto-allowed in the mission workspace' };
    case 'external_side_effect':
      switch (autonomy.externalWrites) {
        case 'deny': return { outcome: 'deny', reason: 'this workspace forbids external writes' };
        case 'ask': return { outcome: 'require_approval', reason: 'this workspace asks before external writes' };
        // 'policy' means "whatever the grant says", and the grant was already
        // checked; 'auto' means allow. Both land on the grant's own floor.
        case 'auto':
        case 'policy': return { outcome: 'allow', reason: 'external writes follow the grant' };
      }
    case 'destructive':
      return { outcome: 'require_approval', reason: 'destructive actions always require human approval' };
    case 'release':
      return autonomy.productionRelease === 'deny'
        ? { outcome: 'deny', reason: 'this workspace forbids production releases' }
        : { outcome: 'require_approval', reason: 'release actions always require human approval' };
    case 'financial':
      return { outcome: 'deny', reason: 'financial actions are disallowed in this version' };
  }
}
