import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { RoleTemplate, RunUsage, RuntimeProfile, RuntimeProfileRepositoryPort, Workspace } from '@tandemise/domain';
import { ENTRY_MAX_CHARS } from '@tandemise/domain';
import type { RuntimeManager } from '@tandemise/runtimes-core';
import type { Clock, Logger, TandemisePaths } from '@tandemise/shared';
import { errorMessage, ids } from '@tandemise/shared';

/** At most this many new lessons from one signal: a reflector with more is summarising, not learning. */
export const REFLECTOR_MAX_LESSONS = 3;
/** Evidence is capped so a large diff can't crowd out the question. */
export const REFLECTOR_EVIDENCE_CHARS = 20_000;
/** A hold longer than this is a signal even when nothing changed: someone had to look closely. */
export const HOLD_LONG_MS = 120_000;
/** A reflector pass is short; one that runs longer than this is abandoned. */
export const REFLECTOR_WALL_TIME_MS = 120_000;

export type ReflectorSignal = 'hold' | 'rejection' | 'gate';

export interface ReflectorInput {
  readonly objective: string;
  readonly roleName: string;
  readonly signal: ReflectorSignal;
  readonly evidence: string;
  /** The brain entries the run loaded; the only part of the brain the reflector sees. */
  readonly loaded: readonly { readonly id: string; readonly text: string }[];
}

const scope = z.object({
  repo: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  step: z.string().min(1).optional(),
  paths: z.array(z.string().min(1)).max(10).optional(),
}).strip();

export const reflectorOutputSchema = z.object({
  lessons: z.array(z.object({ text: z.string().trim().min(3).max(ENTRY_MAX_CHARS), scope: scope.default({}) })).max(REFLECTOR_MAX_LESSONS).default([]),
  tags: z.array(z.object({ id: z.string().min(1), tag: z.enum(['helpful', 'harmful', 'unused']) })).max(100).default([]),
});
export type ReflectorOutput = z.infer<typeof reflectorOutputSchema>;

const SIGNAL_WORDS: Readonly<Record<ReflectorSignal, string>> = {
  hold: 'A person took over this step from the agent and changed the work by hand. The diff below is what they changed.',
  rejection: 'A person asked for changes to this step. Their notes are below.',
  gate: "This step's completion gate failed, then a later attempt passed. The failure and the fix are below.",
};

export function buildReflectorPrompt(input: ReflectorInput): string {
  const evidence = input.evidence.length > REFLECTOR_EVIDENCE_CHARS
    ? `${input.evidence.slice(0, REFLECTOR_EVIDENCE_CHARS)}\n…(evidence truncated)`
    : input.evidence;
  return [
    'You are the reflector for a software team\'s shared memory. You look at one correction and decide what, if anything, the',
    'next agent doing this kind of work should do differently. You do not edit anything.',
    '',
    `Role: ${input.roleName}`,
    `Objective of the step: ${input.objective}`,
    '',
    `What happened: ${SIGNAL_WORDS[input.signal]}`,
    '',
    '<evidence>',
    evidence,
    '</evidence>',
    '',
    'Lessons the agent was given before it ran (tag each one):',
    ...(input.loaded.length === 0 ? ['(none)'] : input.loaded.map((l) => `- [${l.id}] ${l.text}`)),
    '',
    'Reply with one fenced json block and nothing after it:',
    '```json',
    '{ "lessons": [{ "text": "one short, atomic sentence", "scope": { "role": "<role id>", "step": "<step key>", "repo": "<repo>", "paths": ["src/**"] } }],',
    '  "tags": [{ "id": "<loaded lesson id>", "tag": "helpful | harmful | unused" }] }',
    '```',
    `At most ${REFLECTOR_MAX_LESSONS} lessons, each under ${ENTRY_MAX_CHARS} characters. Scope fields are optional; leave out what does not apply.`,
    'No lesson is fine when the correction teaches nothing new. Never include secrets or file paths outside the repository.',
  ].join('\n');
}

