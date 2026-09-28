import type { CriteriaCounts, EvalTrialStatus, RunScore, TrialScore } from '@tandemise/domain';

/**
 * The pure scorecard (spec B1/B4): every function here turns `RunScore`
 * rows (measured facts, never judgements - Ruling 8) into summaries an eval
 * run or the "From your runs" view can show. Nothing here does I/O or reads
 * a clock; every input is data the caller already has in hand.
 *
 * "Attempts" are counted per (taskId, round) group of scores, ordered by
 * `scoredAt`: the first row is attempt 1. This is deliberately not
 * `Run.attempt`, which is a run number that feedback passes also advance.
 */

// --------------------------------------------------------------- helpers

function byScoredAt(a: RunScore, b: RunScore): number {
  return a.scoredAt < b.scoredAt ? -1 : a.scoredAt > b.scoredAt ? 1 : 0;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Sum a field across rows, null if any row's value is null (a partial sum would understate). */
function sumOrNullIfAnyNull(values: readonly (number | null)[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

// -------------------------------------------------------- summarizeRunScores

export interface RoleModelSummary {
  readonly roleId: string;
  readonly model: string | null;
  readonly runs: number;
  readonly firstAttemptPassRate: number | null;
  readonly meanAttemptsToPass: number | null;
  readonly criteriaFailed: number;
  readonly medianCostUsd: number | null;
  readonly medianWallTimeMs: number | null;
}

/** One (taskId, round) group of scores, ordered by scoredAt. */
function attemptGroups(scores: readonly RunScore[]): RunScore[][] {
  const byKey = new Map<string, RunScore[]>();
  for (const score of scores) {
    const key = `${score.taskId}\u0000${score.round}`;
    const group = byKey.get(key);
    if (group) group.push(score);
    else byKey.set(key, [score]);
  }
  return [...byKey.values()].map((group) => [...group].sort(byScoredAt));
}

export function summarizeRunScores(scores: readonly RunScore[]): RoleModelSummary[] {
  const byRoleModel = new Map<string, { readonly roleId: string; readonly model: string | null; rows: RunScore[] }>();
  for (const score of scores) {
    const key = `${score.roleId}\u0000${score.model ?? ''}`;
    const bucket = byRoleModel.get(key);
    if (bucket) bucket.rows.push(score);
    else byRoleModel.set(key, { roleId: score.roleId, model: score.model, rows: [score] });
  }

  const summaries = [...byRoleModel.values()].map(({ roleId, model, rows }) => {
    const groups = attemptGroups(rows);
    // Every group is non-empty: built from at least one score in attemptGroups.
    const firstAttemptPasses = groups.filter((g) => (g[0] as RunScore).gatePassed).length;
    const attemptsToPass = groups
      .map((g) => g.findIndex((row) => row.gatePassed))
      .filter((index) => index >= 0)
      .map((index) => index + 1);
    const criteriaFailed = rows.reduce((sum, row) => sum + (row.criteria?.failed ?? 0), 0);
    const costs = rows.map((row) => row.costUsd).filter((v): v is number => v !== null);
    const wallTimes = rows.map((row) => row.wallTimeMs).filter((v): v is number => v !== null);
    return {
      roleId,
      model,
      runs: rows.length,
      firstAttemptPassRate: rate(firstAttemptPasses, groups.length),
      meanAttemptsToPass: mean(attemptsToPass),
      criteriaFailed,
      medianCostUsd: median(costs),
      medianWallTimeMs: median(wallTimes),
    };
  });

  return summaries.sort((a, b) => {
    if (a.roleId !== b.roleId) return a.roleId < b.roleId ? -1 : 1;
    if (a.model === b.model) return 0;
    if (a.model === null) return 1;
    if (b.model === null) return -1;
    return a.model < b.model ? -1 : 1;
  });
}

// ------------------------------------------------------------ trialScoreFrom

export function trialScoreFrom(scores: readonly RunScore[]): TrialScore | null {
  if (scores.length === 0) return null;
  const sorted = [...scores].sort(byScoredAt);
  const first = sorted[0] as RunScore;
  const last = sorted[sorted.length - 1] as RunScore;
  return {
    gatePassed: last.gatePassed,
    attempts: sorted.length,
    firstAttemptPassed: first.gatePassed,
    criteria: last.criteria,
    overBudget: last.overBudget,
    inputTokens: sumOrNullIfAnyNull(sorted.map((row) => row.inputTokens)),
    outputTokens: sumOrNullIfAnyNull(sorted.map((row) => row.outputTokens)),
    costUsd: sumOrNullIfAnyNull(sorted.map((row) => row.costUsd)),
    wallTimeMs: sumOrNullIfAnyNull(sorted.map((row) => row.wallTimeMs)),
    model: last.model,
  };
}

// -------------------------------------------------------------- scoreEvalRun

export interface VariantScore {
  readonly trials: { readonly completed: number; readonly blocked: number; readonly failed: number };
  readonly gatePassRate: number | null;
  readonly firstAttemptPassRate: number | null;
  readonly criteria: CriteriaCounts | null;
  readonly meanAttempts: number | null;
  readonly overBudget: number;
  readonly tokens: { readonly mean: number | null; readonly total: number | null };
  readonly costUsd: { readonly mean: number | null; readonly total: number | null };
  readonly wallTimeMs: { readonly mean: number | null; readonly total: number | null };
}

export interface ScorecardDifference {
  readonly gatePassRate: number | null;
  readonly firstAttemptPassRate: number | null;
  readonly meanAttempts: number | null;
  readonly overBudget: number;
  readonly meanTokens: number | null;
  readonly meanCostUsd: number | null;
  readonly meanWallTimeMs: number | null;
}

export interface Scorecard {
  readonly baseline: VariantScore;
  readonly candidate: VariantScore;
  readonly difference: ScorecardDifference;
  readonly perCase: readonly {
    readonly caseId: string;
    readonly name: string;
    readonly baseline: VariantScore;
    readonly candidate: VariantScore;
    readonly difference: ScorecardDifference;
  }[];
  readonly fewRepeats: boolean;
}

export interface ScoredTrial {
  readonly caseId: string;
  readonly caseName: string;
  readonly variant: 'baseline' | 'candidate';
  readonly status: EvalTrialStatus;
  readonly score: TrialScore | null;
}

function scoreVariant(trials: readonly ScoredTrial[]): VariantScore {
  const completed = trials.filter((t) => (t.status === 'passed' || t.status === 'failed') && t.score !== null);
  const blocked = trials.filter((t) => t.status === 'blocked').length;
  const failed = trials.filter((t) => t.status === 'failed').length;
  const scores = completed.map((t) => t.score as TrialScore);

  const gatePasses = scores.filter((s) => s.gatePassed).length;
  const firstAttemptPasses = scores.filter((s) => s.firstAttemptPassed).length;

  const criteriaRows = scores.map((s) => s.criteria).filter((c): c is CriteriaCounts => c !== null);
  const criteria = criteriaRows.length === 0
    ? null
    : criteriaRows.reduce(
      (sum, c) => ({ verified: sum.verified + c.verified, failed: sum.failed + c.failed, unverified: sum.unverified + c.unverified }),
      { verified: 0, failed: 0, unverified: 0 },
    );

  const overBudget = scores.reduce((sum, s) => sum + s.overBudget, 0);

  const tokenTotals = scores.map((s) =>
    s.inputTokens === null || s.outputTokens === null ? null : s.inputTokens + s.outputTokens);
  const tokensTotal = sumOrNullIfAnyNull(tokenTotals);
  const costTotal = sumOrNullIfAnyNull(scores.map((s) => s.costUsd));
  const wallTimeTotal = sumOrNullIfAnyNull(scores.map((s) => s.wallTimeMs));

  return {
    trials: { completed: completed.length, blocked, failed },
    gatePassRate: rate(gatePasses, completed.length),
    firstAttemptPassRate: rate(firstAttemptPasses, completed.length),
    criteria,
    meanAttempts: mean(scores.map((s) => s.attempts)),
    overBudget,
    tokens: { total: tokensTotal, mean: tokensTotal === null ? null : rate(tokensTotal, completed.length) },
    costUsd: { total: costTotal, mean: costTotal === null ? null : rate(costTotal, completed.length) },
    wallTimeMs: { total: wallTimeTotal, mean: wallTimeTotal === null ? null : rate(wallTimeTotal, completed.length) },
  };
}

function diff(candidate: number | null, baseline: number | null): number | null {
  return candidate === null || baseline === null ? null : candidate - baseline;
}

function differenceOf(baseline: VariantScore, candidate: VariantScore): ScorecardDifference {
  return {
    gatePassRate: diff(candidate.gatePassRate, baseline.gatePassRate),
    firstAttemptPassRate: diff(candidate.firstAttemptPassRate, baseline.firstAttemptPassRate),
    meanAttempts: diff(candidate.meanAttempts, baseline.meanAttempts),
    overBudget: candidate.overBudget - baseline.overBudget,
    meanTokens: diff(candidate.tokens.mean, baseline.tokens.mean),
    meanCostUsd: diff(candidate.costUsd.mean, baseline.costUsd.mean),
    meanWallTimeMs: diff(candidate.wallTimeMs.mean, baseline.wallTimeMs.mean),
  };
}

export function scoreEvalRun(trials: readonly ScoredTrial[], repeats: number): Scorecard {
  const baselineTrials = trials.filter((t) => t.variant === 'baseline');
  const candidateTrials = trials.filter((t) => t.variant === 'candidate');
  const baseline = scoreVariant(baselineTrials);
  const candidate = scoreVariant(candidateTrials);

  const casesInOrder: { readonly caseId: string; readonly name: string }[] = [];
  const seen = new Set<string>();
  for (const t of trials) {
    if (!seen.has(t.caseId)) {
      seen.add(t.caseId);
      casesInOrder.push({ caseId: t.caseId, name: t.caseName });
    }
  }

  const perCase = casesInOrder.map(({ caseId, name }) => {
    const caseBaseline = scoreVariant(baselineTrials.filter((t) => t.caseId === caseId));
    const caseCandidate = scoreVariant(candidateTrials.filter((t) => t.caseId === caseId));
    return {
      caseId,
      name,
      baseline: caseBaseline,
      candidate: caseCandidate,
      difference: differenceOf(caseBaseline, caseCandidate),
    };
  });

  return {
    baseline,
    candidate,
    difference: differenceOf(baseline, candidate),
    perCase,
    fewRepeats: repeats < 3,
  };
}
