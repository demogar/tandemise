import type { LimitIncidentId, MissionId, Timestamp, WorkspaceId, ApprovalId } from '@tandemise/shared';
import type { GateFacts } from '../gate.js';
import type { MissionPriority } from './backlog.js';

/**
 * Hard limits on spend and time (P8).
 *
 * A person sets a ceiling on how much agent time, how many tokens or how many
 * reported dollars a mission may use, and how much the whole project may use in
 * a calendar month. The daemon measures usage from what runs recorded, compares
 * it with the ceiling, and decides: below the warning level nothing happens; at
 * the warning level the person is told; at 100% work stops and waits for the
 * person to raise the limit or keep it stopped. Nothing an agent says moves a
 * number here.
 */

export const LIMIT_METRICS = ['agent_minutes', 'tokens', 'usd'] as const;
export type LimitMetric = (typeof LIMIT_METRICS)[number];

/** Roadmap decision 5: a limit with no metric named is on agent minutes. */
export const DEFAULT_LIMIT_METRIC: LimitMetric = 'agent_minutes';
export const DEFAULT_WARN_PERCENT = 80;

export interface Limit {
  readonly metric: LimitMetric;
  /** Minutes, tokens or US dollars, by metric. Always above zero. */
  readonly amount: number;
  /** The share of `amount` at which the person is warned, 1-99. */
  readonly warnPercent: number;
}

/** A limit as a person gives it: the warning level may be left out. */
export type LimitDraft = Omit<Limit, 'warnPercent'> & { readonly warnPercent?: number };

/**
 * Usage as runs recorded it. Agent time is always measured (a run that reports
 * no duration is timed by the daemon); tokens and cost are what runtimes
 * reported, and stay null when none did - "not reported" is never zero.
 */
export interface UsageTotals {
  readonly agentMs: number;
  readonly tokens: number | null;
  readonly costUsd: number | null;
  /** Runs with a usage record. */
  readonly runs: number;
}

export const NO_USAGE: UsageTotals = { agentMs: 0, tokens: null, costUsd: null, runs: 0 };

/** ok: under the warning level; soft: at or over it; hard: at or over 100%; unmeasured: the metric is not reported. */
export type LimitLevel = 'ok' | 'soft' | 'hard' | 'unmeasured';

export interface LimitStatus extends Limit {
  /** Null when nothing reported this metric (a USD limit on a runtime that reports no cost). */
  readonly observed: number | null;
  /** observed / amount x 100, unrounded; null when not measured. */
  readonly percent: number | null;
  readonly level: LimitLevel;
}

export function observedFor(metric: LimitMetric, totals: UsageTotals): number | null {
  switch (metric) {
    case 'agent_minutes':
      return totals.agentMs / 60_000;
    case 'tokens':
      return totals.tokens;
    case 'usd':
      return totals.costUsd;
    default:
      return null;
  }
}

export function evaluateLimit(limit: Limit, totals: UsageTotals): LimitStatus {
  const observed = observedFor(limit.metric, totals);
  if (observed === null) return { ...limit, observed: null, percent: null, level: 'unmeasured' };
  const percent = (observed / limit.amount) * 100;
  const level: LimitLevel = percent >= 100 ? 'hard' : percent >= limit.warnPercent ? 'soft' : 'ok';
  return { ...limit, observed, percent, level };
}

export function evaluateLimits(limits: readonly Limit[], totals: UsageTotals): LimitStatus[] {
  return limits.map((l) => evaluateLimit(l, totals));
}

const LEVEL_RANK: Record<LimitLevel, number> = { unmeasured: 0, ok: 1, soft: 2, hard: 3 };

/** The most serious level among measured limits; 'ok' when there are none. */
export function worstLevel(statuses: readonly LimitStatus[]): LimitLevel {
  let worst: LimitLevel = 'ok';
  for (const s of statuses) if (s.level !== 'unmeasured' && LEVEL_RANK[s.level] > LEVEL_RANK[worst]) worst = s.level;
  return worst;
}

/** The highest measured percent, or null when no limit is set or none is measured. */
export function limitPercent(statuses: readonly LimitStatus[]): number | null {
  const measured = statuses.filter((s) => s.percent !== null).map((s) => s.percent!);
  return measured.length === 0 ? null : Math.max(...measured);
}

/**
 * Whether work may start in a scope: no limit on it is at 100%. The admission
 * rule for dispatch, and the reason the scheduler never starts a run in a
 * mission or a project that is over its limit.
 */
export function admits(statuses: readonly LimitStatus[]): boolean {
  return !statuses.some((s) => s.level === 'hard');
}

/**
 * The published facts. Like every fact, an unset limit is not measured:
 * `mission.limit_percent` exists only when the mission has a measured limit.
 */
