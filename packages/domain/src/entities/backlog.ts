import { evaluateGate, type GateFacts, type GateOutcome } from '../gate.js';
import { isTerminalMissionStatus, type MissionStatus } from './mission.js';

/**
 * The backlog (P7).
 *
 * A person keeps more requests than they have agents. Each DRAFT mission sits
 * in one ranked backlog; the ones the person queued are planned, in that order,
 * whenever fewer missions than the project's limit are in progress. Which one
 * is next is a total order over stored values and a gate over measured counts -
 * the same rows always give the same pick - and never something an agent said.
 */

export const MISSION_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type MissionPriority = (typeof MISSION_PRIORITIES)[number];
export const DEFAULT_MISSION_PRIORITY: MissionPriority = 'normal';

/** 0 for urgent to 3 for low: the order the backlog sorts in, and the `mission.priority` fact. */
export function priorityLevel(priority: MissionPriority): number {
  const level = MISSION_PRIORITIES.indexOf(priority);
  // An unknown value (a row written by a newer build) sorts with normal rather than first.
  return level < 0 ? MISSION_PRIORITIES.indexOf(DEFAULT_MISSION_PRIORITY) : level;
}

/** What the order reads. A `Mission` is one. */
export interface BacklogEntry {
  readonly id: string;
  readonly priority: MissionPriority;
  readonly rank: number;
  readonly createdAt: string;
}

/**
 * Priority, then rank, then age, then id.
 *
 * The id makes it total: no two missions compare equal, so the order - and the
 * pick - does not depend on the order rows were read in. A tie on rank (two
 * windows moving two missions to the same place) goes to the older mission.
 */
export function compareBacklog(a: BacklogEntry, b: BacklogEntry): number {
  return priorityLevel(a.priority) - priorityLevel(b.priority)
    || a.rank - b.rank
    || compareText(a.createdAt, b.createdAt)
    || compareText(a.id, b.id);
}

export function backlogOrder<T extends BacklogEntry>(items: readonly T[]): T[] {
  return [...items].sort(compareBacklog);
}

/** Code-unit order, not locale order: the same on every machine. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ------------------------------------------------------------ work in progress

/**
 * Whether there is room for one more mission. A gate expression over measured
 * facts, like every gate: with the limit off `workspace.max_active_missions` is
 * not measured, and an unmeasured fact never passes - so "off" pulls nothing
 * without a special case.
 */
export const WIP_PULL_GATE = 'workspace.active_missions < workspace.max_active_missions';

export interface WipCounts {
  /** Missions in progress in the project. */
  readonly active: number;
  /** The project's limit; null when it is off. */
  readonly limit: number | null;
}

export function wipFacts(counts: WipCounts): GateFacts {
  return {
    'workspace.active_missions': counts.active,
    ...(counts.limit === null ? {} : { 'workspace.max_active_missions': counts.limit }),
  };
}

export function missionFacts(mission: { readonly priority: MissionPriority }): GateFacts {
  return { 'mission.priority': priorityLevel(mission.priority) };
}

/**
 * Started and not finished: not DRAFT, not PAUSED, not COMPLETE/FAILED/CANCELLED.
 * Waiting on a plan approval or blocked counts - it is started work that will
 * come back to the person before it finishes.
 */
export function isInProgress(status: MissionStatus): boolean {
  return status !== 'DRAFT' && status !== 'PAUSED' && !isTerminalMissionStatus(status);
}

// ------------------------------------------------------------------- the pull

export interface PullCandidate extends BacklogEntry {
  readonly queued: boolean;
  /** The readiness gate passes and nothing is refining it right now. */
  readonly ready: boolean;
}

export interface PullDecision {
  readonly id: string;
  /** Its place among queued missions, 1-based, counting the not-ready ones ahead of it. */
  readonly position: number;
  /** Missions in progress once it is pulled. */
  readonly active: number;
  readonly limit: number;
  /** Queued missions ahead of it that were not ready. */
  readonly skipped: number;
}

export interface PullPlan {
  readonly pulls: readonly PullDecision[];
  /** The WIP gate as it stands after the pulls: why nothing more was taken. */
  readonly outcome: GateOutcome;
}

/**
 * Which queued drafts to plan now, in order.
 *
 * Only queued ones are candidates; a not-ready one is skipped (it stays queued
 * and is taken once it is ready and first). Each pull re-reads the gate with
 * the count it leaves behind.
 */
