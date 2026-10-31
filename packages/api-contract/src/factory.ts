import { z } from 'zod';

/**
 * The factory (#53): why a mission got the steps it got, the lane a person can
 * change, and the pull request the ship step opened. Every sentence here is
 * built by the daemon; the renderer only shows it.
 */

export const LANE_REQUESTS = ['quick', 'careful'] as const;

/** `POST /v1/missions/:id/lane`: Make it quick or Make it careful. */
export const setLaneRequest = z.object({ lane: z.enum(LANE_REQUESTS) });
export type SetLaneRequest = z.infer<typeof setLaneRequest>;

/** `POST /v1/missions/:id/plan`: Plan, or Plan quick / Plan careful for a factory mission. */
export const planMissionRequest = z.object({ lane: z.enum(LANE_REQUESTS).optional() });
export type PlanMissionRequest = z.infer<typeof planMissionRequest>;

export interface PlanChipView {
  /** "Fix", "tiny", "low risk". */
  readonly label: string;
  /** What made it so, as sentences: "Prefix fix → type fix". */
  readonly signals: readonly string[];
}

export interface PlanStepLineView {
  readonly key: string;
  /** "Implement · role model". */
  readonly line: string;
}

/** `GET /v1/missions/:id/plan-decision`: "Why these steps". */
export interface PlanDecisionView {
  readonly missionId: string;
  readonly lane: 'quick' | 'standard' | 'careful';
  /** "Fix · tiny · low risk". */
  readonly profileLine: string;
  readonly chips: readonly PlanChipView[];
  /** "Quick lane: one step, then a pull request." */
  readonly laneLine: string;
  /** Why this lane: "The rules matched quick work", "You chose it". */
  readonly laneBecause: string;
  /** Ceremony the lane skipped, in words. */
  readonly skipped: readonly string[];
  /** "Added a security review because it touches auth." */
  readonly modules: readonly string[];
  /** Rules that could not apply, and why. */
  readonly dropped: readonly string[];
  readonly steps: readonly PlanStepLineView[];
  /** "Couldn't tell from the tracker …; asked haiku: fix.", or null when it didn't run. */
  readonly tiebreak: string | null;
  readonly lightenedByPerson: boolean;
  /** Which switches still make sense: none once the pull request is on its way. */
  readonly canMakeQuick: boolean;
  readonly canMakeCareful: boolean;
  /** Measured from the change, not predicted from the request. */
  readonly measured: boolean;
}

export type ShipStage = 'none' | 'waiting' | 'opening' | 'opened' | 'skipped' | 'blocked' | 'cancelled';

export interface ShipPullRequestView {
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly state: 'opening' | 'opened';
}

/** `GET /v1/missions/:id/ship` (part 1: pull requests only). */
export interface ShipView {
  readonly missionId: string;
  readonly taskId: string | null;
  readonly stage: ShipStage;
  /** "Opening the pull request", "Pull request opened". */
  readonly headline: string;
  /** One sentence on where the ship step stands. */
  readonly status: string;
  readonly prs: readonly ShipPullRequestView[];
}
