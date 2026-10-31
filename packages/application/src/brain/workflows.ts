import type { WorkspaceId } from '@tandemise/shared';
import type { LoadedWorkflow, WorkflowSourcePort } from '../ports.js';

/** Reads the workflows in a project's brain (`factory/workflows/*` at its last pull). */
export interface BrainWorkflowReader {
  brainWorkflows(workspaceId: WorkspaceId): Promise<readonly LoadedWorkflow[]>;
}

/**
 * A project's workflows by id, in precedence order (#51 spec §2): the brain's
 * first, then the code repositories' `.tandemise/workflows/`. Presets come
 * after both, where each caller already puts them. A code-repository workflow
 * a brain workflow shadows is returned in `shadowed`, so the Brain screen can
 * offer to move it in.
 */
export async function listProjectWorkflows(
  deps: { readonly workflows: WorkflowSourcePort; readonly brain?: BrainWorkflowReader | undefined },
  workspaceId: WorkspaceId,
  repositoryPaths: readonly string[],
): Promise<{ workflows: readonly LoadedWorkflow[]; shadowed: readonly LoadedWorkflow[] }> {
  const fromRepos = (await deps.workflows.list(repositoryPaths)).map((w) => ({ ...w, origin: 'repository' as const }));
  const fromBrain = deps.brain === undefined ? [] : await deps.brain.brainWorkflows(workspaceId);
  if (fromBrain.length === 0) return { workflows: fromRepos, shadowed: [] };
  const brainIds = new Set(fromBrain.map((w) => w.id));
  const shadowed = fromRepos.filter((w) => brainIds.has(w.id));
  const workflows = [...fromBrain, ...fromRepos.filter((w) => !brainIds.has(w.id))].sort((a, b) => a.id.localeCompare(b.id));
  return { workflows, shadowed };
}
