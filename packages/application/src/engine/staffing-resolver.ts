import type {
  MemberRepositoryPort, Mission, MissionRepositoryPort, MissionTask, ResolvedStaffing, ResolvedStaffingSnapshot, Team, Workspace,
  WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { escalationChain, indexTeam, isActiveMember, resolveStaffing } from '@tandemise/domain';
import { TandemiseError, type MemberId } from '@tandemise/shared';

/** What resolving a task reads, loaded once when many tasks of one mission are resolved together. */
export interface StaffingContext {
  readonly workspace: Workspace;
  readonly mission: Mission;
  readonly team: Team;
}

export type TaskStaffingPatch = Pick<MissionTask, 'staffing' | 'assigneeId' | 'responsibleId'> & Partial<Pick<MissionTask, 'executor'>>;

export interface StaffingResolverDeps {
  readonly members: MemberRepositoryPort;
  readonly workspaces: WorkspaceRepositoryPort;
  readonly missions: MissionRepositoryPort;
}

/**
 * Loads what `resolveStaffing` needs for one task and runs it.
 *
 * The only place that assembles the layers, so the scheduler, the preview
 * endpoint and the Team screen cannot disagree about which layer wins.
 */
export class StaffingResolver {
  constructor(private readonly deps: StaffingResolverDeps) {}

  resolve(task: MissionTask, context?: StaffingContext): ResolvedStaffing {
    return this.#resolve(task, humanStepOf(task), context);
  }

  /** The workspace, mission and team a task of this mission resolves against. */
  context(task: MissionTask): StaffingContext {
    return this.#load(task);
  }

  #resolve(task: MissionTask, humanStep: boolean, context?: StaffingContext): ResolvedStaffing {
    const { workspace, mission, team } = context ?? this.#load(task);
    return resolveStaffing({
      team,
      roleId: task.roleId,
      humanStep,
      layers: {
        workspace: workspace.staffing?.[task.roleId],
        mission: mission.staffing?.[task.roleId],
        task: task.staffingOverride ?? undefined,
      },
    });
  }

  /**
   * What a task stores when it becomes READY: the resolution, who it is
   * assigned to and who answers for it.
   *
   * Null for a workspace with no active owner. Nobody could be responsible
   * for its work, so the task is left unresolved and dispatch keeps the
   * legacy runtime routing rather than stranding it.
   *
   * The executor is rewritten only between `agent` and `human`: staffing
   * decides who does the work, and a `wait` step has nobody to do it.
   */
  snapshot(task: MissionTask): TaskStaffingPatch | null {
    const { team } = this.#load(task);
    if (team.owners.length === 0) return null;
    // Resolved afresh, ignoring any earlier answer: re-snapshotting a READY
    // task whose override changed must not read the answer it is replacing.
    // Only where the task came from is carried over.
    const humanStep = humanStepOf(task);
    const resolved = this.#resolve(task, humanStep);
    const snapshot: ResolvedStaffingSnapshot = {
      staffing: resolved.staffing,
      executor: resolved.executor,
      claimable: resolved.claimable,
      agentCandidateIds: resolved.agentCandidates.map((m) => m.id),
      humanStep,
      ...(resolved.inactiveAssignees === undefined ? {} : { inactiveAssignees: resolved.inactiveAssignees }),
    };
    return {
      staffing: snapshot,
      assigneeId: resolved.assigneeId,
      responsibleId: resolved.responsibleId,
      ...(task.executor === 'agent' || task.executor === 'human' ? { executor: resolved.executor } : {}),
    };
  }

  /**
   * True when a snapshot names someone who can no longer act: its assignee, a
   * person who could claim it, or an agent candidate.
   *
   * The one reason a task that re-enters READY is resolved again. Any other
   * change to staffing leaves it alone - it already reached READY once - but
   * work routed to someone who has left the team would otherwise wait for
   * them forever.
   */
  isStale(task: MissionTask): boolean {
    const snapshot = task.staffing;
    if (snapshot == null) return false;
    const { team } = this.#load(task);
    const referenced = [
      ...(task.assigneeId == null ? [] : [task.assigneeId]),
      ...snapshot.claimable,
      ...snapshot.agentCandidateIds,
    ];
    return referenced.some((id) => !isActiveMember(team, id));
  }

  /** The escalation chain for the task's responsible person, or who it would be. */
  chain(task: MissionTask): readonly string[] {
    const { team } = this.#load(task);
    const responsible = task.responsibleId ?? this.resolve(task).responsibleId;
    return escalationChain(team, responsible);
  }

  #load(task: MissionTask): { workspace: Workspace; mission: Mission; team: Team } {
    const mission = this.deps.missions.get(task.missionId);
    if (mission === undefined) throw TandemiseError.notFound('Mission', task.missionId);
    const workspace = this.deps.workspaces.get(mission.workspaceId);
    if (workspace === undefined) throw TandemiseError.notFound('Workspace', mission.workspaceId);
    // Removed members are kept in the index so `isActiveMember` can tell an
    // agent whose owner left from an id that never existed.
    const team = indexTeam(this.deps.members.listByWorkspace(workspace.id, { includeRemoved: true }));
    return { workspace, mission, team };
  }
}

