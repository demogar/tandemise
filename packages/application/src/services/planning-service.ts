import type {
  ApprovalRepositoryPort, ArtifactRepositoryPort, ArtifactStorePort, Capability, Mission,
  MissionPlan, MissionRepositoryPort, MissionTask, PlanValidationIssue, RepoRepositoryPort,
  Repository, RoleRepositoryPort, RoleTemplate, RuntimeProfile, RuntimeProfileRepositoryPort,
  TaskRepositoryPort, Workspace, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { CORE_CAPABILITIES, canTransition, compileWorkflow, validateMissionPlan } from '@tandemise/domain';
import type { MissionDetail } from '@tandemise/api-contract';
import type { WorkflowSourcePort } from '../ports.js';
import type { ApprovalFactory } from '@tandemise/policy';
import type { ExecutionTarget, ExecutionTargetManager } from '@tandemise/execution-core';
import type { RuntimeManager } from '@tandemise/runtimes-core';
import type { Clock, Logger, MissionId, TandemisePaths } from '@tandemise/shared';
import { TandemiseError, errorMessage, ids, slugify, summarize } from '@tandemise/shared';
import type { PlanningService, ProjectionService } from '../services.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import { satisfiableCapabilities } from '../support/capabilities.js';
import { describeIssues } from '../support/dag.js';
import { DEFAULT_PRESET_ID, findPreset, type WorkflowPreset } from '../planning/presets.js';
import { buildPlannerPrompt, describePlan } from '../planning/prompt.js';
import { parsePlanResponse } from '../planning/parse.js';
import { materializePlan, renderPlanDocument } from '../planning/materialize.js';

/** The role whose runtime routing the planner borrows (MVP.md §9.2). */
const PLANNER_ROLE_ID = 'architecture';

/** One retry with the validation issues fed back, then the preset. */
const MAX_PLANNER_ATTEMPTS = 2;

const PLANNER_WALL_TIME_MS = 10 * 60_000;

/** Every capability a plan is allowed to name, before filtering by the machine. */
const KNOWN_CAPABILITIES: readonly Capability[] = Object.values(CORE_CAPABILITIES);

export interface PlanningDeps {
  readonly workspaces: WorkspaceRepositoryPort;
  readonly repositories: RepoRepositoryPort;
  readonly workflows: WorkflowSourcePort;
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly roles: RoleRepositoryPort;
  readonly runtimeProfiles: RuntimeProfileRepositoryPort;
  readonly approvals: ApprovalRepositoryPort;
  readonly approvalFactory: ApprovalFactory;
  readonly artifacts: ArtifactRepositoryPort;
  readonly artifactStore: ArtifactStorePort;
  readonly runtimeManager: RuntimeManager;
  readonly targetManager: ExecutionTargetManager;
  readonly projections: ProjectionService;
  readonly recorder: EventRecorder;
  readonly paths: TandemisePaths;
  readonly clock: Clock;
  readonly log: Logger;
}

/**
 * Planning (MVP.md §9.2, §9.3).
 *
 * The contract this service has to keep is narrow and absolute: **a mission
 * must never be left unable to start.** Planning is the one step that depends
 * on a model producing well-formed structure, and a product whose first action
 * fails when the model has a bad minute is a product nobody trusts. So the
 * ladder is:
 *
 *   1. Ask the planner.
 *   2. If the plan does not validate, ask again with the validator's own issues
 *      quoted back - by far the most likely thing to fix it, and cheap.
 *   3. If it still does not validate, or there was no runtime to ask in the
 *      first place, use the workflow preset and *say so* on the timeline.
 *
 * Step 3 is not a degraded mode hidden from the user. A preset is a known-good
 * plan; the note exists so the user knows their mission is running the standard
 * shape rather than one tailored to their goal, and can re-plan if they care.
 */
export class PlanningServiceImpl implements PlanningService {
  constructor(private readonly deps: PlanningDeps) {}

  async plan(id: MissionId): Promise<MissionDetail> {
    const mission = this.#requireMission(id);
    const workspace = this.#requireWorkspace(mission);
    const repository = mission.repositoryId === null
      ? undefined
      : this.deps.repositories.get(mission.repositoryId);
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id };

    if (!canTransition(mission.status, 'PLANNING')) {
      throw new TandemiseError(
        'PRECONDITION_FAILED',
        `A mission in ${mission.status} cannot be planned.`,
        { details: { missionId: id, status: mission.status } },
      );
    }
    const planning = this.#setStatus(mission, scope, 'PLANNING', 'Planning the mission.');

    const roles = this.deps.roles.list(workspace.id);
    // A project's repositories are what its plans may target: a mission in a
    // three-repository project can put one task in each and keep them in one
    // dependency graph.
    const repositories = this.deps.repositories.listByWorkspace(workspace.id);

    // A workflow the team wrote wins over anything this repository ships. It is
    // compiled rather than proposed: the author already decided what the steps
    // are, and asking a model to re-derive them would be both slower and less
    // faithful than reading the file.
    const authored = await this.#authoredWorkflow(planning, repositories, scope);
    if (authored !== null) {
      const tasks = materializePlan(authored, mission.id, this.deps.clock, repositories);
      this.deps.tasks.replaceAll(mission.id, tasks);
      await this.#storePlanDocument(planning, authored);
      this.deps.recorder.invalidate('tasks', mission.id);
      this.#requestApprovalOrAccept(planning, workspace,
        { plan: authored, source: 'workflow', fallbackReason: null, issues: [] }, scope, tasks);
      return this.deps.projections.missionDetail(mission.id);
    }

    const preset = findPreset(mission.workflowPreset || DEFAULT_PRESET_ID);
    const outcome = await this.#producePlan(
      planning, workspace, repository ?? null, roles, preset, scope, repositories,
    );

    const tasks = materializePlan(outcome.plan, mission.id, this.deps.clock, repositories);
    this.deps.tasks.replaceAll(mission.id, tasks);
    await this.#storePlanDocument(planning, outcome.plan);
    this.deps.recorder.invalidate('tasks', mission.id);

    this.#requestApprovalOrAccept(planning, workspace, outcome, scope, tasks);
    return this.deps.projections.missionDetail(mission.id);
  }

  /**
   * The project's own workflow for this mission, compiled, or null.
   *
   * Null means "nobody wrote one" and the planner ladder runs as before. A file
   * that exists but does not compile is *not* null: it is reported and the
   * mission stops, because falling back to a generic preset when someone wrote
   * a process would run the wrong process silently.
   */
  async #authoredWorkflow(
    mission: Mission,
    repositories: readonly Repository[],
    scope: EventScope,
  ): Promise<MissionPlan | null> {
    const name = mission.workflowPreset.trim();
    if (name === '') return null;

    const available = await this.deps.workflows.list(repositories.map((r: Repository) => r.path));
    const found = available.find((w) => w.id === name);
    if (found === undefined) return null;

    if (found.definition === null) {
      throw TandemiseError.validation(
        `Workflow '${name}' cannot be read: ${found.issues.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join('; ')}`,
        { workflow: name, path: found.path },
      );
    }

    const compiled = compileWorkflow(found.definition, mission.workflowInputs);
    if (!compiled.ok) {
      throw TandemiseError.validation(
        `Workflow '${name}' cannot run: ${compiled.error.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join('; ')}`,
        { workflow: name, path: found.path },
      );
    }

    this.deps.recorder.note(scope, `Running the project's own "${name}" workflow, from ${found.path}.`);
    return compiled.value;
  }

  // -------------------------------------------------------------- the ladder

  async #producePlan(
    mission: Mission,
    workspace: Workspace,
    repository: Repository | null,
    roles: readonly RoleTemplate[],
    preset: WorkflowPreset,
    scope: EventScope,
    repositories: readonly Repository[],
  ): Promise<PlanOutcome> {
    const fallback = (reason: string): PlanOutcome => {
      this.deps.recorder.note(
        scope,
        `Planning fell back to the "${preset.name}" preset: ${reason} `
        + 'The mission will run the preset\'s standard shape rather than a plan tailored to its goal. '
        + 'Re-plan once a runtime is available if you want a tailored plan.',
        'warn',
      );
      return { plan: preset.build(), source: 'preset', fallbackReason: reason, issues: [] };
    };

    const candidates = this.#plannerCandidates(workspace);
    if (candidates.length === 0) {
      return fallback('no enabled runtime profile is configured.');
    }
    const selected = await this.deps.runtimeManager.select(candidates, ['reasoning']);
    if (!selected.ok) {
      return fallback(
        `no healthy runtime could be selected (${
          selected.error.rejections.map((r) => `${r.profileId}: ${r.reason}`).join('; ') || 'no candidates'
        }).`,
      );
    }

    const context = {
      knownRoleIds: new Set(roles.map((r) => r.id)),
      satisfiableCapabilities: satisfiableCapabilities(
        this.deps.runtimeManager.capabilities(selected.value.profile),
        KNOWN_CAPABILITIES,
      ),
      knownRepositoryNames: new Set(repositories.map((r) => r.name.toLowerCase())),
    };

    let target: ExecutionTarget;
    try {
      target = await this.#provisionPlannerTarget(mission, workspace, repository);
    } catch (e) {
      return fallback(`no target could be provisioned for the planner (${errorMessage(e)}).`);
    }

    try {
      let issues: readonly PlanValidationIssue[] = [];
      for (let attempt = 1; attempt <= MAX_PLANNER_ATTEMPTS; attempt++) {
        const prompt = this.#prompt(mission, repository, roles, preset, context, issues, attempt, repositories);
        const response = await this.#runPlanner(
          selected.value.profile, prompt, target, scope, attempt,
        );
        if (!response.ok) {
          return fallback(`the planner run failed (${response.error}).`);
        }

        const parsed = parsePlanResponse(response.value);
        if (!parsed.ok) {
          issues = parsed.error.map((message) => ({ severity: 'error' as const, taskKey: null, message }));
          this.deps.recorder.note(
            scope, `Planner attempt ${attempt} produced an unusable plan: ${parsed.error.join('; ')}`, 'warn',
          );
          continue;
        }

        const validated = validateMissionPlan(parsed.value, context);
        if (validated.ok) {
          this.deps.recorder.note(
            scope,
            `Planner produced ${describePlan(validated.value)} on attempt ${attempt}.`,
          );
          return { plan: validated.value, source: 'planner', fallbackReason: null, issues: [] };
        }
        issues = validated.error;
        this.deps.recorder.note(
          scope,
          `Planner attempt ${attempt} produced an invalid plan: ${describeIssues(validated.error)}`,
          'warn',
        );
      }
      return fallback(`the planner produced an invalid plan twice (${describeIssues(issues)}).`);
    } finally {
      await this.#releasePlannerTarget(target);
    }
  }

  #prompt(
    mission: Mission,
    repository: Repository | null,
    roles: readonly RoleTemplate[],
    preset: WorkflowPreset,
    context: { satisfiableCapabilities: ReadonlySet<Capability> },
    issues: readonly PlanValidationIssue[],
    attempt: number,
    repositories: readonly Repository[],
  ): string {
    const base = buildPlannerPrompt({
      mission,
      repository,
      repositories,
      roles,
      preset,
      availableCapabilities: [...context.satisfiableCapabilities],
      repositoryContext: repository === null
        ? null
        : `Checkout at ${repository.path} on ${repository.defaultBranch}. `
          + `Configured checks: ${describeChecks(repository)}.`,
    });
    if (attempt === 1 || issues.length === 0) return base;

    // The retry that matters: the validator's own words, verbatim. A planner
    // told "invalid plan" guesses; a planner told "task `qa` requires
    // 'ChangeSet', which is produced by a task that is not an upstream
    // dependency" fixes exactly that.
    return [
      base,
      '',
      '# Your previous attempt was rejected',
      '',
      'These are the validator\'s findings, verbatim. Fix every one of them and return the',
      'corrected plan. Do not change anything else about your approach.',
      '',
      ...issues
        .filter((i) => i.severity === 'error')
        .map((i) => `- ${i.taskKey === null ? '' : `\`${i.taskKey}\`: `}${i.message}`),
    ].join('\n');
  }

  // ----------------------------------------------------------------- the run

  async #runPlanner(
    profile: RuntimeProfile,
    prompt: string,
    target: ExecutionTarget,
    scope: EventScope,
    attempt: number,
  ): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
    const runId = ids.run();
    const runScope: EventScope = { ...scope, roleId: PLANNER_ROLE_ID, runtimeProfileId: profile.id };
    const controller = new AbortController();
    const budget = AbortSignal.timeout(PLANNER_WALL_TIME_MS);
    const signal = AbortSignal.any([controller.signal, budget]);

    this.deps.recorder.record(runScope, {
      type: 'run.started',
      attempt,
      runtime: profile.name,
      target: `${target.kind}:${target.workingDirectory}`,
    });

    const chunks: string[] = [];
    let failure: string | null = null;
    const startedAt = this.deps.clock.epochMs();

    try {
      for await (const event of this.deps.runtimeManager.start({
        runId,
        profile,
        prompt,
        workingDirectory: target.workingDirectory,
        // Planning reads; it never writes code. Handing it anything more would
        // make "the planner edited my repository" a possible sentence.
        grants: [CORE_CAPABILITIES.repositoryRead, CORE_CAPABILITIES.filesystemRead],
        allowedRoots: [],
        mcpConfigPath: null,
        maxWallTimeMs: PLANNER_WALL_TIME_MS,
        signal,
        log: this.deps.log.child({ runId, missionId: scope.missionId, runtime: profile.adapterId }),
      })) {
        // The planner has no task and therefore no `Run` row to hang events off,
        // but its output is still part of the mission's causal record: a user
        // whose plan was rejected twice has to be able to read why.
        this.deps.recorder.record(runScope, event);
        if (event.type === 'message') chunks.push(event.text);
        if (event.type === 'completed' && event.summary !== undefined) chunks.push(event.summary);
        if (event.type === 'failed') failure = `${event.code}: ${event.message}`;
      }
    } catch (e) {
      failure = errorMessage(e);
    }

    this.deps.recorder.record(runScope, {
      type: 'run.finished',
      status: failure === null ? 'SUCCEEDED' : 'FAILED',
      durationMs: this.deps.clock.epochMs() - startedAt,
    });

    if (failure !== null) return { ok: false, error: failure };
    const text = chunks.join('\n').trim();
    return text.length === 0
      ? { ok: false, error: 'the planner produced no output' }
      : { ok: true, value: text };
  }

  // --------------------------------------------------------------- targets

  async #provisionPlannerTarget(
    mission: Mission,
    workspace: Workspace,
    repository: Repository | null,
  ): Promise<ExecutionTarget> {
    return this.deps.targetManager.provision({
      workspaceId: workspace.id,
      missionId: mission.id,
      taskId: null,
      kind: 'local',
      name: `${slugify(mission.title)}-planning`,
      // With no repository there is nothing to read, so the planner is given the
      // Tandemise home as a neutral, always-present working directory.
      repositoryPath: repository?.path ?? this.deps.paths.root,
      missionSlug: slugify(mission.title),
    });
  }

  async #releasePlannerTarget(target: ExecutionTarget): Promise<void> {
    try {
      await this.deps.targetManager.release(target.describe());
    } catch (e) {
      this.deps.log.warn('planning.target_release_failed', { error: errorMessage(e) });
    }
  }

  // -------------------------------------------------------------- acceptance

  async #storePlanDocument(mission: Mission, plan: MissionPlan): Promise<void> {
    try {
      const previous = this.deps.artifacts.latest(mission.id, 'MissionPlan');
      const manifest = await this.deps.artifactStore.write({
        workspaceId: mission.workspaceId,
        missionId: mission.id,
        taskId: null,
        createdByRunId: null,
        type: 'MissionPlan',
        title: `Plan for ${mission.title}`,
        body: renderPlanDocument(plan, mission.title),
        sourceRefs: [],
        supersedes: previous?.id ?? null,
        summary: plan.summary.trim().length > 0 ? plan.summary.trim() : describePlan(plan),
      });
      this.deps.artifacts.create(manifest);
      this.deps.recorder.invalidate('artifacts', mission.id);
    } catch (e) {
      // The plan is already in the task rows; losing its readable rendering is
      // a degraded approval card, not a failed mission.
      this.deps.log.warn('planning.plan_document_failed', {
        missionId: mission.id, error: errorMessage(e),
      });
    }
  }

  #requestApprovalOrAccept(
    mission: Mission,
    workspace: Workspace,
    outcome: PlanOutcome,
    scope: EventScope,
    tasks: readonly MissionTask[],
  ): void {
    const description = describePlan(outcome.plan);
    if (workspace.autonomy.planApproval !== 'ask') {
      this.deps.recorder.note(
        scope,
        `Plan accepted automatically (${description}). Start the mission when you are ready.`,
      );
      this.deps.missions.update(mission.id, {
        statusReason: `Planned: ${description}. Ready to start.`,
      });
      return;
    }

    const artifact = this.deps.artifacts.latest(mission.id, 'MissionPlan');
    const approval = this.deps.approvalFactory.createOrThrow({
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      taskId: null,
      kind: 'plan',
      risk: 'read',
      title: `Approve the plan for ${mission.title}?`,
      rationale: outcome.fallbackReason === null
        ? `The planner proposed ${description}.`
        : `${description}, from the workflow preset because ${outcome.fallbackReason}`,
      effect: 'Approving starts the mission and dispatches its first tasks. '
        + 'Rejecting leaves the mission blocked so you can change the goal or re-plan.',
      evidence: [
        { kind: 'text', label: 'Shape', value: description },
        { kind: 'text', label: 'Summary', value: summarize(outcome.plan.summary || description, 600) },
        ...tasks.slice(0, 12).map((t) => ({
          kind: 'text' as const,
          label: `${t.key} (${t.roleId})`,
          value: summarize(t.objective, 240),
        })),
        ...(artifact === undefined
          ? []
          : [{ kind: 'artifact' as const, label: 'MissionPlan', value: artifact.id }]),
      ],
    });
    this.deps.approvals.create(approval);
    this.deps.recorder.record(scope, { type: 'approval.requested', approvalId: approval.id });
    this.deps.recorder.invalidate('approvals', mission.id);
    this.#setStatus(mission, scope, 'AWAITING_PLAN_APPROVAL', `Waiting for plan approval: ${description}.`);
  }

  // ----------------------------------------------------------------- helpers

  #plannerCandidates(workspace: Workspace): readonly RuntimeProfile[] {
    const all = this.deps.runtimeProfiles.list(workspace.id).filter((p) => p.enabled);
    const routed = workspace.routing[PLANNER_ROLE_ID];
    if (routed === undefined || routed.length === 0) return all;
    return routed.flatMap((id) => all.filter((p) => p.id === id));
  }

  #setStatus(mission: Mission, scope: EventScope, status: Mission['status'], reason: string): Mission {
    if (mission.status === status) return mission;
    const updated = this.deps.missions.update(mission.id, { status, statusReason: reason });
    this.deps.recorder.record(scope, {
      type: 'mission.status', from: mission.status, to: status, reason,
    });
    this.deps.recorder.invalidate('missions', mission.id);
    return updated;
  }

  #requireMission(id: MissionId): Mission {
    const mission = this.deps.missions.get(id);
    if (mission === undefined) throw TandemiseError.notFound('Mission', id);
    return mission;
  }

  #requireWorkspace(mission: Mission): Workspace {
    const workspace = this.deps.workspaces.get(mission.workspaceId);
    if (workspace === undefined) throw TandemiseError.notFound('Workspace', mission.workspaceId);
    return workspace;
  }
}

interface PlanOutcome {
  readonly plan: MissionPlan;
  /** `workflow` is a file the team wrote; the other two are this repo's. */
  readonly source: 'planner' | 'preset' | 'workflow';
  /** Set only when the preset was used, and stated verbatim on the timeline. */
  readonly fallbackReason: string | null;
  readonly issues: readonly PlanValidationIssue[];
}

function describeChecks(repository: Repository): string {
  const configured = Object.entries(repository.checks)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
    .map(([name, command]) => `${name} (\`${command}\`)`);
  return configured.length === 0 ? 'none detected' : configured.join(', ');
}