export function limitFacts(input: {
  readonly mission?: { readonly totals: UsageTotals; readonly statuses: readonly LimitStatus[] };
  readonly month?: readonly LimitStatus[];
}): GateFacts {
  const facts: Record<string, number> = {};
  if (input.mission !== undefined) {
    const t = input.mission.totals;
    facts['mission.agent_minutes'] = round(t.agentMs / 60_000, 2);
    if (t.tokens !== null) facts['mission.tokens'] = t.tokens;
    if (t.costUsd !== null) facts['mission.spend_usd'] = round(t.costUsd, 4);
    const percent = limitPercent(input.mission.statuses);
    if (percent !== null) facts['mission.limit_percent'] = round(percent, 2);
  }
  if (input.month !== undefined) {
    const percent = limitPercent(input.month);
    if (percent !== null) facts['workspace.month_limit_percent'] = round(percent, 2);
  }
  return facts;
}

// --------------------------------------------------------------- the month

export interface UsageWindow {
  /** Inclusive, as an ISO instant. */
  readonly start: Timestamp;
  /** Exclusive, as an ISO instant. */
  readonly end: Timestamp;
  /** "2026-09", the local calendar month. */
  readonly month: string;
}

/**
 * The local calendar month containing `epochMs`. Always called with the
 * injected clock's reading, never the system clock (roadmap decision 12), so a
 * check can put the clock on the last second of a month and see the window turn.
 */
export function monthWindow(epochMs: number): UsageWindow {
  const at = new Date(epochMs);
  return windowOf(at.getFullYear(), at.getMonth());
}

/** The window for "2026-09"; null when the label is not a month. */
export function monthWindowOf(label: string): UsageWindow | null {
  const match = /^(\d{4})-(\d{2})$/.exec(label);
  if (match === null) return null;
  const month = Number(match[2]) - 1;
  if (month < 0 || month > 11) return null;
  return windowOf(Number(match[1]), month);
}

function windowOf(year: number, month: number): UsageWindow {
  const start = new Date(year, month, 1, 0, 0, 0, 0);
  const end = new Date(year, month + 1, 1, 0, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString(), month: `${year}-${String(month + 1).padStart(2, '0')}` };
}

// ---------------------------------------------------------------- incidents

export type LimitThreshold = 'soft' | 'hard';
export type LimitIncidentStatus = 'open' | 'resolved' | 'dismissed';

/**
 * A limit crossed, once per scope, metric, window, threshold and limit amount.
 * A mission's window starts when it was created and has no end; a project's is
 * its calendar month. Raising a limit and crossing the new one is a new incident.
 */
export interface LimitIncident {
  readonly id: LimitIncidentId;
  readonly workspaceId: WorkspaceId;
  /** Null for the project's monthly limit. */
  readonly missionId: MissionId | null;
  readonly metric: LimitMetric;
  readonly windowStart: Timestamp;
  readonly windowEnd: Timestamp | null;
  readonly amountLimit: number;
  readonly amountObserved: number;
  readonly threshold: LimitThreshold;
  readonly status: LimitIncidentStatus;
  /** The "raise or keep paused" card of a hard incident. */
  readonly approvalId: ApprovalId | null;
  /** Missions this incident paused, so raising the limit resumes exactly those. */
  readonly pausedMissionIds: readonly MissionId[];
  readonly createdAt: Timestamp;
  readonly resolvedAt: Timestamp | null;
}

// --------------------------------------------------------------- the words

const UNIT: Record<LimitMetric, { one: string; many: string; short: string }> = {
  agent_minutes: { one: 'agent minute', many: 'agent minutes', short: 'agent min' },
  tokens: { one: 'token', many: 'tokens', short: 'tokens' },
  usd: { one: 'USD', many: 'USD', short: 'USD' },
};

export function metricLabel(metric: LimitMetric): string {
  return metric === 'agent_minutes' ? 'Agent minutes' : metric === 'tokens' ? 'Tokens' : 'Cost (USD)';
}

/** A number as the person reads it: minutes to one decimal, tokens whole, dollars to the cent. */
export function formatNumber(metric: LimitMetric, value: number): string {
  if (metric === 'usd') return `$${value.toFixed(2)}`;
  if (metric === 'tokens') return Math.round(value).toLocaleString('en-US');
  const tenth = Math.round(value * 10) / 10;
  return Number.isInteger(tenth) ? String(tenth) : tenth.toFixed(1);
}

/** "15 agent minutes", "12,000 tokens", "$4.20". */
export function formatAmount(metric: LimitMetric, value: number): string {
  if (metric === 'usd') return formatNumber(metric, value);
  const unit = UNIT[metric];
  return `${formatNumber(metric, value)} ${value === 1 ? unit.one : unit.many}`;
}

/** "15 of 12 agent minutes". */
export function ofAmount(metric: LimitMetric, observed: number, limit: number): string {
  if (metric === 'usd') return `${formatNumber(metric, observed)} of ${formatNumber(metric, limit)}`;
  return `${formatNumber(metric, observed)} of ${formatAmount(metric, limit)}`;
}

/** The limit bar's label: "15 / 30 agent min", "$1.20 / $5.00". */
export function barLabel(status: LimitStatus): string {
  const limit = formatNumber(status.metric, status.amount);
  if (status.observed === null) return `not reported / ${limit}${status.metric === 'usd' ? '' : ` ${UNIT[status.metric].short}`}`;
  const observed = formatNumber(status.metric, status.observed);
  return status.metric === 'usd' ? `${observed} / ${limit}` : `${observed} / ${limit} ${UNIT[status.metric].short}`;
}

