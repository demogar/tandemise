import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { RoleTemplate, RunUsage, RuntimeProfile, Workspace } from '@tandemise/domain';
import { errorMessage, ids } from '@tandemise/shared';
import type { ReflectorDeps } from './reflector.js';

export const PROMOTER_WALL_TIME_MS = 300_000;

export const promoterOutputSchema = z.object({
  files: z.array(z.object({ path: z.string().trim().min(1).max(300), content: z.string().max(200_000) })).min(1).max(10),
});
export type PromoterOutput = z.infer<typeof promoterOutputSchema>;

export interface PromoterInput {
  readonly lessons: readonly { readonly id: string; readonly text: string; readonly helpful: number; readonly harmful: number; readonly missions: readonly string[]; readonly tracker: string | null }[];
  /** The files it may change, with their current text ('' for a new file). Never anything under evals/. */
  readonly targets: readonly { readonly path: string; readonly text: string }[];
}

export function buildPromoterPrompt(input: PromoterInput): string {
  return [
    "You turn lessons that keep proving useful into curated rules in a software team's shared brain.",
    'You rewrite only the files listed under Targets, and return each one whole. Keep what is there; add the',
    'lessons as short, plain rules in the style of the file. Do not invent rules the lessons do not support.',
    '',
    'Lessons (with how often they helped, the missions they came from, and their tracker keys):',
    ...input.lessons.map((l) => `- [${l.id}] ${l.text} (helpful ${l.helpful}, harmful ${l.harmful}; missions: ${l.missions.join(', ') || 'none'}${l.tracker ? `; ${l.tracker}` : ''})`),
    '',
    'Targets:',
    ...input.targets.flatMap((t) => [`<target path="${t.path}">`, t.text === '' ? '(a new file)' : t.text, '</target>']),
    '',
    'Reply with one fenced json block and nothing after it:',
    '```json',
    '{ "files": [{ "path": "<one of the target paths>", "content": "<the whole new file>" }] }',
    '```',
  ].join('\n');
}

export function parsePromoterReply(text: string): { output: PromoterOutput } | { problem: string } {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const raw = blocks.at(-1)?.[1];
  if (raw === undefined) return { problem: 'The promoter replied without a JSON block.' };
  try {
    const parsed = promoterOutputSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { output: parsed.data } : { problem: `The promoter's reply doesn't fit: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  } catch {
    return { problem: "The promoter's JSON block isn't valid JSON." };
  }
}

export interface PromoterPassResult {
  readonly passId: string;
  readonly profileId: string | null;
  readonly model: string | null;
  readonly usage: RunUsage | null;
  readonly result: { output: PromoterOutput } | { problem: string };
}

/**
 * The promoter pass (#51 spec §8): drafts the new text of the target files,
 * on the role's model, in an empty directory with no grants. It never sees
 * `evals/`; classification and evals are decided by code afterwards.
 */
export async function promote(deps: ReflectorDeps, ctx: { workspace: Workspace; role: RoleTemplate | undefined }, input: PromoterInput): Promise<PromoterPassResult> {
  const passId = `bps_${ids.run().slice(4)}`;
  const model = ctx.role?.models?.model ?? null;
  const all = deps.runtimeProfiles.list(ctx.workspace.id).filter((p) => p.enabled);
  const routed = ctx.role === undefined ? [] : ctx.workspace.routing[ctx.role.id] ?? [];
  const candidates: RuntimeProfile[] = routed.length === 0 ? all : routed.flatMap((id) => all.filter((p) => p.id === id));
  if (candidates.length === 0) return { passId, profileId: null, model, usage: null, result: { problem: 'No runtime is enabled to draft the rule.' } };
  const selected = await deps.runtimeManager.select(candidates, ['reasoning']);
  if (!selected.ok) return { passId, profileId: null, model, usage: null, result: { problem: 'No runtime was free to draft the rule.' } };
  const { profile, reservation } = selected.value;
  const dir = join(deps.paths.workspace(ctx.workspace.id), 'brain-passes', passId);
  const prompt = buildPromoterPrompt(input);
  const chunks: string[] = [];
  let usage: RunUsage | null = null;
  let failure: string | null = null;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'prompt.md'), prompt, 'utf8');
    for await (const event of deps.runtimeManager.start({
      runId: ids.run(), profile, prompt, workingDirectory: dir, grants: [], allowedRoots: [], mcpConfigPath: null,
      maxWallTimeMs: PROMOTER_WALL_TIME_MS, reservation, signal: AbortSignal.timeout(PROMOTER_WALL_TIME_MS), model,
      log: deps.log.child({ passId, runtime: profile.adapterId }),
    })) {
      if (event.type === 'message') chunks.push(event.text);
      if (event.type === 'usage') usage = { ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }), ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }), costUsd: event.costUsd ?? null };
      if (event.type === 'failed') failure = `${event.code}: ${event.message}`;
    }
  } catch (e) {
    failure = errorMessage(e);
  }
  if (failure !== null) return { passId, profileId: profile.id, model, usage, result: { problem: `The promoter failed: ${failure}` } };
  return { passId, profileId: profile.id, model, usage, result: parsePromoterReply(chunks.at(-1) ?? '') };
}