/**
 * Whether the task is a person's step. The snapshot records it once; before
 * the first snapshot the executor is still the step's own. Snapshots written
 * before the field existed fall back to the executor.
 */
function humanStepOf(task: MissionTask): boolean {
  return (task.staffing?.humanStep as boolean | undefined) ?? task.executor === 'human';
}

/**
 * The line a human task shows while it waits: whose it is, or that it is
 * anyone's. A pool only one person can claim is that person's in all but
 * name, so it says so - a solo owner sees their own name, not a call for
 * volunteers.
 */
export function waitingFor(
  members: Pick<MemberRepositoryPort, 'get'>, assigneeId: string | null | undefined, claimable: readonly string[],
): string {
  const id = assigneeId ?? (claimable.length === 1 ? claimable[0]! : null);
  const who = id === null ? undefined : members.get(id as MemberId);
  return who === undefined ? 'Waiting for someone to claim this.' : waitingForName(who.name);
}

/**
 * The line any task waiting on a person shows, read off its snapshot: who it
 * waits for, or - when everyone its staffing named is inactive - that somebody
 * has to pick who does it.
 */
export function waitingReason(
  members: Pick<MemberRepositoryPort, 'get'>,
  task: Pick<MissionTask, 'roleId' | 'assigneeId' | 'staffing'>,
): string {
  const inactive = task.staffing?.inactiveAssignees ?? [];
  if (task.assigneeId == null && inactive.length > 0) {
    const names = inactive.map((id) => members.get(id as MemberId)?.name ?? id).join(', ');
    return `Nobody active is staffed for ${task.roleId}: ${names} (inactive). Pick who does it.`;
  }
  return waitingFor(members, task.assigneeId, task.staffing?.claimable ?? []);
}

/**
 * A snapshot with its escalation forgotten, for a task starting a new wait.
 * An escalation only ever adds people who could not claim already, so taking
 * them back out of `claimable` restores who the staffing itself allowed.
 */
export function withoutEscalation(snapshot: ResolvedStaffingSnapshot): ResolvedStaffingSnapshot {
  const escalated = new Set(snapshot.escalatedTo ?? []);
  const next: { -readonly [K in keyof ResolvedStaffingSnapshot]: ResolvedStaffingSnapshot[K] } = {
    ...snapshot, claimable: snapshot.claimable.filter((id) => !escalated.has(id)),
  };
  delete next.escalatedTo;
  return next;
}

/** "Waiting for Bo." - but "Waiting for Cy Jr.", not "Cy Jr..": a name can end the sentence itself. */
export function waitingForName(name: string): string {
  return /[.!?]$/.test(name.trimEnd()) ? `Waiting for ${name.trimEnd()}` : `Waiting for ${name}.`;
}
