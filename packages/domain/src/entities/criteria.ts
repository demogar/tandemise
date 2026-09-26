import type { ArtifactId, CriterionId, MissionId, Timestamp } from '@tandemise/shared';
import type { CriterionResult } from './evaluation.js';

/**
 * The Done-when ledger (P5).
 *
 * Every line a person writes under "Done when" becomes a numbered criterion
 * (`U1…`). The spec answers with its own criteria (`AC1…`), each naming the
 * user criteria it `covers`; QA verifies spec criteria by id. The ledger is
 * what lets the daemon trace that chain and measure it, instead of trusting a
 * report that says everything passed.
 *
 * Only the criteria are stored. Whether one is verified is read from the
 * newest QA evaluation every time it is asked, exactly like every other gate
 * fact: a stored result would go stale the moment the spec or QA moved on.
 */
export const CRITERION_SOURCES = ['user', 'spec'] as const;
export type CriterionSource = (typeof CRITERION_SOURCES)[number];

/**
 * Where a criterion stands (P6). Only `accepted` rows are the ledger: a
 * refinement's proposals wait as `proposed` until the person decides them,
 * and `rejected` and `stale` (replaced by a newer proposal) are history.
 */
export const CRITERION_STATUSES = ['proposed', 'accepted', 'rejected', 'stale'] as const;
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];

/** Who accepted a proposal when no person did: a mission run with autonomy `autonomous`. */
export const AUTONOMY_DECIDER = 'autonomy';

/** Longest statement kept, matching the SQL CHECK: a criterion is a sentence, not a document. */
export const CRITERION_STATEMENT_MAX = 2000;
export const CRITERION_KEY_MAX = 40;

export interface MissionCriterion {
  readonly id: CriterionId;
  readonly missionId: MissionId;
  /** `U1…` for the person's lines; the spec's own id (`AC1`) for spec criteria. */
  readonly key: string;
  readonly statement: string;
  readonly source: CriterionSource;
  /** User keys a spec criterion covers; always empty for a user criterion. */
  readonly covers: readonly string[];
  /** The ProductSpec a spec criterion came from; null for user criteria. */
  readonly specArtifactId: ArtifactId | null;
  /** Order within its source, as written. */
  readonly position: number;
  /** Set when a newer spec replaced it; superseded rows never count. */
  readonly supersededAt: Timestamp | null;
  readonly createdAt: Timestamp;
  /** `accepted` for everything written before P6; proposals start `proposed`. */
  readonly status: CriterionStatus;
  /** The Refinement that proposed it; null for the person's own lines and for spec criteria. */
  readonly refinementArtifactId: ArtifactId | null;
  /** The member who accepted, rejected or added it, or `autonomy`; null for lines written at creation. */
  readonly decidedBy: string | null;
  readonly decidedAt: Timestamp | null;
}

/** A criterion a spec declares, before it is on the ledger. */
export interface SpecCriterionInput {
  readonly key: string;
  readonly statement: string;
  readonly covers: readonly string[];
}

/** `U1` for the first Done-when line. */
export function userCriterionKey(index: number): string {
  return `U${index + 1}`;
}

/** The `U<n>` shape is reserved for the person's lines, so a spec can never take one over. */
export function isUserCriterionKey(key: string): boolean {
  return /^U\d+$/.test(key);
}

/** The ledger key a QA result names: `criterionId`, or the legacy free-text `criterion`. */
export function resultKey(result: CriterionResult): string {
  const id = typeof result.criterionId === 'string' ? result.criterionId.trim() : '';
  return id.length > 0 ? id : result.criterion.trim();
}

// ---------------------------------------------------------------- validation

export interface SpecCriteriaCheck {
  /** Faults that make the spec unreadable against the ledger: it is refused, not stored. */
  readonly refused: readonly string[];
  /** User keys no spec criterion covers. */
  readonly uncovered: readonly string[];
  /** `covers` entries that name no user criterion, as `AC1 → U9`. */
  readonly unknownCovers: readonly string[];
}

/**
 * Checks a spec's criteria against the person's.
 *
 * Duplicate ids and ids that take a user key are refused outright: the ledger
 * could not hold them, and QA could not verify them unambiguously. Leaving a
 * user criterion uncovered, or covering one that does not exist, is recorded
 * and left to the gate to fail - the spec is still the best statement of the
 * work, and the retry needs it on record to say what is missing.
 */
export function checkSpecCriteria(userKeys: readonly string[], criteria: readonly SpecCriterionInput[]): SpecCriteriaCheck {
  const refused: string[] = [];
  const seen = new Set<string>();
  for (const c of criteria) {
    if (seen.has(c.key)) refused.push(`${c.key} is used by more than one acceptance criterion; give each its own id`);
    seen.add(c.key);
    if (isUserCriterionKey(c.key)) refused.push(`${c.key} is reserved for the person's Done-when lines; name spec criteria AC1, AC2, …`);
    if (c.key.length > CRITERION_KEY_MAX) refused.push(`${c.key.slice(0, 20)}… is longer than ${CRITERION_KEY_MAX} characters`);
  }
  const users = new Set(userKeys);
  const covered = new Set(criteria.flatMap((c) => c.covers));
  return {
    refused,
    uncovered: userKeys.filter((k) => !covered.has(k)),
    unknownCovers: criteria.flatMap((c) => c.covers.filter((k) => !users.has(k)).map((k) => `${c.key} → ${k}`)),
  };
}