export function choosePulls(input: WipCounts & { readonly candidates: readonly PullCandidate[] }): PullPlan {
  const queue = backlogOrder(input.candidates.filter((c) => c.queued));
  const pulls: PullDecision[] = [];
  let active = input.active;
  let skipped = 0;
  let outcome = evaluateGate(WIP_PULL_GATE, wipFacts({ active, limit: input.limit }));
  for (const [index, candidate] of queue.entries()) {
    if (!outcome.passed || input.limit === null) break;
    if (!candidate.ready) {
      skipped++;
      continue;
    }
    active++;
    pulls.push({ id: candidate.id, position: index + 1, active, limit: input.limit, skipped });
    outcome = evaluateGate(WIP_PULL_GATE, wipFacts({ active, limit: input.limit }));
  }
  return { pulls, outcome };
}

/** The timeline's words for a pull: "Pulled from the backlog (1 of 1)". */
export function pulledTitle(pull: { readonly active: number; readonly limit: number }): string {
  return `Pulled from the backlog (${pull.active} of ${pull.limit})`;
}

/** The second line: how far down the queue it was, and why the ones ahead were passed over. */
export function pulledDetail(pull: { readonly position: number; readonly limit: number; readonly skipped?: number }): string {
  const place = pull.position === 1 ? 'It was first in the queue' : `It was number ${pull.position} in the queue`;
  const skipped = pull.skipped ?? 0;
  const ahead = skipped === 0 ? '' : `; ${skipped === 1 ? '1 mission' : `${skipped} missions`} ahead of it ${skipped === 1 ? 'is' : 'are'} not ready to plan yet`;
  return `${place}${ahead}. This project works on at most ${pull.limit} ${pull.limit === 1 ? 'mission' : 'missions'} at a time.`;
}

/** The Backlog tab's header and the sentence under it. */
export function describeWip(counts: WipCounts & { readonly queued: number }): { readonly headline: string; readonly hint: string } {
  const queued = `${counts.queued} queued`;
  if (counts.limit === null) {
    return {
      headline: `Working on ${counts.active} · no limit · ${queued}`,
      hint: 'Limit off: queued missions wait until you plan them yourself or set a limit.',
    };
  }
  const room = counts.active < counts.limit;
  return {
    headline: `Working on ${counts.active} of ${counts.limit} · ${queued}`,
    hint: room
      ? `When fewer than ${counts.limit} ${counts.limit === 1 ? 'mission is' : 'missions are'} in progress, Tandemise plans the next queued mission that is ready, in this order.`
      : `Full: the next queued mission that is ready is planned as soon as one in progress finishes.`,
  };
}

/**
 * Home's banner when every slot is taken and work is queued behind them (P10):
 * "Working on 2 of 2 — 3 queued missions wait for a free slot. …"
 */
export function wipBannerText(counts: { readonly active: number; readonly limit: number; readonly queued: number }): string {
  const queued = counts.queued === 1 ? '1 queued mission waits' : `${counts.queued} queued missions wait`;
  return `Working on ${counts.active} of ${counts.limit} — ${queued} for a free slot. The next ready one is planned as soon as one finishes.`;
}

// ------------------------------------------------------------------ moving

export type BacklogMove = 'up' | 'down';

export interface BacklogPlacement {
  readonly id: string;
  readonly priority: MissionPriority;
  readonly rank: number;
}

export interface MoveResult<T extends BacklogEntry> {
  /** The moved mission's new priority and rank. */
  readonly moved: BacklogPlacement;
  /** Every row whose priority or rank changes, the moved one included. */
  readonly updates: readonly BacklogPlacement[];
  /** The neighbour it passed when that changed its priority, else null. */
  readonly crossed: T | null;
}

/**
 * Swaps a mission with its neighbour in the backlog order.
 *
 * Priority sorts first, so passing a neighbour of another priority can only
 * mean taking that priority: moving Low above Normal makes it Normal. The
 * whole backlog is renumbered 1…n in the new order, so ranks never run out of
 * room between two floats. Null when there is nowhere to go.
 */
export function moveInBacklog<T extends BacklogEntry>(items: readonly T[], id: string, direction: BacklogMove): MoveResult<T> | null {
  const order = backlogOrder(items);
  const from = order.findIndex((item) => item.id === id);
  const to = direction === 'up' ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= order.length) return null;
  const mover = order[from]!;
  const neighbour = order[to]!;
  const priority = neighbour.priority;
  const next: BacklogEntry[] = order.map((item) => item);
  next[from] = neighbour;
  next[to] = { ...mover, priority };
  const updates: BacklogPlacement[] = [];
  next.forEach((item, index) => {
    const rank = index + 1;
    const original = order.find((o) => o.id === item.id)!;
    if (original.rank !== rank || original.priority !== item.priority) updates.push({ id: item.id, priority: item.priority, rank });
  });
  const moved = { id: mover.id, priority, rank: to + 1 };
  if (!updates.some((u) => u.id === mover.id)) updates.push(moved);
  return { moved, updates, crossed: priority === mover.priority ? null : neighbour };
}
