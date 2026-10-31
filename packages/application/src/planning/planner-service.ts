import {
  FACTORY_WORKFLOW_ID, IMPLICIT_CRITERION, IMPLICIT_CRITERION_KEY,
  addSkillRefs, applyModules, chooseLane, compileWorkflow, isTrialMission, laneWorkflowId, parseSkillRef,
  profileRuleContext, profileLine, profileTask, stepClassFor, tiebreakReason, validateMissionPlan,
  type Lane, type MissionPlan, type Mission, type MissionCriteriaRepositoryPort, type MissionRepositoryPort,
  type PlanDecision, type PlanDecisionRepositoryPort, type PlannedTask, type PlannerConfig, type ProfileInput,
  type RepoRepositoryPort, type Repository, type RoleRepositoryPort, type RoleTemplate, type SkillRef, type TaskProfile,
  type WorkflowDefinition, type Workspace, type WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { ids, type Clock, type Logger, type MissionId, type Timestamp, type WorkspaceId } from '@tandemise/shared';
import type { FactoryConfigSourcePort, WorkflowSourcePort } from '../ports.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import type { WorkflowPreset } from './presets.js';
import { loadFactoryConfig, type FactoryConfig } from './factory-config.js';
import { laneWorkflows, SHIP_STEP_KEY, VERIFY_STEP_KEY } from './defaults/lanes.js';
import { gatherSignals, userCriteriaCount } from './signals.js';
import { runTiebreak, type TiebreakRunnerPort } from './tiebreak.js';
import type { SkillPinning } from '../services/planning-service.js';

/**
 * The factory planner (#53 §5): the first rung of planning for missions whose
 * workflow is `auto`. Profile, lane, the lane's workflow, modules, skills and
 * validation, with no model call for quick and standard work (the tiebreak
 * aside). The careful lane hands its compiled plan to today's planner run as
 * the starting shape, and the tailored plan comes back through modules,
 * skills and validation, so tailoring can't drop a module's step or gate.
 *
 * Planning never fails because of a rule: an invalid result drops modules,
 * then falls back to the bare lane workflow, then returns null, and today's
 * ladder runs.
 */

/** Quick-lane planning, Start to the first READY step, without a model call. Measured in planner-check. */
export const QUICK_PLAN_BUDGET_MS = 200;

/** The planner role whose economy model breaks ties (P12). */
const PLANNER_ROLE_ID = 'architecture';

export interface PlannerDeps {
  readonly factory: FactoryConfigSourcePort;
  readonly workflows: WorkflowSourcePort;
  readonly workspaces: WorkspaceRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly criteria: Pick<MissionCriteriaRepositoryPort, 'listActive' | 'seed'>;
  readonly repositories: RepoRepositoryPort;
  readonly roles: RoleRepositoryPort;
  readonly planDecisions: PlanDecisionRepositoryPort;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
  readonly tiebreak?: TiebreakRunnerPort;
  readonly skills?: SkillPinning;
}

export interface FactoryPlan {
  readonly plan: MissionPlan;
  readonly lane: Lane;
  readonly decision: PlanDecision;
  /** Quick or standard with no Done-when line: an implicit criterion is written. */
  readonly implicitCriterion: boolean;
  /** Careful lane only: the compiled plan as the planner run's starting shape. */
  readonly preset: WorkflowPreset | null;
}

interface PlanContext {
  readonly roles: readonly RoleTemplate[];
  readonly repositories: readonly Repository[];
  readonly workspace: Workspace;
  readonly repository: Repository | null;
}

export class PlannerService {
  readonly #configs = new Map<WorkspaceId, FactoryConfig>();
  readonly #predicted = new Map<MissionId, Lane>();

  constructor(private readonly deps: PlannerDeps) {}

  /** Whether planning a mission goes through the factory. */
  handles(mission: Mission): boolean {
    return mission.workflowPreset === FACTORY_WORKFLOW_ID && !isTrialMission(mission);
  }

  /**
   * Loads the factory files and predicts the lane, so the synchronous
   * readiness check can ask `skipsReadiness`. Called before entering PLANNING.
   */
  async warm(missionId: MissionId): Promise<void> {
    const mission = this.deps.missions.get(missionId);
    if (mission === undefined || !this.handles(mission)) return;
    try {
      const predicted = await this.predict(mission);
      this.#predicted.set(missionId, predicted.lane);
    } catch (e) {
      this.deps.log.warn('planner.warm_failed', { missionId, error: String(e) });
    }
  }

  /**
   * Refinement and readiness survive only in the careful lane (#53 §4). From
   * the rules-only prediction: a tiebreak that later moves the lane to careful
   * doesn't re-impose readiness, but the planner run and plan approval apply.
   */
  skipsReadiness(mission: Mission): boolean {
    if (!this.handles(mission)) return false;
    if (mission.laneRequest === 'careful') return false;
    const lane = this.#predicted.get(mission.id);
    return lane !== undefined && lane !== 'careful';
  }

  async predict(mission: Mission): Promise<{ profile: TaskProfile; lane: Lane; because: string; config: FactoryConfig }> {
    const repositories = this.#orderedRepositories(mission.workspaceId);
    const config = await this.#config(mission.workspaceId, repositories, true);
    const input = gatherSignals({ mission, criteria: this.deps.criteria.listActive(mission.id), repositories });
    const profile = profileTask(input, config.planner);
    return { profile, config, ...chooseLane(profile, config.planner, input.person) };
  }

  /** The factory files for a project, read fresh. */
  async config(workspaceId: WorkspaceId): Promise<FactoryConfig> {
    return this.#config(workspaceId, this.#orderedRepositories(workspaceId), true);
  }

  async plan(mission: Mission, ctx: PlanContext): Promise<FactoryPlan | null> {
    if (!this.handles(mission)) return null;
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id };
    const config = await this.#config(mission.workspaceId, ctx.repositories, true);
    const criteria = this.deps.criteria.listActive(mission.id);
    let input: ProfileInput = gatherSignals({ mission, criteria, repositories: ctx.repositories });
    let profile = profileTask(input, config.planner);

    let tiebreak: PlanDecision['tiebreak'] = null;
    const reason = config.planner.tiebreak === 'on' ? tiebreakReason(input, profile) : null;
    if (reason !== null && this.deps.tiebreak !== undefined) {
      const role = ctx.roles.find((r) => r.id === PLANNER_ROLE_ID);
      const model = role?.models?.economyModel ?? role?.models?.model ?? null;
      const ran = await runTiebreak(input, this.deps.tiebreak, {
        model, areaNames: config.planner.areas.map((a) => a.name), repoNames: ctx.repositories.map((r) => r.name), workspaceId: mission.workspaceId,
      });
      input = { ...input, tiebreak: ran.answer, tiebreakFailed: ran.answer === null ? ran.error : null };
      profile = profileTask(input, config.planner);
      tiebreak = { reason, model: ran.model, costUsd: ran.costUsd, answer: ran.answer, error: ran.error };
      if (ran.error !== null) this.deps.recorder.note(scope, `Couldn't tell what kind of task this is, and the quick check ${ran.error}; planning with careful defaults.`, 'warn');
    }

    const { lane, because } = chooseLane(profile, config.planner, input.person);
    const workflowId = laneWorkflowId(lane, profile.type, config.planner);
    const definition = await this.#laneDefinition(workflowId, lane, ctx);
    if (definition === null) return null;

    const isolationForRole = (roleId: string) => ctx.roles.find((r) => r.id === roleId)?.defaultIsolation;
    const compiled = compileWorkflow(definition.def, mission.workflowInputs, { isolationForRole });
    if (!compiled.ok) {
      this.deps.recorder.note(scope, `The ${lane} lane's workflow "${definition.id}" can't run (${compiled.error.map((i) => i.message).join('; ')}); planning the usual way.`, 'warn');
      return null;
    }

    const skipped: string[] = [];
    let plan: MissionPlan = compiled.value;
    const userCriteria = userCriteriaCount(criteria);
    if (userCriteria === 0 && plan.tasks.some((t) => t.key === VERIFY_STEP_KEY)) {
      plan = dropStep(plan, VERIFY_STEP_KEY);
      skipped.push('No QA step: there are no Done-when lines to verify, so the tests carry it and the merge decision takes that into account.');
    }
    if (lane !== 'careful') skipped.push('No plan approval.');
    if (lane === 'quick') skipped.push('No separate review or QA: the tests carry it, and the merge decision will take that into account.');
    if (lane !== 'careful' && userCriteria === 0) skipped.push('No Done-when lines: "The task as written is done" stands in, and reads "Not independently verified".');

    const shaped = this.#shape(plan, profile, config.planner, ctx);
    if (shaped === null) return null;

    const decision: PlanDecision = {
      id: ids.planDecision(),
      missionId: mission.id,
      policyRef: policyRef(config),
      basis: 'predicted',
      profile,
      lane,
      laneBecause: because,
      workflowId: definition.id,
      modules: shaped.applied,
      dropped: shaped.dropped,
      steps: decisionSteps(shaped.plan),
      approvals: decisionApprovals(shaped.plan),
      skipped,
      tiebreak,
      lightenedByPerson: false,
      createdAt: this.deps.clock.now() as Timestamp,
    };
    const implicitCriterion = lane !== 'careful' && criteria.length === 0;
    const preset: WorkflowPreset | null = lane !== 'careful' ? null : {
      id: definition.id,
      name: definition.def.name,
      description: definition.def.description ?? definition.def.name,
      stages: shaped.plan.tasks.filter((t) => t.executor !== 'ship').map((t) => t.title),
      // The planner sees the plan without the ship step: it can't write one, and it comes back on in `finish`.
      build: () => ({ ...shaped.plan, tasks: shaped.plan.tasks.filter((t) => t.executor !== 'ship').map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== SHIP_STEP_KEY) })) }),
    };
    return { plan: shaped.plan, lane, decision, implicitCriterion, preset };
  }

  /**
   * The careful lane's tailored plan, put back through the ship step, modules,
   * skills and validation (#53 §5 step 8). A model can't drop a module's step
   * or gate: they are re-added here. A tailored plan that no longer validates
   * gives way to the compiled one.
   */
  finish(factory: FactoryPlan, tailored: MissionPlan, ctx: PlanContext, config: FactoryConfig): FactoryPlan {
    const withShip = tailored.tasks.some((t) => t.executor === 'ship') ? tailored : appendShip(tailored, factory.plan);
    const shaped = this.#shape(withShip, factory.decision.profile, config.planner, ctx);
    if (shaped === null) return factory;
    return {
      ...factory,
      plan: shaped.plan,
      decision: {
        ...factory.decision,
        modules: [...new Set([...factory.decision.modules, ...shaped.applied])],
        dropped: shaped.dropped,
        steps: decisionSteps(shaped.plan),
        approvals: decisionApprovals(shaped.plan),
      },
    };
  }

  /** Writes the decision, the implicit criterion and `plan.decided`. */
  record(factory: FactoryPlan, scope: EventScope): void {
    this.deps.planDecisions.create(factory.decision);
    if (factory.implicitCriterion && this.deps.criteria.listActive(factory.decision.missionId).length === 0) {
      this.deps.criteria.seed(factory.decision.missionId, [{ key: IMPLICIT_CRITERION_KEY, statement: IMPLICIT_CRITERION, source: 'implicit', covers: [] }]);
      this.deps.recorder.invalidate('criteria', factory.decision.missionId);
    }
    this.deps.recorder.record(scope, {
      type: 'plan.decided',
      lane: factory.lane,
      workflowId: factory.decision.workflowId,
      modules: [...factory.decision.modules],
      policyRef: factory.decision.policyRef,
    });
  }

  /** "fix · tiny · low risk", for the plan document's front matter. */
  front(factory: FactoryPlan): { readonly lane: Lane; readonly profile: string } {
    return { lane: factory.lane, profile: profileLine(factory.decision.profile).toLowerCase() };
  }

  // ------------------------------------------------------------------ helpers

  /** Modules, area skills, validation; dropping modules (last first) until it validates. */
  #shape(plan: MissionPlan, profile: TaskProfile, planner: PlannerConfig, ctx: PlanContext): {
    plan: MissionPlan; applied: string[]; dropped: { name: string; why: string }[];
  } | null {
    const { facts, predicates } = profileRuleContext(profile);
    const dropped: { name: string; why: string }[] = [];
    let modules = [...planner.modules];
    for (;;) {
      const applied = applyModules(plan, modules, facts, predicates);
      dropped.push(...applied.dropped.filter((d) => !dropped.some((x) => x.name === d.name)));
      const withSkills = this.#areaSkills(applied.plan, profile, planner, ctx, dropped);
      const issues = this.#validate(withSkills, ctx);
      if (issues === null) return { plan: withSkills, applied: [...applied.applied], dropped };
      const last = applied.applied.at(-1);
      if (last === undefined) {
        this.deps.log.warn('planner.lane_invalid', { issues });
        return null;
      }
      dropped.push({ name: last, why: issues });
      modules = modules.filter((m) => m.name !== last);
    }
  }

  /** Every matching area's skills on each code and review step (#53 §6.4). Missing skills are dropped and said. */
  #areaSkills(plan: MissionPlan, profile: TaskProfile, planner: PlannerConfig, ctx: PlanContext, dropped: { name: string; why: string }[]): MissionPlan {
    const names = new Set(profile.areas.map((a) => a.name));
    const refs = planner.areas.filter((a) => names.has(a.name)).flatMap((a) => a.skills)
      .map((s) => parseSkillRef(s)).filter((s): s is SkillRef => s !== null);
    const tasks = plan.tasks.map((task) => {
      const cls = stepClassFor(task);
      let next = task;
      if (refs.length > 0 && (cls === 'implement' || cls === 'review' || cls === 'resolve_conflicts')) {
        next = { ...task, skillRefs: addSkillRefs(task.skillRefs ?? [], refs) };
      }
      return this.#pinnable(next, ctx, dropped);
    });
    return { ...plan, tasks };
  }

  /**
   * A skill the library doesn't have is taken off the step and named in the
   * decision, rather than refusing the plan: a shipped area or module naming
   * `security-review` must not stop every auth task in a project without it.
   */
  #pinnable(task: PlannedTask, ctx: PlanContext, dropped: { name: string; why: string }[]): PlannedTask {
    const skills = this.deps.skills;
    if (skills === undefined || task.skillRefs === undefined || task.skillRefs.length === 0) return task;
    const role = ctx.roles.find((r) => r.id === task.roleId);
    const keep: SkillRef[] = [];
    for (const ref of task.skillRefs) {
      const problems = skills.pinsFor(ctx.workspace.id, role, { key: task.key, skillRefs: [ref] }).problems;
      if (problems.length === 0) keep.push(ref);
      else if (!dropped.some((d) => d.name === `skill ${ref.name}`)) dropped.push({ name: `skill ${ref.name}`, why: `It isn't in your skills library, so ${task.key} runs without it.` });
    }
    return { ...task, skillRefs: keep };
  }

  /** Null when valid; otherwise the validator's issues in one sentence. */
  #validate(plan: MissionPlan, ctx: PlanContext): string | null {
    // Capabilities are enforced as grants when a step runs; here only the graph,
    // roles, repositories and gates are judged, as an authored workflow is.
    const result = validateMissionPlan(plan, {
      knownRoleIds: new Set(ctx.roles.map((r) => r.id)),
      satisfiableCapabilities: new Set(plan.tasks.flatMap((t) => t.requiredCapabilities)),
      knownRepositoryNames: new Set(ctx.repositories.map((r) => r.name.toLowerCase())),
    });
    if (result.ok) return null;
    return result.error.filter((i) => i.severity === 'error').map((i) => (i.taskKey === null ? i.message : `${i.taskKey}: ${i.message}`)).join(' ') || null;
  }

  async #laneDefinition(workflowId: string, lane: Lane, ctx: PlanContext): Promise<{ id: string; def: WorkflowDefinition } | null> {
    const hasTestCommand = (ctx.repository?.checks?.test ?? null) !== null;
    const shipped = laneWorkflows({ hasTestCommand });
    try {
      // A project's own file of the same id overrides the shipped lane.
      const own = (await this.deps.workflows.list(ctx.repositories.map((r) => r.path))).find((w) => w.id === workflowId && w.definition !== null);
      if (own?.definition != null) return { id: workflowId, def: own.definition };
    } catch (e) {
      this.deps.log.warn('planner.workflows_unreadable', { error: String(e) });
    }
    if (shipped[workflowId] !== undefined) return { id: workflowId, def: shipped[workflowId]! };
    const fallback = shipped[lane];
    return fallback === undefined ? null : { id: lane, def: fallback };
  }

  async #config(workspaceId: WorkspaceId, repositories: readonly Repository[], fresh: boolean): Promise<FactoryConfig> {
    const cached = this.#configs.get(workspaceId);
    if (cached !== undefined && !fresh) return cached;
    const loaded = await loadFactoryConfig(this.deps.factory, repositories.map((r) => r.path));
    this.#configs.set(workspaceId, loaded);
    return loaded;
  }

  #orderedRepositories(workspaceId: WorkspaceId): readonly Repository[] {
    const all = this.deps.repositories.listByWorkspace(workspaceId);
    const first = this.deps.workspaces.get(workspaceId)?.defaultRepositoryId ?? null;
    return [...all].sort((a, b) => (a.id === first ? -1 : b.id === first ? 1 : 0));
  }
}

