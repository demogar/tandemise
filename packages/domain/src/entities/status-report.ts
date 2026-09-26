import type { Timestamp } from '@tandemise/shared';
import type { MissionStatus } from './mission.js';
import type { MissionPriority } from './backlog.js';
import type { LivenessKind } from './liveness.js';
import { barLabel, formatAmount, type LimitStatus, type UsageTotals } from './limits.js';

/**
 * The project status report (P10 spec §2): a fixed Markdown template over
 * stored facts. No model writes it and nothing here reads a clock, the
 * filesystem or a locale, so the same facts always render the same bytes.
 *
 * The instant the facts were read (`asOf`) goes into the front matter only.
 * The body never carries the time, so two reports with nothing changed in
 * between compare line for line as identical, and a reader comparing v1 with
 * v2 sees what moved in the work rather than that a clock ticked.
 */

/**
 * The workflow preset of a project's report holder: one mission row per
 * project, titled "Status reports", that its reports belong to. An artifact
 * needs a mission (migration 001), a project report has none; the holder is
 * never listed, so it is in no count, backlog, liveness pass or scheduler pass.
 */
export const REPORT_HOLDER_PRESET = 'status-reports';
export const REPORT_HOLDER_TITLE = 'Status reports';

export interface StatusReportCriteria {
  readonly verified: number;
  readonly counted: number;
  /** Keys whose newest QA result is FAIL, in ledger order. */
  readonly failed: readonly string[];
  /** Counted keys QA has not verified (skipped or never reached), in ledger order. */
  readonly notVerified: readonly string[];
  /** The person's criteria no live spec criterion covers. */
  readonly notCovered: readonly string[];
}

export interface StatusReportMission {
  readonly title: string;
  readonly status: MissionStatus;
  readonly statusReason: string | null;
  /** P9's verdict: what moves it, or why nothing does and the one thing to press. */
  readonly liveness: { readonly kind: LivenessKind; readonly reason: string | null; readonly action: string | null };
  readonly criteria: StatusReportCriteria;
  /** Its effective limits, measured now (P8); empty when none is set. */
  readonly limits: readonly LimitStatus[];
  /** Open cards other than checks, and steps waiting on a person, as their titles. */
  readonly waitingOn: readonly string[];
  /** The newest failed gate evaluation as the event log recorded it; null when none failed. */
  readonly lastGateFailure: { readonly taskKey: string | null; readonly detail: string } | null;
}

export interface StatusReportBacklogItem {
  readonly title: string;
  readonly priority: MissionPriority;
  /** 1-based pull position among queued drafts; null when not queued. */
  readonly position: number | null;
  readonly ready: boolean;
  /** The readiness gate's label when not ready ("Answer 1 question to plan"). */
  readonly readiness: string;
  readonly refining: boolean;
  /** "Held: …" when the monthly spend rule holds it back (P8). */
  readonly held: string | null;
}

export interface StatusReportFacts {
  readonly project: string;
  /** The Clock's instant when the facts were read. Front matter only. */
  readonly asOf: Timestamp;
  /** The local month the monthly limits measure, "2026-09". */
  readonly month: string;
  readonly needsYou: number;
  readonly active: number;
  readonly wipLimit: number | null;
  readonly queued: number;
  readonly criteria: { readonly verified: number; readonly counted: number; readonly missions: number };
  readonly monthLimits: readonly LimitStatus[];
  readonly monthUsage: UsageTotals;
  readonly stalled: number;
  /** Every mission that is not a draft and not finished, in backlog order. */
  readonly missions: readonly StatusReportMission[];
  /** Queued drafts in pull order, then drafts not queued. */
  readonly backlog: readonly StatusReportBacklogItem[];
}

/** The handoff limits of the artifact contract (`HANDOFF_LIMITS` in @tandemise/artifacts). */
const LIMITS = { title: 60, headline: 90, point: 140, points: 3 } as const;

