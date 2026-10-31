/**
 * Intake (spec 2026-10-30-intake-design.md): anything that might be work, from
 * any source, recorded as a signal and landed as one item in the project's
 * primary tracker.
 *
 * Everything here is pure: the fingerprint that dedupes a signal, how two
 * readings of one signal's impact merge, the words a source kind reads as, and
 * the configuration shapes the pipeline reads through `IntakeConfigSource`.
 * The zod contract and the file schemas live in `@tandemise/api-contract`;
 * these types mirror them so the domain and application layers never depend
 * on the wire format.
 *
 * Signal text is untrusted data (spec §1 "Text is data"). Nothing here reads it
 * for anything but words, so a signal cannot choose a project, a tracker, a
 * state, a threshold or a source.
 */

/** Where a signal is in the pipeline (spec §4, §8). */
export const SIGNAL_STATUSES = [
  'received',
  'held_back',
  'needs_decision',
  'linked',
  'created',
  'rejected',
  'dismissed',
  'closure_pending',
  'closed',
  'closure_failed',
] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

/** Spec §1 `impact.level`, least to most severe. */
export const IMPACT_LEVELS = ['info', 'warning', 'error', 'fatal'] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];

export const KIND_HINTS = ['bug', 'request', 'question'] as const;
export type KindHint = (typeof KIND_HINTS)[number];

/** What the noise filter reads (spec §1 `impact`, §4.1). Every field is optional. */
export interface Impact {
  readonly level?: ImpactLevel;
  readonly events?: number;
  readonly users?: number;
  /** ISO 8601. */
  readonly firstSeen?: string;
  /** ISO 8601. */
  readonly lastSeen?: string;
  readonly release?: string;
}

/**
 * The deterministic dedupe key (spec §1, "Words"): `<kind>:<instance>:<key>`.
 * The same fingerprint always updates the same signal.
 */
export function fingerprintOf(s: { readonly source: { readonly kind: string; readonly instance: string }; readonly key: string }): string {
  return `${s.source.kind}:${s.source.instance}:${s.key}`;
}

/**
 * One signal read twice (a repeat push, the next poll) keeps its worst news:
 * the larger counts, the earliest first sighting, the latest last sighting,
 * the more severe level. The newer reading's release wins, because a release
 * is a label, not a quantity. Absent fields never erase present ones.
 * ISO 8601 timestamps compare correctly as strings.
 */
export function mergeImpact(prev: Impact | null, next: Impact | null): Impact | null {
  if (prev === null) return next;
  if (next === null) return prev;
  const out: { -readonly [K in keyof Impact]: Impact[K] } = {};
  const level = moreSevere(prev.level, next.level);
  if (level !== undefined) out.level = level;
  const events = pick(prev.events, next.events, (a, b) => Math.max(a, b));
  if (events !== undefined) out.events = events;
  const users = pick(prev.users, next.users, (a, b) => Math.max(a, b));
  if (users !== undefined) out.users = users;
  const firstSeen = pick(prev.firstSeen, next.firstSeen, (a, b) => (a <= b ? a : b));
  if (firstSeen !== undefined) out.firstSeen = firstSeen;
  const lastSeen = pick(prev.lastSeen, next.lastSeen, (a, b) => (a >= b ? a : b));
  if (lastSeen !== undefined) out.lastSeen = lastSeen;
  const release = next.release ?? prev.release;
  if (release !== undefined) out.release = release;
  return out;
}

function pick<T>(a: T | undefined, b: T | undefined, both: (a: T, b: T) => T): T | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return both(a, b);
}

function moreSevere(a: ImpactLevel | undefined, b: ImpactLevel | undefined): ImpactLevel | undefined {
  return pick(a, b, (x, y) => (IMPACT_LEVELS.indexOf(x) >= IMPACT_LEVELS.indexOf(y) ? x : y));
}

