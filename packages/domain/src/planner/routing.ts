import { z } from 'zod';
import { MAX_LADDER, modelProblem } from '../entities/models.js';
import { STEP_CLASSES } from './types.js';

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
