import type {
  Approval, ApprovalRepositoryPort, ArtifactRepositoryPort, ArtifactStorePort,
  AssignmentRepositoryPort, CapabilityGrant, CheckResult, CheckpointRepositoryPort,
  DecisionRepositoryPort, ExecutionTargetRepositoryPort, ExecutionTargetRecord, ExternalRef,
  GateOutcome, LoadedArtifact, Mission, MissionRepositoryPort, MissionTask, RepoRepositoryPort,
  Repository, ResourceLease, RoleRepositoryPort, RoleTemplate, Run, RunRepositoryPort, RunUsage,
  RuntimeProfile, RuntimeProfileRepositoryPort, TargetKind, TaskRepositoryPort, TaskStatus,
  Workspace, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { CORE_CAPABILITIES, anyCapabilityMatches } from '@tandemise/domain';
import { isDaemonStopping } from '../support/shutdown.js';
import type { ContextCompiler, ExpectedArtifact } from '@tandemise/context';
import type { ExecutionTarget, ExecutionTargetManager } from '@tandemise/execution-core';
import type { ApprovalFactory, GrantBuilder, PolicyEngine } from '@tandemise/policy';
import type { ToolBroker } from '@tandemise/integrations-core';
import { McpGatewayProvisioner, NO_TOOL_SURFACE, type RunToolSurface } from './mcp-gateway.js';
import { onlyBusy } from '@tandemise/runtimes-core';
import type { RuntimeManager, RuntimeSelection, SlotReservation } from '@tandemise/runtimes-core';
import type { Clock, Logger, RunId, TandemisePaths, TaskId } from '@tandemise/shared';
import { TandemiseError, errorMessage, ids, slugify, summarize } from '@tandemise/shared';
import type { ArtifactTemplatePort } from '../ports.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import { runtimeCapabilitiesFor } from '../support/capabilities.js';
import type { RuntimeOverrides } from '../support/runtime-overrides.js';
import { ArtifactHarvester, outDirFor, type HarvestResult } from './harvester.js';
import type { CheckService } from './checks.js';
import type { GateService } from './gates.js';
import { MAX_PARKED_MS, type RunDeadlines } from './run-deadline.js';

/** How long a resource lease is held before the scheduler must renew it. */
const LEASE_TTL_MS = 30 * 60_000;

export type TaskAttemptOutcome =
  /** Admission failed for a reason that will resolve on its own. Try next tick. */
  | { readonly kind: 'deferred'; readonly reason: string }
  | {
      readonly kind: 'settled';
      readonly status: TaskStatus;
      readonly reason: string | null;
      /** Delay before the scheduler may dispatch this task again. */
      readonly retryAfterMs?: number;
    };

export interface TaskExecutorDeps {
  readonly workspaces: WorkspaceRepositoryPort;
  readonly repositories: RepoRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly runs: RunRepositoryPort;
  readonly assignments: AssignmentRepositoryPort;
  readonly targets: ExecutionTargetRepositoryPort;
  readonly leases: import('@tandemise/domain').LeaseRepositoryPort;
  readonly artifacts: ArtifactRepositoryPort;
  readonly artifactStore: ArtifactStorePort;
  readonly approvals: ApprovalRepositoryPort;
  readonly roles: RoleRepositoryPort;
  readonly runtimeProfiles: RuntimeProfileRepositoryPort;
  readonly decisions: DecisionRepositoryPort;
  readonly checkpoints: CheckpointRepositoryPort;
  readonly runtimeManager: RuntimeManager;
  readonly targetManager: ExecutionTargetManager;
  readonly contextCompiler: ContextCompiler;
  readonly grantBuilder: GrantBuilder;
  /** The decision point every capability this attempt is given must survive. */
  readonly policy: PolicyEngine;
  readonly approvalFactory: ApprovalFactory;
  /** Null when no integration surface is composed; the run simply gets no tools. */
  readonly toolBroker: ToolBroker | null;
  /** Builds the run-scoped MCP surface so a worker can actually call a tool. */
  readonly mcpGateway: McpGatewayProvisioner;
  readonly overrides: RuntimeOverrides;
  readonly templates: ArtifactTemplatePort;
  readonly harvester: ArtifactHarvester;
  readonly checks: CheckService;
  readonly gates: GateService;
  readonly recorder: EventRecorder;
  /** Live run budgets, so a worker waiting on a person is not timed out. */
  readonly deadlines: RunDeadlines;
  readonly paths: TandemisePaths;
  readonly clock: Clock;
  readonly log: Logger;
}

/**
 * One attempt at one task, start to finish (APPLICATION_DESIGN.md §Task
 * lifecycle).
 *
 * The rule that shapes every method here: **persist the state transition before
 * the side effect it authorizes.** The task is RUNNING in the database before
 * the worker is launched; the target row exists as PROVISIONING before the
 * worktree is created; the run row exists before the adapter is asked for a
 * single event. A daemon that dies at any await therefore leaves a record that
 * recovery can interpret, rather than an orphan nothing knows about.
 *
 * The second rule: **every runtime event is persisted and published as it
 * arrives.** Batching them at the end would be faster and would lose the entire
 * timeline of any run that crashes - which is exactly the run whose timeline
 * matters most.
 */
export class TaskExecutor {
  constructor(private readonly deps: TaskExecutorDeps) {}

  async execute(taskId: TaskId, signal: AbortSignal): Promise<TaskAttemptOutcome> {
    const task = this.#requireTask(taskId);
    const mission = this.#require(this.deps.missions.get(task.missionId), 'Mission', task.missionId);
    const workspace = this.#require(
      this.deps.workspaces.get(mission.workspaceId), 'Workspace', mission.workspaceId,
    );
    const repository = this.#repositoryFor(task, mission);

    const scope: EventScope = {
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      taskId: task.id,
      roleId: task.roleId,
    };

    const role = this.deps.roles.get(task.roleId, workspace.id);
    if (role === undefined) {
      return this.#block(task, scope, `No role template '${task.roleId}' exists in this workspace.`);
    }

    // 12(a). An approval demanded *before* the task starts is checked here
    // rather than in the scheduler, because this is the only place that knows
    // what the task is about to be permitted to do.
    const gateOnStart = this.#approvalBeforeStart(task, mission, workspace, role, scope);
    if (gateOnStart !== null) return gateOnStart;

    // 1. Admission.
    const leases = this.#acquireLeases(task, mission, repository);
    if (!leases.ok) return { kind: 'deferred', reason: leases.reason };

    try {
      return await this.#run({ task, mission, workspace, repository, role, scope, signal });
    } catch (e) {
      this.deps.log.error('task.attempt_failed', {
        missionId: mission.id, taskId: task.id, error: errorMessage(e),
      });
      return this.#settleFailure(task, scope, errorMessage(e));
    } finally {
      for (const lease of leases.held) this.deps.leases.release(lease.id);
    }
  }

  // --------------------------------------------------------------- the attempt

  async #run(ctx: AttemptContext): Promise<TaskAttemptOutcome> {
    const { task, workspace, scope } = ctx;
    const { deps } = this;

    // 2. Routing. A role with an explicit routing policy is never given a
    //    runtime that policy excluded - the fallback is "no candidates", which
    //    blocks with a reason, not a silent substitution.
    const candidates = this.#candidateProfiles(workspace, task);
    if (candidates.length === 0) {
      return this.#block(task, scope, `No runtime profile is routed to role '${task.roleId}'.`);
    }
    const required = runtimeCapabilitiesFor(task);
    const selected = await deps.runtimeManager.select(candidates, required);
    if (!selected.ok) {
      const detail = selected.error.rejections.map((r) => `${r.profileId}: ${r.reason}`).join('; ');
      // Every capable runtime is busy: that is contention, not a failure. The
      // task stays READY and is offered again once a slot frees up.
      if (onlyBusy(selected.error)) return { kind: 'deferred', reason: `Waiting for a runtime slot. ${detail}` };
      return this.#block(
        task,
        scope,
        `No healthy runtime satisfies [${required.join(', ')}] for role '${task.roleId}'. ${detail}`,
      );
    }
    // Routing reserved the slot; it passes to the run in #drive, and is given
    // back here on every path that never gets that far - a failed provision,
    // a vetting block - so an attempt that never ran cannot hold a worker.
    try {
      return await this.#runRouted(ctx, selected.value);
    } finally {
      selected.value.reservation.release();
    }
  }

  async #runRouted(ctx: AttemptContext, selection: RuntimeSelection): Promise<TaskAttemptOutcome> {
    const { task, mission, workspace, repository, role, scope, signal } = ctx;
    const { deps } = this;
    const { profile, adapter, reservation } = selection;
    const attempt = task.attempts + 1;

    // Captured before the transition, because moving to RUNNING clears
    // `statusReason` - and `statusReason` is where the previous attempt's gate
    // failure lives. Reading it after the transition is how the single
    // highest-value feedback loop in the system silently becomes a no-op.
    const feedback = attempt > 1 ? task.statusReason : null;

    const running = this.#setStatus(task, scope, 'RUNNING', null, {
      attempts: attempt,
      startedAt: task.startedAt ?? deps.clock.now(),
    });

    // 3. Target. The row exists before the worktree does, so a crash between
    //    the two leaves a PROVISIONING record for recovery to fail cleanly.
    const kind = targetKindFor(task.executionPolicy.isolation);
    // A reviewer or tester must be able to SEE the change. Basing its worktree
    // on the base branch would hand it a tree without the work in it, leaving
    // it to review the ChangeSet's *description* of the diff - and the whole
    // point of an independent evaluator is that it checks the claim against the
    // artifact rather than taking the claim (MVP.md §16.1, §17.3).
    const upstreamBranch = this.#upstreamChangeBranch(running, mission);
    const provisioned = await this.#provisionTarget(
      kind, running, mission, workspace, repository, scope, upstreamBranch,
    );
    if (!provisioned.ok) {
      return this.#settleFailure(running, scope, provisioned.reason);
    }
    const target = provisioned.target;

    // Declared outside the try so the finally can tear it down however the
    // attempt ends. A leftover socket would be a second, unauthenticated door
    // into the tool broker.
    let toolSurface: RunToolSurface = NO_TOOL_SURFACE;

    try {
      // 4. Grants: least privilege, scoped to this target and this mission.
      const requested = deps.grantBuilder.build({
        role,
        task: running,
        autonomy: workspace.autonomy,
        workingDirectory: target.workingDirectory,
        artifactRoot: deps.paths.artifacts(workspace.id),
        readOnlyPaths: repository === null ? [] : [repository.path],
        // Wall time plus the longest the run may be parked on a person. This does
        // not extend what the worker can do: a grant is only exercisable through
        // the run-scoped tool socket, which is destroyed with the run, and the
        // run's *active* time is still bounded by its deadline. A TTL of wall
        // time alone would expire every grant while a question sat unanswered,
        // and the worker would come back from the answer unable to act on it.
        ttlMs: task.executionPolicy.maxWallTimeMs + MAX_PARKED_MS,
      });
      const vetted = this.#vet(requested, running, workspace, scope);
      if (vetted.blockedOn !== null) {
        return this.#block(running, scope, vetted.blockedOn);
      }
      const grants = vetted.grants;

      // 5. Assignment: the unit permissions attach to.
      const assignment = deps.assignments.create({
        id: ids.workerAssignment(),
        workspaceId: workspace.id,
        missionId: mission.id,
        taskId: running.id,
        roleId: role.id,
        runtimeProfileId: profile.id,
        executionTargetId: target.id,
        grants,
        budgets: {
          maxWallTimeMs: task.executionPolicy.maxWallTimeMs,
          maxAttempts: task.retryPolicy.maxAttempts,
        },
        createdAt: deps.clock.now(),
      });

      // The run id is minted here rather than inside #drive so the tool surface,
      // its socket and its config file can all be keyed to this attempt and
      // destroyed with it.
      const runId = ids.run();

      // 6. Context. The tool surface is narrowed to this assignment before the
      //    prompt is written, so a worker is never told about a tool its grants
      //    would not let it call - and the same narrowed gateway is what backs
      //    the MCP server it will call through, so the list it is shown and the
      //    list it can reach are the same list by construction.
      toolSurface = await deps.mcpGateway.provision({
        runId,
        workspaceId: mission.workspaceId,
        missionId: mission.id,
        assignment,
        workingDirectory: target.workingDirectory,
        signal,
      });
      await deps.harvester.prepare(target, scope, running);
      const prompt = await this.#compilePrompt({
        ...ctx, task: running, workspace, role, grants, target, tools: toolSurface.toolNames, feedback,
      });

      // 7. Run.
      const outcome = await this.#drive({
        task: running, mission, profile, adapter, target, assignment, prompt, grants, scope, signal,
        runId, mcpConfigPath: toolSurface.mcpConfigPath, reservation,
      });

      if (outcome.interrupted) {
        // Back to the queue with its attempt count kept, exactly as recovery
        // treats a run the last daemon left behind; the next start resumes it.
        return this.#settle(running, scope, 'READY', 'Tandemise stopped mid-run; this task resumes when it starts again.');
      }
      if (outcome.cancelled) {
        return this.#settle(running, scope, 'CANCELLED', 'Cancelled before the run finished.');
      }

      // 8/9. Commit first, then harvest, so every artifact carries the commit
      //      it describes as provenance. `.tandemise/` is git-ignored, so the
      //      commit's content is unaffected by the order.
      const refs = await this.#commit(target, running, role, profile, outcome.runId, scope);
      const harvest = await deps.harvester.harvest({
        mission,
        task: running,
        target,
        runId: outcome.runId,
        roleId: role.id,
        scope: { ...scope, runId: outcome.runId, runtimeProfileId: profile.id },
        sourceRefs: refs,
      });

      // 10. Checks.
      const checks = outcome.status === 'CANCELLED'
        ? []
        : await deps.checks.run({
          task: running,
          repository,
          target,
          runId: outcome.runId,
          scope: { ...scope, runId: outcome.runId },
          signal,
        });

      // 11. Gate.
      return this.#judge({
        task: running, mission, workspace, role, scope, harvest, checks,
        runFailure: outcome.failure, runId: outcome.runId,
      });
    } finally {
      // 13. Release. A worktree is left intact: it is the reviewable artifact,
      //     but the run's private tool surface dies with the run.
      await toolSurface.dispose();
      await this.#releaseTarget(target, kind);
    }
  }

  // -------------------------------------------------------------- run plumbing

  async #drive(input: DriveInput): Promise<DriveOutcome> {
    const { deps } = this;
    const { task, mission, profile, target, assignment, prompt, grants, scope, signal } = input;

    const resumeFrom = this.#resumableSession(task.id, input.adapter.resume !== undefined);
    const { runId } = input;
    const startedAt = deps.clock.now();

    deps.runs.create({
      id: runId,
      missionId: mission.id,
      taskId: task.id,
      assignmentId: assignment.id,
      attempt: task.attempts,
      status: 'STARTING',
      roleId: task.roleId,
      runtimeProfileId: profile.id,
      executionTargetId: target.id,
      externalSessionId: resumeFrom,
      pid: null,
      exitCode: null,
      errorCode: null,
      errorMessage: null,
      usage: null,
      startedAt,
      finishedAt: null,
      heartbeatAt: startedAt,
    });

    const runScope: EventScope = { ...scope, runId, runtimeProfileId: profile.id };
    deps.recorder.record(runScope, {
      type: 'run.started',
      attempt: task.attempts,
      runtime: profile.name,
      target: `${target.kind}:${target.workingDirectory}`,
    });

    // The budget is enforced here, where it can be paused while the worker waits
    // on a person, and not only inside the adapter - an adapter that ignores it
    // must not be able to hold a worker slot forever.
    const deadline = deps.deadlines.open(assignment.id, task.executionPolicy.maxWallTimeMs);
    const combined = AbortSignal.any([signal, deadline.signal]);

    const request = {
      runId,
      profile,
      prompt,
      workingDirectory: target.workingDirectory,
      grants: grants.map((g) => g.capability),
      allowedRoots: allowedRoots(grants, target.workingDirectory),
      mcpConfigPath: input.mcpConfigPath,
      // The adapter runs its own timer, which cannot be paused. Given the real
      // budget it would kill a worker mid-question; given this it remains a
      // backstop against a runaway adapter and never fires before the deadline
      // above, which is the precise one.
      maxWallTimeMs: task.executionPolicy.maxWallTimeMs + MAX_PARKED_MS,
      signal: combined,
      log: deps.log.child({ runId, taskId: task.id, missionId: mission.id, runtime: profile.adapterId }),
      reservation: input.reservation,
    };

    let usage: RunUsage = {};
    let failure: RunFailure | null = null;
    let started = false;
    let lastBeat = deps.clock.epochMs();

    try {
      const events = resumeFrom !== null
        ? deps.runtimeManager.resume(resumeFrom, request)
        : deps.runtimeManager.start(request);

      for await (const event of events) {
        if (!started) {
          started = true;
          deps.runs.update(runId, {
            status: 'RUNNING',
            pid: deps.runtimeManager.pid(profile, runId),
          });
        }

        // Persisted and published one at a time: the UI timeline and recovery
        // both read the durable log, so a batched write is a lost run.
        deps.recorder.record(runScope, event);

        switch (event.type) {
          case 'checkpoint': {
            // Immediately, not at the end: this is the single fact that makes
            // resuming an interrupted run possible (MVP.md §21.2).
            if (event.externalSessionId !== undefined) {
              deps.runs.update(runId, { externalSessionId: event.externalSessionId });
            }
            deps.checkpoints.append({
              runId,
              sequence: deps.clock.epochMs(),
              label: event.label ?? 'checkpoint',
              externalSessionId: event.externalSessionId ?? null,
              payload: {},
              createdAt: deps.clock.now(),
            });
            break;
          }
          case 'usage':
            usage = mergeUsage(usage, event);
            break;
          case 'failed':
            failure = { code: event.code, message: event.message, retryable: event.retryable };
            break;
          default:
            break;
        }

        const now = deps.clock.epochMs();
        if (now - lastBeat >= 2_000) {
          lastBeat = now;
          deps.runs.heartbeat(runId, deps.clock.now());
        }
      }
    } catch (e) {
      failure = { code: 'RUNTIME_FAILED', message: errorMessage(e), retryable: true };
    } finally {
      deps.deadlines.close(assignment.id);
    }

    const cancelled = signal.aborted;
    if (deadline.expired && !cancelled) {
      // Overrides whatever the adapter reported. From inside the adapter an
      // exhausted budget is indistinguishable from a cancellation - its signal
      // simply fired - so it reports CANCELLED, which is not retryable. Only
      // this side knows the deadline is why, and a timeout is exactly the
      // failure a retry exists for.
      failure = {
        code: 'TIMEOUT',
        message: `Run exceeded its ${task.executionPolicy.maxWallTimeMs}ms wall-time budget`,
        retryable: true,
      };
    } else if (combined.aborted && failure === null) {
      failure = { code: 'CANCELLED', message: 'Run cancelled', retryable: false };
    }

    const finishedAt = deps.clock.now();
    const interrupted = isDaemonStopping(signal);
    const session = deps.runs.get(runId)?.externalSessionId ?? null;
    const status = interrupted
      ? (session !== null && input.adapter.resume !== undefined ? 'RESUMABLE' : 'INTERRUPTED')
      : cancelled ? 'CANCELLED' : failure === null ? 'SUCCEEDED' : 'FAILED';
    deps.runs.update(runId, {
      status,
      finishedAt,
      errorCode: failure?.code ?? null,
      errorMessage: failure === null ? null : summarize(failure.message, 2000),
      usage: hasUsage(usage) ? usage : null,
    });
    if (hasUsage(usage)) deps.runs.recordUsage(runId, usage);

    deps.recorder.record(runScope, {
      type: 'run.finished',
      status,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    });

    return { runId, status, failure, cancelled, interrupted };
  }

  // ------------------------------------------------------------------ decision

  #judge(input: JudgeInput): TaskAttemptOutcome {
    const { task, mission, workspace, role, scope, harvest, checks, runFailure } = input;
    const gate = this.deps.gates.evaluate(task);
    const verdict = decide(gate, harvest, runFailure);

    if (gate !== null) {
      this.deps.recorder.record({ ...scope, runId: input.runId }, {
        type: 'gate.evaluated',
        gate: gate.expression,
        passed: gate.passed,
        detail: gate.detail,
      });
    }

    if (verdict.passed) {
      // 12(b). An approval on completion holds the task - and everything
      //        downstream of it - until a human decides.
      if (task.approvalPolicy.onCompletion) {
        const approval = this.#createCompletionApproval(task, mission, workspace, role, gate, checks);
        this.deps.recorder.record(scope, { type: 'approval.requested', approvalId: approval.id });
        return this.#settle(task, scope, 'AWAITING_APPROVAL', approval.title);
      }
      return this.#settle(task, scope, 'SUCCEEDED', null);
    }

    // 11(b). Gate feedback into the retry. `statusReason` is the carrier: it is
    //        persisted, it is what the UI shows, and the next attempt's prompt
    //        quotes it verbatim so the worker is told exactly what it failed.
    const feedback = verdict.detail;
    if (task.attempts < task.retryPolicy.maxAttempts) {
      this.#setStatus(task, scope, 'READY', feedback);
      return {
        kind: 'settled',
        status: 'READY',
        reason: feedback,
        retryAfterMs: task.retryPolicy.backoffMs,
      };
    }
    if (task.retryPolicy.onExhausted === 'fail') {
      return this.#settle(task, scope, 'FAILED', feedback);
    }
    this.#createInterventionApproval(task, mission, workspace, feedback);
    return this.#settle(task, scope, 'BLOCKED', feedback);
  }

  // -------------------------------------------------------------------- policy

  /**
   * Runs every grant the builder produced through the policy engine before the
   * worker is launched (MVP.md §19.2).
   *
   * The grant builder answers "what did the role and the task ask for?". That
   * is a *description*. The policy engine answers "what does this workspace
   * permit, at this risk class, right now?" - and that is the decision. Without
   * this step the engine's shell classification and autonomy dials are computed
   * and discarded, and a worker is handed whatever its role template listed.
   *
   * A denied capability is dropped from the grant set and recorded as
   * `policy.denied`, so the worker is launched strictly narrower rather than
   * failing later for a reason nobody can see. A denied capability the task
   * declared as *required* is different: running without it would produce work
   * that silently does not do what the plan said, so the task blocks.
   */
  #vet(
    grants: readonly CapabilityGrant[],
    task: MissionTask,
    workspace: Workspace,
    scope: EventScope,
  ): { grants: readonly CapabilityGrant[]; blockedOn: string | null } {
    const required = new Set(task.requiredCapabilities);
    const allowed: CapabilityGrant[] = [];

    for (const grant of grants) {
      const decision = this.deps.policy.evaluate({
        capability: grant.capability,
        ...(grant.resourceScope[0] === undefined ? {} : { resource: grant.resourceScope[0] }),
        grants,
        autonomy: workspace.autonomy,
      });
      if (decision.outcome !== 'deny') {
        allowed.push(grant);
        continue;
      }
      this.deps.recorder.record(scope, {
        type: 'policy.denied',
        capability: grant.capability,
        reason: decision.reason,
      });
      if (required.has(grant.capability)) {
        return {
          grants: allowed,
          blockedOn: `'${task.key}' requires '${grant.capability}', which policy refuses: ${decision.reason}`,
        };
      }
    }
    return { grants: allowed, blockedOn: null };
  }

  // ------------------------------------------------------------------- context

  async #compilePrompt(input: PromptInput): Promise<string> {
    const { task, mission, workspace, role, grants, target, scope } = input;
    const dependencies = await this.#loadDependencies(task, scope);

    const expected: readonly ExpectedArtifact[] = task.expectedOutputs.map((type) => ({
      type,
      template: this.deps.templates.render(type) ?? `(no template is defined for ${type}; write clear Markdown.)`,
      destination: `${outDirFor(task)}/${type}.md`,
    }));

    const compiled = this.deps.contextCompiler.compile({
      role,
      workspaceName: workspace.name,
      knowledge: workspace.knowledge,
      mission,
      task,
      dependencyArtifacts: dependencies,
      decisions: this.deps.decisions.listByMission(mission.id).filter((d) => d.status === 'accepted'),
      evidence: [],
      grants,
      outputContract: {
        artifacts: expected,
        workingDirectory: target.workingDirectory,
        completionGate: task.completionGate,
        notes: this.#contractNotes(task, target, input.tools, input.feedback),
      },
    });

    if (compiled.truncated.length > 0) {
      this.deps.recorder.note(
        scope,
        `Context budget bound: ${compiled.truncated.map((t) => `${t.section} ${t.action}`).join(', ')}.`,
        'warn',
      );
    }
    return compiled.prompt;
  }

  #contractNotes(
    task: MissionTask,
    target: ExecutionTarget,
    tools: readonly string[],
    feedback: string | null,
  ): readonly string[] {
    const notes = [
      `Write each artifact to its own file under \`${outDirFor(task)}/\` in ${target.workingDirectory}. `
      + `The file name is the artifact type followed by \`.md\` — for example \`${outDirFor(task)}/ProductSpec.md\`. `
      + 'Tandemise reads those files after your run ends; anything you only describe in conversation is discarded.',
      `\`.tandemise/\` is git-ignored, so writing there never pollutes the diff.`,
    ];
    if (target.kind === 'worktree') {
      const branch = target.describe().branch;
      notes.push(
        `You are on your own branch${branch ? ` (\`${branch}\`)` : ''} in an isolated worktree `
        + `at ${target.workingDirectory}. Commit your code changes here, on this branch. `
        + 'Anything left uncommitted is committed for you and attributed to this run.',
        // Repository instructions often say "create a worktree and a feature
        // branch first". Followed here, the work lands on a branch Tandemise
        // does not know, and the reviewer and tester - whose worktrees are cut
        // from this one - review a tree without the change in it.
        'Do not create another worktree, clone, or branch to do this work, even if the repository\'s own '
        + 'instructions (CLAUDE.md, AGENTS.md, contributing docs) say to: this worktree already is that '
        + 'isolation, and downstream review and QA read this branch. If a later task needs a differently named '
        + 'branch - for a pull request, say - push this branch under that name rather than moving the work.',
      );
    }
    if (tools.length > 0) {
      notes.push(
        `Integration tools available to you: ${tools.join(', ')}. `
        + 'Every call is checked against this task\'s grants; one that needs a human is paused, not refused.',
      );
    }
    // The retry feedback loop: the previous attempt's failure, stated verbatim.
    // Quoted rather than paraphrased on purpose - the worker needs the exact
    // condition Tandemise measured, not this system's opinion about it.
    if (feedback !== null && feedback.trim().length > 0) {
      notes.push(
        `Your previous attempt did not satisfy this task's completion gate. `
        + `Tandemise measured: ${feedback} `
        + 'Fix exactly that before you finish; nothing else about the task has changed.',
      );
    }
    return notes;
  }

  async #loadDependencies(task: MissionTask, scope: EventScope): Promise<readonly LoadedArtifact[]> {
    const loaded: LoadedArtifact[] = [];
    for (const requirement of task.inputArtifacts) {
      const manifest = this.deps.artifacts.latest(task.missionId, requirement.type);
      if (manifest === undefined) {
        if (requirement.required) {
          this.deps.recorder.note(
            scope,
            `Required input artifact ${requirement.type} does not exist; ${task.key} runs without it.`,
            'warn',
          );
        }
        continue;
      }
      try {
        loaded.push(await this.deps.artifactStore.read(manifest.id));
      } catch (e) {
        this.deps.recorder.note(scope, `Could not read ${requirement.type}: ${errorMessage(e)}`, 'warn');
      }
    }
    return loaded;
  }

  // ------------------------------------------------------------------- targets

  /**
   * The branch a downstream task should start from.
   *
   * Walks this task's transitive dependencies for the most recent `ChangeSet`
   * and returns the branch it recorded. Null when nothing upstream produced
   * code - a product or design task has nothing to check out, and the base
   * branch is correct for it.
   *
   * Only *upstream* changesets count. A ChangeSet produced by a parallel task
   * this one does not depend on is not part of what it was asked to evaluate,
   * and silently folding it in would make a review report about code the
   * reviewer was never shown.
   */
  /**
   * The repository a task works in: its own, or the mission's when it names none.
   *
   * Most tasks name none. One that does is how a mission spanning several of a
   * project's repositories stays a single dependency graph.
   */
  #repositoryFor(task: MissionTask, mission: Mission): Repository | null {
    const id = task.repositoryId ?? mission.repositoryId;
    return id === null ? null : this.deps.repositories.get(id) ?? null;
  }

  #upstreamChangeBranch(task: MissionTask, mission: Mission): string | null {
    const all = this.deps.tasks.listByMission(mission.id);
    const byKey = new Map(all.map((t) => [t.key, t]));

    const upstream = new Set<string>();
    const walk = (key: string): void => {
      for (const dep of byKey.get(key)?.dependsOn ?? []) {
        if (upstream.has(dep)) continue;
        upstream.add(dep);
        walk(dep);
      }
    };
    walk(task.key);
    if (upstream.size === 0) return null;

    // Only upstream tasks in the *same* repository. A mission may span several
    // of a project's repositories, and a branch cut in one of them does not
    // exist in another - checking it out would fail, and matching it by name
    // against an unrelated branch would be worse.
    const ownRepository = task.repositoryId ?? mission.repositoryId;
    const upstreamIds = new Set(
      [...upstream]
        .map((key) => byKey.get(key))
        .filter((t): t is MissionTask => t !== undefined)
        .filter((t) => (t.repositoryId ?? mission.repositoryId) === ownRepository)
        .map((t) => t.id),
    );
    if (upstreamIds.size === 0) return null;

    // Newest first: after a remediation cycle the fix task's ChangeSet is the
    // one that should be reviewed, not the original.
    const changeSets = this.deps.artifacts
      .listByMission(mission.id, 'ChangeSet')
      .filter((a) => a.taskId !== null && upstreamIds.has(a.taskId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    for (const artifact of changeSets) {
      const branch = artifact.sourceRefs.find((r) => r.kind === 'git.branch')?.value;
      if (branch) return branch;
    }
    return null;
  }

  async #provisionTarget(
    kind: TargetKind,
    task: MissionTask,
    mission: Mission,
    workspace: Workspace,
    repository: Repository | null,
    scope: EventScope,
    upstreamBranch: string | null,
  ): Promise<{ ok: true; target: ExecutionTarget } | { ok: false; reason: string }> {
    if (repository === null && kind !== 'local') {
      return { ok: false, reason: `Task '${task.key}' needs a ${kind} target but the mission has no repository.` };
    }
    const repositoryPath = repository?.path ?? this.deps.paths.mission(workspace.id, mission.id);
    const id = ids.executionTarget();
    const name = `${slugify(mission.title)}-${task.key}`;

    this.deps.targets.create({
      id,
      workspaceId: workspace.id,
      missionId: mission.id,
      taskId: task.id,
      kind,
      name,
      workingDirectory: repositoryPath,
      branch: null,
      baseBranch: upstreamBranch ?? mission.baseBranch,
      status: 'PROVISIONING',
      detail: null,
      createdAt: this.deps.clock.now(),
      releasedAt: null,
    });

    try {
      const target = await this.deps.targetManager.provision({
        id,
        workspaceId: workspace.id,
        missionId: mission.id,
        taskId: task.id,
        kind,
        name,
        repositoryPath,
        baseBranch: upstreamBranch ?? mission.baseBranch ?? repository?.defaultBranch,
        missionSlug: slugify(mission.title),
      });
      const record = target.describe();
      this.deps.targets.update(id, {
        workingDirectory: record.workingDirectory,
        branch: record.branch,
        baseBranch: record.baseBranch,
        status: 'IN_USE',
        detail: record.detail,
      });
      this.deps.recorder.invalidate('targets', mission.id);
      return { ok: true, target };
    } catch (e) {
      this.deps.targets.update(id, { status: 'FAILED', detail: summarize(errorMessage(e), 500) });
      this.deps.recorder.note(scope, `Could not provision a ${kind} target: ${errorMessage(e)}`, 'error');
      return { ok: false, reason: `Target provisioning failed: ${errorMessage(e)}` };
    }
  }

  async #releaseTarget(target: ExecutionTarget, kind: TargetKind): Promise<void> {
    const record = target.describe();
    if (kind === 'worktree') {
      // The branch and its tree are the reviewable output of the task. Leaving
      // them is not laziness; discarding them would destroy the work.
      this.deps.targets.update(record.id, { status: 'READY' });
      await target.dispose();
      return;
    }
    try {
      await this.deps.targetManager.release(record);
      this.deps.targets.update(record.id, { status: 'RELEASED', releasedAt: this.deps.clock.now() });
    } catch (e) {
      this.deps.log.warn('target.release_failed', { targetId: record.id, error: errorMessage(e) });
    }
  }

  // ---------------------------------------------------------------------- git

  /**
   * Commits whatever the worker left behind, attributed to the role and the run
   * (MVP.md §P7). Failure here is recorded and stepped over: losing the commit
   * is bad, losing the artifacts the run already produced would be worse.
   */
  async #commit(
    target: ExecutionTarget,
    task: MissionTask,
    role: RoleTemplate,
    profile: RuntimeProfile,
    runId: RunId,
    scope: EventScope,
  ): Promise<readonly ExternalRef[]> {
    const record = target.describe();
    const refs: ExternalRef[] = [];
    if (record.branch !== null) {
      refs.push({ kind: 'git.branch', value: record.branch, label: `${task.key} branch` });
    }
    if (target.kind !== 'worktree') return refs;

    try {
      const status = await target.exec({ command: 'git', args: ['status', '--porcelain'] });
      if (status.exitCode === 0 && status.stdout.trim().length > 0) {
        const name = `Tandemise ${role.name}`;
        const email = `${role.id}@tandemise.local`;
        await target.exec({ command: 'git', args: ['add', '--all'] });
        const commit = await target.exec({
          command: 'git',
          args: [
            '-c', `user.name=${name}`,
            '-c', `user.email=${email}`,
            '-c', 'commit.gpgsign=false',
            'commit',
            '--message', commitMessage(task, role, profile, runId),
          ],
        });
        if (commit.exitCode !== 0) {
          this.deps.recorder.note(scope, `Could not commit the worker's changes: ${summarize(commit.stderr, 400)}`, 'warn');
        }
      }
      const head = await target.exec({ command: 'git', args: ['rev-parse', 'HEAD'] });
      if (head.exitCode === 0 && head.stdout.trim().length > 0) {
        refs.push({ kind: 'git.commit', value: head.stdout.trim(), label: `${task.key} HEAD` });
      }
    } catch (e) {
      this.deps.recorder.note(scope, `Git bookkeeping failed after the run: ${errorMessage(e)}`, 'warn');
    }
    return refs;
  }

  // ------------------------------------------------------------------- leases

  /**
   * Exclusive claims on anything two runs must not share. Contention is an
   * ordinary scheduling outcome, so a failed acquisition releases what it
   * already holds and asks to be tried again - it never errors.
   */
  #acquireLeases(
    task: MissionTask,
    mission: Mission,
    repository: Repository | null,
  ): { ok: true; held: readonly ResourceLease[] } | { ok: false; reason: string; held: readonly ResourceLease[] } {
    const held: ResourceLease[] = [];
    for (const key of resourceKeysFor(task, mission, repository)) {
      const lease = this.deps.leases.acquire(key, { taskId: task.id }, LEASE_TTL_MS);
      if (lease === undefined) {
        for (const acquired of held) this.deps.leases.release(acquired.id);
        return {
          ok: false,
          reason: key.endsWith(':worktree')
            ? 'Queued: another task is working directly in this repository checkout, and tasks that run in place take turns.'
            : `Queued: resource '${key}' is held by another task.`,
          held: [],
        };
      }
      held.push(lease);
    }
    return { ok: true, held };
  }

  // ---------------------------------------------------------------- approvals

  #approvalBeforeStart(
    task: MissionTask,
    mission: Mission,
    workspace: Workspace,
    role: RoleTemplate,
    scope: EventScope,
  ): TaskAttemptOutcome | null {
    if (!task.approvalPolicy.beforeStart) return null;
    const existing = this.deps.approvals.pendingForTask(task.id).find((a) => a.kind === 'action');
    if (existing !== undefined) {
      return { kind: 'settled', status: 'AWAITING_APPROVAL', reason: existing.title };
    }
    const decided = this.deps.approvals
      .list({ missionId: mission.id, statuses: ['APPROVED'] })
      .some((a) => a.taskId === task.id && a.kind === 'action');
    if (decided) return null;

    const approval = this.deps.approvalFactory.createOrThrow({
      workspaceId: workspace.id,
      missionId: mission.id,
      taskId: task.id,
      kind: 'action',
      risk: 'write_reversible',
      title: `Start ${task.title}?`,
      rationale: task.approvalPolicy.reason ?? `The plan requires approval before '${task.key}' runs.`,
      effect: `${role.name} will run in a ${task.executionPolicy.isolation} target and may use: `
        + `${task.executionPolicy.capabilities.join(', ') || 'no capabilities'}.`,
      evidence: [
        { kind: 'text', label: 'Objective', value: summarize(task.objective, 600) },
        { kind: 'text', label: 'Mission goal', value: summarize(mission.goal, 400) },
      ],
    });
    this.deps.approvals.create(approval);
    this.deps.recorder.record(scope, { type: 'approval.requested', approvalId: approval.id });
    this.deps.recorder.invalidate('approvals', mission.id);
    return this.#settle(task, scope, 'AWAITING_APPROVAL', approval.title);
  }

  #createCompletionApproval(
    task: MissionTask,
    mission: Mission,
    workspace: Workspace,
    role: RoleTemplate,
    gate: GateOutcome | null,
    checks: readonly CheckResult[],
  ): Approval {
    const outputs = this.deps.artifacts.listByTask(task.id);
    const approval = this.deps.approvalFactory.createOrThrow({
      workspaceId: workspace.id,
      missionId: mission.id,
      taskId: task.id,
      kind: task.expectedOutputs.includes('ReleaseCandidate') ? 'release' : 'action',
      risk: task.expectedOutputs.includes('ReleaseCandidate') ? 'release' : 'write_reversible',
      title: `Approve the output of ${task.title}?`,
      rationale: task.approvalPolicy.reason
        ?? `${role.name} finished '${task.key}' and its output authorizes the work that follows.`,
      effect: 'Approving releases every task that depends on this one. Rejecting with a note sends it back to '
        + `${role.name} to revise, with your note as the brief; rejecting without one leaves it blocked.`,
      evidence: [
        ...(gate === null
          ? [{ kind: 'text' as const, label: 'Gate', value: 'This task declares no completion gate.' }]
          : [{ kind: 'check' as const, label: `Gate ${gate.passed ? 'passed' : 'failed'}`, value: gate.detail }]),
        ...checks.map((c) => ({ kind: 'check' as const, label: c.name, value: `${c.outcome} — ${summarize(c.detail, 200)}` })),
        ...outputs.map((a) => ({ kind: 'artifact' as const, label: a.type, value: a.id })),
      ],
    });
    this.deps.approvals.create(approval);
    this.deps.recorder.invalidate('approvals', mission.id);
    return approval;
  }

  #createInterventionApproval(
    task: MissionTask,
    mission: Mission,
    workspace: Workspace,
    detail: string,
  ): Approval {
    const approval = this.deps.approvalFactory.createOrThrow({
      workspaceId: workspace.id,
      missionId: mission.id,
      taskId: task.id,
      kind: 'intervention',
      risk: 'read',
      title: `${task.title} exhausted its retries`,
      rationale: `'${task.key}' failed its completion gate on every one of its ${task.retryPolicy.maxAttempts} attempts.`,
      effect: 'Approving returns the task to the queue for one more attempt. Rejecting leaves the mission blocked.',
      evidence: [
        { kind: 'text', label: 'Last measurement', value: summarize(detail, 1000) },
        { kind: 'text', label: 'Objective', value: summarize(task.objective, 600) },
      ],
      options: [
        { id: 'approve', label: 'Retry once more' },
        { id: 'reject', label: 'Leave blocked' },
      ],
      recommendedOptionId: null,
    });
    this.deps.approvals.create(approval);
    this.deps.recorder.invalidate('approvals', mission.id);
    return approval;
  }

  // -------------------------------------------------------------- transitions

  #setStatus(
    task: MissionTask,
    scope: EventScope,
    status: TaskStatus,
    reason: string | null,
    extra: Partial<MissionTask> = {},
  ): MissionTask {
    if (task.status === status && task.statusReason === reason) return task;
    const finished = status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED' || status === 'SKIPPED';
    const updated = this.deps.tasks.update(task.id, {
      status,
      statusReason: reason,
      ...(finished ? { finishedAt: this.deps.clock.now() } : {}),
      ...extra,
    });
    this.deps.recorder.record(scope, {
      type: 'task.status',
      from: task.status,
      to: status,
      ...(reason === null ? {} : { reason }),
    });
    this.deps.recorder.invalidate('tasks', task.missionId);
    return updated;
  }

  #settle(task: MissionTask, scope: EventScope, status: TaskStatus, reason: string | null): TaskAttemptOutcome {
    this.#setStatus(task, scope, status, reason);
    return { kind: 'settled', status, reason };
  }

  #settleFailure(task: MissionTask, scope: EventScope, reason: string): TaskAttemptOutcome {
    if (task.attempts < task.retryPolicy.maxAttempts) {
      this.#setStatus(task, scope, 'READY', reason);
      return { kind: 'settled', status: 'READY', reason, retryAfterMs: task.retryPolicy.backoffMs };
    }
    return this.#settle(task, scope, task.retryPolicy.onExhausted === 'fail' ? 'FAILED' : 'BLOCKED', reason);
  }

  #block(task: MissionTask, scope: EventScope, reason: string): TaskAttemptOutcome {
    return this.#settle(task, scope, 'BLOCKED', reason);
  }

  // ----------------------------------------------------------------- lookups

  #candidateProfiles(workspace: Workspace, task: MissionTask): readonly RuntimeProfile[] {
    const all = this.deps.runtimeProfiles.list(workspace.id).filter((p) => p.enabled);

    // A manual retry may name a runtime. It is a preference, not a bypass: the
    // profile still has to pass health and capability selection, so overriding
    // onto a runtime that cannot do the work blocks with a reason rather than
    // failing halfway through the run.
    const override = this.deps.overrides.take(task.id);
    if (override !== undefined) {
      const chosen = all.filter((p) => p.id === override);
      if (chosen.length > 0) return chosen;
    }

    const routed = workspace.routing[task.roleId];
    if (routed === undefined || routed.length === 0) return all;
    // Routing is an ordered preference list, so it is walked in order and a
    // profile it does not mention is not a candidate at all.
    return routed.flatMap((id) => all.filter((p) => p.id === id));
  }

  #resumableSession(taskId: TaskId, adapterSupportsResume: boolean): string | null {
    if (!adapterSupportsResume) return null;
    const runs = [...this.deps.runs.listByTask(taskId)].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const resumable = runs.find((r) => r.status === 'RESUMABLE');
    return resumable?.externalSessionId ?? null;
  }

  #requireTask(id: TaskId): MissionTask {
    return this.#require(this.deps.tasks.get(id), 'Task', id);
  }

  #require<T>(value: T | undefined, what: string, id: string): T {
    if (value === undefined) throw TandemiseError.notFound(what, id);
    return value;
  }
}