const SHIPPED_SOURCE_LABELS: Readonly<Record<string, string>> = {
  github: 'GitHub',
  sentry: 'Sentry',
  posthog: 'PostHog',
  slack: 'Slack',
  discord: 'Discord',
};

/** The words a source kind reads as. A custom runner's slug is shown as itself. */
export function sourceLabel(kind: string): string {
  return SHIPPED_SOURCE_LABELS[kind] ?? kind;
}

// ------------------------------------------------------------------ configuration

export const TRACKER_KINDS = ['youtrack', 'github-issues'] as const;
export type TrackerKind = (typeof TRACKER_KINDS)[number];

export const INTAKE_SOURCE_CADENCES = ['5m', '10m', '15m', '30m', '60m'] as const;
export type IntakeSourceCadence = (typeof INTAKE_SOURCE_CADENCES)[number];

export const INTAKE_FILTER_WINDOWS = ['1h', '24h', '7d'] as const;
export type IntakeFilterWindow = (typeof INTAKE_FILTER_WINDOWS)[number];

export const DEFAULT_INTAKE_DAILY_CAP = 20;
export const DEFAULT_INTAKE_SIMILARITY: { readonly link: number; readonly ask: number } = { link: 0.85, ask: 0.55 };

/** Spec §6.2: the tracker's own states mapped to the five Tandemise needs. */
export interface TrackerStatesConfig {
  /** Where intake creates; what the board offers to Start. At least one. */
  readonly ready: readonly string[];
  readonly in_progress: string;
  readonly in_review?: string;
  /** The first one is what Tandemise writes. At least one. */
  readonly done: readonly string[];
  readonly wont_do: readonly string[];
}

/** Spec §6.2 `factory/tracker.yaml`'s `tracker`. */
export interface TrackerConfig {
  readonly kind: TrackerKind;
  /** YouTrack's base URL. */
  readonly url?: string;
  /** YouTrack's project short name. */
  readonly project?: string;
  /** GitHub Issues' `owner/name`. */
  readonly repo?: string;
  /** The tracker's own query for the board. */
  readonly board: string;
  readonly states: TrackerStatesConfig;
  /** What Tandemise writes when a mission completes. */
  readonly onComplete: 'in_review' | 'done';
  readonly workflows?: Readonly<Record<string, string>>;
}

/** Spec §4.1 per-source noise rules. */
export interface NoiseRules {
  readonly minLevel?: ImpactLevel;
  readonly minEvents?: number;
  readonly minUsers?: number;
  readonly window?: IntakeFilterWindow;
  /** A plain substring, or `/re/` for a regular expression. */
  readonly ignoreTitles?: readonly string[];
}

/** Spec §4.1 `factory/intake.yaml`'s one source. */
export interface IntakeSourceConfig {
  readonly id: string;
  readonly kind: string;
  readonly instance: string;
  readonly every?: IntakeSourceCadence;
  readonly filter?: NoiseRules;
  readonly trigger?: { readonly emoji?: string; readonly mention?: boolean; readonly label?: string };
  readonly create?: { readonly type?: string; readonly fields?: Readonly<Record<string, string>> };
  readonly closeOnDone: boolean;
  readonly closeWontDo: boolean;
  /** Base-URL override for self-hosted instances and fakes: https, or http on loopback only. */
  readonly api?: string;
}

/** Everything the pipeline reads about one project, from wherever it is configured. */
export interface IntakeConfig {
  /** Null when the project has no tracker, and so no intake (spec §6.2). */
  readonly tracker: TrackerConfig | null;
  readonly sources: readonly IntakeSourceConfig[];
  /** New tracker items per source per day; past it, signals wait as `needs_decision`. */
  readonly dailyCap: number;
  readonly similarity: { readonly link: number; readonly ask: number };
}

/** What a project with nothing configured reads as. */
export function emptyIntakeConfig(): IntakeConfig {
  return { tracker: null, sources: [], dailyCap: DEFAULT_INTAKE_DAILY_CAP, similarity: { ...DEFAULT_INTAKE_SIMILARITY } };
}
