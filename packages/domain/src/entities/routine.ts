import type { MissionId, RoutineId, RoutineRunId, Timestamp, WorkspaceId } from '@tandemise/shared';
import type { MissionPriority } from './backlog.js';
import type { Limit } from './limits.js';

/**
 * Routines (P11 spec §1): standing work that adds itself to the backlog on a
 * simple schedule.
 *
 * Everything here is pure. Time arrives as epoch milliseconds from the caller's
 * injected Clock, and wall-clock times are read in the process's local time
 * zone (the daemon's), so the same inputs always give the same slots - which is
 * what lets the offline check pin daylight-saving behaviour down exactly.
 */

export const ROUTINE_KINDS = ['mission', 'status_report'] as const;
export type RoutineKind = (typeof ROUTINE_KINDS)[number];

/** "Every N hours" presets: divisors of a day, so the slots line up day after day. */
export const ROUTINE_HOURS = [1, 2, 3, 4, 6, 8, 12] as const;

export const ROUTINE_OUTCOMES = ['created', 'reported', 'skipped_active', 'skipped_limit', 'missed', 'failed'] as const;
export type RoutineOutcome = (typeof ROUTINE_OUTCOMES)[number];

export const ROUTINE_TRIGGERS = ['schedule', 'manual'] as const;
export type RoutineTrigger = (typeof ROUTINE_TRIGGERS)[number];

/** Simple presets only; no cron (roadmap). `day` is 0 = Sunday … 6 = Saturday, as `Date#getDay`. */
export type RoutineSchedule =
  | { readonly type: 'daily'; readonly at: string }
  | { readonly type: 'weekly'; readonly day: number; readonly at: string }
  | { readonly type: 'hourly'; readonly every: number };

