import type { Mission, Repository, RoleTemplate, MissionPlan } from '@tandemise/domain';
import { ARTIFACT_TYPES } from '@tandemise/domain';
import type { WorkflowPreset } from './presets.js';

/**
 * The planner prompt.
 *
 * The planner is the one place where a model is asked to design organizational
 * structure, so the prompt is written to constrain that tightly: it hands over a
 * known-good preset as the starting point, enumerates the exact vocabulary that
 * will validate, and states the structural rules that `validateMissionPlan`
 * enforces. A planner that invents a role name or an artifact type produces a
 * plan that is rejected wholesale (MVP.md §9.3) - so it is worth spending words
 * here to make that outcome rare.
 */

export interface PlannerPromptInput {
  readonly mission: Mission;
  readonly repository: Repository | null;
  readonly roles: readonly RoleTemplate[];
  readonly preset: WorkflowPreset;
  readonly availableCapabilities: readonly string[];
  readonly repositoryContext: string | null;
}

export function buildPlannerPrompt(input: PlannerPromptInput): string {
  const { mission, repository, roles, preset, availableCapabilities, repositoryContext } = input;

  const roleCatalogue = roles
    .map((r) => [
      `- id: ${r.id} — ${r.name}`,
      `  responsibility: ${r.summary}`,
      `  produces: ${r.producesArtifacts.join(', ') || 'nothing'}`,
      `  consumes: ${r.consumesArtifacts.join(', ') || 'nothing'}`,
      `  default isolation: ${r.defaultIsolation}`,
    ].join('\n'))
    .join('\n');

  const presetPlan = preset.build();

  return `You are the Planner for Tandemise, an orchestration system that runs software
missions across multiple AI workers. You do not implement anything. You produce
one thing: a mission plan, as JSON.

# The mission

Goal (the user's own words):
${fence(mission.goal)}

${mission.constraints.length > 0 ? `Constraints:\n${mission.constraints.map((c) => `- ${c}`).join('\n')}\n` : ''}${
    mission.successCriteria.length > 0
      ? `Stated success criteria:\n${mission.successCriteria.map((c) => `- ${c}`).join('\n')}\n`
      : ''
  }
Repository: ${repository ? `${repository.name} at ${repository.path} (default branch ${repository.defaultBranch})` : 'none selected — plan tasks that do not require a repository'}
Autonomy level: ${mission.autonomy}

${repositoryContext ? `# What the repository looks like\n\n${repositoryContext}\n` : ''}
# Roles you may assign work to

You may ONLY use these role ids. Inventing a role causes the plan to be rejected.

${roleCatalogue}

# Artifact types

You may ONLY use these artifact type names:

${ARTIFACT_TYPES.join(', ')}

# Capabilities

A task may only require capabilities this installation can actually satisfy:

${availableCapabilities.join(', ')}

# The starting shape

The "${preset.name}" preset is a known-good plan for this kind of work. Start
from it and adapt it to THIS mission. Adaptation is expected and encouraged:

- Drop a phase that this mission genuinely does not need. A backend refactor
  with no user-visible surface does not need a design phase; say so by omitting
  it rather than creating a token task.
- Split implementation into several parallel tasks when the work is genuinely
  independent. Parallel tasks each get their own isolated worktree, so they must
  not touch the same files. If they would, keep them sequential.
- Add a task the preset lacks if this mission needs it (a data migration, a
  spike to answer an open question before committing to an approach).
- Do not add phases for the sake of looking thorough. Every task costs the user
  wall-clock time and model usage.

The preset, for reference:

${fence(JSON.stringify(presetPlan, null, 2), 'json')}

# Structural rules — a plan violating any of these is rejected outright

1. \`key\` is lowercase letters, digits and underscores, unique within the plan.
2. \`dependsOn\` references keys that exist in this plan. The graph must be acyclic.
3. If a task lists an input artifact with \`required: true\`, some **transitive
   dependency** of that task must list that artifact in its \`expectedOutputs\`.
   Producing it elsewhere in the plan is not sufficient — it must be upstream.
4. \`roleId\` must be one of the role ids above.
5. Every artifact type must be from the list above, spelled exactly.
6. Any task that writes code must use \`executionPolicy.isolation: "worktree"\`.
7. \`completionGate\`, when present, is a boolean expression over measured facts.
   The available operators are \`&& || ! == != > >= < <=\` and parentheses.
   The facts you may reference:
   - \`artifact.<Type>.exists\` — boolean
   - \`checks.typecheck\`, \`checks.lint\`, \`checks.tests\`, \`checks.build\` — PASS | FAIL | SKIP
   - \`review.blocking_findings\` — number
   - \`review.verdict\` — pass | fail | needs_changes
   - \`qa.acceptance_criteria_coverage\` — number, 0-100
   - \`qa.blocking_defects\` — number
   Prefer \`checks.tests != FAIL\` over \`checks.tests == PASS\` when a repository
   may legitimately have no test command — \`!= FAIL\` tolerates SKIP.
8. \`retryPolicy.maxAttempts\` is at least 1. \`executionPolicy.maxWallTimeMs\` is
   positive; budget generously for implementation (30-45 minutes) and modestly
   for analysis (15-25 minutes).
9. Set \`approvalPolicy.onCompletion: true\` for any task whose output authorizes
   a consequential action — a release candidate always does.

# Writing good objectives

Each task's \`objective\` is handed to a worker that has no memory of this
planning step. Write it as a direct instruction naming the concrete outcome, not
as a topic. "Implement the ImplementationPlan's steps 1-4 in the onboarding
components, add tests for the reduced-step flow, and run the repository checks"
is usable. "Work on onboarding" is not.

# Output

Return ONLY a JSON object, with no prose before or after it and no markdown
fence, matching:

{
  "summary": "one or two sentences describing the shape of this plan and why",
  "tasks": [
    {
      "key": "product_spec",
      "title": "short imperative title",
      "objective": "the direct instruction for the worker",
      "roleId": "product",
      "dependsOn": [],
      "requiredCapabilities": ["repository.read", "filesystem.read", "artifact.write"],
      "inputArtifacts": [{ "type": "ProductSpec", "required": true }],
      "expectedOutputs": ["ProductSpec"],
      "executionPolicy": { "isolation": "none", "maxWallTimeMs": 1200000, "capabilities": ["repository.read"] },
      "approvalPolicy": { "beforeStart": false, "onCompletion": false },
      "retryPolicy": { "maxAttempts": 2, "backoffMs": 5000, "onExhausted": "block" },
      "completionGate": null
    }
  ]
}`;
}

function fence(content: string, lang = ''): string {
  // Four backticks so a body that itself contains a fenced block stays intact.
  return `\`\`\`\`${lang}\n${content}\n\`\`\`\``;
}

/**
 * Extracts the plan object from a model response.
 *
 * Models wrap JSON in prose or a fence often enough that failing the whole
 * planning step over it would be a bad trade. This recovers the outermost
 * balanced JSON object and lets schema validation reject anything genuinely
 * malformed.
 */
export function extractPlanJson(response: string): string | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(response);
  const haystack = fenced?.[1] ?? response;

  const start = haystack.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < haystack.length; i++) {
    const ch = haystack[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return haystack.slice(start, i + 1);
  }
  return null;
}

/** Human-readable plan summary for the approval card and the mission header. */
export function describePlan(plan: MissionPlan): string {
  const byRole = new Map<string, number>();
  for (const t of plan.tasks) byRole.set(t.roleId, (byRole.get(t.roleId) ?? 0) + 1);
  const roles = [...byRole.entries()].map(([role, n]) => (n > 1 ? `${role} ×${n}` : role)).join(' → ');
  return `${plan.tasks.length} tasks: ${roles}`;
}
