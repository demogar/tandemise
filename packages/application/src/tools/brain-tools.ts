import { z } from 'zod';
import type { MissionRepositoryPort, RunRepositoryPort } from '@tandemise/domain';
import { CORE_CAPABILITIES, isTrialMission, isValidAt } from '@tandemise/domain';
import { defineTool, type IntegrationTool, type ToolContext, type ToolExecution } from '@tandemise/integrations-core';
import type { Clock } from '@tandemise/shared';
import type { BrainService } from '../brain/brain-service.js';

export const BRAIN_READ_TOOL = 'brain.read';
export const BRAIN_SEARCH_TOOL = 'brain.search';
export const BRAIN_PROPOSE_TOOL = 'brain.propose';
/** brain.search answers at most this many entries: enough to choose from, small enough to read. */
export const SEARCH_MAX = 20;
/** brain.propose per run: an agent with more to say than this is writing a report, not lessons. */
export const MAX_PROPOSALS_PER_RUN = 5;

export const UNKNOWN_LESSON = 'No lesson with that id in this brain.';
export const NO_BRAIN = "This project has no brain, so there's nothing to read.";
export const TOO_MANY_PROPOSALS = `You've proposed ${MAX_PROPOSALS_PER_RUN} lessons in this run; that's the limit.`;
export const NO_LESSONS_IN_TRIAL = "Lessons aren't saved during an eval trial.";

export interface BrainToolDeps {
  readonly brain: () => BrainService;
  readonly runs: Pick<RunRepositoryPort, 'get' | 'update'>;
  readonly missions: Pick<MissionRepositoryPort, 'get'>;
  readonly clock: Clock;
}

const scopeSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  role: z.string().trim().min(1).optional(),
  step: z.string().trim().min(1).optional(),
}).strict();

/**
 * The brain for agents, on demand (#51 spec §10): read one lesson, search the
 * lessons and history, or propose a lesson for a person to accept. Every read
 * is at the run's own brain commit, goes through `BrainService` (which refuses
 * `evals/`), takes no path and never shows the clone's location.
 */
export function createBrainTools(deps: BrainToolDeps): readonly IntegrationTool[] {
  const runOf = (ctx: ToolContext) => (ctx.runId === null ? undefined : deps.runs.get(ctx.runId));

  const read = defineTool({
    name: BRAIN_READ_TOOL,
    capability: CORE_CAPABILITIES.repositoryRead,
    risk: 'read',
    description: 'Read one lesson from the project brain by its id (the ids in "More lessons you can read with brain.read"), with its counters and history.',
    inputSchema: z.object({ id: z.string().trim().min(1).describe('The lesson id, as the prompt shows it in brackets.') }),
    async execute(ctx, input): Promise<ToolExecution<Record<string, unknown>>> {
      const run = runOf(ctx);
      if (run?.brain === null || run?.brain === undefined) return { output: { found: false, message: NO_BRAIN } };
      const memory = await deps.brain().memoryAt(ctx.assignment.workspaceId, run.brain.sha);
      const id = memory.aliases[input.id] ?? input.id;
      const entry = memory.entries.find((e) => e.id === id);
      if (entry === undefined) return { output: { found: false, message: UNKNOWN_LESSON } };
      const history = (await deps.brain().eventsFor(ctx.assignment.workspaceId, run.brain.sha, id)).map((e) => ({ op: e.op, at: e.at, by: e.by }));
      const fresh = deps.runs.get(run.id);
      if (fresh?.brain && !fresh.brain.fetched.includes(id)) deps.runs.update(run.id, { brain: { ...fresh.brain, fetched: [...fresh.brain.fetched, id] } });
      const view = deps.brain().entryView(ctx.assignment.workspaceId, entry);
      const { runLink: _runLink, ...withoutLink } = view;
      return { output: { found: true, entry: withoutLink, history }, summary: `Read lesson ${id}` };
    },
  });

  const search = defineTool({
    name: BRAIN_SEARCH_TOOL,
    capability: CORE_CAPABILITIES.repositoryRead,
    risk: 'read',
    description: `Search the project brain's lessons and mission history for a word or phrase (case-insensitive). At most ${SEARCH_MAX} results.`,
    inputSchema: z.object({ query: z.string().trim().min(1), scope: scopeSchema.optional() }),
    async execute(ctx, input): Promise<ToolExecution<Record<string, unknown>>> {
      const run = runOf(ctx);
      if (run?.brain === null || run?.brain === undefined) return { output: { results: [], message: NO_BRAIN } };
      const memory = await deps.brain().memoryAt(ctx.assignment.workspaceId, run.brain.sha);
      const q = input.query.toLowerCase();
      const now = deps.clock.now();
      const results = memory.entries
        .filter((e) => isValidAt(e, now) && e.state !== 'rejected')
        .filter((e) => e.text.toLowerCase().includes(q))
        .filter((e) => input.scope === undefined || Object.entries(input.scope).every(([k, v]) => (e.scope as Record<string, unknown>)[k] === v))
        .slice(0, SEARCH_MAX)
        .map((e) => ({ id: e.id, kind: e.kind, text: e.text }));
      return { output: { results }, summary: `${results.length} brain results for "${input.query}"` };
    },
  });

  const propose = defineTool({
    name: BRAIN_PROPOSE_TOOL,
    capability: CORE_CAPABILITIES.repositoryRead,
    risk: 'read',
    description: 'Propose one short lesson the next person doing this step should know. A person accepts it before it loads for everyone.',
    inputSchema: z.object({
      text: z.string().trim().min(3).max(400).describe('One atomic sentence.'),
      scope: scopeSchema.optional().describe('Who it applies to: a role, a repository, a step. Leave out for the whole project.'),
    }),
    async execute(ctx, input): Promise<ToolExecution<Record<string, unknown>>> {
      const run = runOf(ctx);
      if (run === undefined) return { output: { saved: false, message: NO_BRAIN } };
      const mission = deps.missions.get(run.missionId);
      if (isTrialMission(mission)) return { output: { saved: false, message: NO_LESSONS_IN_TRIAL } };
      if (run.brain === null || run.brain === undefined) return { output: { saved: false, message: NO_BRAIN } };
      if (run.brain.proposed.length >= MAX_PROPOSALS_PER_RUN) return { output: { saved: false, message: TOO_MANY_PROPOSALS } };
      const link = deps.brain().linkOf(ctx.assignment.workspaceId);
      if (link === undefined) return { output: { saved: false, message: NO_BRAIN } };
      const [event] = await deps.brain().append(ctx.assignment.workspaceId, [{
        op: 'add',
        entry: {
          kind: 'lesson', text: input.text, scope: { ...(input.scope ?? {}) }, state: 'candidate',
          source: { signal: 'agent', mission: mission?.title ?? '', run: { daemon: link.writerId, runId: run.id } },
        },
      }], { actor: 'agent', missionId: run.missionId });
      if (event === undefined) return { output: { saved: false, message: "That lesson couldn't be saved: it named a secret or a path on this machine." } };
      const fresh = deps.runs.get(run.id);
      if (fresh?.brain) deps.runs.update(run.id, { brain: { ...fresh.brain, proposed: [...fresh.brain.proposed, event.id] } });
      return { output: { saved: true, id: event.id, message: 'Proposed. A person will accept it, or another mission will confirm it.' }, summary: 'Proposed a lesson' };
    },
  });

  return [read, search, propose] as unknown as readonly IntegrationTool[];
}
