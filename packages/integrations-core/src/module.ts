import { defineModule, type Resolver } from '@tandemise/kernel';
import { nullLogger, systemClock, type Logger } from '@tandemise/shared';
import { ToolBroker } from './broker.js';
import { IntegrationToolCatalog } from './catalog.js';
import { loggingAuditSink } from './audit.js';
import { denyAllPolicyGate, denyingApprovalGate } from './policy-gate.js';
import { INTEGRATION_PROVIDERS, IntegrationProviderRegistry } from './provider.js';
import {
  APPROVAL_GATE, CLOCK, INTEGRATION_PROVIDER_REGISTRY, INTEGRATION_SOURCE, LOGGER,
  TOOL_AUDIT_SINK, TOOL_BROKER, TOOL_CATALOG, TOOL_POLICY_GATE,
} from './tokens.js';

/**
 * Binds the integration core.
 *
 * Every optional collaborator resolves through `tryResolve` with a default, and
 * the two security-relevant defaults - the policy gate and the approval gate -
 * both refuse. A half-composed system is therefore inert rather than open.
 *
 * `INTEGRATION_PROVIDERS` is resolved lazily inside the factory so provider
 * modules may be composed in any order relative to this one.
 */
export const integrationsCoreModule = defineModule('integrations-core', (container) => {
  container.bind(
    INTEGRATION_PROVIDER_REGISTRY,
    (r) => new IntegrationProviderRegistry(r.resolveAll(INTEGRATION_PROVIDERS)),
    { source: 'integrations-core' },
  );

  container.bind(
    TOOL_CATALOG,
    (r) => new IntegrationToolCatalog(
      r.resolve(INTEGRATION_PROVIDER_REGISTRY),
      r.tryResolve(INTEGRATION_SOURCE) ?? (() => []),
      log(r).child({ component: 'tool-catalog' }),
    ),
    { source: 'integrations-core' },
  );

  container.bind(
    TOOL_BROKER,
    (r) => new ToolBroker({
      catalog: r.resolve(TOOL_CATALOG),
      policy: r.tryResolve(TOOL_POLICY_GATE) ?? denyAllPolicyGate,
      approvals: r.tryResolve(APPROVAL_GATE) ?? denyingApprovalGate,
      audit: r.tryResolve(TOOL_AUDIT_SINK) ?? loggingAuditSink(log(r).child({ component: 'tool-audit' })),
      clock: r.tryResolve(CLOCK) ?? systemClock,
      log: log(r).child({ component: 'tool-broker' }),
    }),
    { source: 'integrations-core' },
  );
});

function log(r: Resolver): Logger {
  return r.tryResolve(LOGGER) ?? nullLogger;
}