// ------------------------------------------------------------------ internals

interface AttemptContext {
  readonly task: MissionTask;
  readonly mission: Mission;
  readonly workspace: Workspace;
  readonly repository: Repository | null;
  readonly role: RoleTemplate;
  readonly scope: EventScope;
  readonly signal: AbortSignal;
}

interface PromptInput extends AttemptContext {
  readonly grants: readonly CapabilityGrant[];
  readonly target: ExecutionTarget;
  readonly tools: readonly string[];
  /** The previous attempt's gate detail, verbatim, or null on a first attempt. */
  readonly feedback: string | null;
}

interface DriveInput {
  readonly task: MissionTask;
  readonly mission: Mission;
  readonly profile: RuntimeProfile;
  readonly adapter: { resume?: unknown };
  readonly target: ExecutionTarget;
  readonly assignment: { id: import('@tandemise/shared').WorkerAssignmentId };
  readonly prompt: string;
  readonly grants: readonly CapabilityGrant[];
  readonly scope: EventScope;
  readonly signal: AbortSignal;
  readonly runId: import('@tandemise/shared').RunId;
  /** Null when the assignment was granted no tools. */
  readonly mcpConfigPath: string | null;
  readonly reservation: SlotReservation;
}

interface RunFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

interface DriveOutcome {
  readonly runId: RunId;
  readonly status: Run['status'];
  readonly failure: RunFailure | null;
  readonly cancelled: boolean;
  /** The daemon stopped under the run; the task goes back to the queue, not to CANCELLED. */
  readonly interrupted: boolean;
}

