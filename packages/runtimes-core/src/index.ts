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

export { runtimesCoreModule } from './module.js';
