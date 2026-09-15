import { z } from 'zod';
import type { Member } from './entities/member.js';
import { validateGate } from './gate.js';

/**
 * Who does a role's work, who answers for it, and who has to look at it.
 *
 * Kept as data and pure functions so the same rules run in the scheduler, the
 * preview endpoint and the Team screen - three places that must never disagree
 * about who is responsible for a task.
 */
export interface StaffingReview {
  readonly by: 'responsible' | readonly string[];
  readonly mode: 'blocking' | 'after';
  /** `always`, or a gate expression over the task's measured facts. */
  readonly when: string;
}

export interface Staffing {
  readonly assignees: readonly string[];
  readonly mode: 'first_available' | 'pool';
  readonly responsible: string | null;
  readonly reviews: readonly StaffingReview[];
  readonly escalateAfterMs: number | null;
  readonly notify: readonly string[];
}

export type StaffingPatch = Partial<Staffing>;
export type RoleStaffing = Readonly<Record<string, StaffingPatch>>;

export const DEFAULT_ESCALATE_AFTER_MS = 86_400_000;

export const BASE_STAFFING: Staffing = {
  assignees: [], mode: 'first_available', responsible: null, reviews: [],
  escalateAfterMs: DEFAULT_ESCALATE_AFTER_MS, notify: [],
};

const reviewSchema = z.object({
  by: z.union([z.literal('responsible'), z.array(z.string().min(1)).min(1)]),
  mode: z.enum(['blocking', 'after']),
  when: z.string().min(1),
}).strict();

export const staffingPatchSchema = z.object({
  assignees: z.array(z.string().min(1)),
  mode: z.enum(['first_available', 'pool']),
  responsible: z.string().min(1).nullable(),
  reviews: z.array(reviewSchema),
  escalateAfterMs: z.number().int().positive().nullable(),
  notify: z.array(z.string().min(1)),
}).partial().strict();

export const roleStaffingSchema = z.record(z.string().min(1), staffingPatchSchema);

export interface Team {
  readonly members: readonly Member[];
  readonly byId: ReadonlyMap<string, Member>;
  readonly owners: readonly Member[];
}

export function indexTeam(members: readonly Member[]): Team {
  const byId = new Map(members.map((m) => [m.id as string, m]));
  const owners = members.filter((m) => m.kind === 'person' && m.status === 'active' && m.access === 'owner');
  return { members, byId, owners };
}

/**
 * Active means usable right now. An agent is only as active as its owner: a
 * person who leaves takes their agents' authority with them (Buzz NIP-AA).
 */
export function isActiveMember(team: Team, id: string): boolean {
  const m = team.byId.get(id);
  if (m === undefined || m.status !== 'active') return false;
  if (m.kind === 'agent') return m.reportsTo !== null && isActivePerson(team, m.reportsTo);
  return true;
}

function isActivePerson(team: Team, id: string): boolean {
  const m = team.byId.get(id);
  return m !== undefined && m.kind === 'person' && m.status === 'active';
}

export function mergeStaffing(...layers: ReadonlyArray<StaffingPatch | undefined>): Staffing {
  let out: Staffing = BASE_STAFFING;
  for (const layer of layers) {
    if (layer === undefined) continue;
    const defined = Object.fromEntries(Object.entries(layer).filter(([, v]) => v !== undefined)) as StaffingPatch;
    out = { ...out, ...defined };
  }
  return out;
}

export interface StaffingLayers {
  readonly workspace?: StaffingPatch;
  readonly mission?: StaffingPatch;
  readonly task?: StaffingPatch;
}

/**
 * The part of a `ResolvedStaffing` a task stores. Members are kept as ids rather
 * than copies, so the snapshot stays small and a renamed agent is still found.
 */
export interface ResolvedStaffingSnapshot {
  readonly staffing: Staffing;
  readonly executor: 'agent' | 'human';
  readonly claimable: readonly string[];
  readonly agentCandidateIds: readonly string[];
  /**
   * Whether the task came from a person's step, as it was before any snapshot.
   * Kept because resolution rewrites the task's executor: without it a later
   * re-resolution could not tell a human step staffed to an agent from an
   * agent step, and would drop the step's pool hint. Absent on snapshots
   * written before it existed.
   */
  readonly humanStep: boolean;
  /**
   * People an unanswered pool was opened to, in the order they were added.
   * Recorded rather than inferred: it is the one reason someone other than a
   * task's assignee may take it. Absent on snapshots written before it, or
   * never escalated - both mean nobody.
   */
  readonly escalatedTo?: readonly string[];
  /**
   * Who the staffing named when none of them could act, so nobody does the
   * work until a person picks who does. Absent when someone active was named,
   * or when nothing was named at all (the zero-configuration runtime fallback).
   */
  readonly inactiveAssignees?: readonly string[];
}

