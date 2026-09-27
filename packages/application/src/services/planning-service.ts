import type {
  ApprovalRepositoryPort, ArtifactHandoff, ArtifactRepositoryPort, ArtifactStorePort, Capability, MemberRepositoryPort, Mission,
  MissionCriteriaRepositoryPort, MissionPlan, MissionQuestionRepositoryPort, MissionRepositoryPort, MissionTask, PlanValidationIssue, RepoRepositoryPort,
  PlannedTask, Repository, RoleRepositoryPort, RoleTemplate, RuntimeProfile, RuntimeProfileRepositoryPort, SkillPin,
  TaskRepositoryPort, Workspace, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { ARTIFACT_OUT_DIR, CORE_CAPABILITIES, RUNTIME_ACTOR, DEFAULT_ESCALATE_AFTER_MS, canTransition, indexTeam, isActiveMember, compileWorkflow, validateMissionPlan } from '@tandemise/domain';
import type { MissionDetail } from '@tandemise/api-contract';
import type { ArtifactMeasurePort, WorkflowSourcePort } from '../ports.js';
import type { ReadinessService } from './readiness.js';
import type { ApprovalFactory } from '@tandemise/policy';
import type { ExecutionTarget, ExecutionTargetManager } from '@tandemise/execution-core';
import { describeRejections, onlyBusy } from '@tandemise/runtimes-core';
import type { RuntimeManager, RuntimeSelection, SlotReservation } from '@tandemise/runtimes-core';
import type { Clock, Logger, MissionId, TandemisePaths, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, errorMessage, ids, slugify, summarize } from '@tandemise/shared';
import type { PlanningService, ProjectionService } from '../services.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import { satisfiableCapabilities } from '../support/capabilities.js';
import { describeIssues } from '../support/dag.js';
import { DEFAULT_PRESET_ID, findPreset, type WorkflowPreset } from '../planning/presets.js';
import { buildPlannerPrompt, describePlan, type ConnectedApp } from '../planning/prompt.js';
import { parsePlanResponse } from '../planning/parse.js';
import { clip, materializePlan, planTitle, renderPlanDocument } from '../planning/materialize.js';
import { ensureTandemiseIgnore } from '../support/ignore.js';

/** The role whose runtime routing the planner borrows (MVP.md §9.2). */
const PLANNER_ROLE_ID = 'architecture';

/** One retry with the validation issues fed back, then the preset. */
const MAX_PLANNER_ATTEMPTS = 2;

const PLANNER_WALL_TIME_MS = 10 * 60_000;

/** How long planning waits for a busy runtime before falling back to the preset. */
const PLANNER_SLOT_WAIT_MS = 30 * 60_000;
const PLANNER_SLOT_POLL_MS = 3_000;

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
  /** The workspace's owners, who a plan nobody asked for by name goes to. */
  readonly members: MemberRepositoryPort;
  readonly artifacts: ArtifactRepositoryPort;
  readonly artifactStore: ArtifactStorePort;
  /** Cuts the plan's summary to a headline and measures the plan document. */
  readonly measure: ArtifactMeasurePort;
  readonly runtimeManager: RuntimeManager;
  readonly targetManager: ExecutionTargetManager;
  readonly projections: ProjectionService;
  readonly recorder: EventRecorder;
  readonly paths: TandemisePaths;
  readonly clock: Clock;
  readonly log: Logger;
  /** Healthy integrations in the workspace. Optional: a composition without integrations plans without them. */
  readonly connectedApps?: (workspaceId: string) => Promise<readonly ConnectedApp[]>;
  /**
   * The readiness gate a DRAFT mission must pass before it is planned (P6).
   * Optional only so harnesses built before it still compose; the module
   * always passes it, and so does every route.
   */
  readonly readiness?: ReadinessService;
  /** The accepted ledger and the answers, which the planner is told. */
  readonly criteria?: Pick<MissionCriteriaRepositoryPort, 'listActive'>;
  readonly questions?: Pick<MissionQuestionRepositoryPort, 'listByMission'>;
  /** The skills library (P13): pins resolved when the tasks are created. Optional for older harnesses. */
  readonly skills?: SkillPinning;
}