/** The mission's status reason at a hard stop: "Limit reached: 15 of 12 agent minutes". */
export function reachedReason(status: LimitStatus, scope: 'mission' | 'month'): string {
  const amounts = ofAmount(status.metric, status.observed ?? 0, status.amount);
  return scope === 'mission'
    ? `Limit reached: ${amounts}`
    : `Monthly limit reached: this project used ${amounts} this month`;
}

/** The status reason of a mission the daemon paused at a limit (and not someone's own pause). */
export function isLimitPause(reason: string | null): boolean {
  return reason !== null && (reason.startsWith('Limit reached: ') || reason.startsWith('Monthly limit reached: ') || reason.startsWith('Kept paused at its limit: '));
}

/** The timeline note at the warning level. */
export function warningNote(status: LimitStatus, scope: 'mission' | 'month'): string {
  const amounts = ofAmount(status.metric, status.observed ?? 0, status.amount);
  const percent = Math.floor(status.percent ?? 0);
  return scope === 'mission'
    ? `Limit warning: ${amounts} used (${percent}%). Work stops at ${formatAmount(status.metric, status.amount)}.`
    : `Monthly limit warning: this project used ${amounts} this month (${percent}%). Only urgent and high missions are pulled from the backlog; work stops at ${formatAmount(status.metric, status.amount)}.`;
}

/**
 * Home's banner at the project's monthly warning level (P10): the rule it
 * triggers first, then the numbers. "Monthly limit at 85% — only urgent and
 * high work will be pulled. This project used 25.5 of 30 agent minutes this
 * month; work stops at 30 agent minutes."
 */
export function monthBannerText(status: LimitStatus): string {
  const amounts = ofAmount(status.metric, status.observed ?? 0, status.amount);
  const percent = Math.floor(status.percent ?? 0);
  return `Monthly limit at ${percent}% — only urgent and high work will be pulled. This project used ${amounts} this month; work stops at ${formatAmount(status.metric, status.amount)}.`;
}

/** Said once on a mission whose USD limit cannot be read. */
export const UNMEASURED_USD_NOTE =
  'USD limit cannot be measured for this runtime: it does not report cost, so this limit never stops work. Set an agent minutes or tokens limit to cap this mission.';

/** A raise worth suggesting: double the limit, and always above what was used. */
export function suggestedRaise(status: LimitStatus): number {
  const floor = (status.observed ?? 0) * 1.25;
  const doubled = status.amount * 2;
  const raw = Math.max(doubled, floor);
  if (status.metric === 'usd') return Math.ceil(raw);
  if (status.metric === 'tokens') return Math.ceil(raw / 1000) * 1000;
  return Math.ceil(raw);
}

// ----------------------------------------------------- the backlog rule (P7)

/**
 * With the project at its monthly warning level, only urgent and high missions
 * are pulled from the backlog; at the limit, none. Normal and low work waits for
 * the next month or a higher limit instead of spending what is left.
 */
export function pullAllowedAtSpend(priority: MissionPriority, month: LimitLevel): boolean {
  if (month === 'hard') return false;
  if (month === 'soft') return priority === 'urgent' || priority === 'high';
  return true;
}

/** The backlog row of a mission the spend rule holds back. */
export function heldLabel(status: LimitStatus): string {
  const amounts = ofAmount(status.metric, status.observed ?? 0, status.amount);
  return status.level === 'hard'
    ? `Held: this project reached its monthly limit (${amounts}).`
    : `Held: this project is over ${status.warnPercent}% of its monthly limit (${amounts}). Only urgent and high missions are pulled.`;
}

/** The limit on this metric in the list, or null. */
export function limitOn(limits: readonly Limit[], metric: LimitMetric): Limit | null {
  return limits.find((l) => l.metric === metric) ?? null;
}

/** One limit per metric, amounts above zero, warning levels 1-99; the last one given for a metric wins. */
export function normalizeLimits(limits: readonly LimitDraft[]): Limit[] {
  const byMetric = new Map<LimitMetric, Limit>();
  for (const l of limits) {
    if (!LIMIT_METRICS.includes(l.metric) || !(l.amount > 0)) continue;
    const warn = Math.min(99, Math.max(1, Math.round(l.warnPercent ?? DEFAULT_WARN_PERCENT)));
    byMetric.set(l.metric, { metric: l.metric, amount: l.amount, warnPercent: warn });
  }
  return LIMIT_METRICS.filter((m) => byMetric.has(m)).map((m) => byMetric.get(m)!);
}

/** The list with this metric's amount set (added if absent). */
export function withAmount(limits: readonly Limit[], metric: LimitMetric, amount: number): Limit[] {
  const current = limitOn(limits, metric);
  return normalizeLimits([...limits.filter((l) => l.metric !== metric), { metric, amount, warnPercent: current?.warnPercent ?? DEFAULT_WARN_PERCENT }]);
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