export function statusReportTitle(project: string): string {
  return clip(`Status report: ${project}`, LIMITS.title);
}

/** "1 needs you · working on 2 of 2 · 4 of 6 criteria verified · 1 stalled". */
export function statusReportHeadline(facts: StatusReportFacts): string {
  const parts = [
    `${facts.needsYou} ${facts.needsYou === 1 ? 'needs' : 'need'} you`,
    facts.wipLimit === null ? `working on ${facts.active}` : `working on ${facts.active} of ${facts.wipLimit}`,
  ];
  if (facts.criteria.counted > 0) parts.push(`${facts.criteria.verified} of ${facts.criteria.counted} criteria verified`);
  if (facts.stalled > 0) parts.push(`${facts.stalled} stalled`);
  return clip(parts.join(' · '), LIMITS.headline);
}

/** The whole file: front matter, then the fixed template filled from facts. */
export function renderStatusReport(facts: StatusReportFacts): string {
  const title = statusReportTitle(facts.project);
  const points = statusReportPoints(facts);
  const front = [
    '---',
    'type: StatusReport',
    'schemaVersion: 1',
    `title: ${quote(title)}`,
    `asOf: ${quote(facts.asOf)}`,
    'handoff:',
    `  headline: ${quote(statusReportHeadline(facts))}`,
    points.length === 0 ? '  points: []' : ['  points:', ...points.map((p) => `    - ${quote(p)}`)].join('\n'),
    '---',
  ];
  const body = [
    `# ${md(title)}`,
    '',
    '## At a glance',
    '',
    ...glance(facts),
    '',
    '## Missions',
    '',
    ...(facts.missions.length === 0 ? ['Nothing is in progress or paused.', ''] : facts.missions.flatMap(missionSection)),
    '## Backlog',
    '',
    ...backlogSection(facts.backlog),
    '',
    '## How this report was made',
    '',
    'Rendered by Tandemise from stored facts: mission and step rows, the Done-when ledger and the newest QA report, usage records, open cards and the event log. No model wrote it. The same facts always render the same report.',
    '',
  ];
  return `${front.join('\n')}\n\n${body.join('\n')}`;
}

function glance(facts: StatusReportFacts): string[] {
  const { criteria } = facts;
  return [
    `- Needs you: ${facts.needsYou}`,
    facts.wipLimit === null
      ? `- Working on: ${facts.active} · no limit · ${facts.queued} queued`
      : `- Working on: ${facts.active} of ${facts.wipLimit} · ${facts.queued} queued`,
    criteria.counted === 0
      ? '- Criteria verified: none yet; no mission in progress has criteria to verify.'
      : `- Criteria verified: ${criteria.verified} of ${criteria.counted}, across ${plural(criteria.missions, 'mission')} in progress`,
    facts.monthLimits.length === 0
      ? `- This month (${facts.month}): no monthly limit set; ${formatAmount('agent_minutes', facts.monthUsage.agentMs / 60_000)} used.`
      : `- This month (${facts.month}): ${facts.monthLimits.map(limitText).join('; ')}`,
    `- Stalled: ${facts.stalled}`,
  ];
}

function missionSection(m: StatusReportMission): string[] {
  const lines = [`### ${md(m.title)}`, '', `- Status: ${statusLabel(m.status)}.${m.statusReason ? ` ${md(m.statusReason)}` : ''}`];
  const { liveness } = m;
  if (liveness.kind === 'stalled') lines.push(`- Stalled: ${md(liveness.reason ?? 'Nothing can move this mission.')}${liveness.action ? ` Next: ${md(liveness.action)}.` : ''}`);
  else if (liveness.kind === 'moving') lines.push('- Moving: work continues without you.');
  else if (liveness.kind === 'parked') lines.push('- Parked: nothing runs until you resume it.');
  else if (liveness.kind === 'waiting' && m.waitingOn.length === 0) lines.push('- Waiting on a person.');
  lines.push(`- Criteria: ${criteriaText(m.criteria)}.`);
  lines.push(`- Limit: ${m.limits.length === 0 ? 'no limit set' : m.limits.map(limitText).join('; ')}.`);
  if (m.waitingOn.length > 0) lines.push(`- Waiting on you: ${m.waitingOn.map(md).join('; ')}.`);
  if (m.lastGateFailure !== null) {
    lines.push(`- Last gate failure${m.lastGateFailure.taskKey === null ? '' : ` (${md(m.lastGateFailure.taskKey)})`}: ${md(m.lastGateFailure.detail)}`);
  }
  lines.push('');
  return lines;
}