/** The factory files' refs, as one string the decision and the PR cite. */
export function policyRef(config: Pick<FactoryConfig, 'refs'>): string {
  const { planner, routing, merge } = config.refs;
  return planner === routing && routing === merge ? planner : `planner ${planner}, routing ${routing}, merge ${merge}`;
}

/** Removes a step and hands its dependencies to whoever depended on it. */
export function dropStep(plan: MissionPlan, key: string): MissionPlan {
  const gone = plan.tasks.find((t) => t.key === key);
  if (gone === undefined) return plan;
  return {
    ...plan,
    tasks: plan.tasks.filter((t) => t.key !== key).map((t) => (t.dependsOn.includes(key)
      ? { ...t, dependsOn: [...new Set([...t.dependsOn.filter((d) => d !== key), ...gone.dependsOn])] }
      : t)),
  };
}

/** Adds the compiled plan's ship step after every step nothing depends on. */
function appendShip(tailored: MissionPlan, compiled: MissionPlan): MissionPlan {
  const ship = compiled.tasks.find((t) => t.executor === 'ship');
  if (ship === undefined) return tailored;
  const depended = new Set(tailored.tasks.flatMap((t) => t.dependsOn));
  const sinks = tailored.tasks.filter((t) => !depended.has(t.key)).map((t) => t.key);
  return { ...tailored, tasks: [...tailored.tasks, { ...ship, dependsOn: sinks }] };
}

function decisionSteps(plan: MissionPlan): PlanDecision['steps'] {
  return plan.tasks.map((t) => ({
    key: t.key,
    stepClass: stepClassFor(t),
    model: t.modelPolicy?.model ?? null,
    reason: t.modelPolicy?.reason ?? (t.modelPolicy?.model !== undefined ? 'step override' : 'role model'),
    escalate: [...(t.modelPolicy?.escalate ?? [])],
  }));
}

function decisionApprovals(plan: MissionPlan): PlanDecision['approvals'] {
  return plan.tasks.flatMap((t) => [
    ...(t.approvalPolicy.beforeStart ? [{ step: t.key, when: 'before' as const, reason: t.approvalPolicy.reason ?? 'The workflow asks for it.' }] : []),
    ...(t.approvalPolicy.onCompletion ? [{ step: t.key, when: 'after' as const, reason: t.approvalPolicy.reason ?? 'The workflow asks for it.' }] : []),
  ]);
}

