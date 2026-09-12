export { ClaudeCodeAdapter, CLAUDE_ADAPTER_ID, CLAUDE_CAPABILITIES } from './adapter.js';
export type { ClaudeCodeAdapterOptions } from './adapter.js';

export { ClaudeEventMapper } from './event-mapper.js';
export type { ClaudeEventMapperOptions } from './event-mapper.js';

export {
  CAPABILITY_TOOL_GUARDS, MAX_PROMPT_ARG_CHARS, PERMISSION_MODES,
  buildInvocation, disallowedTools, permissionMode,
} from './cli-args.js';
export type { ClaudeInvocation, PermissionMode } from './cli-args.js';

export {
  CLAUDE_EXECUTABLE, VERSION_PROBE_TIMEOUT_MS, findExecutable, parseVersion, probeVersion, requireExecutable,
} from './discovery.js';
export type { VersionProbe } from './discovery.js';

export { claudeRuntimeModule } from './module.js';