export interface ResolvedStaffing {
  readonly staffing: Staffing;
  readonly executor: 'agent' | 'human';
  /** Active agents, in order; empty = legacy runtime fallback. */
  readonly agentCandidates: readonly Member[];
  /** Set for a person assignee; for agents, set after runtime selection. */
  readonly assigneeId: string | null;
  /** Person member ids who may claim (pool / fallback). */
  readonly claimable: readonly string[];
  readonly responsibleId: string;
  /** Set when the staffing named assignees and none of them is active; see the snapshot's field. */
  readonly inactiveAssignees?: readonly string[];
}

export function resolveStaffing(input: {
  readonly team: Team; readonly roleId: string; readonly humanStep: boolean; readonly layers: StaffingLayers;
}): ResolvedStaffing {
  const { team, roleId, humanStep, layers } = input;
  const builtIn: StaffingPatch = {
    assignees: team.members.filter((m) => m.kind === 'agent' && m.roleIds.includes(roleId)).map((m) => m.id),
  };
  const hint: StaffingPatch | undefined = humanStep ? { assignees: [], mode: 'pool' } : undefined;
  const staffing = mergeStaffing(
    humanStep ? undefined : builtIn, hint, peopleOnly(team, humanStep, layers.workspace), layers.mission, layers.task,
  );

  const active = staffing.assignees.map((id) => team.byId.get(id)).filter((m): m is Member => m !== undefined && isActiveMember(team, m.id));
  const agents = active.filter((m) => m.kind === 'agent');
  const people = active.filter((m) => m.kind === 'person');
  const ownerIds = team.owners.map((m) => m.id as string);
  const done = (r: Omit<ResolvedStaffing, 'staffing' | 'responsibleId'>, assignee: string | null): ResolvedStaffing =>
    ({ staffing, ...r, responsibleId: responsibleFor(team, staffing, assignee) });
  // A pool only one person can claim is that person's: a lone owner should not
  // have to claim their own step. Two or more keep the claim flow.
  const peoplePool = (claimable: readonly string[]): ResolvedStaffing => {
    const only = claimable.length === 1 ? claimable[0]! : null;
    return done({ executor: 'human', agentCandidates: [], assigneeId: only, claimable }, only);
  };
  // Staffing named who does the work and none of them can act. The legacy
  // "every enabled runtime" fallback is for a role nobody staffed at all;
  // widening to it here would hand the work to a runtime nobody chose. It
  // waits, unassigned, for anyone up the responsible person's chain to pick
  // who does it - and escalates like any other pool.
  const nobodyActive = (): ResolvedStaffing => {
    const responsibleId = responsibleFor(team, staffing, null);
    return {
      staffing, executor: 'human', agentCandidates: [], assigneeId: null,
      claimable: escalationChain(team, responsibleId), responsibleId, inactiveAssignees: staffing.assignees,
    };
  };
  const named = staffing.assignees.length > 0;

  if (staffing.mode === 'first_available') {
    const first = active[0];
    if (first === undefined) {
      if (humanStep) return peoplePool(ownerIds);
      return named ? nobodyActive() : done({ executor: 'agent', agentCandidates: [], assigneeId: null, claimable: [] }, null);
    }
    if (first.kind === 'agent') {
      return done({ executor: 'agent', agentCandidates: agents, assigneeId: null, claimable: [] }, agents[0]!.id);
    }
    return done({ executor: 'human', agentCandidates: [], assigneeId: first.id, claimable: [first.id] }, first.id);
  }
  if (agents.length > 0) {
    return done({ executor: 'agent', agentCandidates: agents, assigneeId: null, claimable: [] }, agents[0]!.id);
  }
  if (people.length > 0) return peoplePool(people.map((m) => m.id as string));
  return named && !humanStep ? nobodyActive() : peoplePool(ownerIds);
}

/**
 * A workflow step written for a person stays a person's step unless someone
 * deliberately puts an agent on *this* mission or task. The built-in layer and
 * the workspace's role defaults describe who does the role's agent work -
 * migration 008 staffs every routed role to an agent - and letting them apply
 * to a human step would quietly hand a sign-off or a design review to a model.
 * People staffed at the workspace still apply: a design role staffed to Ana
 * makes the design checkpoint Ana's.
 */
function peopleOnly(team: Team, humanStep: boolean, layer: StaffingPatch | undefined): StaffingPatch | undefined {
  if (!humanStep || layer?.assignees === undefined) return layer;
  return { ...layer, assignees: layer.assignees.filter((id) => team.byId.get(id)?.kind !== 'agent') };
}

/**
 * The real person who answers for the work. Never an agent: an agent's work is
 * answered for by its owner (principle 0 of the collaboration roadmap).
 */
