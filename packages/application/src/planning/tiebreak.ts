import { z } from 'zod';
import { TASK_SIZES, TASK_TYPES, type ProfileInput, type TiebreakAnswer } from '@tandemise/domain';
import { errorMessage } from '@tandemise/shared';

/**
 * The cheap classifier pass (#53 §2). It runs only when the rules can't tell,
 * on the planner role's economy model, and its answer is a set of signals
 * picked from enumerated values: it fills gaps and breaks ties, and can never
 * lower risk below the sensitivity floor. If it fails, times out or answers
 * something invalid, planning goes on with the conservative default.
 */
export const TIEBREAK_TIMEOUT_MS = 30_000;

/** Runs one prompt on one model. The application binds a runtime-backed one. */
export interface TiebreakRunnerPort {
  run(request: { readonly prompt: string; readonly model: string | null; readonly signal: AbortSignal; readonly workspaceId?: string }): Promise<{
    readonly text: string;
    readonly costUsd: number | null;
    readonly model: string | null;
  }>;
}

const answerSchema = z.object({
  type: z.enum(TASK_TYPES),
  size: z.enum(TASK_SIZES),
  areas: z.array(z.string().trim().min(1)).max(20).default([]),
  why: z.string().trim().min(1).max(400),
});

export function tiebreakPrompt(input: ProfileInput, areaNames: readonly string[], repoNames: readonly string[]): string {
  return [
    'Classify one software task. Answer with only a JSON object, no prose:',
    `{"type": one of ${TASK_TYPES.map((t) => `"${t}"`).join(', ')}, "size": one of ${TASK_SIZES.map((s) => `"${s}"`).join(', ')}, "areas": [names from the list below that the task will touch], "why": "one short sentence"}`,
    '',
    'Sizes: xs is a line or two, s a small change in one place, m a few files, l a large or cross-cutting change.',
    `Areas: ${areaNames.length === 0 ? '(none)' : areaNames.join(', ')}`,
    `Repositories: ${repoNames.length === 0 ? '(one)' : repoNames.join(', ')}`,
    '',
    `Title: ${input.item.title}`,
    `Description: ${input.item.description}`,
    `Done-when lines: ${input.item.criteria}`,
  ].join('\n');
}

export async function runTiebreak(
  input: ProfileInput,
  runner: TiebreakRunnerPort,
  ctx: { readonly model: string | null; readonly areaNames: readonly string[]; readonly repoNames: readonly string[]; readonly workspaceId?: string },
): Promise<{ answer: TiebreakAnswer | null; error: string | null; costUsd: number | null; model: string | null }> {
  try {
    const reply = await runner.run({
      prompt: tiebreakPrompt(input, ctx.areaNames, ctx.repoNames), model: ctx.model, signal: AbortSignal.timeout(TIEBREAK_TIMEOUT_MS),
      ...(ctx.workspaceId === undefined ? {} : { workspaceId: ctx.workspaceId }),
    });
    const json = /\{[\s\S]*\}/.exec(reply.text)?.[0];
    if (json === undefined) return { answer: null, error: 'it did not answer with JSON', costUsd: reply.costUsd, model: reply.model };
    let raw: unknown;
    try { raw = JSON.parse(json); } catch { return { answer: null, error: 'its JSON could not be read', costUsd: reply.costUsd, model: reply.model }; }
    const parsed = answerSchema.safeParse(raw);
    if (!parsed.success) return { answer: null, error: `its answer was not valid (${parsed.error.issues[0]?.message ?? 'invalid'})`, costUsd: reply.costUsd, model: reply.model };
    const known = new Set(ctx.areaNames.map((a) => a.toLowerCase()));
    return {
      answer: { ...parsed.data, areas: parsed.data.areas.filter((a) => known.has(a.toLowerCase())) },
      error: null,
      costUsd: reply.costUsd,
      model: reply.model,
    };
  } catch (e) {
    return { answer: null, error: `it failed (${errorMessage(e)})`, costUsd: null, model: ctx.model };
  }
}
