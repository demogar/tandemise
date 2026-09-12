import { z } from 'zod';
import type { MissionPlan, PlannedTask } from '@tandemise/domain';
import { ARTIFACT_TYPES, DEFAULT_RETRY_POLICY, ISOLATION_MODES, NO_APPROVAL } from '@tandemise/domain';
import { Err, Ok, type Result } from '@tandemise/shared';
import { extractPlanJson } from './prompt.js';

const DEFAULT_WALL_TIME_MS = 25 * 60_000;

/**
 * Parses a planner's response into a `MissionPlan`.
 *
 * Two layers, and the split matters. This one answers "is it the right
 * *shape*?" - types, enums, required fields - and is permissive about anything
 * that has a safe default, because rejecting a plan because the model omitted
 * `backoffMs` would waste an entire planning round on nothing. The second layer
 * is `validateMissionPlan`, which answers "is it a *coherent plan*?" - acyclic,
 * every required input produced upstream, every role real. Only the second can
 * be fixed by the planner thinking harder, which is why only its issues are
 * worth feeding back into a retry.
 *
 * Unknown keys are stripped rather than rejected: a model that adds
 * `"rationale"` to a task has not made a mistake worth failing a mission over.
 */
const artifactType = z.enum(ARTIFACT_TYPES);

const plannedTask = z.object({
  key: z.string().trim().min(1),
  title: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  roleId: z.string().trim().min(1),
  dependsOn: z.array(z.string().trim().min(1)).default([]),
  requiredCapabilities: z.array(z.string().trim().min(1)).default([]),
  inputArtifacts: z
    .array(z.object({ type: artifactType, required: z.boolean().default(true) }))
    .default([]),
  expectedOutputs: z.array(artifactType).default([]),
  executionPolicy: z
    .object({
      isolation: z.enum(ISOLATION_MODES).default('none'),
      maxWallTimeMs: z.number().int().positive().default(DEFAULT_WALL_TIME_MS),
      capabilities: z.array(z.string().trim().min(1)).default([]),
    })
    .default({ isolation: 'none', maxWallTimeMs: DEFAULT_WALL_TIME_MS, capabilities: [] }),
  approvalPolicy: z
    .object({
      beforeStart: z.boolean().default(false),
      onCompletion: z.boolean().default(false),
      reason: z.string().trim().min(1).optional(),
    })
    .default(NO_APPROVAL),
  retryPolicy: z
    .object({
      maxAttempts: z.number().int().min(1).max(10).default(DEFAULT_RETRY_POLICY.maxAttempts),
      backoffMs: z.number().int().min(0).max(600_000).default(DEFAULT_RETRY_POLICY.backoffMs),
      onExhausted: z.enum(['block', 'fail']).default(DEFAULT_RETRY_POLICY.onExhausted),
    })
    .default(DEFAULT_RETRY_POLICY),
  completionGate: z.string().trim().min(1).nullable().default(null),
});

const missionPlan = z.object({
  summary: z.string().trim().default(''),
  tasks: z.array(plannedTask).min(1, 'a plan needs at least one task'),
});

export function parsePlanResponse(response: string): Result<MissionPlan, readonly string[]> {
  const json = extractPlanJson(response);
  if (json === null) {
    return Err(['The planner returned no JSON object. A plan must be a single JSON object.']);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return Err([`The planner's JSON did not parse: ${e instanceof Error ? e.message : String(e)}`]);
  }

  const parsed = missionPlan.safeParse(raw);
  if (!parsed.success) {
    return Err(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return Ok({
    summary: parsed.data.summary,
    tasks: parsed.data.tasks as readonly PlannedTask[],
  });
}