interface JudgeInput {
  readonly task: MissionTask;
  readonly mission: Mission;
  readonly workspace: Workspace;
  readonly role: RoleTemplate;
  readonly scope: EventScope;
  readonly harvest: HarvestResult;
  readonly checks: readonly CheckResult[];
  readonly runFailure: RunFailure | null;
  readonly runId: RunId;
}

/**
 * The gate decides, and when there is no gate the evidence does.
 *
 * A task without a completion gate still has an objective contract: the outputs
 * its plan declared. Treating "no gate" as "always succeeded" would let a
 * worker that produced nothing satisfy its dependents.
 */
function decide(
  gate: GateOutcome | null,
  harvest: HarvestResult,
  runFailure: RunFailure | null,
): { passed: boolean; detail: string } {
  const context = [
    ...(runFailure === null ? [] : [`The run failed (${runFailure.code}): ${runFailure.message}`]),
    ...(harvest.missing.length > 0 ? [`Missing expected artifacts: ${harvest.missing.join(', ')}.`] : []),
    ...harvest.issues,
  ];

  if (gate !== null) {
    return {
      passed: gate.passed,
      detail: [gate.detail, ...context].join(' '),
    };
  }
  const passed = runFailure === null && harvest.missing.length === 0 && harvest.issues.length === 0;
  return {
    passed,
    detail: passed ? 'All expected outputs were produced.' : context.join(' '),
  };
}

