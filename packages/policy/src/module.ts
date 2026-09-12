import { defineModule, token, type TandemiseModule } from '@tandemise/kernel';
import type { Clock } from '@tandemise/shared';
import { systemClock } from '@tandemise/shared';
import { createApprovalFactory, type ApprovalFactory } from './approvals.js';
import { createPolicyEngine, type PolicyEngine } from './engine.js';
import { createGrantBuilder, type GrantBuilder } from './grants.js';
import { createRiskClassifier, type RiskClassifier } from './risk.js';

export const RISK_CLASSIFIER = token<RiskClassifier>('RiskClassifier');
export const POLICY_ENGINE = token<PolicyEngine>('PolicyEngine');
export const GRANT_BUILDER = token<GrantBuilder>('GrantBuilder');
export const APPROVAL_FACTORY = token<ApprovalFactory>('ApprovalFactory');

export interface PolicyModuleOptions {
  /**
   * Injected rather than resolved from a container token because there is no
   * lower-layer package that owns a `Clock` token, and inventing one here would
   * make every other package import `@tandemise/policy` to reach it.
   */
  readonly clock?: Clock;
}

export function createPolicyModule(options: PolicyModuleOptions = {}): TandemiseModule {
  const clock = options.clock ?? systemClock;
  return defineModule('policy', (container) => {
    const source = 'policy';
    container.bind(RISK_CLASSIFIER, () => createRiskClassifier(), { source });
    container.bind(POLICY_ENGINE, (r) => createPolicyEngine({ clock, classifier: r.resolve(RISK_CLASSIFIER) }), { source });
    container.bind(GRANT_BUILDER, () => createGrantBuilder({ clock }), { source });
    container.bind(APPROVAL_FACTORY, () => createApprovalFactory({ clock }), { source });
  });
}

/** Convenience binding for composition roots that use the system clock. */
export const policyModule: TandemiseModule = createPolicyModule();