export interface Routine {
  readonly id: RoutineId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly kind: RoutineKind;
  /** The goal of each mission; `{date}` becomes the run's local date. */
  readonly goal: string;
  /** Become U1…Un of each mission (P5). */
  readonly successCriteria: readonly string[];
  readonly priority: MissionPriority;
  /** The mission's own limits (P8); null uses the project's default mission limits. */
  readonly limits: readonly Limit[] | null;
  readonly workflowPreset: string | null;
  readonly schedule: RoutineSchedule;
  readonly enabled: boolean;
  /** Null while paused. */
  readonly nextRunAt: Timestamp | null;
  readonly lastRunAt: Timestamp | null;
  readonly lastOutcome: RoutineOutcome | null;
  /** The words of the last outcome, as the window shows them. */
  readonly lastDetail: string | null;
  readonly lastMissionId: MissionId | null;
  readonly lastArtifactId: string | null;
  /** The member who set it up; the routine acts as them. */
  readonly createdBy: string | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface RoutineDraft {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly kind: RoutineKind;
  readonly goal: string;
  readonly successCriteria: readonly string[];
  readonly priority: MissionPriority;
  readonly limits: readonly Limit[] | null;
  readonly workflowPreset: string | null;
  readonly schedule: RoutineSchedule;
  readonly enabled: boolean;
  readonly nextRunAt: Timestamp | null;
  readonly createdBy: string | null;
}

/** One run of a routine, skipped and missed ones included: the note a person can read. */
export interface RoutineRun {
  readonly id: RoutineRunId;
  readonly routineId: RoutineId;
  readonly trigger: RoutineTrigger;
  readonly scheduledFor: Timestamp | null;
  readonly ranAt: Timestamp;
  readonly outcome: RoutineOutcome;
  readonly detail: string;
  /** For a `missed` row: how many slots were skipped. */
  readonly skippedCount: number;
  readonly missionId: MissionId | null;
  readonly artifactId: string | null;
}

// ------------------------------------------------------------------ schedule

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:MM` on a 24-hour clock, or null. */
export function parseClockTime(at: string): { hour: number; minute: number } | null {
  const match = TIME.exec(at);
  if (match === null) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** What is wrong with a schedule, in words; null when it is one of the presets. */
export function scheduleProblem(schedule: RoutineSchedule): string | null {
  switch (schedule.type) {
    case 'daily':
      return parseClockTime(schedule.at) === null ? 'Give the time as HH:MM on a 24-hour clock.' : null;
    case 'weekly':
      if (!Number.isInteger(schedule.day) || schedule.day < 0 || schedule.day > 6) return 'Pick a day of the week.';
      return parseClockTime(schedule.at) === null ? 'Give the time as HH:MM on a 24-hour clock.' : null;
    case 'hourly':
      return (ROUTINE_HOURS as readonly number[]).includes(schedule.every)
        ? null
        : `Every N hours takes one of ${ROUTINE_HOURS.join(', ')}.`;
    default:
      return 'Pick daily, weekly or every few hours.';
  }
}

const HOUR_MS = 3_600_000;

/**
 * The first slot strictly after `afterMs`.
 *
 * Daily and weekly slots are local wall-clock times. On the day clocks go
 * forward, a time inside the gap (02:30 when 02:00 jumps to 03:00) is read the
 * way `Date` reads it: with the offset from before the change, so it fires at
 * 03:30 - the same distance past the gap. On the day clocks go back, a time
 * that happens twice is read with the earlier offset, so it fires at the first
 * occurrence; "strictly after" then moves the next slot to the following day,
 * never to the repeat an hour later.
 *
 * Every N hours is elapsed time from the previous slot: a DST change never
 * makes it N - 1 or N + 1 hours.
 */
export function firstSlotAfter(schedule: RoutineSchedule, afterMs: number): number {
  if (schedule.type === 'hourly') return afterMs + schedule.every * HOUR_MS;
  const time = parseClockTime(schedule.at);
  if (time === null) throw new RangeError(`Not a clock time: ${schedule.at}`);
  const base = new Date(afterMs);
  // Nine days covers "today" plus a whole week plus a DST day either side.
  for (let k = 0; k <= 8; k++) {
    const y = base.getFullYear();
    const m = base.getMonth();
    const d = base.getDate() + k;
    // The weekday of the calendar day, read at noon: midnight itself is skipped by DST in some zones.
    if (schedule.type === 'weekly' && new Date(y, m, d, 12).getDay() !== schedule.day) continue;
    const slot = new Date(y, m, d, time.hour, time.minute, 0, 0).getTime();
    if (slot > afterMs) return slot;
  }
  // Unreachable for a valid schedule; kept so a bad row fails loudly, not silently never.
  throw new RangeError('No slot found in the next nine days.');
}

export interface DueSlots {
  /** Slots from the stored next run up to and including now. */
  readonly count: number;
  readonly firstMs: number | null;
  /** The newest due slot: the one a catch-up run stands for. */
  readonly lastMs: number | null;
  /** The slot before `lastMs`: the end of the missed span. Null with fewer than two. */
  readonly lastMissedMs: number | null;
  /** The first slot after now: where the next run moves to. */
  readonly nextMs: number;
}

/** The most slots counted one by one; a daily routine reaches it after 270 years down. */
const MAX_COUNTED = 100_000;

/** Every slot due between the stored next run and now (both inclusive), and the one after. */
export function dueSlots(schedule: RoutineSchedule, nextRunAtMs: number, nowMs: number): DueSlots {
  if (nextRunAtMs > nowMs) return { count: 0, firstMs: null, lastMs: null, lastMissedMs: null, nextMs: nextRunAtMs };
  if (schedule.type === 'hourly') {
    const step = schedule.every * HOUR_MS;
    const count = Math.floor((nowMs - nextRunAtMs) / step) + 1;
    const lastMs = nextRunAtMs + (count - 1) * step;
    return { count, firstMs: nextRunAtMs, lastMs, lastMissedMs: count > 1 ? lastMs - step : null, nextMs: lastMs + step };
  }
  let count = 0;
  let previous: number | null = null;
  let slot = nextRunAtMs;
  let last = nextRunAtMs;
  while (slot <= nowMs && count < MAX_COUNTED) {
    count++;
    previous = count > 1 ? last : null;
    last = slot;
    slot = firstSlotAfter(schedule, slot);
  }
  // Past the cap the next run still lands after now, and the count says "at least".
  const nextMs = slot <= nowMs ? firstSlotAfter(schedule, nowMs) : slot;
  return { count, firstMs: nextRunAtMs, lastMs: last, lastMissedMs: previous, nextMs };
}

// ------------------------------------------------------------------ decision

export interface RoutineRunInput {
  readonly kind: RoutineKind;
  /** Due slots (a manual run is one). */
  readonly due: number;
  /** A mission from this routine that is not finished yet (a queued draft counts). */
  readonly previousActive: boolean;
  /** The project's monthly hard stop, in words; null when under it. */
  readonly limitReason: string | null;
}

export type RoutineDecision =
  | { readonly action: 'none' }
  | { readonly action: 'run'; readonly missed: number }
  | { readonly action: 'skip'; readonly outcome: 'skipped_active' | 'skipped_limit'; readonly detail: string; readonly missed: number };

export const SKIPPED_ACTIVE = 'Skipped: previous run still active';

/**
 * What a due routine does (spec §1, steps 2-4). All but the newest due slot
 * are missed; the newest is the one run, and it is still subject to the
 * checks - catching up never gets past them.
 *
 * A status report runs no agent and spends nothing, so neither coalescing nor
 * the monthly limit applies to it (ruling 5).
 */
export function decideRoutineRun(input: RoutineRunInput): RoutineDecision {
  if (input.due <= 0) return { action: 'none' };
  const missed = input.due - 1;
  if (input.kind === 'status_report') return { action: 'run', missed };
  if (input.previousActive) return { action: 'skip', outcome: 'skipped_active', detail: SKIPPED_ACTIVE, missed };
  if (input.limitReason !== null) return { action: 'skip', outcome: 'skipped_limit', detail: `Skipped: ${input.limitReason}`, missed };
  return { action: 'run', missed };
}

// ------------------------------------------------------------------ words

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** The full weekday name, 0 = Sunday. */
export function weekdayName(day: number): string {
  return WEEKDAYS[day] ?? 'Monday';
}

const pad = (n: number): string => String(n).padStart(2, '0');
const short = (d: Date): string => weekdayName(d.getDay()).slice(0, 3);
const clock = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** "Mon 09:00", local. */
export function slotLabel(ms: number): string {
  const d = new Date(ms);
  return `${short(d)} ${clock(d)}`;
}

/** "Mon 28 Sep", local. */
export function dayLabel(ms: number): string {
  const d = new Date(ms);
  return `${short(d)} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "2026-09-28", local. */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Every day at 09:00", "Every Monday at 09:00", "Every 6 hours". */
export function scheduleLabel(schedule: RoutineSchedule): string {
  switch (schedule.type) {
    case 'daily': return `Every day at ${schedule.at}`;
    case 'weekly': return `Every ${weekdayName(schedule.day)} at ${schedule.at}`;
    case 'hourly': return schedule.every === 1 ? 'Every hour' : `Every ${schedule.every} hours`;
  }
}

const WEEK_MS = 7 * 24 * HOUR_MS;

/** "Next: Mon 09:00" within a week, "Next: Mon 5 Oct 09:00" further out, "Paused" with none. */
export function nextRunLabel(nextMs: number | null, nowMs: number): string {
  if (nextMs === null) return 'Paused';
  if (nextMs - nowMs < WEEK_MS) return `Next: ${slotLabel(nextMs)}`;
  return `Next: ${dayLabel(nextMs)} ${clock(new Date(nextMs))}`;
}

/** "Missed 3 runs while Tandemise was not running (Mon 09:00 to Wed 09:00); ran once to catch up." */
export function missedNote(count: number, firstMs: number, lastMs: number): string {
  const span = count === 1 || firstMs === lastMs ? slotLabel(firstMs) : `${slotLabel(firstMs)} to ${slotLabel(lastMs)}`;
  return `Missed ${count} ${count === 1 ? 'run' : 'runs'} while Tandemise was not running (${span}); ran once to catch up.`;
}

/** Two missions from one routine are told apart by the day they were made for. */
export function routineMissionTitle(name: string, slotMs: number): string {
  return `${name} · ${dayLabel(slotMs)}`;
}

export function routineGoal(goal: string, slotMs: number): string {
  return goal.split('{date}').join(localDateKey(slotMs));
}

export function createdNote(name: string, slotMs: number, trigger: RoutineTrigger): string {
  return trigger === 'manual'
    ? `Created by the routine “${name}” (Run now).`
    : `Created by the routine “${name}” (${slotLabel(slotMs)} run).`;
}

export function coalescedNote(name: string, slotMs: number, trigger: RoutineTrigger): string {
  const which = trigger === 'manual' ? 'a Run now' : `its ${slotLabel(slotMs)} run`;
  return `The routine “${name}” skipped ${which}: this mission is not finished yet.`;
}

// ------------------------------------------------------------------ starters

export interface RoutineTemplate {
  readonly key: string;
  readonly name: string;
  readonly kind: RoutineKind;
  readonly goal: string;
  readonly successCriteria: readonly string[];
  readonly priority: MissionPriority;
  readonly schedule: RoutineSchedule;
  /** One line under the button in the create dialog. */
  readonly description: string;
}

/**
 * The three starters the create dialog offers (spec §5). The renderer mirrors
 * this list (it may not import runtime values); keep the two in step.
 */
export const ROUTINE_TEMPLATES: readonly RoutineTemplate[] = [
  {
    key: 'dependencies',
    name: 'Weekly dependency updates',
    kind: 'mission',
    goal: 'Update the project\'s dependencies to their latest compatible versions, run the tests, and fix anything the updates break.',
    successCriteria: [
      'Every direct dependency is on its latest compatible version, or the reason it is held back is written down',
      'The test suite passes after the updates',
      'The change lists each updated package with its old and new version',
    ],
    priority: 'normal',
    schedule: { type: 'weekly', day: 1, at: '09:00' },
    description: 'Every Monday at 09:00, a mission to bring dependencies up to date.',
  },
  {
    key: 'failing-checks',
    name: 'Nightly: fix failing checks',
    kind: 'mission',
    goal: 'Find the checks that fail on the default branch (tests, typecheck, lint) and fix the cause of each one.',
    successCriteria: [
      'Every check that failed at the start passes',
      'No test was skipped or deleted to make a check pass',
      'Each fix names the check it repaired and why it failed',
    ],
    priority: 'high',
    schedule: { type: 'daily', at: '02:00' },
    description: 'Every night at 02:00, a high-priority mission to get the checks green.',
  },
  {
    key: 'status-report',
    name: 'Weekly status report',
    kind: 'status_report',
    goal: '',
    successCriteria: [
      'Every mission in progress is listed with its criteria verified',
      'Every open decision is named',
      'This month\'s usage is shown against the monthly limit',
    ],
    priority: 'normal',
    schedule: { type: 'weekly', day: 5, at: '16:00' },
    description: 'Every Friday at 16:00, the status report written from facts. No agent runs.',
  },
];
