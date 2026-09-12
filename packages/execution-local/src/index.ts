export { GitService } from './git/git-service.js';
export type {
  GitCommitResult,
  GitCommitSummary,
  GitDiffStat,
  GitFileChange,
  GitStatus,
  GitStatusEntry,
  GitWorktreeEntry,
  MergeResult,
} from './git/types.js';

export { NodeProcessSupervisor } from './process/node-process-supervisor.js';
export type { SupervisorOptions } from './process/node-process-supervisor.js';
export { LineQueue, LineSplitter } from './process/line-stream.js';

export { DirectoryExecutionTarget } from './targets/directory-target.js';
export type { DirectoryTargetOptions } from './targets/directory-target.js';
export { LocalTargetFactory } from './targets/local-factory.js';
export type { LocalTargetDeps } from './targets/local-factory.js';
export { WorktreeTargetFactory } from './targets/worktree-factory.js';
export type { WorktreeTargetDeps } from './targets/worktree-factory.js';

export { WorkspaceProvisioner } from './workspace-provisioner.js';
export type { MissionLayout, WorkspaceLayout } from './workspace-provisioner.js';

export { executionLocalModule, GIT_SERVICE, WORKSPACE_PROVISIONER } from './module.js';
