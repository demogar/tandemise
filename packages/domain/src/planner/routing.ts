import { z } from 'zod';
import { MAX_LADDER, modelProblem } from '../entities/models.js';
import { STEP_CLASSES, type RiskLevel, type StepClass } from './types.js';
import type { OutcomeStats } from '../brain/outcomes.js';

/**
 * `routing.yaml` (#53 §6.1): for each step class, the models the project
 * allows (cheapest first) and where a bucket with too little data starts.
 * The shipped default has no classes, so every step keeps its role's model
 * until the owner writes a ladder.
 */
const modelName = z.string().trim().min(1).superRefine((v, ctx) => {
  const problem = modelProblem(v);
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
});

const classRouting = z.object({
  ladder: z.array(modelName).min(1).max(MAX_LADDER),
  default: modelName,
  independentOf: z.string().trim().min(1).optional(),
}).superRefine((c, ctx) => {
  if (!c.ladder.includes(c.default)) ctx.addIssue({ code: 'custom', path: ['default'], message: `The default model ${c.default} is not on the ladder.` });
});

export const routingConfigSchema = z.object({
  version: z.literal(1).default(1),
  target: z.number().min(0).max(1).default(0.8),
  minSamples: z.number().int().min(1).max(10_000).default(8),
  probeEvery: z.number().int().min(0).max(1000).default(10),
  classes: z.record(z.enum(STEP_CLASSES), classRouting).default({}),
});

export type RoutingConfig = z.infer<typeof routingConfigSchema>;
export type ClassRouting = z.infer<typeof classRouting>;

export const EMPTY_ROUTING_CONFIG: RoutingConfig = routingConfigSchema.parse({});

/** A broken routing file routes nothing: every step keeps its role's model, and the problem is reported. */
export function parseRoutingConfig(raw: unknown): { readonly config: RoutingConfig; readonly problems: readonly { path: string; message: string }[] } {
  const parsed = routingConfigSchema.safeParse(raw ?? {});
  if (parsed.success) return { config: parsed.data, problems: [] };
  const issue = parsed.error.issues[0];
  return {
    config: EMPTY_ROUTING_CONFIG,
    problems: [{ path: issue?.path.join('.') || '(root)', message: `The routing file can't be read (${issue?.message ?? 'invalid'}), so every step uses its role's model.` }],
  };
}

// ------------------------------------------------------------ rung choice

/** 95% two-sided: the factory picks a model only when it is confidently good enough. */
export const WILSON_Z = 1.96;

/** Lower bound of the Wilson score interval for `successes` of `n`. 0 for no data. */
export function wilsonLowerBound(successes: number, n: number, z = WILSON_Z): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

export interface RungChoice {
  readonly model: string;
  readonly escalate: readonly string[];
  readonly reason: string;
  readonly probe: boolean;
}

const CLASS_WORDS: Readonly<Record<string, string>> = {
  implement: 'implement', review: 'review', verify: 'verify', spec: 'spec', design: 'design',
  architecture: 'architecture', investigate: 'investigate', resolve_conflicts: 'conflict', ship: 'ship',
};

/**
 * The starting rung for a step (#53 §6.2), within the ladder the owner wrote:
 * the class's default under `minSamples`; else the cheapest rung whose success
 * rate's Wilson lower bound clears `target`; else the best measured. A
 * low-risk task every `probeEvery`th tries one rung cheaper. Null when the
 * class has no ladder: the role's model applies.
 */
export function chooseRung(input: {
  readonly cls: StepClass;
  readonly bucket: string;
  readonly risk: RiskLevel;
  readonly config: RoutingConfig;
  readonly stats: Pick<OutcomeStats, 'buckets'>;
  readonly taskOrdinal: number;
}): RungChoice | null {
  const cls = input.config.classes[input.cls];
  if (cls === undefined) return null;
  const ladder = cls.ladder;
  const bucket = input.stats.buckets[input.bucket] ?? {};
  const rows = ladder.map((model) => ({ model, s: bucket[model] }));
  const most = Math.max(0, ...rows.map((r) => r.s?.n ?? 0));
  const above = (model: string) => ladder.slice(ladder.indexOf(model) + 1);
  const words = CLASS_WORDS[input.cls] ?? input.cls;
  let model: string;
  let reason: string;
  if (most < input.config.minSamples) {
    model = cls.default;
    reason = `default: only ${most} similar ${words} ${most === 1 ? 'step' : 'steps'} measured`;
  } else {
    const good = rows.find((r) => r.s !== undefined && wilsonLowerBound(r.s.success, r.s.n) >= input.config.target);
    if (good !== undefined) {
      model = good.model;
      reason = `routed: ${good.model} passed ${good.s!.success} of ${good.s!.n} similar ${words} steps first time`;
    } else {
      const measured = rows.filter((r) => r.s !== undefined && r.s.n > 0)
        .sort((a, b) => b.s!.success / b.s!.n - a.s!.success / a.s!.n || ladder.indexOf(a.model) - ladder.indexOf(b.model));
      const best = measured[0];
      model = best?.model ?? cls.default;
      reason = best === undefined ? `default: no similar ${words} steps measured`
        : `routed: ${best.model} did best, passing ${best.s!.success} of ${best.s!.n} similar ${words} steps first time`;
    }
  }
  const index = ladder.indexOf(model);
  if (input.risk === 'low' && input.config.probeEvery > 0 && input.taskOrdinal > 0 && input.taskOrdinal % input.config.probeEvery === 0 && index > 0) {
    const cheaper = ladder[index - 1]!;
    return { model: cheaper, escalate: above(cheaper), reason: `Trying ${cheaper}: it hasn't been measured on enough similar work`, probe: true };
  }
  return { model, escalate: above(model), reason, probe: false };
}
