import type { Container, Resolver } from '@tandemise/kernel';
import { CLOCK as EXECUTION_CLOCK, LOGGER as EXECUTION_LOGGER, PATHS as EXECUTION_PATHS } from '@tandemise/execution-core';
import { TandemiseError, createPaths, nullLogger, systemClock } from '@tandemise/shared';
import type { BrainHostPort, BrainRepoPort } from '@tandemise/domain';
import * as t from '../tokens.js';
import * as b from './tokens.js';
import { BrainService } from './brain-service.js';
import { BrainSyncLoop } from './sync-loop.js';

const SOURCE = '@tandemise/application:brain';

const noGit = (): never => {
  throw new TandemiseError('PRECONDITION_FAILED', 'Brains need git on this machine.');
};

/**
 * The brain's bindings (#51), kept out of `../module.ts`, which other work
 * edits in parallel. The defaults keep the application usable without git or
 * gh; the daemon rebinds both ports.
 */
export function bindBrain(container: Container): void {
  const repo: BrainRepoPort = {
    clone: noGit, init: noGit, setRemote: noGit, head: noGit, fetchAndRebase: noGit, commit: noGit, push: noGit,
    branch: noGit, moveUnpushedTo: noGit, fastForward: noGit, revert: noGit, readAt: noGit, listAt: noGit, diffAt: noGit,
  };
  const host: BrainHostPort = {
    available: async () => ({ ok: false, reason: 'GitHub CLI is not connected.' }),
    createRepo: async () => { throw new TandemiseError('PRECONDITION_FAILED', 'GitHub CLI is not connected.'); },
    openPr: async () => { throw new TandemiseError('PRECONDITION_FAILED', 'GitHub CLI is not connected.'); },
    findPr: async () => null,
    prState: async () => null,
  };
  container.bind(b.BRAIN_REPO, () => repo, { source: SOURCE });
  container.bind(b.BRAIN_HOST, () => host, { source: SOURCE });

  container.bind(b.BRAIN_SERVICE, (r) => new BrainService({
    brains: r.resolve(b.WORKSPACE_BRAIN_REPOSITORY),
    records: r.resolve(b.BRAIN_RECORD_REPOSITORY),
    repo: r.resolve(b.BRAIN_REPO),
    host: r.resolve(b.BRAIN_HOST),
    setup: r.resolve(t.SETUP_SERVICE),
    skills: r.resolve(t.SKILL_SERVICE),
    skillFiles: r.resolve(t.SKILL_FILES),
    decisions: r.resolve(t.DECISION_REPOSITORY),
    workspaces: r.resolve(t.WORKSPACE_SERVICE),
    paths: paths(r),
    settings: r.resolve(t.SETTINGS_STORE),
    identity: r.resolve(t.IDENTITY),
    recorder: r.resolve(t.EVENT_RECORDER),
    clock: clock(r),
    log: log(r).child({ component: 'brain' }),
  }), { source: SOURCE });

  container.bind(b.BRAIN_SYNC_LOOP, (r) => new BrainSyncLoop(
    r.resolve(b.BRAIN_SERVICE), r.resolve(b.WORKSPACE_BRAIN_REPOSITORY), log(r).child({ component: 'brain-sync' }),
  ), { source: SOURCE });
}

const log = (r: Resolver) => r.tryResolve(EXECUTION_LOGGER) ?? nullLogger;
const clock = (r: Resolver) => r.tryResolve(EXECUTION_CLOCK) ?? systemClock;
const paths = (r: Resolver) => r.tryResolve(EXECUTION_PATHS) ?? createPaths();

/**
 * The brain as the services' edit hook and workflow reader, resolved lazily:
 * the brain depends on the setup service, which depends on these services.
 */
export function brainEdits(r: Resolver): { edited(workspaceId: import('@tandemise/shared').WorkspaceId, what: string): void } {
  return { edited: (workspaceId, what) => r.resolve(b.BRAIN_SERVICE).edited(workspaceId, what) };
}

export function brainWorkflows(r: Resolver): import('./workflows.js').BrainWorkflowReader {
  return { brainWorkflows: (workspaceId) => r.resolve(b.BRAIN_SERVICE).brainWorkflows(workspaceId) };
}