export function responsibleFor(team: Team, staffing: Staffing, assigneeId: string | null): string {
  if (staffing.responsible !== null && isActivePerson(team, staffing.responsible)) return staffing.responsible;
  const assignee = assigneeId === null ? undefined : team.byId.get(assigneeId);
  if (assignee !== undefined && isActiveMember(team, assignee.id)) {
    if (assignee.kind === 'person') return assignee.id;
    if (assignee.reportsTo !== null) return assignee.reportsTo;
  }
  return firstOwner(team);
}

function firstOwner(team: Team): string {
  const owner = team.owners[0];
  // validateTeam guarantees an owner; a team without one is a corrupt workspace.
  if (owner === undefined) throw new Error('Workspace has no active owner.');
  return owner.id;
}

export function escalationChain(team: Team, responsibleId: string): readonly string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = responsibleId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const m = team.byId.get(cursor);
    if (m === undefined) break;
    if (m.kind === 'person' && m.status === 'active') chain.push(m.id);
    cursor = m.reportsTo;
  }
  for (const o of team.owners) if (!chain.includes(o.id)) chain.push(o.id);
  return chain;
}

/**
 * Who an unanswered request goes to next: the first person in the chain above
 * the highest-ranked person it is already addressed to. Escalation only ever
 * moves up. A card already with the lead goes to the lead's lead, never back
 * down to the person who reports to them. When none of the addressees are in
 * the chain (a named reviewer from elsewhere in the team, or nobody), it starts
 * with the responsible person. Null at the top of the tree.
 */
export function nextEscalation(team: Team, responsibleId: string, addressees: readonly string[]): string | null {
  const chain = escalationChain(team, responsibleId);
  const highest = Math.max(-1, ...addressees.map((id) => chain.indexOf(id)));
  const from = highest === -1 ? Math.max(0, chain.indexOf(responsibleId)) : highest + 1;
  return chain.slice(from).find((id) => !addressees.includes(id)) ?? null;
}

export function signOffLead(team: Team, responsibleId: string): string | null {
  const lead = team.byId.get(team.byId.get(responsibleId)?.reportsTo ?? '');
  return lead !== undefined && isActivePerson(team, lead.id) && lead.oversight === 'both_sign_off' ? lead.id : null;
}

export function reviewersFor(team: Team, review: StaffingReview, responsibleId: string): readonly string[] {
  if (review.by === 'responsible') return [responsibleId];
  const people = review.by.filter((id) => isActivePerson(team, id));
  return people.length > 0 ? people : [responsibleId];
}

export function validateStaffing(team: Team, patch: StaffingPatch): readonly string[] {
  const issues: string[] = [];
  patch.assignees?.forEach((id, i) => {
    if (!team.byId.has(id)) issues.push(`assignees.${i}: unknown member '${id}'.`);
  });
  if (patch.responsible !== undefined && patch.responsible !== null && team.byId.get(patch.responsible)?.kind !== 'person') {
    issues.push(`responsible: '${patch.responsible}' must be a person member.`);
  }
  patch.reviews?.forEach((r, i) => {
    if (r.by !== 'responsible') {
      r.by.forEach((id, j) => {
        if (team.byId.get(id)?.kind !== 'person') issues.push(`reviews.${i}.by.${j}: '${id}' must be a person member.`);
      });
    }
    if (r.when !== 'always') {
      const g = validateGate(r.when);
      if (!g.ok) issues.push(`reviews.${i}.when: ${g.error}`);
    }
  });
  patch.notify?.forEach((id, i) => {
    if (team.byId.get(id)?.kind !== 'person') issues.push(`notify.${i}: '${id}' must be a person member.`);
  });
  return issues;
}

export function validateTeam(members: readonly Member[]): readonly string[] {
  const issues: string[] = [];
  const team = indexTeam(members);
  if (team.owners.length === 0) issues.push('The workspace needs at least one active owner.');
  for (const m of members) {
    if (m.status !== 'active') continue;
    if (m.kind === 'agent') {
      const owner = m.reportsTo === null ? undefined : team.byId.get(m.reportsTo);
      if (owner?.kind !== 'person') issues.push(`${m.name}: an agent must be owned by a person.`);
    }
    if (m.reportsTo !== null && team.byId.get(m.reportsTo)?.kind === 'agent') {
      issues.push(`${m.name}: agents cannot have reports.`);
    }
    if (m.reportsTo === m.id) {
      issues.push(`${m.name}: cannot report to themselves.`);
      continue;
    }
    // Only a member who is on the loop is in a cycle. Someone who merely
    // reports up into one (everyone below a self-reference, say) is not, and
    // listing them buried the one line that says what is actually wrong.
    const seen = new Set<string>([m.id]);
    let cursor = m.reportsTo;
    while (cursor !== null) {
      if (cursor === m.id) { issues.push(`${m.name}: reporting lines form a cycle.`); break; }
      if (seen.has(cursor)) break;
      seen.add(cursor);
      cursor = team.byId.get(cursor)?.reportsTo ?? null;
    }
  }
  return issues;
}
