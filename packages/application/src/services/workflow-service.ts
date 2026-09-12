import type { RepoRepositoryPort } from '@tandemise/domain';
import type { WorkspaceId } from '@tandemise/shared';
import type { WorkflowService, WorkflowSummary } from '../services.js';
import type { WorkflowSourcePort } from '../ports.js';
import { WORKFLOW_PRESETS } from '../planning/presets.js';

/**
 * What this project can run.
 *
 * The project's own files come first and shadow a preset of the same id, which
 * is the whole point: a team that writes `build-feature.yaml` should get theirs,
 * not one shipped in this repository. The built-ins remain underneath as a
 * starting position rather than a ceiling.
 *
 * A file that will not parse is listed with its issues rather than omitted.
 * A workflow that silently vanishes from this list sends its author looking
 * everywhere except at the file they just broke.
 */
export class WorkflowServiceImpl implements WorkflowService {
  constructor(
    private readonly workflows: WorkflowSourcePort,
    private readonly repositories: RepoRepositoryPort,
  ) {}

  async list(workspaceId: WorkspaceId): Promise<readonly WorkflowSummary[]> {
    const paths = this.repositories.listByWorkspace(workspaceId).map((r) => r.path);
    const authored = await this.workflows.list(paths);

    const own: WorkflowSummary[] = authored.map((loaded) => ({
      id: loaded.id,
      name: loaded.definition?.name ?? loaded.id,
      description: loaded.definition?.description ?? null,
      path: loaded.path,
      inputs: (loaded.definition?.inputs ?? []).map((input) => ({
        name: input.name,
        description: input.description ?? null,
        required: input.required,
      })),
      steps: (loaded.definition?.steps ?? []).map((step) => ({
        key: step.key,
        title: step.title ?? step.key.replace(/_/g, ' '),
        executor: step.executor,
      })),
      issues: loaded.issues,
    }));

    const shadowed = new Set(own.map((w) => w.id));
    const builtIn: WorkflowSummary[] = WORKFLOW_PRESETS
      .filter((preset) => !shadowed.has(preset.id))
      .map((preset) => ({
        id: preset.id,
        name: preset.name,
        description: preset.description,
        path: null,
        inputs: [],
        // A preset's stages are the closest thing it has to steps; the real
        // task list only exists once the planner has run.
        steps: preset.stages.map((stage) => ({ key: stage.toLowerCase(), title: stage, executor: 'agent' as const })),
        issues: [],
      }));

    return [...own, ...builtIn];
  }
}