/** The last fenced block of the reply, parsed and validated; null when there is none or it is invalid. */
export function parseReflectorReply(text: string): { output: ReflectorOutput } | { problem: string } {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const raw = blocks.at(-1)?.[1];
  if (raw === undefined) return { problem: 'The reflector replied without a JSON block.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { problem: "The reflector's JSON block isn't valid JSON." };
  }
  const result = reflectorOutputSchema.safeParse(parsed);
  if (!result.success) return { problem: `The reflector's reply doesn't fit: ${result.error.issues[0]?.message ?? 'invalid'}` };
  return { output: result.data };
}

export interface ReflectorDeps {
  readonly runtimeManager: Pick<RuntimeManager, 'select' | 'start'>;
  readonly runtimeProfiles: Pick<RuntimeProfileRepositoryPort, 'list'>;
  readonly paths: TandemisePaths;
  readonly clock: Clock;
  readonly log: Logger;
}

export interface ReflectorPassResult {
  readonly passId: string;
  readonly profileId: string | null;
  readonly model: string | null;
  readonly usage: RunUsage | null;
  readonly result: { output: ReflectorOutput } | { problem: string };
}

/**
 * One model pass (#51 spec §6): on the role's economy model, in an empty
 * directory that is never the clone or a worktree, with no grants and no
 * tools. Never throws: a failure comes back as a problem.
 */
export async function reflect(deps: ReflectorDeps, ctx: { workspace: Workspace; role: RoleTemplate }, input: ReflectorInput): Promise<ReflectorPassResult> {
  const passId = `bps_${ids.run().slice(4)}`;
  const model = ctx.role.models?.economyModel ?? ctx.role.models?.model ?? null;
  const all = deps.runtimeProfiles.list(ctx.workspace.id).filter((p) => p.enabled);
  const routed = ctx.workspace.routing[ctx.role.id] ?? [];
  const candidates: RuntimeProfile[] = routed.length === 0 ? all : routed.flatMap((id) => all.filter((p) => p.id === id));
  if (candidates.length === 0) return { passId, profileId: null, model, usage: null, result: { problem: 'No runtime is enabled to reflect on this.' } };
  const selected = await deps.runtimeManager.select(candidates, ['reasoning']);
  if (!selected.ok) return { passId, profileId: null, model, usage: null, result: { problem: 'No runtime was free to reflect on this.' } };
  const { profile, reservation } = selected.value;
  const dir = join(deps.paths.workspace(ctx.workspace.id), 'brain-passes', passId);
  const prompt = buildReflectorPrompt(input);
  const chunks: string[] = [];
  let usage: RunUsage | null = null;
  let failure: string | null = null;
  try {
    await mkdir(dir, { recursive: true });
    // Kept beside the pass, so what the reflector saw can be checked afterwards.
    await writeFile(join(dir, 'prompt.md'), prompt, 'utf8');
    for await (const event of deps.runtimeManager.start({
      runId: ids.run(), profile, prompt, workingDirectory: dir, grants: [], allowedRoots: [], mcpConfigPath: null,
      maxWallTimeMs: REFLECTOR_WALL_TIME_MS, reservation, signal: AbortSignal.timeout(REFLECTOR_WALL_TIME_MS), model,
      log: deps.log.child({ passId, runtime: profile.adapterId }),
    })) {
      if (event.type === 'message') chunks.push(event.text);
      if (event.type === 'usage') {
        usage = {
          ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
          ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }),
          costUsd: event.costUsd ?? null,
          ...(event.wallTimeMs === undefined ? {} : { wallTimeMs: event.wallTimeMs }),
        };
      }
      if (event.type === 'failed') failure = `${event.code}: ${event.message}`;
    }
  } catch (e) {
    failure = errorMessage(e);
  }
  if (failure !== null) return { passId, profileId: profile.id, model, usage, result: { problem: `The reflector failed: ${failure}` } };
  // The answer is the last message; earlier ones are the model thinking aloud.
  return { passId, profileId: profile.id, model, usage, result: parseReflectorReply(chunks.at(-1) ?? '') };
}
