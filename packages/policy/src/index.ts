export { classifyShellCommand, DEFAULT_PROTECTED_BRANCHES } from './shell.js';
export type { ShellClassification, ShellContext, ShellRiskMatch } from './shell.js';

export { createRiskClassifier, riskForCapability } from './risk.js';
export type { RiskAssessment, RiskClassifier, RiskRequest } from './risk.js';

export { absolutePath, hostOf, inferResourceKind, matchesScope } from './scope.js';
export type { ResourceKind, ScopeMatch } from './scope.js';

export { createPolicyEngine } from './engine.js';
export type { PolicyDecision, PolicyEngine, PolicyEngineOptions, PolicyOutcome, PolicyRequest } from './engine.js';

export { createGrantBuilder } from './grants.js';
export type { GrantBuildRequest, GrantBuilder } from './grants.js';

export { createApprovalFactory } from './approvals.js';
export type { ApprovalDraft, ApprovalFactory, DecisionApprovalInput } from './approvals.js';

export {
  isUntrusted, renderTrusted, renderUntrusted, renderWithTrustBoundaries,
  trusted, untrusted, UNTRUSTED_PREAMBLE,
} from './trust.js';
export type { LabelledContent, TrustedContent, TrustLabel, UntrustedContent } from './trust.js';

export {
  APPROVAL_FACTORY, createPolicyModule, GRANT_BUILDER, policyModule, POLICY_ENGINE, RISK_CLASSIFIER,
} from './module.js';
export type { PolicyModuleOptions } from './module.js';
