import { z } from 'zod';
import { lintRule } from '../gate-lint.js';

/**
 * `merge.yaml` (#53 §8.3): when Tandemise may merge a pull request on its own.
 * A merge policy is never partially loaded: any rule that can't be read makes
 * the whole file `{ error }`, and an unreadable policy asks for every PR.
 */
const onOff = z.preprocess((v) => (v === true ? 'on' : v === false ? 'off' : v), z.enum(['on', 'off']));
const text = z.string().trim().min(1);

const neverRule = z.union([
  z.object({ paths: z.array(text).min(1) }).strict(),
  z.object({ areas: z.array(text).min(1) }).strict(),
  z.object({ when: text }).strict(),
]);

const scoreRule = z.object({ when: text, points: z.number().int().min(-10).max(100), why: text });

export const mergePolicySchema = z.object({
  version: z.literal(1).default(1),
  autoMerge: onOff.default('off'),
  method: z.enum(['squash', 'merge', 'rebase']).default('squash'),
  reviewers: z.array(text).default([]),
  tests: z.array(text).default([]),
  never: z.array(neverRule).default([]),
  requires: z.array(text).default([]),
  score: z.array(scoreRule).default([]),
  autoMergeAtMost: z.number().int().min(0).max(1000).default(2),
  revertAutoMerge: onOff.default('on'),
});

export type MergePolicy = z.infer<typeof mergePolicySchema>;
export type NeverRule = MergePolicy['never'][number];
export type ScoreRule = MergePolicy['score'][number];
export type MergePolicyOrError = MergePolicy | { readonly error: string };

export function isPolicyError(p: MergePolicyOrError): p is { readonly error: string } {
  return 'error' in p;
}

export function parseMergePolicy(raw: unknown): MergePolicyOrError {
  if (raw === null || raw === undefined) return { error: 'the file is empty' };
  const parsed = mergePolicySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: `${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}` };
  }
  const rules = [
    ...parsed.data.requires.map((r, i) => [`requires.${i}`, r] as const),
    ...parsed.data.score.map((r, i) => [`score.${i}.when`, r.when] as const),
    ...parsed.data.never.flatMap((r, i) => ('when' in r ? [[`never.${i}.when`, r.when] as const] : [])),
  ];
  for (const [path, rule] of rules) {
    const problem = lintRule(rule, 'ship')[0];
    if (problem !== undefined) return { error: `${path}: ${problem.message}` };
  }
  return parsed.data;
}