function targetKindFor(isolation: MissionTask['executionPolicy']['isolation']): TargetKind {
  return isolation === 'none' ? 'local' : isolation;
}

/**
 * Resource keys a task must hold exclusively.
 *
 * A worktree task owns its own branch, so it contends with nobody. A task
 * running unisolated in the user's checkout contends with every other such
 * task, because they share one working tree (MVP.md §9.4).
 */
/** Capabilities that let a task change the checkout it runs in, beyond its own artifacts. */
const CHANGES_CHECKOUT = [
  CORE_CAPABILITIES.filesystemWrite, CORE_CAPABILITIES.shell, CORE_CAPABILITIES.git, CORE_CAPABILITIES.gitCommit,
];

function resourceKeysFor(
  task: MissionTask,
  mission: Mission,
  repository: Repository | null,
): readonly string[] {
  if (repository === null) return [];
  if (task.executionPolicy.isolation === 'none') {
    // A task that only reads and writes its own artifact folder cannot disturb
    // another task in the same checkout, so it does not take turns with them.
    // Without this, research in one mission queued behind a spec in another.
    const capabilities = [...task.executionPolicy.capabilities, ...task.requiredCapabilities];
    const changes = capabilities.some((c) => CHANGES_CHECKOUT.some((w) => anyCapabilityMatches([c], w)));
    return changes ? [`repository:${repository.id}:worktree`] : [];
  }
  return [`mission:${mission.id}:branch:${task.key}`];
}

