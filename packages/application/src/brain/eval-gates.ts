import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { EvalBlobPort, EvalCase, EvalRepositoryPort } from '@tandemise/domain';
import type { Scorecard } from '@tandemise/evaluation';
import type { Logger, WorkspaceId } from '@tandemise/shared';
import { asId, errorMessage, ids } from '@tandemise/shared';
import type { EvalService } from '../services/eval-service.js';
import type { Caller } from '../support/identity.js';

/**
 * Promotion evals (#51 spec §8): `evals/gates.yaml` names the P3b suites that
 * gate a promotion, and the rule a candidate must meet against the baseline.
 * The cases live in the brain's `evals/`, which no prompt, tool or worktree
 * ever exposes; the scorecard is computed by the daemon, never the proposer.
 */

export interface EvalGateSuite {
  readonly name: string;
  readonly repeats: number;
  readonly spendCapUsd: number;
}

export interface EvalGates {
  readonly suites: readonly EvalGateSuite[];
  /** Candidate cost may be at most this many times the baseline's. */
  readonly rule: { readonly maxCostFactor: number };
}

const gatesSchema = z.object({
  suites: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    repeats: z.number().int().min(1).max(5).default(1),
    spendCapUsd: z.number().positive(),
  })).default([]),
  rule: z.object({
    // `baseline` is the only value the gate-pass and criteria rules take; they are fixed.
    minGatePassRate: z.literal('baseline').optional(),
    maxCriteriaFailed: z.literal('baseline').optional(),
    maxCostFactor: z.number().positive().default(1.25),
  }).default({}),
});

export const NO_PROMOTION_EVALS: EvalGates = { suites: [], rule: { maxCostFactor: 1.25 } };

export function readEvalGates(text: string | null): EvalGates | { problem: string } {
  if (text === null || text.trim() === '') return NO_PROMOTION_EVALS;
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    return { problem: `evals/gates.yaml isn't valid YAML: ${errorMessage(e).split('\n')[0]}` };
  }
  const parsed = gatesSchema.safeParse(raw ?? {});
  if (!parsed.success) return { problem: `evals/gates.yaml: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`.trim() };
  return { suites: parsed.data.suites, rule: { maxCostFactor: parsed.data.rule.maxCostFactor } };
}

const pct = (n: number | null): string => (n === null ? 'not measured' : `${Math.round(n * 100)}%`);
const usd = (n: number | null): string => (n === null ? 'not measured' : `$${n.toFixed(2)}`);

/**
 * Passes when the candidate's gate pass rate is at least the baseline's, it
 * fails no more criteria, and its mean cost is at most the baseline's times
 * the factor. The P3b scorecard reports a mean, not a median, so the mean
 * stands in for spec §8's median. A null on either side fails: unmeasured is
 * never a pass.
 */
export function promotionVerdict(scorecard: Pick<Scorecard, 'baseline' | 'candidate'>, rule: EvalGates['rule']): { passed: boolean; lines: string[] } {
  const b = scorecard.baseline;
  const c = scorecard.candidate;
  const lines: string[] = [];
  const passRate = b.gatePassRate !== null && c.gatePassRate !== null && c.gatePassRate >= b.gatePassRate;
  lines.push(`gate pass rate ${pct(c.gatePassRate)} vs ${pct(b.gatePassRate)}${passRate ? '' : ' (fails)'}`);
  const criteria = b.criteria !== null && c.criteria !== null && c.criteria.failed <= b.criteria.failed;
  lines.push(`criteria failed ${c.criteria?.failed ?? 'not measured'} vs ${b.criteria?.failed ?? 'not measured'}${criteria ? '' : ' (fails)'}`);
  const cost = b.costUsd.mean !== null && c.costUsd.mean !== null && c.costUsd.mean <= b.costUsd.mean * rule.maxCostFactor;
  lines.push(`mean cost ${usd(c.costUsd.mean)} vs ${usd(b.costUsd.mean)} × ${rule.maxCostFactor}${cost ? '' : ' (fails)'}`);
  return { passed: passRate && criteria && cost, lines };
}

/** Runs a promotion's suites against a brain candidate; one result per suite. */
export interface PromotionEvalPort {
  run(workspaceId: WorkspaceId, suites: readonly EvalGateSuite[], ref: string): Promise<readonly { suite: string; scorecard: Scorecard | null; problem: string | null }[]>;
}

