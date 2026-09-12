import { multiToken, token } from '@tandemise/kernel';
import type { Clock, Logger } from '@tandemise/shared';
import type { Integration } from '@tandemise/domain';
import type { ToolBroker } from './broker.js';
import type { ToolCatalog } from './catalog.js';
import type { IntegrationTool } from './tool.js';
import type { ToolAuditSink } from './audit.js';
import type { ApprovalGate, ToolPolicyGate } from './policy-gate.js';
import type { IntegrationProviderRegistry } from './provider.js';
import type { BackgroundProcessLauncher, CommandExecutor } from './exec.js';

/**
 * `LOGGER` and `CLOCK` are declared here rather than imported because
 * `@tandemise/execution-core`, which currently owns them, sits on the same
 * layer and is therefore off-limits. Its own comment says these three
 * cross-cutting tokens belong in `@tandemise/kernel`; until they move, the
 * composition root must bind the logger and clock once per token identity.
 */
export const LOGGER = token<Logger>('tandemise/logger');
export const CLOCK = token<Clock>('tandemise/clock');

export const INTEGRATION_PROVIDER_REGISTRY =
  token<IntegrationProviderRegistry>('integrations/provider-registry');
export const TOOL_CATALOG = token<ToolCatalog>('integrations/tool-catalog');
export const TOOL_BROKER = token<ToolBroker>('integrations/tool-broker');
export const TOOL_POLICY_GATE = token<ToolPolicyGate>('integrations/policy-gate');
export const APPROVAL_GATE = token<ApprovalGate>('integrations/approval-gate');
export const TOOL_AUDIT_SINK = token<ToolAuditSink>('integrations/audit-sink');

/** How the daemon spawns commands for CLI-transport integrations. */
export const COMMAND_EXECUTOR = token<CommandExecutor>('integrations/command-executor');

/** How the daemon starts long-lived child processes, e.g. a repository dev server. */
export const BACKGROUND_PROCESS_LAUNCHER =
  token<BackgroundProcessLauncher>('integrations/background-process-launcher');

/**
 * The workspace's configured integrations. A thunk, not a snapshot: these are
 * database rows, and enabling an integration must take effect without
 * rebuilding the broker.
 */
export const INTEGRATION_SOURCE =
  token<() => readonly Integration[]>('integrations/source');

/**
 * Tools that belong to no configured integration.
 *
 * Everything a worker can do arrives through an `Integration` row, which is
 * right for anything with a vendor behind it - there is no GitHub without a
 * GitHub. A few capabilities have no vendor and cannot sensibly be switched
 * off: asking the supervising human a question is the first. Making that a
 * configurable integration would mean a workspace could accidentally remove a
 * worker's ability to ask, which is not a setting anyone wants to own.
 *
 * Contributed to rather than bound, so a package may add one without the core
 * naming it - the same seam `INTEGRATION_PROVIDERS` uses.
 */
export const BUILT_IN_TOOLS = multiToken<IntegrationTool>('integrations/built-in-tool');
