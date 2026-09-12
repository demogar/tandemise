export type { CommandExecutor, ToolExecRequest, ToolExecResult } from './exec.js';

export type {
  IntegrationTool, ToolContext, ToolEvidence, ToolExecution, ToolOutcome, ToolResult,
} from './tool.js';
export { defineTool, toolDescriptor } from './tool.js';

export type { JsonSchema } from './json-schema.js';
export { toJsonSchema } from './json-schema.js';

export type { IntegrationHealthContext, IntegrationProvider } from './provider.js';
export { INTEGRATION_PROVIDERS, IntegrationProviderRegistry } from './provider.js';

export type { ToolCatalog } from './catalog.js';
export { IntegrationToolCatalog, StaticToolCatalog } from './catalog.js';

export type {
  ApprovalGate, ToolApprovalDecision, ToolApprovalRequest, ToolPolicyDecision, ToolPolicyGate,
  ToolPolicyRequest,
} from './policy-gate.js';
export {
  denyAllPolicyGate, denyingApprovalGate, grantsPolicyGate, isExpired, resourceInScope,
} from './policy-gate.js';

export type { ToolAuditSink, ToolInvocationAudit } from './audit.js';
export { RecordingAuditSink, loggingAuditSink } from './audit.js';

export type { ToolBrokerDeps } from './broker.js';
export { ToolBroker, unwrapToolResult } from './broker.js';

export { RunScopedToolGateway } from './gateway.js';

export type { McpConfigFile, McpGatewayHandle, McpGatewayRequest, McpServerConfig } from './mcp/config.js';
export { MCP_SERVER_NAME, defaultServerEntryPath, writeMcpGatewayConfig } from './mcp/config.js';

export type { ToolBridgeHandler, ToolBridgeServerOptions } from './mcp/bridge-server.js';
export { ToolBridgeServer, gatewayBridgeHandler } from './mcp/bridge-server.js';

export { ToolBridgeClient } from './mcp/bridge-client.js';

export type { BridgeRequest, BridgeResponse, BridgeToolResult } from './mcp/protocol.js';
export {
  BRIDGE_PROTOCOL_VERSION, BRIDGE_SOCKET_ENV, BRIDGE_TOKEN_ENV, LineStream, toBridgeResult,
} from './mcp/protocol.js';

export type { StdioTransport } from './mcp/stdio-server.js';
export { DEFAULT_MCP_PROTOCOL_VERSION, McpStdioServer, mcpToolName, stdioTransport } from './mcp/stdio-server.js';

export {
  APPROVAL_GATE, CLOCK, COMMAND_EXECUTOR, INTEGRATION_PROVIDER_REGISTRY, INTEGRATION_SOURCE,
  LOGGER, TOOL_AUDIT_SINK, TOOL_BROKER, TOOL_CATALOG, TOOL_POLICY_GATE,
} from './tokens.js';

export { integrationsCoreModule } from './module.js';