/** QA results that name no criterion on the ledger. Empty when the ledger is (legacy missions). */
export function unknownQaKeys(ledgerKeys: readonly string[], results: readonly CriterionResult[]): readonly string[] {
  if (ledgerKeys.length === 0) return [];
  const known = new Set(ledgerKeys);
  return [...new Set(results.map(resultKey).filter((k) => !known.has(k)))];
}

// ------------------------------------------------------------------- tracing

export type TracedResult = 'PASS' | 'FAIL' | 'SKIP' | 'UNVERIFIED';

export interface TracedCriterion {
  readonly criterion: MissionCriterion;
  /** Spec keys covering a user criterion; empty for spec criteria. */
  readonly coveredBy: readonly string[];
  readonly result: TracedResult;
  readonly evidence: string;
  /** True when the result came from a QA report (directly or through what covers it). */
  readonly fromQa: boolean;
  /** Counts towards "N of M verified" and the qa.criteria_* facts. */
  readonly counted: boolean;
  /** A user criterion nothing in the live spec covers, once a spec exists. */
  readonly uncovered: boolean;
}

export interface QaReading {
  readonly results: readonly CriterionResult[];
  /** When QA reported: a criterion written after this was never in front of it. */
  readonly recordedAt: Timestamp;
}

export interface CriteriaTrace {
  readonly rows: readonly TracedCriterion[];
  readonly total: number;
  readonly userTotal: number;
  readonly specTotal: number;
  readonly uncoveredUser: number;
  readonly unknownCovers: number;
  /** Size of the counted set: live spec criteria plus user criteria nothing covers. */
  readonly counted: number;
  readonly verified: number;
  readonly failed: number;
  readonly unverified: number;
}

/**
 * Traces live criteria against the newest QA reading.
 *
 * What counts is every live spec criterion plus every user criterion nothing
 * covers. Counting only spec criteria would let a spec that silently dropped
 * `U2` look finished once QA passed what it did write; counting covered user
 * criteria too would count the same work twice.
 *
 * A result applies only to a criterion that existed when QA reported. A spec
 * rewritten after QA ran has criteria nobody verified, even if an old id
 * reappears with new words.
 */
export function traceCriteria(live: readonly MissionCriterion[], qa: QaReading | null): CriteriaTrace {
  const users = live.filter((c) => c.source === 'user').sort(byPosition);
  const specs = live.filter((c) => c.source === 'spec').sort(byPosition);
  const specWritten = specs.length > 0;
  const userKeys = new Set(users.map((u) => u.key));

  const direct = new Map<string, CriterionResult>();
  for (const r of qa?.results ?? []) {
    const key = resultKey(r);
    if (!direct.has(key)) direct.set(key, r);
  }
  const reported = (c: MissionCriterion): CriterionResult | undefined =>
    qa !== null && c.createdAt <= qa.recordedAt ? direct.get(c.key) : undefined;

  const specRows = new Map<string, TracedCriterion>();
  for (const s of specs) {
    const r = reported(s);
    specRows.set(s.key, {
      criterion: s,
      coveredBy: [],
      result: r?.outcome ?? 'UNVERIFIED',
      evidence: r?.evidence ?? '',
      fromQa: r !== undefined,
      counted: true,
      uncovered: false,
    });
  }

  const userRows = users.map((u): TracedCriterion => {
    const coveredBy = specs.filter((s) => s.covers.includes(u.key)).map((s) => s.key);
    const own = reported(u);
    if (own !== undefined) {
      return { criterion: u, coveredBy, result: own.outcome, evidence: own.evidence, fromQa: true, counted: coveredBy.length === 0, uncovered: specWritten && coveredBy.length === 0 };
    }
    if (coveredBy.length === 0) {
      return { criterion: u, coveredBy, result: 'UNVERIFIED', evidence: '', fromQa: false, counted: true, uncovered: specWritten };
    }
    const through = coveredBy.flatMap((k) => { const row = specRows.get(k); return row === undefined ? [] : [row]; });
    const outcomes = through.map((t) => t.result);
    const result: TracedResult = outcomes.every((o) => o === 'PASS') ? 'PASS'
      : outcomes.includes('FAIL') ? 'FAIL'
        : outcomes.includes('SKIP') ? 'SKIP'
          : 'UNVERIFIED';
    return {
      criterion: u, coveredBy, result,
      evidence: through.some((t) => t.fromQa) ? `Through ${coveredBy.join(', ')}` : '',
      fromQa: through.some((t) => t.fromQa),
      counted: false,
      uncovered: false,
    };
  });

  const rows = [...userRows, ...specRows.values()];
  const counted = rows.filter((r) => r.counted);
  const verified = counted.filter((r) => r.result === 'PASS').length;
  const failed = counted.filter((r) => r.result === 'FAIL').length;
  return {
    rows,
    total: live.length,
    userTotal: users.length,
    specTotal: specs.length,
    uncoveredUser: userRows.filter((r) => r.coveredBy.length === 0).length,
    unknownCovers: specs.reduce((n, s) => n + s.covers.filter((k) => !userKeys.has(k)).length, 0),
    counted: counted.length,
    verified,
    failed,
    unverified: counted.length - verified - failed,
  };
}

function byPosition(a: MissionCriterion, b: MissionCriterion): number {
  return a.position - b.position || a.createdAt.localeCompare(b.createdAt);
}
