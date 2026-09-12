import type { MissionStatus, TaskStatus } from '@tandemise/domain';

/** The five-value status palette. Every status in the app maps onto one of these. */
export type Tone = 'running' | 'blocked' | 'failed' | 'succeeded' | 'pending';

const MISSION_TONES: Readonly<Record<MissionStatus, Tone>> = {
  DRAFT: 'pending',
  PLANNING: 'running',
  AWAITING_PLAN_APPROVAL: 'blocked',
  EXECUTING: 'running',
  REVIEWING: 'running',
  QA: 'running',
  READY_TO_SHIP: 'blocked',
  RELEASED: 'succeeded',
  OBSERVING: 'running',
  COMPLETE: 'succeeded',
  BLOCKED: 'blocked',
  PAUSED: 'pending',
  FAILED: 'failed',
  CANCELLED: 'pending',
};

const TASK_TONES: Readonly<Record<TaskStatus, Tone>> = {
  PENDING: 'pending',
  READY: 'pending',
  RUNNING: 'running',
  AWAITING_HUMAN: 'blocked',
  AWAITING_APPROVAL: 'blocked',
  BLOCKED: 'blocked',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  SKIPPED: 'pending',
  CANCELLED: 'pending',
};

export function missionTone(status: MissionStatus): Tone {
  return MISSION_TONES[status] ?? 'pending';
}

export function taskTone(status: TaskStatus): Tone {
  return TASK_TONES[status] ?? 'pending';
}

export function healthTone(state: string): Tone {
  if (state === 'healthy') return 'succeeded';
  if (state === 'degraded') return 'blocked';
  if (state === 'unavailable') return 'failed';
  return 'pending';
}

/** `AWAITING_PLAN_APPROVAL` → `Awaiting plan approval`. */
export function humanizeStatus(status: string): string {
  const words = status.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function titleCase(value: string): string {
  return value
    .replace(/[_-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' });
const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['second', 1000],
  ['minute', 60_000],
  ['hour', 3_600_000],
  ['day', 86_400_000],
  ['week', 604_800_000],
  ['month', 2_629_800_000],
  ['year', 31_557_600_000],
];

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const delta = then - now;
  const magnitude = Math.abs(delta);
  if (magnitude < 45_000) return 'just now';

  let chosen: readonly [Intl.RelativeTimeFormatUnit, number] = UNITS[0] as [Intl.RelativeTimeFormatUnit, number];
  for (const unit of UNITS) {
    if (magnitude >= unit[1]) chosen = unit;
  }
  return RELATIVE.format(Math.round(delta / chosen[1]), chosen[0]);
}

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'not reported';
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * MVP.md §22.2: a metric the runtime did not report is *unknown*, and must not
 * be rendered as zero. Callers pass the raw nullable value straight through.
 */
export function metric(value: number | null | undefined): string {
  return value === null || value === undefined ? 'not reported' : new Intl.NumberFormat().format(value);
}

export function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'not reported';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value);
}

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function shortenPath(path: string, segments = 3): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= segments) return path;
  return `…/${parts.slice(-segments).join('/')}`;
}
