export { RUNTIME_ADAPTERS, describeAdapter } from './adapter.js';
export type { AgentRuntimeAdapter, RunRequest, RuntimeAdapterDescriptor } from './adapter.js';

export { RuntimeRegistry, RUNTIME_REGISTRY } from './registry.js';

export { RuntimeManager, RUNTIME_MANAGER, DEFAULT_HEALTH_TTL_MS } from './manager.js';
export type {
  RuntimeManagerOptions, RuntimeRejection, RuntimeSelection, RuntimeSelectionFailure,
} from './manager.js';

export { NormalizingEventSink } from './event-sink.js';
export type { NormalizingEventSinkOptions } from './event-sink.js';

export { normalizeAgentEvent, isTerminalEvent, MAX_SUMMARY_CHARS, MAX_TEXT_CHARS } from './normalize.js';

export { LineAssembler } from './line-assembler.js';

export {
  DEFAULT_TERMINATION_GRACE_MS, classifyAbort, escalateTerminationOnAbort, withWallTimeBudget,
} from './termination.js';
export type { AbortOutcome, Terminable } from './termination.js';

export { runtimesCoreModule, defineRuntimeModule, RUNTIMES_CORE_MODULE_NAME } from './module.js';
/** Re-exported so a runtime plugin can name its module type without depending on the kernel. */
export type { TandemiseModule } from '@tandemise/kernel';
