import { defineModule, token, type Resolver } from '@tandemise/kernel';
import { createPaths, nullLogger, systemClock, type Clock, type Logger, type TandemisePaths } from '@tandemise/shared';
import {
  CLOCK,
  EXECUTION_TARGET_FACTORIES,
  LOGGER,
  PATHS,
  PROCESS_SUPERVISOR,
} from '@tandemise/execution-core';
import { GitService } from './git/git-service.js';
import { NodeProcessSupervisor } from './process/node-process-supervisor.js';
import { LocalTargetFactory } from './targets/local-factory.js';
import { WorktreeTargetFactory } from './targets/worktree-factory.js';
import { WorkspaceProvisioner } from './workspace-provisioner.js';

export const GIT_SERVICE = token<GitService>('execution-local/git');
export const WORKSPACE_PROVISIONER = token<WorkspaceProvisioner>('execution-local/workspace-provisioner');

/**
 * The provider half of execution: process spawning, git, and the `local` and
 * `worktree` target kinds. Composition root wiring is one line
 * (`compose(c, executionCoreModule, executionLocalModule)`); nothing above this
 * package names `child_process` or `git`.
 */
export const executionLocalModule = defineModule(
  'execution-local',
  (c) => {
    c.bind(PROCESS_SUPERVISOR, (r) => new NodeProcessSupervisor(log(r).child({ component: 'supervisor' }), { clock: clock(r) }), {
      source: 'execution-local',
      // Shutdown must reap children before the daemon exits (MVP.md §7.3).
      dispose: (supervisor) => supervisor.killAll('daemon shutdown'),
    });

    c.bind(GIT_SERVICE, (r) => new GitService(r.resolve(PROCESS_SUPERVISOR), log(r).child({ component: 'git' })), {
      source: 'execution-local',
    });

    c.bind(WORKSPACE_PROVISIONER, (r) => new WorkspaceProvisioner(paths(r), log(r)), {
      source: 'execution-local',
    });

    c.contribute(
      EXECUTION_TARGET_FACTORIES,
      (r) =>
        new LocalTargetFactory({
          supervisor: r.resolve(PROCESS_SUPERVISOR),
          git: r.resolve(GIT_SERVICE),
          log: log(r).child({ target: 'local' }),
          clock: clock(r),
        }),
      { source: 'execution-local' },
    );

    c.contribute(
      EXECUTION_TARGET_FACTORIES,
      (r) =>
        new WorktreeTargetFactory({
          git: r.resolve(GIT_SERVICE),
          supervisor: r.resolve(PROCESS_SUPERVISOR),
          provisioner: r.resolve(WORKSPACE_PROVISIONER),
          log: log(r).child({ target: 'worktree' }),
          clock: clock(r),
        }),
      { source: 'execution-local' },
    );
  },
  ['execution-core'],
);

// The daemon binds these; the defaults keep the package usable on its own (in a
// test or a one-off script) without every consumer having to wire three tokens.
const log = (r: Resolver): Logger => r.tryResolve(LOGGER) ?? nullLogger;
const clock = (r: Resolver): Clock => r.tryResolve(CLOCK) ?? systemClock;
const paths = (r: Resolver): TandemisePaths => r.tryResolve(PATHS) ?? createPaths();
