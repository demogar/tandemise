export type {
  ExecRequest,
  ExecResult,
  ExecutionTarget,
  OutputStream,
  TargetCapability,
} from './exec.js';
export { TARGET_CAPABILITIES, formatCommand } from './exec.js';

export type { FileEntry, FileKind, FileSystemHandle } from './filesystem.js';
export { ScopedFileSystem } from './filesystem.js';

export type {
  LiveProcess,
  ProcessCorrelation,
  ProcessExit,
  ProcessHeartbeat,
  ProcessSpec,
  ProcessSupervisor,
  SupervisedProcess,
} from './process-supervisor.js';
export { BASE_ENV_ALLOWLIST, buildProcessEnv } from './process-supervisor.js';

export type { WorkAttribution } from './attribution.js';

export type {
  ExecutionTargetFactory,
  ProvisionRequest,
  ReleaseOptions,
  ReleaseOutcome,
} from './target-factory.js';
export { ExecutionTargetManager } from './target-factory.js';

export {
  CLOCK,
  EXECUTION_TARGET_FACTORIES,
  EXECUTION_TARGET_MANAGER,
  LOGGER,
  PATHS,
  PROCESS_SUPERVISOR,
} from './tokens.js';

export { executionCoreModule } from './module.js';