/** What planning asks of the skills library (P13). */
export interface SkillPinning {
  pinsFor(
    workspaceId: WorkspaceId,
    role: RoleTemplate | undefined,
    step: Pick<PlannedTask, 'key' | 'skillRefs'>,
  ): { readonly pins: readonly SkillPin[]; readonly problems: readonly string[] };
}

/** Materialisation's pinning for a plan in this project, or nothing when there is no library. */
export function skillPinner(
  skills: SkillPinning | undefined,
  workspaceId: WorkspaceId,
  roles: readonly RoleTemplate[],
): { skills?: (task: PlannedTask) => readonly SkillPin[] } {
  if (skills === undefined) return {};
  return { skills: (task) => skills.pinsFor(workspaceId, roles.find((r) => r.id === task.roleId), task).pins };
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
  /** One per mission being planned in this process, so cancelling can stop the planner run. */
  readonly #planning = new Map<MissionId, AbortController>();

  constructor(private readonly deps: PlanningDeps) {}

  abandon(id: MissionId): void {
    this.#planning.get(id)?.abort();
  }

  isPlanning(id: MissionId): boolean {
    return this.#planning.has(id);
  }

  async plan(id: MissionId): Promise<MissionDetail> {
    const planning = this.#enterPlanning(id);
    return this.#planFrom(planning);
  }

  /**
   * Starts planning and returns at once, with the mission already in PLANNING.
   *
   * Planning runs a model and routinely takes longer than any sensible HTTP
   * timeout - the desktop gives up after 30s, and planning a real mission took
   * 40s and more - so a request that waited for it reported failure for a
   * mission that was in fact created and planned, and left the user on the
   * form wondering whether to press the button again. The plan's progress and
   * outcome reach the UI the way everything else does: over the event stream.
   */
  async begin(id: MissionId): Promise<MissionDetail> {
    const planning = this.#enterPlanning(id);
    this.#inBackground(planning);
    return this.deps.projections.missionDetail(id);
  }

  /**
   * Re-plans every mission a previous daemon left in PLANNING.
   *
   * Planning lives in memory. A daemon that exits mid-plan leaves a mission in
   * a state nothing will move it out of - and PLANNING offers the user no way
   * to re-plan either - so the only honest recovery is to plan it again.
   */
  resumeInterrupted(): readonly MissionId[] {
    const stranded = this.deps.missions.list({ statuses: ['PLANNING'] });
    for (const mission of stranded) {
      this.deps.recorder.note(
        { workspaceId: mission.workspaceId, missionId: mission.id },
        'The daemon stopped while this mission was being planned. Planning it again.',
        'warn',
      );
      this.#inBackground(mission);
    }
    return stranded.map((m) => m.id);
  }

  #inBackground(planning: Mission): void {
    const scope: EventScope = { workspaceId: planning.workspaceId, missionId: planning.id };
    void this.#planFrom(planning).catch((e: unknown) => {
      // Never leave a mission in PLANNING because planning threw: BLOCKED says
      // why and offers Re-plan, where PLANNING offers nothing.
      this.deps.log.error('planning.failed', { missionId: planning.id, error: errorMessage(e) });
      const current = this.deps.missions.get(planning.id);
      if (current?.status === 'PLANNING') {
        this.#setStatus(current, scope, 'BLOCKED', `Planning failed: ${errorMessage(e)}`);
      }
    });
  }

  #enterPlanning(id: MissionId): Mission {
    const mission = this.#requireMission(id);
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id };
    if (!canTransition(mission.status, 'PLANNING')) {
      throw new TandemiseError(
        'PRECONDITION_FAILED',
        `A mission in ${mission.status} cannot be planned.`,
        { details: { missionId: id, status: mission.status } },
      );
    }
    // The Definition of Ready (P6). Every way into planning - the Plan
    // button, POST /plan, planNow - comes through here, so none can skip it.
    // Only the first plan is gated: a mission that already left DRAFT was
    // judged ready then, and one from before P6 must stay re-plannable.
    if (mission.status === 'DRAFT') this.deps.readiness?.assertReady(id);
    // A re-plan replaces the tasks the pending plan approval describes, so that
    // approval would authorize a plan that no longer exists.
    for (const approval of this.deps.approvals.list({ missionId: id, statuses: ['PENDING'] })) {
      if (approval.kind !== 'plan') continue;
      this.deps.approvals.update(approval.id, { status: 'CANCELLED', decidedAt: this.deps.clock.now() });
      this.deps.recorder.invalidate('approvals', id);
    }
    return this.#setStatus(mission, scope, 'PLANNING', 'Planning the mission.');
  }

  async #planFrom(planning: Mission): Promise<MissionDetail> {
    const controller = new AbortController();
    this.#planning.set(planning.id, controller);
    try {
      return await this.#planWithin(planning);
    } finally {
      if (this.#planning.get(planning.id) === controller) this.#planning.delete(planning.id);
    }
  }

  /**
   * Whether the mission is still being planned, re-read now.
   *
   * Planning takes minutes and the person may cancel meanwhile - more so now
   * that the backlog starts planning on its own. A plan that arrives for a
   * mission that left PLANNING is discarded: writing its tasks and raising a
   * plan approval would put a cancelled mission back in front of the person.
   */
  #stillPlanning(planning: Mission, scope: EventScope): boolean {
    const current = this.deps.missions.get(planning.id);
    if (current?.status === 'PLANNING') return true;
    this.deps.recorder.note(
      scope,
      `Planning finished after the mission was ${current === undefined ? 'deleted' : current.status === 'CANCELLED' ? 'cancelled' : `moved to ${current.status}`}; the plan was discarded.`,
    );
    this.deps.log.info('planning.discarded', { missionId: planning.id, status: current?.status ?? null });
    return false;
  }

  async #planWithin(planning: Mission): Promise<MissionDetail> {
    const mission = planning;
    const workspace = this.#requireWorkspace(mission);
    const repository = mission.repositoryId === null
      ? undefined
      : this.deps.repositories.get(mission.repositoryId);
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id };

    const roles = this.deps.roles.list(workspace.id);
    // A project's repositories are what its plans may target: a mission in a
    // three-repository project can put one task in each and keep them in one
    // dependency graph.
    const repositories = this.deps.repositories.listByWorkspace(workspace.id);

    // A workflow the team wrote wins over anything this repository ships. It is
    // compiled rather than proposed: the author already decided what the steps
    // are, and asking a model to re-derive them would be both slower and less
    // faithful than reading the file.
    const authored = await this.#authoredWorkflow(planning, repositories, roles, scope);
    if (authored !== null) {
      if (!this.#stillPlanning(planning, scope)) return this.deps.projections.missionDetail(mission.id);
      const tasks = materializePlan(authored, mission.id, this.deps.clock, repositories, skillPinner(this.deps.skills, workspace.id, roles));
      this.deps.tasks.replaceAll(mission.id, tasks);
      await this.#storePlanDocument(planning, authored, workspace);
      this.deps.recorder.invalidate('tasks', mission.id);
      this.#requestApprovalOrAccept(planning, workspace,
        { plan: authored, source: 'workflow', fallbackReason: null, issues: [] }, scope, tasks);
      return this.deps.projections.missionDetail(mission.id);
    }

    const preset = findPreset(mission.workflowPreset || DEFAULT_PRESET_ID);
    const outcome = await this.#producePlan(
      planning, workspace, repository ?? null, roles, preset, scope, repositories,
    );

    if (!this.#stillPlanning(planning, scope)) return this.deps.projections.missionDetail(mission.id);
    // A preset names its inputs, so inferring only fills what a model's plan left out.
    const tasks = materializePlan(outcome.plan, mission.id, this.deps.clock, repositories, { inferInputs: true, ...skillPinner(this.deps.skills, workspace.id, roles) });
    this.deps.tasks.replaceAll(mission.id, tasks);
    await this.#storePlanDocument(planning, outcome.plan, workspace);
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
    roles: readonly RoleTemplate[],
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

    const compiled = compileWorkflow(found.definition, mission.workflowInputs, {
      // So a `development` step gets a worktree without the author having to
      // ask for one.
      isolationForRole: (roleId) => roles.find((r) => r.id === roleId)?.defaultIsolation,
    });
    if (!compiled.ok) {
      throw TandemiseError.validation(
        `Workflow '${name}' cannot run: ${compiled.error.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join('; ')}`,
        { workflow: name, path: found.path },
      );
    }

    // P13: every skill a step or its role pins must be in the library now, at
    // that version; a workflow that names one it cannot have does not run.
    if (this.deps.skills !== undefined) {
      const skills = this.deps.skills;
      const problems = compiled.value.tasks.flatMap((task) =>
        skills.pinsFor(mission.workspaceId, roles.find((r) => r.id === task.roleId), task).problems);
      if (problems.length > 0) {
        throw TandemiseError.validation(`Workflow '${name}' cannot run: ${[...new Set(problems)].join(' ')}`, { workflow: name, path: found.path });
      }
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
      return { plan: preset.build({ hasTestCommand: (repository?.checks?.test ?? null) !== null }), source: 'preset', fallbackReason: reason, issues: [] };
    };

    const candidates = this.#plannerCandidates(workspace);
    if (candidates.length === 0) {
      return fallback('no enabled runtime profile is configured.');
    }
    const selected = await this.#selectPlannerRuntime(candidates, scope);
    if (!selected.ok) {
      return fallback(
        `no healthy runtime could be selected (${
          describeRejections(selected.error.rejections) || 'no candidates'
        }).`,
      );
    }
    try {
      return await this.#planWith(selected.value, mission, repository, roles, preset, scope, repositories, workspace, fallback);
    } finally {
      selected.value.reservation.release();
    }
  }

  /**
   * A runtime for the planner, waiting for one that is merely busy.
   *
   * Falling back to the preset because the only runtime was running another
   * task handed the user a generic seven-step pipeline for a goal the planner
   * would have shaped - it planned a one-line sidebar change as full feature
   * delivery - and nothing on the approval said why. Busy is a reason to wait;
   * only a runtime that cannot plan at all is a reason to fall back.
   */
  async #selectPlannerRuntime(
    candidates: readonly RuntimeProfile[],
    scope: EventScope,
  ): ReturnType<RuntimeManager['select']> {
    const deadline = this.deps.clock.epochMs() + PLANNER_SLOT_WAIT_MS;
    let announced = false;
    for (;;) {
      const selected = await this.deps.runtimeManager.select(candidates, ['reasoning']);
      const abandoned = scope.missionId !== undefined && this.#planning.get(scope.missionId)?.signal.aborted === true;
      if (selected.ok || !onlyBusy(selected.error) || this.deps.clock.epochMs() >= deadline || abandoned) return selected;
      if (!announced) {
        announced = true;
        this.deps.recorder.note(scope, 'Every runtime that can plan is busy. Waiting for one to free up.');
      }
      await new Promise((resolve) => setTimeout(resolve, PLANNER_SLOT_POLL_MS));
    }
  }

  async #planWith(
    selection: RuntimeSelection,
    mission: Mission,
    repository: Repository | null,
    roles: readonly RoleTemplate[],
    preset: WorkflowPreset,
    scope: EventScope,
    repositories: readonly Repository[],
    workspace: Workspace,
    fallback: (reason: string) => PlanOutcome,
  ): Promise<PlanOutcome> {
    const selected = { value: selection };

    const context = {
      knownRoleIds: new Set(roles.map((r) => r.id)),
      satisfiableCapabilities: satisfiableCapabilities(
        this.deps.runtimeManager.capabilities(selected.value.profile),
        KNOWN_CAPABILITIES,
      ),
      knownRepositoryNames: new Set(repositories.map((r) => r.name.toLowerCase())),
    };

    let apps: readonly ConnectedApp[] = [];
    try {
      apps = (await this.deps.connectedApps?.(workspace.id)) ?? [];
    } catch (e) {
      this.deps.log.warn('planning.connected_apps_unavailable', { error: errorMessage(e) });
    }

    let target: ExecutionTarget;
    try {
      target = await this.#provisionPlannerTarget(mission, workspace, repository);
    } catch (e) {
      return fallback(`no target could be provisioned for the planner (${errorMessage(e)}).`);
    }

    try {
      let issues: readonly PlanValidationIssue[] = [];
      for (let attempt = 1; attempt <= MAX_PLANNER_ATTEMPTS; attempt++) {
        const prompt = this.#prompt(mission, repository, roles, preset, context, issues, attempt, repositories, apps);
        const response = await this.#runPlanner(
          selected.value.profile, prompt, target, scope, attempt, selected.value.reservation,
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
    connectedApps: readonly ConnectedApp[] = [],
  ): string {
    const answers = (this.deps.questions?.listByMission(mission.id) ?? [])
      .flatMap((q) => (q.status === 'answered' && q.answer !== null ? [{ key: q.key, text: q.text, answer: q.answer }] : []));
    const base = buildPlannerPrompt({
      criteria: (this.deps.criteria?.listActive(mission.id) ?? [])
        .filter((c) => c.source === 'user').map((c) => ({ key: c.key, statement: c.statement })),
      answers,
      connectedApps,
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
    reservation: SlotReservation,
  ): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
    const runId = ids.run();
    const runScope: EventScope = { ...scope, roleId: PLANNER_ROLE_ID, runtimeProfileId: profile.id };
    const budget = AbortSignal.timeout(PLANNER_WALL_TIME_MS);
    // Cancelling the mission aborts the run (`abandon`): no model keeps thinking about a plan nobody wants.
    const abandoned = scope.missionId === undefined ? undefined : this.#planning.get(scope.missionId)?.signal;
    const signal = AbortSignal.any([budget, ...(abandoned === undefined ? [] : [abandoned])]);

    this.deps.recorder.record(runScope, {
      type: 'run.started',
      attempt,
      runtime: profile.name,
      target: `${target.kind}:${target.workingDirectory}`,
    });

    const chunks: string[] = [];
    let failure: string | null = null;
    const startedAt = this.deps.clock.epochMs();

    // The plan comes back in a file, not in the chat reply. Streamed messages
    // are clipped for the timeline (16k characters), and a detailed plan for a
    // real mission is longer than that: it arrived truncated, failed to parse
    // twice, and the mission fell back to the generic preset.
    const planDir = `${ARTIFACT_OUT_DIR}/planning-${scope.missionId ?? 'mission'}-${attempt}`;
    const planFile = `${planDir}/plan.json`;
    const fs = target.filesystem();
    try {
      if (await fs.exists(planDir)) await fs.remove(planDir, { recursive: true });
      await fs.mkdir(planDir);
      await ensureTandemiseIgnore(fs);
    } catch (e) {
      this.deps.log.warn('planning.plan_file_unavailable', { error: errorMessage(e) });
    }
    const filePrompt = `${prompt}

# Where the plan goes

Write the JSON object to the file \`${planFile}\` (relative to your working
directory) with your file-writing tool, then reply with only the word DONE. A
long plan sent as a chat reply can be cut off; the file cannot. If you have no
way to write that file, reply with the JSON object instead.`;

    try {
      for await (const event of this.deps.runtimeManager.start({
        runId,
        profile,
        prompt: filePrompt,
        workingDirectory: target.workingDirectory,
        // Planning reads; it never writes code. Its only write is the plan file,
        // and artifact.write alone scopes file edits to the out directory.
        grants: [CORE_CAPABILITIES.repositoryRead, CORE_CAPABILITIES.filesystemRead, CORE_CAPABILITIES.artifactWrite],
        allowedRoots: [],
        mcpConfigPath: null,
        maxWallTimeMs: PLANNER_WALL_TIME_MS,
        // Honoured on the first attempt only; a retry claims a fresh slot.
        reservation,
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
    try {
      if (await fs.exists(planFile)) {
        const written = (await fs.read(planFile)).trim();
        if (written.length > 0) return { ok: true, value: written };
      }
    } catch (e) {
      this.deps.log.warn('planning.plan_file_unreadable', { error: errorMessage(e) });
    } finally {
      await fs.remove(planDir, { recursive: true }).catch(() => undefined);
    }
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

  async #storePlanDocument(mission: Mission, plan: MissionPlan, workspace: Workspace): Promise<void> {
    try {
      const previous = this.deps.artifacts.latest(mission.id, 'MissionPlan');
      const handoff = this.#planHandoff(plan, workspace);
      const body = renderPlanDocument(plan, mission.title, handoff);
      const manifest = await this.deps.artifactStore.write({
        workspaceId: mission.workspaceId,
        missionId: mission.id,
        taskId: null,
        createdByRunId: null,
        type: 'MissionPlan',
        title: planTitle(mission.title),
        body,
        sourceRefs: [],
        supersedes: previous?.id ?? null,
        summary: handoff.headline,
      });
      // Written by the planner run, not by a member; answered for by whoever asked for the mission.
      // Measured for the reader but never held to a budget: like a person's
      // text, the plan document is a system summary, not an agent's draft.
      this.deps.artifacts.create({
        ...manifest, authorId: RUNTIME_ACTOR, responsibleId: mission.createdBy ?? null,
        handoff, wordCount: this.deps.measure.measure('MissionPlan', body).mainWords, overBudget: false,
      });
      this.deps.recorder.invalidate('artifacts', mission.id);
    } catch (e) {
      // The plan is already in the task rows; losing its readable rendering is
      // a degraded approval card, not a failed mission.
      this.deps.log.warn('planning.plan_document_failed', {
        missionId: mission.id, error: errorMessage(e),
      });
    }
  }

  /**
   * What the plan card says before anyone opens the plan: its one-line summary,
   * its shape and the first thing that will stop for a person. That the
   * mission waits on its approval is said once, in `needs`, which the feed and
   * reader hide once the plan is decided; a point saying it would outlive the
   * approval and repeat the needs line while it lasts.
   */
  #planHandoff(plan: MissionPlan, workspace: Workspace): ArtifactHandoff {
    const description = describePlan(plan);
    const awaitsApproval = workspace.autonomy.planApproval === 'ask';
    const summary = plan.summary.trim().length > 0 ? plan.summary.trim() : description;
    const stop = plan.tasks.find((t) => t.completionGate !== null || t.approvalPolicy.beforeStart || t.approvalPolicy.onCompletion);
    const stopLine = stop === undefined ? null
      : stop.completionGate !== null ? `First gate: ${stop.key} passes when ${stop.completionGate}`
        : `${stop.title} needs approval ${stop.approvalPolicy.beforeStart ? 'before it starts' : 'when it finishes'}`;
    const points = [description, stopLine]
      .filter((p): p is string => p !== null)
      .map((p) => clip(p, 140));
    return {
      // Cut on a word boundary at 90 characters, the same rule a person's text gets.
      headline: clip(this.deps.measure.deriveHandoff(summary.split('\n')[0] ?? summary).headline, 90),
      points,
      needs: awaitsApproval ? 'Approve the plan to start' : null,
      changed: [],
      links: [],
    };
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
      addressees: this.#planAddressees(mission),
      escalateAfterMs: DEFAULT_ESCALATE_AFTER_MS,
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

  /**
   * Whoever asked for the mission, while they are still an active person on
   * the team; otherwise the owners, who always exist.
   */
  #planAddressees(mission: Mission): readonly string[] {
    const team = indexTeam(this.deps.members.listByWorkspace(mission.workspaceId, { includeRemoved: true }));
    const creator = mission.createdBy ?? null;
    if (creator !== null && isActiveMember(team, creator) && team.byId.get(creator)?.kind === 'person') return [creator];
    return team.owners.map((m) => m.id);
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