function allowedRoots(grants: readonly CapabilityGrant[], workingDirectory: string): readonly string[] {
  const roots = new Set<string>();
  for (const grant of grants) {
    if (grant.approvalMode === 'deny') continue;
    for (const scope of grant.resourceScope) {
      if (scope.startsWith('/') && scope !== workingDirectory) roots.add(scope);
    }
  }
  return [...roots];
}

function commitMessage(
  task: MissionTask,
  role: RoleTemplate,
  profile: RuntimeProfile,
  runId: RunId,
): string {
  return [
    `${task.key}: ${task.title}`,
    '',
    summarize(task.objective, 500),
    '',
    `Tandemise-Role: ${role.id}`,
    `Tandemise-Task: ${task.id}`,
    `Tandemise-Run: ${runId}`,
    `Tandemise-Runtime: ${profile.adapterId}`,
  ].join('\n');
}

function mergeUsage(
  usage: RunUsage,
  event: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number | null },
): RunUsage {
  const add = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  return {
    inputTokens: add(usage.inputTokens, event.inputTokens),
    outputTokens: add(usage.outputTokens, event.outputTokens),
    cacheReadTokens: add(usage.cacheReadTokens, event.cacheReadTokens),
    cacheWriteTokens: add(usage.cacheWriteTokens, event.cacheWriteTokens),
    // A subscription runtime exposes no trustworthy per-run cost, so a missing
    // cost stays null rather than being summed into a fabricated zero.
    costUsd: event.costUsd === undefined || event.costUsd === null
      ? usage.costUsd ?? null
      : (usage.costUsd ?? 0) + event.costUsd,
  };
}

function hasUsage(usage: RunUsage): boolean {
  return usage.inputTokens !== undefined
    || usage.outputTokens !== undefined
    || (usage.costUsd !== null && usage.costUsd !== undefined);
}