/** How long a promotion waits for its evals before calling them not finished. */
const EVAL_WAIT_MS = 60 * 60_000;
const EVAL_POLL_MS = 2_000;

export interface ServiceEvalDeps {
  readonly evals: () => Pick<EvalService, 'createSuite' | 'listSuites' | 'startRun' | 'getRun'>;
  readonly repo: Pick<EvalRepositoryPort, 'listCases' | 'insertCase'>;
  readonly blobs: Pick<EvalBlobPort, 'put'>;
  /** Files under the brain's `evals/` at a commit: the only reader of that folder. */
  readonly readEvals: (workspaceId: WorkspaceId, ref: string) => Promise<Readonly<Record<string, string>>>;
  readonly caller: () => Caller;
  readonly log: Logger;
}

/**
 * The real eval port: imports the brain's cases into a local suite named
 * `Brain: <name>`, starts a P3b run with the `brain` candidate and waits for
 * its scorecard.
 */
export class ServiceEvalPort implements PromotionEvalPort {
  constructor(private readonly deps: ServiceEvalDeps) {}

  async run(workspaceId: WorkspaceId, suites: readonly EvalGateSuite[], ref: string): Promise<readonly { suite: string; scorecard: Scorecard | null; problem: string | null }[]> {
    const out: { suite: string; scorecard: Scorecard | null; problem: string | null }[] = [];
    let files: Readonly<Record<string, string>>;
    try {
      files = await this.deps.readEvals(workspaceId, ref);
    } catch (e) {
      return suites.map((s) => ({ suite: s.name, scorecard: null, problem: errorMessage(e) }));
    }
    for (const suite of suites) {
      try {
        const suiteId = await this.#importBrainCases(workspaceId, suite.name, files);
        const run = await this.deps.evals().startRun(suiteId, this.deps.caller(), { candidate: { kind: 'brain', ref }, repeats: suite.repeats, spendCapUsd: suite.spendCapUsd });
        const until = Date.now() + EVAL_WAIT_MS;
        let scorecard: Scorecard | null = null;
        let status: string = run.status;
        while (Date.now() < until) {
          const detail = this.deps.evals().getRun(run.id).run;
          status = detail.status;
          if (status !== 'queued' && status !== 'running') { scorecard = (detail.scorecard as Scorecard | null) ?? null; break; }
          await new Promise((r) => setTimeout(r, EVAL_POLL_MS));
        }
        out.push({ suite: suite.name, scorecard, problem: scorecard === null ? `The ${suite.name} evals ended ${status} without a scorecard.` : null });
      } catch (e) {
        out.push({ suite: suite.name, scorecard: null, problem: errorMessage(e) });
      }
    }
    return out;
  }

  /** Upserts the local suite `Brain: <name>` and its cases from `evals/cases/*\/case.json`, blobs into the store. */
  async #importBrainCases(workspaceId: WorkspaceId, name: string, files: Readonly<Record<string, string>>): Promise<import('@tandemise/shared').EvalSuiteId> {
    const title = `Brain: ${name}`;
    const evals = this.deps.evals();
    const suite = evals.listSuites(workspaceId).find((s) => s.name === title) ?? evals.createSuite(workspaceId, this.deps.caller(), title);
    for (const [path, text] of Object.entries(files)) {
      if (path.startsWith('evals/blobs/')) await this.deps.blobs.put(new Uint8Array(Buffer.from(text, 'utf8')));
    }
    const have = new Set(this.deps.repo.listCases(suite.id).map((c) => c.name));
    for (const [path, text] of Object.entries(files)) {
      if (!/^evals\/cases\/[^/]+\/case\.json$/.test(path)) continue;
      try {
        const raw = JSON.parse(text) as Partial<EvalCase> & { suite?: string };
        if (raw.suite !== undefined && raw.suite !== name) continue;
        const caseName = raw.name ?? path.split('/')[2] ?? 'case';
        if (have.has(caseName) || raw.snapshot === undefined || raw.provenance === undefined) continue;
        this.deps.repo.insertCase({
          id: ids.evalCase(), suiteId: suite.id, name: caseName, snapshot: raw.snapshot, provenance: raw.provenance,
          createdBy: null, createdAt: new Date().toISOString(),
        });
        have.add(caseName);
      } catch (e) {
        this.deps.log.warn('brain.eval_case_unreadable', { path, error: errorMessage(e) });
      }
    }
    return asId<'EvalSuiteId'>(suite.id);
  }
}
