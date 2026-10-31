import type { Container, Resolver } from '@tandemise/kernel';
import { CLOCK as EXECUTION_CLOCK, LOGGER as EXECUTION_LOGGER, PATHS as EXECUTION_PATHS } from '@tandemise/execution-core';
import { TandemiseError, createPaths, nullLogger, systemClock } from '@tandemise/shared';
import type { BrainHostPort, BrainRepoPort } from '@tandemise/domain';
import * as t from '../tokens.js';
import * as b from './tokens.js';
import { BrainService } from './brain-service.js';
import { BrainSyncLoop } from './sync-loop.js';
import { BrainContextSupply } from './context-supply.js';
import { BrainSignals } from './signals.js';
import { ServiceEvalPort } from './eval-gates.js';
import { RUNTIME_MANAGER } from '@tandemise/runtimes-core';
import { BUILT_IN_TOOLS } from '@tandemise/integrations-core';
import { createBrainTools } from '../tools/brain-tools.js';

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
    missions: r.resolve(t.MISSION_REPOSITORY),
    tasks: r.resolve(t.TASK_REPOSITORY),
    runs: r.resolve(t.RUN_REPOSITORY),
    runScores: r.resolve(t.RUN_SCORE_REPOSITORY),
    issues: r.resolve(t.ISSUE_REPOSITORY),
    workflowSource: r.resolve(t.WORKFLOW_SOURCE),
    promotion: {
      runtimeManager: r.resolve(RUNTIME_MANAGER),
      runtimeProfiles: r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      roles: r.resolve(t.ROLE_REPOSITORY),
      // Resolved per promotion, so a check can stub the evals.
      evals: () => r.resolve(b.BRAIN_PROMOTION_EVALS),
    },
  }), { source: SOURCE });

  container.bind(b.BRAIN_PROMOTION_EVALS, (r) => new ServiceEvalPort({
    evals: () => r.resolve(t.EVAL_SERVICE),
    repo: r.resolve(t.EVAL_REPOSITORY),
    blobs: r.resolve(t.EVAL_BLOBS),
    readEvals: (workspaceId, ref) => r.resolve(b.BRAIN_SERVICE).evalsFilesForPromotion(workspaceId, ref),
    caller: () => ({ personId: r.resolve(t.IDENTITY).localPerson().id }),
    log: log(r).child({ component: 'brain-evals' }),
  }), { source: SOURCE });

  container.bind(b.BRAIN_CONTEXT_SUPPLY, (r) => new BrainContextSupply(r.resolve(b.BRAIN_SERVICE), clock(r), log(r).child({ component: 'brain-context' })), { source: SOURCE });

  // The brain.* tools (spec §10): every worker with repository.read can read and propose.
  const tools = (r: Resolver) => createBrainTools({
    brain: () => r.resolve(b.BRAIN_SERVICE), runs: r.resolve(t.RUN_REPOSITORY), missions: r.resolve(t.MISSION_REPOSITORY), clock: clock(r),
  });
  container.contribute(BUILT_IN_TOOLS, (r) => tools(r)[0]!, { source: SOURCE });
  container.contribute(BUILT_IN_TOOLS, (r) => tools(r)[1]!, { source: SOURCE });
  container.contribute(BUILT_IN_TOOLS, (r) => tools(r)[2]!, { source: SOURCE });

  container.bind(b.BRAIN_SIGNALS, (r) => new BrainSignals({
    brain: r.resolve(b.BRAIN_SERVICE),
    bus: r.resolve(t.EVENT_BUS),
    workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
    missions: r.resolve(t.MISSION_REPOSITORY),
    tasks: r.resolve(t.TASK_REPOSITORY),
    runs: r.resolve(t.RUN_REPOSITORY),
    targets: r.resolve(t.EXECUTION_TARGET_REPOSITORY),
    roles: r.resolve(t.ROLE_REPOSITORY),
    feedback: r.resolve(t.FEEDBACK_REPOSITORY),
    runScores: r.resolve(t.RUN_SCORE_REPOSITORY),
    records: r.resolve(b.BRAIN_RECORD_REPOSITORY),
    recorder: r.resolve(t.EVENT_RECORDER),
    runtimeManager: r.resolve(RUNTIME_MANAGER),
    runtimeProfiles: r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
    paths: paths(r),
    clock: clock(r),
    log: log(r),
    diff: r.tryResolve(b.BRAIN_WORKTREE_DIFF) ?? null,
  }), { source: SOURCE });

  container.bind(b.BRAIN_SYNC_LOOP, (r) => {
    return new BrainSyncLoop(
      r.resolve(b.BRAIN_SERVICE), r.resolve(b.WORKSPACE_BRAIN_REPOSITORY), log(r).child({ component: 'brain-sync' }),
      r.tryResolve(t.EVENT_BUS) ?? null,
    );
  }, { source: SOURCE });
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