function backlogSection(items: readonly StatusReportBacklogItem[]): string[] {
  if (items.length === 0) return ['The backlog is empty.'];
  const describe = (i: StatusReportBacklogItem): string => [
    md(i.title),
    priorityName(i.priority),
    i.ready ? 'Ready to plan' : md(i.readiness),
    ...(i.refining ? ['Refining'] : []),
    ...(i.held === null ? [] : [md(i.held)]),
  ].join(' · ');
  const queued = items.filter((i) => i.position !== null).map((i) => `${i.position}. ${describe(i)}`);
  const rest = items.filter((i) => i.position === null).map((i) => `- Not queued: ${describe(i)}`);
  // A blank line between them: a numbered list followed at once by a bullet would read as one list.
  return queued.length > 0 && rest.length > 0 ? [...queued, '', ...rest] : [...queued, ...rest];
}

/** "1 of 3 verified; AC2 failed; AC3 not verified; U2 not covered by the spec". */
function criteriaText(c: StatusReportCriteria): string {
  if (c.counted === 0) return 'none yet';
  const parts = [`${c.verified} of ${c.counted} verified`];
  if (c.failed.length > 0) parts.push(`${c.failed.join(', ')} failed`);
  if (c.notVerified.length > 0) parts.push(`${c.notVerified.join(', ')} not verified`);
  if (c.notCovered.length > 0) parts.push(`${c.notCovered.join(', ')} not covered by the spec`);
  return parts.join('; ');
}

/** "25.5 / 30 agent min (85%)"; a metric nothing reports has no percent. */
function limitText(s: LimitStatus): string {
  return s.percent === null ? barLabel(s) : `${barLabel(s)} (${Math.floor(s.percent)}%)`;
}

/** What someone who reads only the handoff most needs: stuck work, spend, then decisions. */
export function statusReportPoints(facts: StatusReportFacts): string[] {
  const points: string[] = [];
  for (const m of facts.missions) {
    if (m.liveness.kind === 'stalled') points.push(`Stalled: ${m.title}${m.liveness.action ? ` — ${m.liveness.action}` : ''}`);
  }
  const month = facts.monthLimits.filter((s) => s.percent !== null && (s.level === 'soft' || s.level === 'hard'));
  for (const s of month) points.push(`This month: ${limitText(s)}`);
  for (const m of facts.missions) {
    if (m.waitingOn.length > 0) points.push(`Waiting on you: ${m.title}: ${m.waitingOn[0]}`);
  }
  return points.slice(0, LIMITS.points).map((p) => clip(p, LIMITS.point));
}

/** "Awaiting plan approval" from AWAITING_PLAN_APPROVAL: the same words everywhere, in any locale. */
function statusLabel(status: MissionStatus): string {
  const words = status.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function priorityName(priority: MissionPriority): string {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/**
 * Text from the rows (titles, reasons, gate details) printed literally: a
 * backslash before each character Markdown would read as markup, so
 * "SCRIPTED_FAIL_RELEASE" is not shown in italics. The front matter is not
 * Markdown and is never escaped.
 */
function md(text: string): string {
  return text.replace(/[\\`*_[\]]/g, (c) => `\\${c}`);
}

/** A JSON string is a valid double-quoted YAML scalar, whatever it contains. */
function quote(value: string): string {
  return JSON.stringify(value);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
